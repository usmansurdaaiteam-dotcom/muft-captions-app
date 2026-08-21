/**
 * check-reference-match.mjs
 *
 * Measures a rendered template against numbers taken off a reference clip, so
 * "does this look right?" is answered by measurement instead of opinion.
 *
 * The reference figures below were obtained by scanning every frame of the
 * reference clip, isolating the hero word by colour, and measuring its ink. This
 * script renders the same phrases with our template and measures the same things
 * the same way, phrase by phrase, then reports each reading against tolerance.
 *
 * Measuring pixels rather than asking the layout for its own numbers is the
 * point: it catches a template whose declared sizes are right but which draws
 * something else.
 *
 * Usage:
 *   node scripts/check-reference-match.mjs            check
 *   node scripts/check-reference-match.mjs --write    also write PNGs to /tmp
 */

import { createCanvas } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';
import { registerFonts } from '../src/render/fonts-node.js';
import { renderCaptionFrame, clearLayoutCache } from '../src/render/caption-renderer.js';
import { getTemplate } from '../src/render/templates.js';

registerFonts();

const W = 1080;
const H = 1920;
const WRITE = process.argv.includes('--write');

// ─── What the reference actually does ───────────────────────────────────────────

/**
 * All lengths are percentages of the frame, so they hold at any render size.
 * They come from a 282x501 preview of the reference clip; the timestamp on each
 * phrase is the frame the numbers were read from.
 *
 * supportLeftDeltaPct is how far the support line's first ink sits from the
 * hero's first ink. Three of the four reference frames read -0.7%, i.e. the
 * support line is aligned to the hero's left edge. The fourth ("was a") sits
 * about 10% further left, which no other frame does and which is not consistent
 * with the rest, so it is recorded as null and not gated on rather than fitting
 * the template to a single contradictory reading.
 */
const REFERENCE = {
  templateId: 'muft-glow-hero',
  label: 'Muft Glow',
  heroColor: [159, 216, 58],
  heroCasing: 'upper',
  phrases: [
    {
      at: '8.60s', words: ['was', 'a', 'bright'], heroIndex: 2,
      heroCapHeightPct: 7.98, heroCentreXPct: 0.53, supportBandPct: 1.60,
      supportGapPct: 1.80, supportLeftDeltaPct: null, stackCentreYPct: 44.81
    },
    {
      // The only phrase here whose support text comes *after* the hero, so the
      // only one where the diagonal is visible. It is gated on the right edge
      // matching the hero's, which is the original template's arrangement; the
      // reference clip puts this line's support on the left instead, so its left
      // reading is recorded but not gated. See heroSupportAlign in templates.js.
      at: '13.00s', words: ['played', 'for', 'solid'], heroIndex: 0,
      heroCapHeightPct: 7.98, heroCentreXPct: 0.18, supportBandPct: 2.59,
      supportGapPct: 2.59, supportLeftDeltaPct: null, supportRightDeltaPct: 0,
      stackCentreYPct: 44.71
    },
    {
      at: '19.50s', words: ['started', 'earning'], heroIndex: 1,
      heroCapHeightPct: 7.98, heroCentreXPct: 0.53, supportBandPct: 2.59,
      supportGapPct: 1.60, supportLeftDeltaPct: -0.71, stackCentreYPct: 42.02
    },
    {
      at: '21.60s', words: ['but', "I'm", 'still', 'figuring'], heroIndex: 3,
      heroCapHeightPct: 8.18, heroCentreXPct: 0.35, supportBandPct: 3.19,
      supportGapPct: 1.60, supportLeftDeltaPct: -0.71, stackCentreYPct: 47.01
    }
  ],
  // Tolerances are sized to the precision the reference itself supports: it was
  // measured off a low-resolution preview, so a single pixel there is already
  // 0.2% of the frame height.
  //
  // stackCentreYPct is the loosest by a distance, and deliberately so. Sampling
  // the reference frame by frame shows the block is rock steady while a line is
  // on screen (44.2% held for four consecutive frames, 49.3% for three) but
  // moves by up to 5 points of frame height *between* lines. Nothing about the
  // line's own structure predicts it, so it looks like the reference shifts
  // captions to stay clear of the speaker. A fixed anchor cannot reproduce that,
  // so this is gated against the reference's own spread rather than pretending
  // to a precision that does not exist.
  tolerance: {
    heroCapHeightPct: 0.5,
    heroCentreXPct: 1.0,
    supportBandPct: 0.7,
    supportGapPct: 0.9,
    supportLeftDeltaPct: 1.5,
    supportRightDeltaPct: 1.5,
    stackCentreYPct: 3.2
  },
  heroColorTolerance: 12
};

