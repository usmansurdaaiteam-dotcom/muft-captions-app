/**
 * test-editor-ui.mjs
 *
 * Headless browser check of the editor. Verifies the things that are easy to
 * break and hard to notice: that the preview canvas actually has captions drawn
 * on it, that switching template changes those pixels, that style controls take
 * effect, and that nothing threw on the way.
 *
 * Usage: node scripts/test-editor-ui.mjs [baseUrl]
 */

// Read .env the way the server does, so a project with its own
// ACCESS_PASSWORD is testable without also exporting it to the shell.
import '../src/load-env.js';
import puppeteer from 'puppeteer-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

const BASE = process.argv[2] || 'http://localhost:3111';
const PASSWORD = process.env.ACCESS_PASSWORD || 'muftcaptions2026';
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';

const problems = [];
const consoleLines = [];

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(`${label}${detail ? `: ${detail}` : ''}`);
}

/** Count non-transparent pixels on the caption canvas, via the page itself. */
async function captionInk(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('captionCanvas');
    if (!canvas) return { error: 'no canvas' };
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    let sum = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 12) {
        count++;
        sum += data[i - 3] + data[i - 2] + data[i - 1];
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      inkPixels: count,
      coverage: count / (canvas.width * canvas.height),
      avgColor: count ? Math.round(sum / (count * 3)) : 0
    };
  });
}

