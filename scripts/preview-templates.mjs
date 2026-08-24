/**
 * preview-templates.mjs
 *
 * Renders a sample frame for every template into a single contact sheet so the
 * whole catalogue can be eyeballed at once. Used to verify that templates
 * actually look the way their data claims before shipping them.
 *
 * Usage: node scripts/preview-templates.mjs [outfile.png]
 */

import { createCanvas } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerFonts } from '../src/render/fonts-node.js';
import { renderCaptionFrame, clearLayoutCache } from '../src/render/caption-renderer.js';
import { TEMPLATES, normalizeTemplate } from '../src/render/templates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

registerFonts();

// A short phrase with the third word active, which is where most templates
// show their highlight treatment.
const WORDS = ['this', 'is', 'actually', 'insane', 'bhai'];
const HERO_INDEX = 2;

const tokens = WORDS.map((text, i) => ({
  id: i + 1,
  text,
  start_ms: i * 400,
  end_ms: i * 400 + 380
}));
const tokenMap = new Map(tokens.map(t => [t.id, t]));

const composition = {
  id: 1,
  token_ids: tokens.map(t => t.id),
  hero_token_id: tokens[HERO_INDEX].id,
  comp_type: 'emphasis',
  start_ms: 0,
  end_ms: WORDS.length * 400
};

// Sample midway through the hero word, past any entry animation.
const SAMPLE_MS = HERO_INDEX * 400 + 300;

const CELL_W = 360;
const CELL_H = 640;
const COLS = 6;
const rows = Math.ceil(TEMPLATES.length / COLS);
const LABEL_H = 26;

const sheet = createCanvas(CELL_W * COLS, (CELL_H + LABEL_H) * rows);
const sheetCtx = sheet.getContext('2d');
sheetCtx.fillStyle = '#101010';
sheetCtx.fillRect(0, 0, sheet.width, sheet.height);

let failures = 0;

for (let i = 0; i < TEMPLATES.length; i++) {
  const template = normalizeTemplate(TEMPLATES[i]);
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const originX = col * CELL_W;
  const originY = row * (CELL_H + LABEL_H);

  const cell = createCanvas(CELL_W, CELL_H);
  const ctx = cell.getContext('2d');

  // Stand-in for footage: a mid-dark gradient with a lighter band across the
  // caption zone, so templates are judged against both tones the way real
  // video would present them.
  const backdrop = ctx.createLinearGradient(0, 0, 0, CELL_H);
  backdrop.addColorStop(0, '#3b3b44');
  backdrop.addColorStop(0.55, '#1b1b20');
  backdrop.addColorStop(1, '#2c2c34');
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, CELL_W, CELL_H);
  ctx.fillStyle = 'rgba(190, 190, 205, 0.22)';
  ctx.fillRect(0, CELL_H * 0.62, CELL_W, CELL_H * 0.16);

  clearLayoutCache();
  try {
    const drew = renderCaptionFrame(ctx, SAMPLE_MS, [composition], tokenMap, template, CELL_W, CELL_H);
    if (!drew) {
      failures++;
      console.error(`FAIL  ${template.id}: renderer drew nothing`);
    }
  } catch (err) {
    failures++;
    console.error(`ERROR ${template.id}: ${err.message}`);
  }

  sheetCtx.drawImage(cell, originX, originY);

  sheetCtx.fillStyle = '#000000';
  sheetCtx.fillRect(originX, originY + CELL_H, CELL_W, LABEL_H);
  sheetCtx.fillStyle = '#dddddd';
  sheetCtx.font = '15px sans-serif';
  sheetCtx.textBaseline = 'middle';
  sheetCtx.fillText(`${i + 1}. ${template.name} [${template.mode}]`, originX + 8, originY + CELL_H + LABEL_H / 2);

  sheetCtx.strokeStyle = '#000000';
  sheetCtx.lineWidth = 2;
  sheetCtx.strokeRect(originX, originY, CELL_W, CELL_H + LABEL_H);
}

const out = process.argv[2] || path.join(__dirname, '..', 'template-contact-sheet.png');
await writeFile(out, sheet.toBuffer('image/png'));
console.log(`\nWrote ${TEMPLATES.length} template previews to ${out}`);
console.log(failures ? `${failures} template(s) failed to render.` : 'All templates rendered.');
process.exit(failures ? 1 : 0);