/**
 * The two things that make this style read as glowing, both measured off the
 * reference and both of which were missing at one point:
 *
 *   the hero word is lit from the middle, easing out to the colour. Across the
 *   reference's hero, luma climbs 20 from the outer letters to the middle while
 *   saturation falls 41. A flat fill reads as painted on rather than emitting
 *   light; too strong a core reads as washed out.
 *
 *   light spills onto the footage around the caption, not just around the
 *   letterforms, and every word carries it rather than only the emphasised one.
 */
const LIGHT = {
  coreLumaRise: { value: 20.4, tol: 8, unit: 'luma, centre minus edge' },
  coreSaturationDrop: { value: -40.6, tol: 14, unit: 'saturation, centre minus edge' },
  supportCarriesLight: { value: true, unit: '' }
};

const METRICS = [
  ['heroCapHeightPct', 'hero cap height'],
  ['heroCentreXPct', 'hero centre offset'],
  ['supportBandPct', 'support ink height'],
  ['supportGapPct', 'hero/support gap'],
  ['supportLeftDeltaPct', 'support left edge'],
  ['supportRightDeltaPct', 'support right edge'],
  ['stackCentreYPct', 'stack centre Y']
];

// ─── Measurement, mirroring how the reference was measured ─────────────────────

/** Contiguous row bands whose pixel count clears a threshold. */
function bands(profile, minCount, minRows) {
  const out = [];
  let start = -1;
  for (let y = 0; y <= profile.length; y++) {
    const on = y < profile.length && profile[y] >= minCount;
    if (on && start < 0) start = y;
    else if (!on && start >= 0) {
      if (y - start >= minRows) out.push([start, y - 1]);
      start = -1;
    }
  }
  return out;
}

function measureFrame(data, width, height, heroRgb) {
  const heroRow = new Array(height).fill(0);
  const whiteRow = new Array(height).fill(0);
  const heroPix = [];
  const whitePix = [];

  const near = (r, g, b) =>
    Math.abs(r - heroRgb[0]) < 60 && Math.abs(g - heroRgb[1]) < 60 && Math.abs(b - heroRgb[2]) < 60;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (data[p + 3] < 200) continue;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      if (near(r, g, b)) { heroRow[y]++; heroPix.push([x, y]); }
      else if (r > 238 && g > 238 && b > 238) { whiteRow[y]++; whitePix.push([x, y]); }
    }
  }

  const minCount = Math.max(4, Math.round(width * 0.012));
  const heroBand = bands(heroRow, minCount, Math.round(height * 0.008))
    .sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
  if (!heroBand) return null;

  const inBand = heroPix.filter(([, y]) => y >= heroBand[0] && y <= heroBand[1]);
  const hx0 = Math.min(...inBand.map(p => p[0]));
  const hx1 = Math.max(...inBand.map(p => p[0]));

  const support = bands(whiteRow, minCount, Math.round(height * 0.004))
    .map(b => ({ b, dist: b[1] < heroBand[0] ? heroBand[0] - b[1] : b[0] - heroBand[1] }))
    .filter(o => o.dist > 0 && o.dist < height * 0.16)
    .sort((a, b) => a.dist - b.dist)[0];

  // Colour at the glyph core: the bloom halo would drag an average toward the
  // background, so take the most saturated tenth as the reference did.
  const samples = inBand.map(([x, y]) => {
    const p = (y * width + x) * 4;
    return [data[p], data[p + 1], data[p + 2]];
  });
  samples.sort((a, b) => (b[1] - (b[0] + b[2]) / 2) - (a[1] - (a[0] + a[2]) / 2));
  const core = samples.slice(0, Math.max(1, Math.floor(samples.length * 0.1)));

  const out = {
    heroColor: core
      .reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0])
      .map(v => Math.round(v / core.length)),
    heroCapHeightPct: (heroBand[1] - heroBand[0] + 1) / height * 100,
    heroCentreXPct: ((hx0 + hx1) / 2 - width / 2) / width * 100,
    supportBandPct: null,
    supportGapPct: null,
    supportLeftDeltaPct: null,
    supportRightDeltaPct: null,
    stackCentreYPct: (heroBand[0] + heroBand[1]) / 2 / height * 100
  };

  if (support) {
    const sPix = whitePix.filter(([, y]) => y >= support.b[0] && y <= support.b[1]);
    out.supportBandPct = (support.b[1] - support.b[0] + 1) / height * 100;
    out.supportGapPct = support.dist / height * 100;
    out.supportLeftDeltaPct = (Math.min(...sPix.map(p => p[0])) - hx0) / width * 100;
    out.supportRightDeltaPct = (Math.max(...sPix.map(p => p[0])) - hx1) / width * 100;
    out.stackCentreYPct =
      (Math.min(heroBand[0], support.b[0]) + Math.max(heroBand[1], support.b[1])) / 2 / height * 100;
  }

  return out;
}

