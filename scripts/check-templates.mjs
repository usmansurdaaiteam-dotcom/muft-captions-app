/**
 * check-templates.mjs
 *
 * Objective sanity check for the template catalogue. For every template it
 * renders sample frames onto a transparent canvas and asserts that:
 *
 *   - something was actually drawn (catches templates that silently render
 *     nothing because of a bad style or a broken font reference)
 *   - the ink stays inside the frame (catches overflow and bad anchors)
 *   - unspoken words are visible when the template shows the whole phrase
 *     (catches entry animations leaving words stuck at zero opacity)
 *   - every font the template asks for is actually installed
 *
 * Exits non-zero if any template fails, so it can gate a release.
 *
 * Usage: node scripts/check-templates.mjs
 */

import { createCanvas } from '@napi-rs/canvas';
import { registerFonts } from '../src/render/fonts-node.js';
import { renderCaptionFrame, clearLayoutCache } from '../src/render/caption-renderer.js';
import { TEMPLATES, normalizeTemplate } from '../src/render/templates.js';
import { FONT_FILES, resolveFont } from '../src/render/fonts.js';

registerFonts();

const W = 1080;
const H = 1920;

const WORDS = ['yeh', 'wala', 'template', 'bilkul', 'insane', 'hai'];
const tokens = WORDS.map((text, i) => ({
  id: i + 1,
  text,
  start_ms: i * 400,
  end_ms: i * 400 + 380
}));
const tokenMap = new Map(tokens.map(t => [t.id, t]));

function makeComposition(compType) {
  return {
    id: 1,
    token_ids: tokens.map(t => t.id),
    hero_token_id: tokens[2].id,
    comp_type: compType,
    start_ms: 0,
    end_ms: WORDS.length * 400
  };
}

/** Alpha coverage and bounding box of everything drawn on a transparent canvas. */
function inkStats(ctx) {
  const { data } = ctx.getImageData(0, 0, W, H);
  let count = 0;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 12) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { coverage: count / (W * H), minX, minY, maxX, maxY, empty: maxX < 0 };
}

function render(template, comp, timeMs) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  clearLayoutCache();
  renderCaptionFrame(ctx, timeMs, [comp], tokenMap, template, W, H);
  return inkStats(ctx);
}

const failures = [];
const warnings = [];
const installed = new Set(FONT_FILES.map(f => f.family));

console.log(`Checking ${TEMPLATES.length} templates at ${W}x${H}\n`);
console.log('  #  template               mode      coverage  ink box');
console.log('  ─────────────────────────────────────────────────────────────────');

for (let i = 0; i < TEMPLATES.length; i++) {
  const raw = TEMPLATES[i];
  const template = normalizeTemplate(raw);
  const problems = [];

  // Font availability. resolveFont silently falls back, which would otherwise
  // hide a typo in a template's family name.
  const wanted = template.font.family;
  if (!installed.has(wanted)) {
    problems.push(`font "${wanted}" not installed (falls back to ${resolveFont(wanted).family})`);
  }

  const comp = makeComposition('emphasis');

  // Mid-phrase: third word is being spoken.
  const mid = render(template, comp, 2 * 400 + 300);
  if (mid.empty) {
    problems.push('drew nothing mid-phrase');
  } else {
    if (mid.coverage < 0.004) problems.push(`almost nothing drawn (coverage ${(mid.coverage * 100).toFixed(3)}%)`);
    if (mid.minX < 0 || mid.maxX > W - 1 || mid.minY < 0 || mid.maxY > H - 1) {
      problems.push(`ink outside frame (${mid.minX},${mid.minY})-(${mid.maxX},${mid.maxY})`);
    }
    // Captions should not bleed into the very edges of the frame.
    if (mid.minX < 8 || mid.maxX > W - 8) {
      warnings.push(`${template.id}: ink reaches frame edge (x ${mid.minX}..${mid.maxX})`);
    }
  }

  // Early in the phrase, a whole-phrase template must already show later words.
  if (template.layout.reveal === 'all') {
    const early = render(template, comp, 120);
    if (early.empty) {
      problems.push('whole-phrase template drew nothing near composition start');
    } else if (mid.coverage > 0 && early.coverage < mid.coverage * 0.35) {
      problems.push(
        `unspoken words appear hidden at start (coverage ${(early.coverage * 100).toFixed(3)}% ` +
        `vs ${(mid.coverage * 100).toFixed(3)}% mid-phrase)`
      );
    }
  }

  // Spotlight and plain composition types must not blow up.
  for (const compType of ['plain', 'spotlight']) {
    try {
      const stats = render(template, makeComposition(compType), 2 * 400 + 300);
      if (stats.empty) problems.push(`drew nothing for comp_type "${compType}"`);
    } catch (err) {
      problems.push(`threw on comp_type "${compType}": ${err.message}`);
    }
  }

  const status = problems.length ? 'FAIL' : ' ok ';
  console.log(
    `  ${String(i + 1).padStart(2)} ${template.id.padEnd(22)} ${template.mode.padEnd(9)} ` +
    `${(mid.coverage * 100).toFixed(3)}%   ` +
    (mid.empty ? '—' : `${mid.minX},${mid.minY} → ${mid.maxX},${mid.maxY}`) +
    `  ${status}`
  );
  for (const problem of problems) console.log(`       ↳ ${problem}`);
  if (problems.length) failures.push({ id: template.id, problems });
}

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  - ${w}`);
}

if (failures.length) {
  console.log(`\n${failures.length} of ${TEMPLATES.length} template(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${TEMPLATES.length} templates passed.`);
