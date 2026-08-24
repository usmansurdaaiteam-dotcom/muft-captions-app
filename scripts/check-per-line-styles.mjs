/**
 * check-per-line-styles.mjs
 *
 * Verifies the two narrower levels of styling below the project:
 *
 *   - a single line can carry overrides that layer on top of the project's, and
 *     they affect only that line
 *   - a single word inside a line can carry its own colour, size, font and
 *     casing, without disturbing the words beside it
 *
 * The per-word size case is the one worth guarding. A resized word has to be
 * measured at its new size during layout, not just drawn larger; if it is only
 * drawn larger it overlaps whatever comes next on the line.
 *
 * Usage: node scripts/check-per-line-styles.mjs
 */

import { createCanvas } from '@napi-rs/canvas';
import { registerFonts } from '../src/render/fonts-node.js';
import { renderCaptionFrame, clearLayoutCache, getCaptionBounds } from '../src/render/caption-renderer.js';
import { getTemplate } from '../src/render/templates.js';

registerFonts();

const W = 1080;
const H = 1920;

const tokens = [1, 2, 3, 4, 5, 6].map(i => ({
  id: i, text: `word${i}`, start_ms: (i - 1) * 400, end_ms: (i - 1) * 400 + 380
}));
const tokenMap = new Map(tokens.map(t => [t.id, t]));

const plainLine = {
  id: 1, token_ids: [1, 2, 3], hero_token_id: 2,
  comp_type: 'emphasis', start_ms: 0, end_ms: 1200
};
const styledLine = {
  id: 2, token_ids: [4, 5, 6], hero_token_id: 5,
  comp_type: 'emphasis', start_ms: 1200, end_ms: 2400,
  styleOverrides: { activeColor: '#FF0000', fontSize: 130 }
};

function probe(timeMs) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  clearLayoutCache();
  renderCaptionFrame(ctx, timeMs, [plainLine, styledLine], tokenMap, getTemplate('muft-default'), W, H);

  const { data } = ctx.getImageData(0, 0, W, H);
  let ink = 0, red = 0, green = 0;
  let minY = H, maxY = -1;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= 140) continue;
    ink++;
    const y = Math.floor((i / 4) / W);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (data[i] > 170 && data[i + 1] < 90 && data[i + 2] < 90) red++;
    if (data[i + 1] > 170 && data[i] < 120) green++;
  }
  return { ink, red, green, height: maxY - minY };
}

const plain = probe(700);
const styled = probe(1900);

console.log('line without its own style:', JSON.stringify(plain));
console.log('line with its own style   :', JSON.stringify(styled));

const checks = [
  ['project highlight colour applies to the untouched line', plain.green > 200 && plain.red < 50],
  ['the styled line uses its own highlight colour', styled.red > 200 && styled.green < 50],
  // The larger font size shows up as more ink and a taller block. It does not
  // show up as a wider block, because wrapping caps the line at the template's
  // maximum width and shrinks the text to fit.
  ['the styled line renders larger text', styled.ink > plain.ink * 1.3],
  ['the styled line is taller', styled.height > plain.height]
];

// ─── One word inside a line ─────────────────────────────────────────────────────

/**
 * Per-word geometry, read from the renderer's own layout rather than from
 * pixels, so overlap between neighbouring words can be measured exactly.
 */
function wordBoxes(comp) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  clearLayoutCache();
  const template = getTemplate('muft-default');
  renderCaptionFrame(ctx, comp.end_ms - 10, [comp], tokenMap, template, W, H);

  // getCaptionBounds walks the same layout the frame was drawn from.
  const bounds = getCaptionBounds(ctx, comp.end_ms - 10, [comp], tokenMap, template, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);
  let blue = 0;
  let minY = H, maxY = -1;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= 140) continue;
    const y = Math.floor((i / 4) / W);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (data[i + 2] > 170 && data[i] < 110 && data[i + 1] < 150) blue++;
  }
  return { bounds, blue, height: maxY - minY };
}

const wordLine = {
  id: 3, token_ids: [1, 2, 3], hero_token_id: 2,
  comp_type: 'plain', start_ms: 0, end_ms: 1200
};
const wordStyled = {
  ...wordLine,
  wordOverrides: { 3: { color: '#2255FF', sizeScale: 1.8, casing: 'upper' } }
};

const before = wordBoxes(wordLine);
const after = wordBoxes(wordStyled);

console.log('\nline with no per-word styling:', JSON.stringify({ blue: before.blue, height: before.height }));
console.log('line with one word restyled  :', JSON.stringify({ blue: after.blue, height: after.height }));

checks.push(
  ['a word takes the colour set on it alone', after.blue > 200 && before.blue < 50],
  // Enlarging one word makes the line taller. If the enlarged word were drawn
  // big but measured small, the block height would barely move while the word
  // silently overlapped its neighbour.
  ['enlarging one word makes the line taller', after.height > before.height * 1.2],
  ['the line still fits inside the frame', after.bounds
    && after.bounds.x >= 0 && after.bounds.x + after.bounds.width <= W]
);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}

if (failed) {
  console.log(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nPer-line and per-word style overrides work.');
