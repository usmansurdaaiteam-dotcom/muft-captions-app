/**
 * tune-glow.mjs
 *
 * Fits a template's glow to the halo measured off a reference clip.
 *
 * A glow is easy to get wrong by eye, because what reads as "glowing" is not the
 * brightness next to the letters but how far the light carries and how gradually
 * it fades. A tight bright halo just looks like a soft edge. So this measures the
 * thing that matters: hue excess above the cap line, averaged across the word and
 * sampled row by row outward, with a far-field reading subtracted so whatever is
 * behind the caption cancels out.
 *
 * Reference profiles were taken that way, with scripts/measure-creator-styles.mjs
 * for the creator presets and the same method by hand for Muft Glow. This
 * searches glow settings for the closest match, weighting the far rows more
 * heavily since they are what carries the effect.
 *
 * Usage:
 *   node scripts/tune-glow.mjs                # every style with a profile
 *   node scripts/tune-glow.mjs muft-glow-hero # one style
 *   node scripts/tune-glow.mjs --all          # show more candidates
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { registerFonts } from '../src/render/fonts-node.js';
import { renderCaptionFrame, clearLayoutCache } from '../src/render/caption-renderer.js';
import { getTemplate } from '../src/render/templates.js';

registerFonts();

const DISTANCES = [1, 2, 3, 4, 6, 8, 11];

/**
 * Each entry renders at the same pixel size as the reference it is fitted
 * against. Measuring a glow at one size and rescaling it is not the same glow,
 * because blur radius does not survive the trip.
 */
const STYLES = [
  {
    id: 'muft-glow-hero',
    label: 'Muft Glow',
    frame: { w: 282, h: 501 },
    plate: '/tmp/vids/clean/c_011.png',
    words: ['started', 'earning'],
    heroIndex: 1,
    compType: 'emphasis',
    sampleX: [30, 255],
    hue: (r, g, b) => g - (r + b) / 2,
    colour: '#9FD83A',
    // Measured off the reference clip at 282x501.
    reference: [26.4, 17.8, 16.8, 15.7, 9.2, 4.1, 3.5]
  },
  {
    id: 'hormozi-green',
    label: 'Hormozi Green',
    frame: { w: 290, h: 460 },
    plate: '/tmp/vids/allcards/f_0034.png',
    words: ['all', 'the', 'reasons'],
    heroIndex: 0,
    compType: 'plain',
    sampleX: [20, 270],
    hue: (r, g, b) => g - (r + b) / 2,
    colour: '#ABF548',
    // Averaged over ten frames of the reference preview card.
    reference: [22.6, 24.0, 7.3, 7.3, 3.8, 2.1, 0.1]
  }
];

const weightFor = dy => 1 + dy / 4;

function measure(data, style) {
  const { w, h } = style.frame;
  const [sx0, sx1] = style.sampleX;
  const at = (x, y) => {
    const p = (y * w + x) * 4;
    return [data[p], data[p + 1], data[p + 2]];
  };

  let top = -1;
  for (let y = 0; y < h && top < 0; y++) {
    let n = 0;
    for (let x = sx0; x <= sx1; x++) if (style.hue(...at(x, y)) > 70) n++;
    if (n > 12) top = y;
  }
  if (top < 0 || top < 48) return null;

  const rowMean = y => {
    let sum = 0;
    for (let x = sx0; x <= sx1; x++) sum += style.hue(...at(x, y));
    return sum / (sx1 - sx0 + 1);
  };
  const baseline = (rowMean(top - 46) + rowMean(top - 44) + rowMean(top - 42)) / 3;
  return DISTANCES.map(dy => rowMean(top - dy) - baseline);
}

