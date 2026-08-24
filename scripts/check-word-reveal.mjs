/**
 * check-word-reveal.mjs
 *
 * Checks that word-by-word reveal behaves, on every template that uses it.
 *
 * Two things have to hold, and they pull against each other:
 *
 *   1. Words arrive one at a time, as they are spoken, rather than the whole
 *      line landing at once.
 *   2. A word does not move after it lands.
 *
 * The second is the one that goes wrong. If the line is laid out from only the
 * words revealed so far, every new word re-centres the ones already on screen
 * and the caption crawls sideways for the whole line. Laying out the finished
 * line up front and revealing into those positions is what stops it — and this
 * asserts it by checking the ink's top-left corner never moves while the ink
 * itself keeps growing.
 *
 * Usage: node scripts/check-word-reveal.mjs
 */

import { createCanvas } from '@napi-rs/canvas';
import { registerFonts } from '../src/render/fonts-node.js';
import { renderCaptionFrame, clearLayoutCache } from '../src/render/caption-renderer.js';
import { TEMPLATES, normalizeTemplate } from '../src/render/templates.js';

registerFonts();

const W = 1080;
const H = 1920;
const WORD_MS = 460;
const WORDS = ['pehle', 'research', 'karo', 'phir', 'paisa', 'lagao'];

const tokens = WORDS.map((text, i) => ({
  id: i + 1,
  text,
  start_ms: i * WORD_MS,
  end_ms: i * WORD_MS + WORD_MS - 60
}));
const tokenMap = new Map(tokens.map(t => [t.id, t]));

function composition(compType) {
  return {
    id: 1,
    token_ids: tokens.map(t => t.id),
    // A hero late in the line, so "the hero waits for its own beat" is testable.
    hero_token_id: tokens[4].id,
    comp_type: compType,
    start_ms: 0,
    end_ms: WORDS.length * WORD_MS
  };
}

/** Ink pixel count and bounding box of whatever is drawn. */
function ink(ctx) {
  const data = ctx.getImageData(0, 0, W, H).data;
  let count = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Ignore the faint outer edge of a glow, which spreads a little as
      // neighbouring words light up and would look like movement.
      if (data[(y * W + x) * 4 + 3] < 120) continue;
      count++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return { count, x0, y0, x1, y1 };
}

function sample(template, comp, timeMs) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  clearLayoutCache();
  renderCaptionFrame(ctx, timeMs, [comp], tokenMap, template, W, H);
  return ink(ctx);
}

function run() {
  const progressive = TEMPLATES
    .map(normalizeTemplate)
    .filter(t => t.layout.reveal === 'progressive');

  if (!progressive.length) {
    console.log('\n  No template uses word-by-word reveal.\n');
    return 1;
  }

  console.log(`\n  ${progressive.length} template(s) reveal word by word\n`);
  console.log('  template              words seen   corner drift   verdict');
  console.log('  ' + '─'.repeat(62));

  let failures = 0;
  for (const template of progressive) {
    const comp = composition(template.mode === 'hero' ? 'emphasis' : 'plain');

    // Sample each word 300ms after it starts: past its entry animation, before
    // the next word arrives, so what is measured is settled ink.
    const samples = tokens.map(t => sample(template, comp, t.start_ms + 300));
    const problems = [];

    const counts = samples.map(s => s.count);
    if (counts[0] === 0) problems.push('nothing drawn on the first word');
    for (let i = 1; i < counts.length; i++) {
      if (counts[i] <= counts[i - 1]) {
        problems.push(`ink did not grow at word ${i + 1} (${counts[i - 1]} then ${counts[i]})`);
      }
    }

    // The first word is the leftmost on the first line, so once it is on screen
    // the top-left of the ink is fixed for the rest of the line.
    const drift = Math.max(
      ...samples.slice(1).map(s => Math.max(Math.abs(s.x0 - samples[0].x0), Math.abs(s.y0 - samples[0].y0)))
    );
    if (drift > 2) problems.push(`settled words moved by ${drift}px`);

    // Nothing may be revealed before the first word is spoken.
    const before = sample(template, comp, -50);
    if (before.count > 0) problems.push('words visible before they are spoken');

    // In hero mode the hero must wait its turn rather than appearing with the
    // first word of the line.
    if (template.mode === 'hero') {
      const heroToken = tokens[4];
      const justBefore = sample(template, comp, heroToken.start_ms - 80);
      const justAfter = sample(template, comp, heroToken.start_ms + 300);
      if (justAfter.count <= justBefore.count) problems.push('the hero word never appeared');
      if (justBefore.y1 >= justAfter.y1 && justBefore.x1 >= justAfter.x1) {
        problems.push('the hero added no ink of its own');
      }
    }

    if (problems.length) failures++;
    console.log(`  ${problems.length ? 'FAIL' : 'ok  '} ${template.id.padEnd(18)} ` +
      `${String(counts.filter(c => c > 0).length).padStart(2)}/${tokens.length}        ` +
      `${String(drift).padStart(3)}px          ${problems.length ? problems.join('; ') : 'reveals in place'}`);
  }

  if (failures) {
    console.log(`\n  ${failures} template(s) do not reveal correctly\n`);
    return 1;
  }
  console.log('\n  every word-by-word template reveals in place\n');
  return 0;
}

process.exit(run());
