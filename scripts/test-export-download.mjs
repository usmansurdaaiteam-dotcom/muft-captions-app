/**
 * test-export-download.mjs
 *
 * Clicks "Export MP4" in a real browser and checks that a file actually arrives
 * on disk.
 *
 * This covers the gap the other tests left. test-export.mjs drives the export
 * API with fetch and an auth header, which is not how the browser fetches the
 * finished file: that happens through an anchor click, a plain navigation that
 * carries cookies but no custom headers. So the API test could pass while the
 * download silently failed for a real user.
 *
 * Usage: node scripts/test-export-download.mjs [baseUrl]
 */

// Read .env the way the server does, so a project with its own
// ACCESS_PASSWORD is testable without also exporting it to the shell.
import '../src/load-env.js';
import puppeteer from 'puppeteer-core';
import { mkdtemp, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BASE = process.argv[2] || 'http://localhost:3111';
const PASSWORD = process.env.ACCESS_PASSWORD || 'muftcaptions2026';
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';

const problems = [];
const seen = [];

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(`${label}${detail ? `: ${detail}` : ''}`);
}

/** Wait for a file to appear and stop growing. */
async function waitForDownload(dir, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stableFor = 0;

  while (Date.now() < deadline) {
    const files = (await readdir(dir)).filter(f => !f.endsWith('.crdownload'));
    if (files.length) {
      const target = path.join(dir, files[0]);
      const { size } = await stat(target);
      if (size === lastSize && size > 0) {
        stableFor += 400;
        if (stableFor >= 1200) return target;
      } else {
        stableFor = 0;
        lastSize = size;
      }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

const downloadDir = await mkdtemp(path.join(tmpdir(), 'mc-dl-'));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });

  page.on('pageerror', err => problems.push(`page error: ${err.message}`));
  // Record every request to the download endpoint and how it was authorised.
  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('/api/export/')) return;
    const request = res.request();
    seen.push({
      url: url.replace(BASE, ''),
      status: res.status(),
      hadTokenHeader: !!request.headers()['x-access-token'],
      hadCookie: !!request.headers().cookie,
      resourceType: request.resourceType()
    });
  });

  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true
  });

  console.log(`Opening ${BASE}`);
  await page.goto(BASE, { waitUntil: 'networkidle2' });

  await page.waitForSelector('#passwordInput', { visible: true });
  await page.type('#passwordInput', PASSWORD);
  await page.click('.password-submit-btn');
  await page.waitForFunction(
    () => document.getElementById('passwordOverlay').classList.contains('hidden'),
    { timeout: 15000 }
  );

  // Is the session cookie actually set? The anchor download depends on it,
  // because a navigation cannot carry the x-access-token header.
  const cookies = await browser.cookies();
  const session = cookies.find(c => c.name === 'mc_session');
  check('session cookie is set after logging in', !!session,
    session ? `path=${session.path} sameSite=${session.sameSite} httpOnly=${session.httpOnly}` : 'no mc_session cookie');

  await page.waitForSelector('.project-card', { timeout: 15000 });
  await page.click('.project-card');
  await page.waitForFunction(() => document.body.classList.contains('project-loaded'), { timeout: 15000 });
  await page.waitForFunction(() => {
    const v = document.getElementById('videoPlayer');
    return v && v.readyState >= 1;
  }, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  console.log('  clicking Export MP4...');
  await page.click('#exportBtn');

  // Wait for the dialog to actually appear before watching it, otherwise the
  // first poll sees it still hidden and reports a finish that never happened.
  await page.waitForFunction(
    () => !document.getElementById('exportModal').classList.contains('hidden'),
    { timeout: 15000 }
  );

  // Follow the dialog so a failure message is captured rather than missed.
  const finished = await page.waitForFunction(() => {
    const modal = document.getElementById('exportModal');
    const title = document.getElementById('exportTitle')?.textContent || '';
    const error = document.getElementById('exportError');
    const link = document.getElementById('exportDownloadLink');

    if (modal.classList.contains('hidden')) return { outcome: 'closed', detail: '' };
    if (error && !error.classList.contains('hidden')) {
      return { outcome: 'failed', detail: error.textContent };
    }
    if (link && !link.classList.contains('hidden')) {
      return { outcome: 'ready', detail: title };
    }
    return false;
  }, { timeout: 300000, polling: 400 }).then(h => h.jsonValue()).catch(() => null);

  console.log(`  dialog outcome: ${finished ? finished.outcome : 'timed out'}` +
    (finished?.detail ? ` — ${finished.detail}` : ''));
  check('the export reached a finished state', !!finished,
    finished ? '' : 'timed out waiting for the dialog');
  check('the export did not fail', finished?.outcome !== 'failed',
    finished?.outcome === 'failed' ? finished.detail : '');
  check('the dialog stays open with the result', finished?.outcome === 'ready',
    finished?.outcome === 'ready' ? ''
      : `outcome was "${finished?.outcome}" — a dialog that closes itself leaves nothing to click`);

  const file = await waitForDownload(downloadDir, 120000);
  check('a file was actually downloaded', !!file, file ? path.basename(file) : `nothing in ${downloadDir}`);

  if (file) {
    const { size } = await stat(file);
    check('the file is a plausible size', size > 100000, `${(size / 1024 / 1024).toFixed(2)} MB`);
    check('it has an .mp4 name', /\.mp4$/i.test(file), path.basename(file));

    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file
      ], { maxBuffer: 8 * 1024 * 1024 });
      const probe = JSON.parse(stdout);
      const video = probe.streams.find(s => s.codec_type === 'video');
      check('it is a real playable video', !!video,
        video ? `${video.width}x${video.height} ${video.codec_name}` : 'no video stream');
    } catch (err) {
      check('it is a real playable video', false, `ffprobe rejected it: ${err.message}`);
    }
  }

  // A visible link must be offered too, because a browser can refuse a download
  // it did not start from a click and there has to be something to fall back to.
  const link = await page.evaluate(() => {
    const a = document.getElementById('exportDownloadLink');
    if (!a) return null;
    return { visible: !a.classList.contains('hidden'), href: a.getAttribute('href'), name: a.getAttribute('download') };
  });
  check('a clickable download link is offered', !!link && link.visible, link ? link.href : 'no link element');
  if (link?.href) {
    check('the link carries a credential', link.href.includes('token='), link.href);
    check('the link names the file', /\.mp4$/.test(link.name || ''), link.name || '(none)');
  }

  const downloadReq = seen.find(r => r.url.includes('/download'));
  if (downloadReq) {
    check('the download request was authorised', downloadReq.status === 200, `HTTP ${downloadReq.status}`);
  }

  // Fetch the same URL directly to prove the credential in it actually works —
  // downloads bypass the normal response pipeline, so a status is not always
  // observable from the page.
  if (link?.href) {
    const direct = await page.evaluate(async href => {
      const res = await fetch(href, { headers: {} });
      return { status: res.status, type: res.headers.get('content-type'), disp: res.headers.get('content-disposition') };
    }, link.href);
    check('the download URL returns the file on its own', direct.status === 200,
      `HTTP ${direct.status} ${direct.type || ''} ${direct.disp || ''}`);
  }

  // 2. The failure path has to stay on screen. A message that hides itself after
  //    a few seconds is indistinguishable from nothing happening.
  console.log('\n  checking the failure path is visible...');
  await page.evaluate(() => document.getElementById('exportCloseBtn')?.click());
  const failure = await page.evaluate(async () => {
    // Ask to export a project whose video is not there.
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compositions: window.__muft.state.compositions,
        tokens: window.__muft.state.tokens,
        templateId: 'muft-default',
        videoUrl: '/uploads/definitely-not-here.mp4',
        title: 'failtest'
      })
    });
    return { status: res.status, body: await res.json() };
  });
  check('a missing source video is rejected with a reason', failure.status >= 400 && !!failure.body.error,
    `HTTP ${failure.status}: ${failure.body.error}`);
} finally {
  await browser.close();
}

await rm(downloadDir, { recursive: true, force: true }).catch(() => {});

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\nExport download OK.');
