/**
 * measure-creator-styles.mjs
 *
 * Measures the creator-style presets in the reference gallery from the frames of
 * a screen recording of it, and reports each figure with the confidence it
 * actually deserves.
 *
 * The recording shows each style as a small preview card, so the caption inside
 * it is only a few pixels tall. That is fine for some things and hopeless for
 * others, and the difference matters:
 *
 *   - colour is reliable. Flat, saturated fills survive scaling and compression,
 *     and the reading is consistent frame to frame.
 *   - ink height and position are usable, averaged over frames.
 *   - halo reach is usable, because it is measured as a falloff over several
 *     pixels rather than as a single edge.
 *   - outline and shadow thickness are near the noise floor at this size, and
 *     are reported as such rather than dressed up.
 *
 * Usage: node scripts/measure-creator-styles.mjs
 */

import { loadImage, createCanvas } from '@napi-rs/canvas';

// The preview card, cropped from the recording. It stands in for a whole 9:16
// frame, so percentages here are percentages of frame.
const W = 290;
const H = 460;

const STYLES = [
  {
    name: 'Alex Hormozi',
    ours: 'hormozi-green',
    frames: ['8.67', '9.00', '9.33', '10.00', '10.33', '11.33', '12.00', '12.33', '12.67', '13.00'],
    // Green excess: a yellow-green fill against footage.
    hue: (r, g, b) => g - (r + b) / 2,
    isInk: (r, g, b) => g > 170 && g - r > 45 && g - b > 90
  },
  {
    name: 'Mr Beast',
    ours: 'beast-yellow',
    frames: ['48.00', '48.33', '48.67', '49.00', '49.67', '50.00', '50.33'],
    // Yellow excess: red and green together, against very little blue.
    hue: (r, g, b) => (r + g) / 2 - b,
    isInk: (r, g, b) => Math.abs(g - r) < 34 && r > 185 && g > 185 && b < 95
  }
];

const frameFile = t => {
  // Frames were extracted at 3fps, numbered from 1.
  const index = Math.round(parseFloat(t) * 3) + 1;
  return `/tmp/vids/allcards/f_${String(index).padStart(4, '0')}.png`;
};

async function pixels(file) {
  const img = await loadImage(file);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  return ctx.getImageData(0, 0, W, H).data;
}