// ─── Rendering a reference phrase with our own template ────────────────────────

/**
 * Sample the hero's fill from the middle of the word outward, and check whether
 * any light lands on the frame away from the support word's letters.
 */
function measureLight(data, width, height, heroRgb) {
  const at = (x, y) => {
    const p = (y * width + x) * 4;
    return [data[p], data[p + 1], data[p + 2], data[p + 3]];
  };

  const isHeroInk = (r, g, b, a) => {
    if (a <= 220) return false;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    // Brightness and hue direction, not hue dominance: requiring green to beat
    // red would drop the very pixels the core lightens, and under-report it.
    return luma > 150 && g >= b + 25 && g >= r - 40 && g > heroRgb[1] - 90;
  };

  // Columns holding hero ink, so the fill can be sampled by distance from the
  // word's own centre.
  const columns = [];
  for (let x = 0; x < width; x++) {
    const hits = [];
    for (let y = 0; y < height; y++) {
      const [r, g, b, a] = at(x, y);
      if (isHeroInk(r, g, b, a)) hits.push([r, g, b]);
    }
    if (hits.length >= 6) columns.push({ x, hits });
  }
  if (columns.length < 20) return null;

  const first = columns[0].x;
  const last = columns[columns.length - 1].x;
  const centre = (first + last) / 2;
  const half = Math.max(1, (last - first) / 2);

  const band = (lo, hi) => {
    const all = columns
      .filter(c => {
        const frac = Math.abs(c.x - centre) / half;
        return frac >= lo && frac < hi;
      })
      .flatMap(c => c.hits);
    if (!all.length) return null;
    const avg = all
      .reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0])
      .map(v => v / all.length);
    return {
      luma: 0.299 * avg[0] + 0.587 * avg[1] + 0.114 * avg[2],
      saturation: Math.max(...avg) - Math.min(...avg)
    };
  };

  const core = band(0, 0.15);
  const edge = band(0.85, 1.01);
  if (!core || !edge) return null;

  // Light on the frame away from any letters: sample a ring outside the caption's
  // own ink and see whether anything was painted there at all.
  let spill = 0;
  const step = 3;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const [, , , a] = at(x, y);
      if (a > 4 && a < 90) spill++;
    }
  }

  return {
    coreLumaRise: core.luma - edge.luma,
    coreSaturationDrop: core.saturation - edge.saturation,
    spill
  };
}

function buildScene(phrase) {
  const tokens = phrase.words.map((text, i) => ({
    id: i + 1,
    text,
    start_ms: i * 420,
    end_ms: i * 420 + 400
  }));
  return {
    tokenMap: new Map(tokens.map(t => [t.id, t])),
    comp: {
      id: 1,
      token_ids: tokens.map(t => t.id),
      hero_token_id: tokens[phrase.heroIndex].id,
      comp_type: 'emphasis',
      start_ms: 0,
      end_ms: phrase.words.length * 420
    }
  };
}

