/**
 * check-per-line-styles.mjs
 *
 * Verifies that a single composition can carry its own style overrides that
 * layer on top of the project's, and that they only affect that composition.
 *
 * Usage: node scripts/check-per-line-styles.mjs
 */

import { createCanvas } from '@napi-rs/canvas';
import { registerFonts } from '../src/render/fonts-node.js';
import { renderCaptionFrame, clearLayoutCache } from '../src/render/caption-renderer.js';
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

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}

if (failed) {
  console.log(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nPer-line style overrides work.');
