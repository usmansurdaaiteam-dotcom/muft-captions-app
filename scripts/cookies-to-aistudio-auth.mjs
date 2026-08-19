/**
 * cookies-to-aistudio-auth.mjs
 *
 * Converts a browser Cookie header into the auth file AIStudioToAPI stores, so an
 * existing Google session can be reused instead of logging in again.
 *
 * AIStudioToAPI's own flow (`npm run setup-auth`) drives a real browser through a
 * Google login with an email and password, then saves the resulting browser state
 * to `configs/auth/auth-N.json`. That file is a Playwright `storageState()`
 * document, which is just a list of cookies — so it can be written directly from
 * a Cookie header, no password required.
 *
 * Caveats worth knowing before relying on it:
 *
 * - A Cookie header carries no domain information, so every cookie is written as
 *   `.google.com`. That is correct for the ones that matter for authentication
 *   (SID, SAPISID, HSID, SSID, APISID, the __Secure-*PSID family, NID) and
 *   harmless for the rest.
 * - Google may still challenge the session when it is presented from a different
 *   IP or device than the one that created it, in which case the browser will
 *   land on a login page and the supported email/password flow is the answer.
 * - Session cookies expire on their own regardless of how they got there.
 *
 * Usage:
 *   node scripts/cookies-to-aistudio-auth.mjs                        # from GEMINI_COOKIES in .env
 *   node scripts/cookies-to-aistudio-auth.mjs --out /path/auth-1.json
 *   node scripts/cookies-to-aistudio-auth.mjs --cookies "SID=...; SAPISID=..."
 */

import '../src/load-env.js';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sapisidFromCookies } from '../src/gemini-web.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Cookies Google's session actually depends on. */
const AUTH_COOKIES = new Set([
  'SID', 'SAPISID', 'APISID', 'HSID', 'SSID', 'SIDCC', 'NID',
  '__Secure-1PSID', '__Secure-3PSID',
  '__Secure-1PAPISID', '__Secure-3PAPISID',
  '__Secure-1PSIDCC', '__Secure-3PSIDCC',
  '__Secure-1PSIDTS', '__Secure-3PSIDTS'
]);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const inline = process.argv.find(a => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

/**
 * Split a Cookie header into name/value pairs.
 *
 * Values may themselves contain '=' (Google's COMPASS cookie does), so only the
 * first '=' separates the name.
 */
function parseCookieHeader(header) {
  const cookies = [];
  for (const part of String(header).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    cookies.push({ name: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() });
  }
  return cookies;
}

function toStorageState(pairs) {
  // A year out. Playwright treats -1 as a session cookie, which would be dropped
  // when the browser context closes.
  const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  return {
    cookies: pairs.map(({ name, value }) => ({
      name,
      value,
      domain: '.google.com',
      path: '/',
      expires,
      httpOnly: true,
      secure: true,
      // Third-party variants are sent cross-site, which requires SameSite=None.
      sameSite: name.includes('3P') ? 'None' : 'Lax'
    })),
    origins: []
  };
}

async function main() {
  const header = arg('cookies') || process.env.GEMINI_COOKIES || '';
  if (!header) {
    console.error(
      'No cookies given. Either set GEMINI_COOKIES in .env or pass --cookies "SID=...; SAPISID=..."'
    );
    process.exit(1);
  }

  const pairs = parseCookieHeader(header);
  if (!pairs.length) {
    console.error('That did not look like a Cookie header — no name=value pairs found.');
    process.exit(1);
  }

  const names = new Set(pairs.map(p => p.name));
  const present = [...AUTH_COOKIES].filter(n => names.has(n));
  const missing = [...AUTH_COOKIES].filter(n => !names.has(n));

  console.log(`Parsed ${pairs.length} cookies.`);
  console.log(`  Authentication cookies present: ${present.length}/${AUTH_COOKIES.size}`);
  if (present.length) console.log(`    ${present.join(', ')}`);
  if (missing.length) console.log(`  Not present: ${missing.join(', ')}`);

  if (!sapisidFromCookies(header)) {
    console.error('\nNo SAPISID cookie found. This session will not authenticate — copy the full Cookie header.');
    process.exit(1);
  }
  if (!names.has('__Secure-1PSID') && !names.has('SID')) {
    console.error('\nNeither SID nor __Secure-1PSID is present. This is not a signed-in session.');
    process.exit(1);
  }

  const outPath = arg('out') || path.join(ROOT, 'configs', 'auth', 'auth-1.json');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(toStorageState(pairs)));

  console.log(`\nWrote ${outPath}`);
  console.log(
    '\nTo use it with AIStudioToAPI, copy the file into that project as\n' +
    '  configs/auth/auth-1.json\n' +
    'then start it and check its web console shows the account as logged in.\n' +
    '\nIf AI Studio bounces it to a login page, Google has rejected the transplanted\n' +
    'session — use its supported flow instead:\n' +
    '  npm run setup-auth        (interactive, opens a browser)\n' +
    '  npm run setup-auth -- --non-interactive --email you@gmail.com --password ... --headless\n' +
    '\nThen point this app at it:\n' +
    '  GEMINI_API_BASE=http://localhost:7860/v1beta\n' +
    '  GEMINI_API_KEY=<one of its API_KEYS>\n' +
    '  npm run credentials:check'
  );
}

main().catch(err => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