// These tests edit captions and styles as part of what they check, so the
// fixtures are rebuilt first to keep runs comparable.
//
// Only possible for a server running from this same checkout: the rebuild writes
// to ./projects here, which is not what a server elsewhere is reading. Pointed at
// another install, the run continues against whatever state that install has —
// which previously looked like a real failure of find-and-replace when the
// fixtures there had already been edited by an earlier run.
const targetIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE);
if (targetIsLocal) {
  await execFileAsync('node', [path.join(SCRIPTS, 'make-fixtures.mjs')], { maxBuffer: 16 * 1024 * 1024 });
} else {
  console.log(`Note: ${BASE} is not this checkout, so its fixtures are left as they are.`);
  console.log('      Run "npm run fixtures" there first if a caption-editing check fails.\n');
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });

  page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => {
    // The stack is what makes an uncaught error actionable; the message alone
    // rarely says which of the editor's many listeners threw.
    const where = (err.stack || '').split('\n').slice(1, 4).join(' | ').trim();
    consoleLines.push(`[pageerror] ${err.message}${where ? `\n              at ${where}` : ''}`);
    problems.push(`Uncaught page error: ${err.message}${where ? ` (at ${where})` : ''}`);
  });
  page.on('requestfailed', req =>
    consoleLines.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText}`));

  console.log(`Opening ${BASE}`);
  await page.goto(BASE, { waitUntil: 'networkidle2' });

  // 1. Log in
  await page.waitForSelector('#passwordInput', { visible: true });
  await page.type('#passwordInput', PASSWORD);
  await page.click('.password-submit-btn');
  await page.waitForFunction(
    () => document.getElementById('passwordOverlay').classList.contains('hidden'),
    { timeout: 10000 }
  );
  check('login', true);

  // 2. Renderer module reached the page
  const rendererReady = await page.evaluate(() => ({
    renderer: typeof window.CaptionRenderer,
    fonts: typeof window.CaptionFonts,
    templates: typeof window.CaptionTemplates,
    overrides: typeof window.applyStyleOverrides
  }));
  check('renderer modules loaded', rendererReady.renderer === 'object', JSON.stringify(rendererReady));

  // 3. Project list
  await page.waitForSelector('.project-card', { timeout: 10000 });
  const projectNames = await page.$$eval('.project-card', els =>
    els.map(e => e.textContent.trim().split('\n')[0]));
  check('projects listed', projectNames.length >= 1, projectNames.join(' | '));

  // 4. Open the first project
  await page.click('.project-card');
  await page.waitForFunction(
    () => document.body.classList.contains('project-loaded'), { timeout: 10000 });
  await page.waitForFunction(() => {
    const v = document.getElementById('videoPlayer');
    return v && v.readyState >= 1;
  }, { timeout: 20000 });

  // Seek to a moment where a caption is definitely on screen. At t=0 there may
  // legitimately be no caption yet, which would look identical to a failure.
  await page.evaluate(() => {
    const first = window.__muft?.state?.compositions?.[0];
    const mid = first ? (first.start_ms + first.end_ms) / 2 / 1000 : 1;
    document.getElementById('videoPlayer').currentTime = mid;
  });
  await new Promise(r => setTimeout(r, 900));

  const templateState = await page.evaluate(() => {
    const s = window.__muft?.state;
    return {
      templateId: s?.templateId,
      hasTemplate: !!s?.template,
      mode: s?.template?.mode,
      compositions: s?.compositions?.length,
      tokens: s?.tokens?.length,
      currentTime: s?.currentTime
    };
  });
  console.log('  state:', JSON.stringify(templateState));
  check('project loaded with template', templateState.hasTemplate && templateState.compositions > 0);

  // 5. THE key assertion: captions are actually painted on the preview canvas.
  const baseInk = await captionInk(page);
  console.log('  canvas:', JSON.stringify(baseInk));
  check('captions drawn on preview canvas', (baseInk.inkPixels || 0) > 500,
    `${baseInk.inkPixels} ink pixels (${((baseInk.coverage || 0) * 100).toFixed(2)}%)`);

  await page.screenshot({ path: '/tmp/ui-01-default.png' });

  // 6. Switching template must change the pixels
  const clickedBold = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.template-card')]
      .find(c => c.textContent.includes('Bold Yellow'));
    if (!card) return false;
    card.click();
    return true;
  });
  check('found Bold Yellow template card', clickedBold);
  await new Promise(r => setTimeout(r, 700));
  const boldInk = await captionInk(page);
  console.log('  after Bold Yellow:', JSON.stringify(boldInk));
  check('template switch changes the preview',
    Math.abs((boldInk.inkPixels || 0) - (baseInk.inkPixels || 0)) > 100,
    `${baseInk.inkPixels} -> ${boldInk.inkPixels} ink pixels`);
  await page.screenshot({ path: '/tmp/ui-02-bold-yellow.png' });

  // 7. Pill background template
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.template-card')]
      .find(c => c.textContent.includes('Bubble Pill'));
    if (card) card.click();
  });
  await new Promise(r => setTimeout(r, 700));
  const pillInk = await captionInk(page);
  check('pill template renders', (pillInk.inkPixels || 0) > 500, `${pillInk.inkPixels} ink pixels`);
  await page.screenshot({ path: '/tmp/ui-03-bubble-pill.png' });

  // 8. Font size control drives the render
  await page.click('#tabText');
  const bigger = await page.evaluate(() => {
    const slider = document.getElementById('soFontSize');
    slider.value = '150';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    return Number(slider.value);
  });
  await new Promise(r => setTimeout(r, 500));
  const bigInk = await captionInk(page);
  check('font size control changes the render', (bigInk.inkPixels || 0) > (pillInk.inkPixels || 0),
    `size ${bigger}: ${pillInk.inkPixels} -> ${bigInk.inkPixels} ink pixels`);

  // 9. Animation actually animates: sample the canvas across consecutive frames
  //    while playing and confirm the pixels are not identical.
  await page.evaluate(() => {
    const v = document.getElementById('videoPlayer');
    v.currentTime = 0;
    return v.play();
  });
  const samples = [];
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 120));
    samples.push(await page.evaluate(() => {
      const canvas = document.getElementById('captionCanvas');
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let count = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 12) count++;
      return count;
    }));
  }
  await page.evaluate(() => document.getElementById('videoPlayer').pause());
  const distinct = new Set(samples).size;
  console.log('  ink across playback frames:', samples.join(', '));
  check('captions animate during playback', distinct >= 3,
    `${distinct} distinct values across 10 samples`);
  await page.screenshot({ path: '/tmp/ui-04-playing.png' });

  // 10. Template search
  await page.click('#tabTemplates');
  await page.type('#templateSearch', 'glow');
  await new Promise(r => setTimeout(r, 300));
  const glowCount = await page.$$eval('.template-card', els => els.length);
  check('template search filters', glowCount > 0 && glowCount < 10, `${glowCount} results for "glow"`);

  // 11. Legacy project renders too
  await page.click('#closeProjectBtn');
  await page.waitForFunction(() => document.body.classList.contains('project-unloaded'), { timeout: 10000 });
  const openedLegacy = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.project-card')]
      .find(c => c.textContent.includes('Legacy'));
    if (!card) return false;
    card.click();
    return true;
  });
  if (openedLegacy) {
    await page.waitForFunction(() => document.body.classList.contains('project-loaded'), { timeout: 10000 });
    await page.waitForFunction(() => {
      const v = document.getElementById('videoPlayer');
      return v && v.readyState >= 1;
    }, { timeout: 20000 });
    await page.evaluate(() => {
      const first = window.__muft?.state?.compositions?.[0];
      document.getElementById('videoPlayer').currentTime =
        first ? (first.start_ms + first.end_ms) / 2 / 1000 : 1;
    });
    await new Promise(r => setTimeout(r, 900));
    const legacyInk = await captionInk(page);
    check('legacy project renders captions', (legacyInk.inkPixels || 0) > 500,
      `${legacyInk.inkPixels} ink pixels`);
    await page.screenshot({ path: '/tmp/ui-05-legacy.png' });
  } else {
    check('legacy project present', false, 'card not found');
  }

  // 12. Timeline media tracks actually drew something
  const tracks = await page.evaluate(() => {
    const inked = (id) => {
      const canvas = document.getElementById(id);
      if (!canvas || !canvas.width) return 0;
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 12) n++;
      return n;
    };
    const visible = (id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      const box = el.getBoundingClientRect();
      const viewport = document.getElementById('timelineViewport').getBoundingClientRect();
      return box.height > 0 && box.bottom <= viewport.bottom + 1;
    };
    return {
      filmInk: inked('filmstripCanvas'),
      waveInk: inked('waveformCanvas'),
      videoTrackVisible: visible('videoTrack'),
      audioTrackVisible: visible('audioTrack')
    };
  });
  check('filmstrip track drew thumbnails', tracks.filmInk > 1000, `${tracks.filmInk} pixels`);
  check('waveform track drew an envelope', tracks.waveInk > 500, `${tracks.waveInk} pixels`);
  check('both media tracks are inside the timeline viewport',
    tracks.videoTrackVisible && tracks.audioTrackVisible, JSON.stringify(tracks));

  // 13. Preview shape follows the source video
  const aspect = await page.evaluate(() => {
    const s = window.__muft.state;
    const container = document.getElementById('videoContainer');
    return {
      videoAspect: s.videoAspect,
      baseW: s.baseCanvasWidth,
      baseH: s.baseCanvasHeight,
      containerAspect: getComputedStyle(container).aspectRatio
    };
  });
  const expectedAspect = aspect.baseW / aspect.baseH;
  check('canvas matches the video aspect', Math.abs(expectedAspect - aspect.videoAspect) < 0.02,
    JSON.stringify(aspect));

  // 14. Safe zones
  await page.click('#safeZoneBtn');
  await new Promise(r => setTimeout(r, 200));
  const safeOn = await page.evaluate(() =>
    !document.getElementById('safeZones').classList.contains('hidden'));
  await page.click('#safeZoneBtn');
  await new Promise(r => setTimeout(r, 200));
  const safeOff = await page.evaluate(() =>
    document.getElementById('safeZones').classList.contains('hidden'));
  check('safe zones toggle on and off', safeOn && safeOff);

  // 15. Find and replace really changes the caption text
  const replaceResult = await page.evaluate(async () => {
    const before = window.__muft.state.tokens.map(t => t.text).join(' ');
    document.getElementById('findReplaceBtn').click();
    const find = document.getElementById('findInput');
    const replace = document.getElementById('replaceInput');
    find.value = 'insane';
    find.dispatchEvent(new Event('input', { bubbles: true }));
    const countText = document.getElementById('findCount').textContent;
    replace.value = 'zabardast';
    document.getElementById('replaceAllBtn').click();
    await new Promise(r => setTimeout(r, 400));
    return { before, after: window.__muft.state.tokens.map(t => t.text).join(' '), countText };
  });
  check('find reports matches', /\d/.test(replaceResult.countText), replaceResult.countText);
  check('replace all rewrote the transcript',
    replaceResult.after.includes('zabardast') && !replaceResult.after.includes('insane'),
    replaceResult.after);

  // 16. Per-line styling only affects the line under the playhead
  const perLine = await page.evaluate(async () => {
    const s = window.__muft.state;
    const target = s.compositions[1];
    document.getElementById('videoPlayer').currentTime = (target.start_ms + 60) / 1000;
    await new Promise(r => setTimeout(r, 400));

    document.getElementById('scopeLineBtn').click();
    const picker = document.getElementById('soActiveColor');
    picker.value = '#ff0000';
    picker.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));

    return {
      styledLine: Object.keys(target.styleOverrides || {}),
      otherLine: Object.keys(s.compositions[0].styleOverrides || {}),
      projectLevel: Object.keys(s.styleOverrides)
    };
  });
  // 16b. The restyle popover reaches a single word inside a line
  const perWord = await page.evaluate(async () => {
    const s = window.__muft.state;
    const line = document.querySelector('.caption-line');
    const compId = line.dataset.compId;
    const comp = s.compositions.find(c => String(c.id) === String(compId));

    line.querySelector('.style-btn').click();
    await new Promise(r => setTimeout(r, 200));
    const opened = !document.getElementById('stylePopover').classList.contains('hidden');

    // Targets are "Whole line" followed by one chip per word; pick a word.
    const targets = [...document.querySelectorAll('#styleTargetRow .style-target')];
    targets[1].click();
    await new Promise(r => setTimeout(r, 150));

    document.querySelectorAll('#styleSwatchRow .style-swatch')[1].click();
    await new Promise(r => setTimeout(r, 150));

    const size = document.getElementById('styleSize');
    size.value = '1.6';
    size.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));

    const firstToken = comp.token_ids[0];
    const entry = (comp.wordOverrides || {})[firstToken] || {};
    const fresh = () => document.querySelector(`.caption-line[data-comp-id="${compId}"]`);
    const markerShown = !!fresh().querySelector('.style-btn.has-style');

    // Reset must clear it again, marker included.
    document.getElementById('styleResetTarget').click();
    await new Promise(r => setTimeout(r, 250));

    return {
      opened,
      targetCount: targets.length,
      wordCount: comp.token_ids.length,
      entry: Object.keys(entry),
      colour: entry.color || '',
      sizeScale: entry.sizeScale,
      markerShown,
      markerClearedAfterReset: !fresh().querySelector('.style-btn.has-style'),
      clearedAfterReset: !(comp.wordOverrides && comp.wordOverrides[firstToken]),
      lineUntouched: !comp.styleOverrides
    };
  });
  check('restyle popover opens from the transcript line', perWord.opened);
  check('it offers the whole line plus every word',
    perWord.targetCount === perWord.wordCount + 1,
    `${perWord.targetCount} targets for ${perWord.wordCount} words`);
  check('a colour and size land on that word alone',
    perWord.entry.includes('color') && perWord.sizeScale === 1.6 && perWord.lineUntouched,
    `${perWord.colour} at ${perWord.sizeScale}x`);
  check('the line is marked as carrying its own styling', perWord.markerShown);
  check('reset clears the word and its marker',
    perWord.clearedAfterReset && perWord.markerClearedAfterReset);

  // 16c. Dragging the caption tracks the cursor, and snaps to the guides
  const dragResult = await page.evaluate(async () => {
    // Reset placement to a spot that is not already on a snap target, and clear
    // the per-line scope so the drag writes to the project.
    document.getElementById('scopeAllBtn').click();
    window.__muft.state.styleOverrides.x = 0.35;
    window.__muft.state.styleOverrides.y = 0.6;
    window.__muft.refreshTemplate();
    document.getElementById('videoPlayer').pause();
    await new Promise(r => setTimeout(r, 500));
    const outline = document.getElementById('canvasSelectOutline');
    const canvas = document.getElementById('captionCanvas');
    return {
      visible: !outline.classList.contains('hidden'),
      outline: outline.getBoundingClientRect().toJSON(),
      canvas: canvas.getBoundingClientRect().toJSON(),
      x: window.__muft.state.styleOverrides.x,
      y: window.__muft.state.styleOverrides.y
    };
  });

  if (!dragResult.visible) {
    check('caption drag box is visible when paused', false, 'outline hidden');
  } else {
    const startX = dragResult.outline.x + dragResult.outline.width / 2;
    const startY = dragResult.outline.y + dragResult.outline.height / 2;
    const moveBy = 26;

    // Shift held so snapping cannot mask a scaling error.
    await page.keyboard.down('Shift');
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + moveBy, startY + moveBy, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Shift');

    const after = await page.evaluate(() => ({
      x: window.__muft.state.styleOverrides.x,
      y: window.__muft.state.styleOverrides.y
    }));

    // A caption's position is a fraction of the frame, so moving the cursor a
    // quarter of the way across the video should move the caption a quarter of
    // the way across it too. This previously ran nearly 3x fast on a video whose
    // own pixel size differed from the design canvas.
    const expectedDx = moveBy / dragResult.canvas.width;
    const expectedDy = moveBy / dragResult.canvas.height;
    const gotDx = after.x - dragResult.x;
    const gotDy = after.y - dragResult.y;
    const ratioX = gotDx / expectedDx;
    const ratioY = gotDy / expectedDy;

    check('caption drag tracks the cursor 1:1',
      ratioX > 0.85 && ratioX < 1.15 && ratioY > 0.85 && ratioY < 1.15,
      `moved ${ratioX.toFixed(2)}x horizontally, ${ratioY.toFixed(2)}x vertically`);

    // Snapping: release near the middle without shift and it should land exactly.
    const snapTarget = await page.evaluate(async () => {
      const canvas = document.getElementById('captionCanvas').getBoundingClientRect();
      window.__muft.state.styleOverrides.x = 0.5 - 0.012;
      window.__muft.refreshTemplate();
      await new Promise(r => setTimeout(r, 400));
      const outline = document.getElementById('canvasSelectOutline').getBoundingClientRect();
      return { canvas: canvas.toJSON(), outline: outline.toJSON() };
    });
    const sx = snapTarget.outline.x + snapTarget.outline.width / 2;
    const sy = snapTarget.outline.y + snapTarget.outline.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 2, sy, { steps: 3 });
    const guideShown = await page.evaluate(() =>
      !document.getElementById('dragGuideV').classList.contains('hidden'));
    await page.mouse.up();
    const snappedX = await page.evaluate(() => window.__muft.state.styleOverrides.x);

    check('a drag near the middle snaps to it',
      Math.abs(snappedX - 0.5) < 0.0005, `landed at ${snappedX.toFixed(4)}`);
    check('the guide line shows while snapped', guideShown);
    const guideHidden = await page.evaluate(() =>
      document.getElementById('dragGuideV').classList.contains('hidden'));
    check('the guide disappears on release', guideHidden);
  }

  check('per-line styling records on that line only',
    perLine.styledLine.includes('activeColor') && perLine.otherLine.length === 0,
    JSON.stringify(perLine));

  await page.evaluate(() => document.getElementById('scopeAllBtn').click());

  // 17. Language picker and font upload control exist and are populated
  const options = await page.evaluate(() => ({
    languages: document.querySelectorAll('#languageSelect option').length,
    fontFamilies: document.querySelectorAll('#soFontFamily option').length,
    hasFontUpload: !!document.getElementById('fontUploadInput'),
    textFormats: document.querySelectorAll('[data-text-format]').length
  }));
  check('language list is populated', options.languages > 20, `${options.languages} languages`);
  check('font picker is populated', options.fontFamilies > 10, `${options.fontFamilies} families`);
  check('font upload control is present', options.hasFontUpload);
  check('text export formats offered', options.textFormats >= 4, `${options.textFormats} formats`);

  // 18. Disk usage widget shows real figures rather than placeholders
  const usage = await page.evaluate(() => ({
    uploads: document.getElementById('usageUploads').textContent,
    cache: document.getElementById('usageCache').textContent
  }));
  check('disk usage widget shows real values',
    /\d/.test(usage.uploads) && usage.uploads !== '—', JSON.stringify(usage));

  // 20. Only one render loop should be running no matter how many opens
  const loops = await page.evaluate(() => {
    let count = 0;
    const original = window.requestAnimationFrame;
    return new Promise(resolve => {
      window.requestAnimationFrame = function (cb) {
        count++;
        return original.call(window, cb);
      };
      setTimeout(() => {
        window.requestAnimationFrame = original;
        resolve(count);
      }, 500);
    });
  });
  // ~30 frames in 500ms for one loop; a second loop would roughly double it.
  check('exactly one preview loop running', loops < 45, `${loops} rAF calls in 500ms`);

} finally {
  await browser.close();
}

console.log('\n--- browser console ---');
const noisy = consoleLines.filter(l =>
  !l.includes('favicon') && !l.includes('[Autosave]'));
for (const line of noisy.slice(0, 40)) console.log('  ' + line);

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('\nEditor UI OK.');
