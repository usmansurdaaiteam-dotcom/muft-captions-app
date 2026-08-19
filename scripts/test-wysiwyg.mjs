/**
 * test-wysiwyg.mjs
 *
 * Verifies that the editor preview and the export renderer agree.
 *
 * Both sides import the same renderer module, but they run on different
 * rasterisers (the browser's Skia vs @napi-rs/canvas) and load fonts through
 * different paths, so "same code" is not by itself proof of the same picture.
 * This renders the same composition at the same size in both places and
 * compares the results.
 *
 * Exact pixel equality is not expected — antialiasing and hinting differ. What
 * must match is the layout: where the words sit, how big they are, and where
 * the lines break. That is what a coverage and centroid comparison catches.
 *
 * Usage: node scripts/test-wysiwyg.mjs [baseUrl]
 */

import puppeteer from 'puppeteer-core';
import { createCanvas } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';
import { registerFonts } from '../src/render/fonts-node.js';
import { renderCaptionFrame, clearLayoutCache } from '../src/render/caption-renderer.js';
import { getTemplate } from '../src/render/templates.js';

const BASE = process.argv[2] || 'http://localhost:3111';
const PASSWORD = process.env.ACCESS_PASSWORD || 'muftcaptions2026';
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';

const W = 540;
const H = 960;
const TEMPLATES = ['muft-default', 'bold-yellow', 'bubble-pill', 'muft-glow-hero', 'mega-wide'];

const WORDS = ['yeh', 'template', 'system', 'bilkul', 'insane', 'hai'];
const tokens = WORDS.map((text, i) => ({
  id: i + 1, text, start_ms: 200 + i * 380, end_ms: 200 + i * 380 + 330
}));
const composition = {
  id: 1,
  token_ids: tokens.map(t => t.id),
  hero_token_id: 3,
  before_token_ids: [1, 2],
  after_token_ids: [4, 5, 6],
  comp_type: 'emphasis',
  start_ms: tokens[0].start_ms,
  end_ms: tokens[tokens.length - 1].end_ms
};
const SAMPLE_MS = 200 + 2 * 380 + 200;

registerFonts();

/** Alpha coverage plus the centroid and extent of the drawn pixels. */
function inkProfile(data, width, height) {
  let count = 0, sumX = 0, sumY = 0;
  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 24) {
        count++; sumX += x; sumY += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!count) return null;
  return {
    coverage: count / (width * height),
    cx: sumX / count,
    cy: sumY / count,
    minX, maxX, minY, maxY,
    boxW: maxX - minX,
    boxH: maxY - minY
  };
}

function serverRender(templateId) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  clearLayoutCache();
  renderCaptionFrame(
    ctx, SAMPLE_MS, [composition],
    new Map(tokens.map(t => [t.id, t])),
    getTemplate(templateId), W, H
  );
  const { data } = ctx.getImageData(0, 0, W, H);
  return { profile: inkProfile(data, W, H), buffer: canvas.toBuffer('image/png') };
}

const problems = [];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('pageerror', err => problems.push(`page error: ${err.message}`));

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#passwordInput', { visible: true });
  await page.type('#passwordInput', PASSWORD);
  await page.click('.password-submit-btn');
  await page.waitForFunction(
    () => document.getElementById('passwordOverlay').classList.contains('hidden'),
    { timeout: 10000 }
  );

  // Wait for the caption fonts so the browser is not measuring a fallback face.
  await page.evaluate(() => document.fonts.ready);

  console.log(`Comparing preview and export at ${W}x${H}\n`);
  console.log('  template            coverage(browser/server)   centre offset   size offset');
  console.log('  ────────────────────────────────────────────────────────────────────────────');

  for (const templateId of TEMPLATES) {
    // Render in the page using the same module, tokens and template.
    const browserResult = await page.evaluate(async (args) => {
      const { templateId, tokens, composition, sampleMs, w, h } = args;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const template = window.CaptionTemplates.getTemplate(templateId);

      // Canvas does not pull in an @font-face on its own, so the font this
      // template needs has to be requested before measuring anything.
      const resolved = window.CaptionFonts.resolveFont(template.font.family, template.font.weight);
      const alias = window.CaptionFonts.aliasFor(resolved.family, resolved.weight);
      await document.fonts.load(`400 40px "${alias}"`);
      await document.fonts.load(`400 40px "${window.CaptionFonts.ARABIC_FALLBACK_ALIAS}"`);

      window.CaptionRenderer.clearLayoutCache();
      window.CaptionRenderer.renderCaptionFrame(
        ctx, sampleMs, [composition],
        new Map(tokens.map(t => [t.id, t])),
        template, w, h
      );
      const { data } = ctx.getImageData(0, 0, w, h);
      return { data: Array.from(data), dataUrl: canvas.toDataURL('image/png') };
    }, { templateId, tokens, composition, sampleMs: SAMPLE_MS, w: W, h: H });

    const browserProfile = inkProfile(Uint8Array.from(browserResult.data), W, H);
    const { profile: serverProfile, buffer } = serverRender(templateId);

    if (!browserProfile || !serverProfile) {
      problems.push(`${templateId}: one side drew nothing (browser=${!!browserProfile} server=${!!serverProfile})`);
      console.log(`  ${templateId.padEnd(20)} DREW NOTHING`);
      continue;
    }

    const centreOffset = Math.hypot(browserProfile.cx - serverProfile.cx, browserProfile.cy - serverProfile.cy);
    const sizeOffset = Math.hypot(browserProfile.boxW - serverProfile.boxW, browserProfile.boxH - serverProfile.boxH);
    const coverageRatio = browserProfile.coverage / serverProfile.coverage;

    console.log(
      `  ${templateId.padEnd(20)} ` +
      `${(browserProfile.coverage * 100).toFixed(2)}% / ${(serverProfile.coverage * 100).toFixed(2)}%`.padEnd(26) +
      `${centreOffset.toFixed(1)}px`.padEnd(16) +
      `${sizeOffset.toFixed(1)}px`
    );

    // Layout must line up: the caption block should sit in the same place and
    // be the same size on both sides, within antialiasing noise.
    if (centreOffset > 8) {
      problems.push(`${templateId}: caption centre differs by ${centreOffset.toFixed(1)}px between preview and export`);
    }
    if (sizeOffset > 14) {
      problems.push(`${templateId}: caption block size differs by ${sizeOffset.toFixed(1)}px between preview and export`);
    }
    if (coverageRatio < 0.7 || coverageRatio > 1.4) {
      problems.push(`${templateId}: ink coverage ratio ${coverageRatio.toFixed(2)} — the two renders differ substantially`);
    }

    // Keep both images side by side for eyeballing when something looks off.
    await writeFile(`/tmp/wysiwyg-${templateId}-server.png`, buffer);
    await writeFile(
      `/tmp/wysiwyg-${templateId}-browser.png`,
      Buffer.from(browserResult.dataUrl.split(',')[1], 'base64')
    );
  }
} finally {
  await browser.close();
}

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('\nPreview and export agree on layout for all sampled templates.');
