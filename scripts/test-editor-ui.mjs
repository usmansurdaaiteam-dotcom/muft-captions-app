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

import puppeteer from 'puppeteer-core';

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
    consoleLines.push(`[pageerror] ${err.message}`);
    problems.push(`Uncaught page error: ${err.message}`);
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

  // 12. Only one render loop should be running no matter how many opens
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