async function run() {
  const template = getTemplate(REFERENCE.templateId);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const results = [];
  for (const phrase of REFERENCE.phrases) {
    const { tokenMap, comp } = buildScene(phrase);
    clearLayoutCache();
    ctx.clearRect(0, 0, W, H);
    // Render past the end of the phrase so every word is revealed and no entry
    // animation is mid-flight.
    renderCaptionFrame(ctx, comp.end_ms - 10, [comp], tokenMap, template, W, H);

    const measured = measureFrame(ctx.getImageData(0, 0, W, H).data, W, H, REFERENCE.heroColor);
    if (!measured) {
      console.log(`\n  FAIL  "${phrase.words.join(' ')}" — no hero ink found in the frame\n`);
      return 1;
    }
    results.push({ phrase, measured });

    if (WRITE) {
      const slug = phrase.words.join('-').replace(/'/g, '');
      await writeFile(`/tmp/artifacts/ours-${slug}.png`, canvas.toBuffer('image/png'));
    }
  }

  let failures = 0;
  const note = [];

  console.log(`\n  ${REFERENCE.label} — rendered ${W}x${H}, measured against the reference clip\n`);

  // Colour and casing are properties of the style rather than of a phrase.
  const colours = results.map(r => r.measured.heroColor);
  const meanColour = [0, 1, 2].map(i =>
    Math.round(colours.reduce((s, c) => s + c[i], 0) / colours.length));
  const colourOff = Math.max(...[0, 1, 2].map(i => Math.abs(meanColour[i] - REFERENCE.heroColor[i])));
  const colourOk = colourOff <= REFERENCE.heroColorTolerance;
  if (!colourOk) failures++;
  console.log(`  ${colourOk ? 'ok  ' : 'FAIL'} hero colour        reference rgb(${REFERENCE.heroColor.join(',')})` +
    `   ours rgb(${meanColour.join(',')})   off by ${colourOff}`);

  const casingOk = template.heroCasing === REFERENCE.heroCasing;
  if (!casingOk) failures++;
  console.log(`  ${casingOk ? 'ok  ' : 'FAIL'} hero casing        reference ${REFERENCE.heroCasing}` +
    `              ours ${template.heroCasing}`);

  for (const [key, label] of METRICS) {
    console.log(`\n  ${label}`);
    for (const { phrase, measured } of results) {
      const want = phrase[key];
      const got = measured[key];
      const name = `"${phrase.words.join(' ')}" @${phrase.at}`;

      if (want === null || want === undefined) {
        note.push(`${label} for ${name} is not gated (see comment in REFERENCE)`);
        console.log(`    --   ${name.padEnd(34)} reference —        ours ` +
          `${got === null ? '—' : got.toFixed(2) + '%'}`);
        continue;
      }
      if (got === null) {
        failures++;
        console.log(`    FAIL ${name.padEnd(34)} reference ${want.toFixed(2)}%    ours not found`);
        continue;
      }

      const delta = got - want;
      const ok = Math.abs(delta) <= REFERENCE.tolerance[key];
      if (!ok) failures++;
      console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(34)} reference ${want.toFixed(2).padStart(6)}%   ` +
        `ours ${got.toFixed(2).padStart(6)}%   ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}` +
        `   (tol ${REFERENCE.tolerance[key]})`);
    }
  }

  // ── Fill and light ───────────────────────────────────────────────────────────

  const { tokenMap: lightTokens, comp: lightComp } = buildScene(REFERENCE.phrases[2]);
  clearLayoutCache();
  ctx.clearRect(0, 0, W, H);
  renderCaptionFrame(ctx, lightComp.end_ms - 10, [lightComp], lightTokens, template, W, H);
  const light = measureLight(ctx.getImageData(0, 0, W, H).data, W, H, REFERENCE.heroColor);

  // A support word on its own, to check light is not reserved for the hero.
  const supportOnly = {
    ...lightComp,
    id: 99,
    token_ids: [lightComp.token_ids[0]],
    hero_token_id: -1,
    comp_type: 'plain'
  };
  clearLayoutCache();
  ctx.clearRect(0, 0, W, H);
  renderCaptionFrame(ctx, lightComp.end_ms - 10, [supportOnly], lightTokens, template, W, H);
  const supportData = ctx.getImageData(0, 0, W, H).data;
  let supportSpill = 0;
  for (let i = 3; i < supportData.length; i += 4 * 3) {
    if (supportData[i] > 4 && supportData[i] < 90) supportSpill++;
  }

  console.log('\n  fill and light');
  if (!light) {
    failures++;
    console.log('    FAIL could not sample the hero fill');
  } else {
    const readings = {
      coreLumaRise: light.coreLumaRise,
      coreSaturationDrop: light.coreSaturationDrop,
      supportCarriesLight: supportSpill > 400
    };
    for (const [key, spec] of Object.entries(LIGHT)) {
      const got = readings[key];
      let ok, refText, gotText;
      if (typeof spec.value === 'boolean') {
        ok = got === spec.value;
        refText = String(spec.value);
        gotText = `${got} (${supportSpill} lit pixels off the letters)`;
      } else {
        ok = Math.abs(got - spec.value) <= spec.tol;
        refText = spec.value.toFixed(1);
        gotText = got.toFixed(1);
      }
      if (!ok) failures++;
      console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${key.padEnd(22)} reference ${refText.padStart(7)}   ` +
        `ours ${String(gotText).padStart(7)}   ${spec.unit}`);
    }
  }

  if (note.length) {
    console.log('\n  not gated:');
    for (const n of note) console.log(`    ${n}`);
  }

  if (failures) {
    console.log(`\n  ${failures} reading${failures === 1 ? '' : 's'} outside tolerance\n`);
    return 1;
  }
  console.log('\n  every reading within tolerance of the reference\n');
  return 0;
}

process.exit(await run());