function analyseFrame(data, style) {
  const at = (x, y) => {
    const p = (y * W + x) * 4;
    return [data[p], data[p + 1], data[p + 2]];
  };

  // Ink mask and its bounding box.
  const ink = [];
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = at(x, y);
      if (!style.isInk(r, g, b)) continue;
      ink.push([x, y]);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (ink.length < 150) return null;

  // Colour at the glyph core: the most saturated tenth, so the blurred rim of
  // the halo does not drag the reading toward the background.
  const samples = ink.map(([x, y]) => at(x, y));
  samples.sort((a, b) => style.hue(...b) - style.hue(...a));
  const core = samples.slice(0, Math.max(1, Math.floor(samples.length * 0.1)));
  const colour = core
    .reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0])
    .map(v => Math.round(v / core.length));

  // Halo: hue excess above the ink, row by row, against a far-field baseline.
  const rowMean = y => {
    let sum = 0;
    for (let x = x0; x <= x1; x++) sum += style.hue(...at(x, y));
    return sum / (x1 - x0 + 1);
  };
  const far = Math.max(2, y0 - 40);
  const baseline = (rowMean(far) + rowMean(far + 1) + rowMean(far + 2)) / 3;
  const halo = [1, 2, 3, 4, 6, 8, 11].map(dy => (y0 - dy >= 0 ? rowMean(y0 - dy) - baseline : 0));
  // Reach: how far the halo stays clearly above the background.
  let reach = 0;
  for (let i = 0; i < halo.length; i++) if (halo[i] > 3) reach = [1, 2, 3, 4, 6, 8, 11][i];

  // Outline: walking in from the left of each ink run, how many dark pixels sit
  // between the background and the fill.
  const midY = Math.round((y0 + y1) / 2);
  const darkRuns = [];
  let inside = false;
  for (let x = x0; x <= x1; x++) {
    const [r, g, b] = at(x, midY);
    const isInk = style.isInk(r, g, b);
    if (isInk && !inside) {
      let dark = 0;
      for (let k = 1; k <= 6; k++) {
        const [pr, pg, pb] = at(Math.max(0, x - k), midY);
        if ((pr + pg + pb) / 3 < 70) dark++;
        else break;
      }
      darkRuns.push(dark);
      inside = true;
    } else if (!isInk) {
      inside = false;
    }
  }
  const outline = darkRuns.length
    ? darkRuns.reduce((a, b) => a + b, 0) / darkRuns.length
    : 0;

  // Shadow: darkness below the ink, against the same kind of far-field reading.
  const lumaRow = y => {
    let sum = 0;
    for (let x = x0; x <= x1; x++) {
      const [r, g, b] = at(x, y);
      sum += (r + g + b) / 3;
    }
    return sum / (x1 - x0 + 1);
  };
  const lumaFar = Math.min(H - 3, y1 + 34);
  const lumaBase = (lumaRow(lumaFar) + lumaRow(lumaFar + 1) + lumaRow(lumaFar + 2)) / 3;
  const shadow = [1, 2, 3, 4, 6].map(dy => (y1 + dy < H ? lumaRow(y1 + dy) - lumaBase : 0));

  return {
    colour,
    inkHeight: y1 - y0 + 1,
    inkWidth: x1 - x0 + 1,
    centreY: (y0 + y1) / 2,
    halo,
    reach,
    outline,
    shadow
  };
}

const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
const hex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();

for (const style of STYLES) {
  const results = [];
  for (const t of style.frames) {
    const data = await pixels(frameFile(t));
    const result = analyseFrame(data, style);
    if (result) results.push({ t, ...result });
  }

  console.log(`\n  ${style.name}  (our template: ${style.ours})`);
  console.log(`  ${results.length} frames measured, out of a ${W}x${H} preview card\n`);

  if (!results.length) {
    console.log('    nothing measurable in these frames\n');
    continue;
  }

  const colour = [0, 1, 2].map(i => Math.round(mean(results.map(r => r.colour[i]))));
  const spread = [0, 1, 2].map(i =>
    Math.max(...results.map(r => r.colour[i])) - Math.min(...results.map(r => r.colour[i])));

  console.log(`    colour        ${hex(colour)}  rgb(${colour.join(',')})`);
  console.log(`                  frame-to-frame spread ${spread.join('/')} — RELIABLE`);
  console.log(`    ink height    ${mean(results.map(r => r.inkHeight)).toFixed(1)}px ` +
    `= ${(mean(results.map(r => r.inkHeight)) / H * 100).toFixed(2)}% of frame height`);
  console.log(`    centre Y      ${(mean(results.map(r => r.centreY)) / H * 100).toFixed(1)}% of frame height`);
  console.log(`    halo reach    ${mean(results.map(r => r.reach)).toFixed(1)}px ` +
    `= ${(mean(results.map(r => r.reach)) / H * 100).toFixed(2)}% of frame height`);
  console.log('    halo falloff  ' + [1, 2, 3, 4, 6, 8, 11]
    .map((dy, i) => `${dy}px:${mean(results.map(r => r.halo[i])).toFixed(1)}`).join('  '));
  console.log(`    outline       ${mean(results.map(r => r.outline)).toFixed(2)}px of dark edge ` +
    `— AT THE NOISE FLOOR at this size`);
  console.log('    shadow below  ' + [1, 2, 3, 4, 6]
    .map((dy, i) => `${dy}px:${mean(results.map(r => r.shadow[i])).toFixed(1)}`).join('  ') +
    '  (luma vs background; negative means darker)');
}
console.log('');