async function fit(style, showCount) {
  const { w, h } = style.frame;
  const tokens = style.words.map((text, i) => ({
    id: i + 1, text, start_ms: i * 420, end_ms: i * 420 + 400
  }));
  const tokenMap = new Map(tokens.map(t => [t.id, t]));
  const comp = {
    id: 1,
    token_ids: tokens.map(t => t.id),
    hero_token_id: tokens[style.heroIndex].id,
    comp_type: style.compType,
    start_ms: 0,
    end_ms: style.words.length * 420
  };
  const plate = await loadImage(style.plate);

  const render = (glow, ambientOverride) => {
    const template = getTemplate(style.id);
    // Both states carry the glow: a style where every word is coloured has no
    // separate highlight, so the glow has to be on the base word too.
    template.word = { ...template.word, glow };
    template.active = { ...template.active, glow };
    if (ambientOverride !== undefined) {
      template.active = { ...template.active, ambient: ambientOverride };
    }

    const layer = createCanvas(w, h);
    clearLayoutCache();
    renderCaptionFrame(layer.getContext('2d'), comp.end_ms - 20, [comp], tokenMap, template, w, h);

    const out = createCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.drawImage(plate, 0, 0, w, h);
    ctx.drawImage(layer, 0, 0);
    return measure(ctx.getImageData(0, 0, w, h).data, style);
  };

  const score = profile => {
    if (!profile) return Infinity;
    let total = 0;
    DISTANCES.forEach((dy, i) => {
      const diff = profile[i] - style.reference[i];
      total += weightFor(dy) * diff * diff;
    });
    return total;
  };

  const existing = getTemplate(style.id);
  const currentGlow = (existing.active && existing.active.glow) || null;
  const currentAmbient = (existing.active && existing.active.ambient) || null;
  const currentProfile = render(currentGlow || { color: style.colour, passes: [] }, currentAmbient);

  // Two stages rather than one big grid. The pool and the halo act at different
  // distances — the pool sets how far light carries, the halo how bright it is
  // right at the letters — so fitting them in turn finds the same answer as a
  // combined sweep for a fraction of the renders.
  let bestAmbient = currentAmbient;
  if (currentAmbient) {
    const ambientCandidates = [];
    for (const centre of [0.25, 0.35, 0.45, 0.55]) {
      for (const mid of [0.08, 0.12, 0.16, 0.22]) {
        for (const maxRadius of [140, 180, 220, 280]) {
          ambientCandidates.push({
            color: currentAmbient.color,
            stops: [[0, centre], [0.35, mid], [1, 0]],
            maxRadius
          });
        }
      }
    }
    const ambientResults = ambientCandidates
      .map(a => ({ a, score: score(render(currentGlow, a)) }))
      .sort((x, y) => x.score - y.score);
    bestAmbient = ambientResults[0].a;
    console.log(`\n  ${style.label} — ambient pool: centre ${bestAmbient.stops[0][1]}, ` +
      `mid ${bestAmbient.stops[1][1]}, radius cap ${bestAmbient.maxRadius} ` +
      `(error ${score(render(currentGlow, currentAmbient)).toFixed(0)} -> ${ambientResults[0].score.toFixed(0)})`);
  }

  const candidates = [];
  for (const blurOuter of [20, 30, 40, 58, 70, 85, 100, 120, 145]) {
    for (const opacityOuter of [0.2, 0.3, 0.45, 0.6, 0.75, 0.9]) {
      for (const blurInner of [6, 10, 16, 22, 30]) {
        for (const opacityInner of [0.2, 0.35, 0.5, 0.7, 0.9]) {
          candidates.push([
            { blur: blurOuter, opacity: opacityOuter },
            { blur: blurInner, opacity: opacityInner }
          ]);
        }
      }
    }
  }

  const results = candidates
    .map(passes => {
      const glowSpec = { color: style.colour, passes };
      const profile = render(glowSpec, bestAmbient);
      return { passes, profile, score: score(profile) };
    })
    .sort((a, b) => a.score - b.score);

  const row = (label, profile) =>
    `  ${label.padEnd(24)}` + profile.map(v => v.toFixed(1).padStart(7)).join('');

  console.log(`\n  ${style.label} — halo measured at ${w}x${h}, the reference's own size`);
  console.log(`  ${''.padEnd(24)}` + DISTANCES.map(dy => `${dy}px`.padStart(7)).join(''));
  console.log(row('reference', style.reference));
  console.log(row(currentGlow ? 'current template' : 'current (no glow)', currentProfile || DISTANCES.map(() => 0)) +
    `   score ${score(currentProfile).toFixed(0)}`);
  console.log('');
  for (const result of results.slice(0, showCount)) {
    const [outer, inner] = result.passes;
    console.log(row(`blur ${outer.blur}@${outer.opacity} + ${inner.blur}@${inner.opacity}`, result.profile) +
      `   score ${result.score.toFixed(0)}`);
  }

  const best = results[0];
  console.log(`\n  best fit: glow('${style.colour}', [{ blur: ${best.passes[0].blur}, opacity: ${best.passes[0].opacity} }, ` +
    `{ blur: ${best.passes[1].blur}, opacity: ${best.passes[1].opacity} }])`);
  console.log(`  weighted error ${score(currentProfile).toFixed(0)} -> ${best.score.toFixed(0)}`);
}

const args = process.argv.slice(2);
const wanted = args.filter(a => !a.startsWith('--'));
const showCount = args.includes('--all') ? 12 : 5;
for (const style of STYLES) {
  if (wanted.length && !wanted.includes(style.id)) continue;
  await fit(style, showCount);
}
console.log('');
