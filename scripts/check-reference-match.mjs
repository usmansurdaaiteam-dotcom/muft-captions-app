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
      at: '13.00s', words: ['played', 'for', 'solid'], heroIndex: 0,
      heroCapHeightPct: 7.98, heroCentreXPct: 0.18, supportBandPct: 2.59,
      supportGapPct: 2.59, supportLeftDeltaPct: -0.71, stackCentreYPct: 44.71
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
    stackCentreYPct: 3.2
  },
  heroColorTolerance: 12
};

const METRICS = [
  ['heroCapHeightPct', 'hero cap height'],
  ['heroCentreXPct', 'hero centre offset'],
  ['supportBandPct', 'support ink height'],
  ['supportGapPct', 'hero/support gap'],
  ['supportLeftDeltaPct', 'support left edge'],
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
    stackCentreYPct: (heroBand[0] + heroBand[1]) / 2 / height * 100
  };

  if (support) {
    const sPix = whitePix.filter(([, y]) => y >= support.b[0] && y <= support.b[1]);
    out.supportBandPct = (support.b[1] - support.b[0] + 1) / height * 100;
    out.supportGapPct = support.dist / height * 100;
    out.supportLeftDeltaPct = (Math.min(...sPix.map(p => p[0])) - hx0) / width * 100;
    out.stackCentreYPct =
      (Math.min(heroBand[0], support.b[0]) + Math.max(heroBand[1], support.b[1])) / 2 / height * 100;
  }

  return out;
}

// ─── Rendering a reference phrase with our own template ────────────────────────

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
