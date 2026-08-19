/**
 * gemini-web.js
 *
 * The fallback caption-composition path: talks to the gemini.google.com web app
 * using a logged-in Google session rather than an API key.
 *
 * This is not a supported interface and it will break eventually. It is kept
 * because it costs nothing and works with an account you already have. Two
 * things make it less fragile than it was:
 *
 * - The session is read from the environment instead of being hardcoded in
 *   source, so it can be refreshed without editing and committing code.
 * - The `bl` build identifier is discovered from the live page instead of being
 *   pinned. The pinned value in the original code was from 2026-05-25 and had
 *   drifted almost three months behind the deployed build.
 *
 * Prefer a real API or a Gemini-compatible proxy — see src/gemini.js.
 */

import crypto from 'node:crypto';
import https from 'node:https';

/** Last resort if the live page cannot be read. Will go stale. */
const FALLBACK_BUILD_ID = 'boq_assistant-bard-web-server_20260525.09_p0';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

/** Build ids change every few days, so this is cached rather than looked up per call. */
const BUILD_ID_TTL_MS = 30 * 60 * 1000;
let cachedBuildId = null;
let cachedBuildIdAt = 0;

/**
 * Fetch a URL with a raised header limit.
 *
 * Google's responses carry enough Set-Cookie headers to exceed Node's default
 * 16 KB limit, which makes global fetch throw HeadersOverflowError outright.
 */
function fetchWithLargeHeaders(url, { headers = {}, timeoutMs = 20000, maxBytes = 700000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'GET',
      maxHeaderSize: 262144,
      headers: { 'User-Agent': BROWSER_UA, ...headers }
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        // Only the head of the document is needed; it is a very large page.
        if (body.length < maxBytes) body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

/** The build id the deployed Gemini web app is currently running. */
export async function resolveBuildId({ force = false } = {}) {
  if (!force && cachedBuildId && Date.now() - cachedBuildIdAt < BUILD_ID_TTL_MS) {
    return cachedBuildId;
  }

  try {
    const { status, body } = await fetchWithLargeHeaders('https://gemini.google.com/app', {
      headers: { Accept: 'text/html' }
    });
    if (status === 200) {
      const match = body.match(/"cfb2h":"([^"]+)"/)
        || body.match(/(boq_assistant-bard-web-server_[0-9a-zA-Z._-]+)/);
      if (match) {
        if (match[1] !== cachedBuildId) {
          console.log(`[gemini-web] Using build id ${match[1]}`);
        }
        cachedBuildId = match[1];
        cachedBuildIdAt = Date.now();
        return cachedBuildId;
      }
    }
    console.warn(`[gemini-web] Could not read the build id (HTTP ${status}); using the pinned fallback.`);
  } catch (err) {
    console.warn(`[gemini-web] Could not read the build id (${err.message}); using the pinned fallback.`);
  }

  cachedBuildId = FALLBACK_BUILD_ID;
  cachedBuildIdAt = Date.now();
  return cachedBuildId;
}

/**
 * Google's SAPISIDHASH scheme: sha1 of "timestamp SAPISID origin".
 */
function makeSapisidHash(sapisid) {
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1')
    .update(`${ts} ${sapisid} https://gemini.google.com`)
    .digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

/** Pull SAPISID out of a Cookie header string, so it need not be configured twice. */
export function sapisidFromCookies(cookies) {
  const match = String(cookies || '').match(/(?:^|;\s*)SAPISID=([^;]+)/)
    || String(cookies || '').match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/);
  return match ? match[1] : null;
}

function cleanGeminiText(text) {
  return text.replace(
    /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n.*?```\n?/gs,
    ''
  ).trim();
}

/**
 * Dig the assistant's reply out of the batchexecute envelope.
 * The payload is JSON nested inside JSON inside a line-delimited stream.
 */
export function extractResponseText(raw) {
  const texts = [];

  for (const line of raw.split('\n')) {
    if (!line.includes('"wrb.fr"') || line.length < 200) continue;
    try {
      const envelope = JSON.parse(line);
      const innerString = envelope[0][2];
      if (!innerString || innerString.length < 50) continue;
      const inner = JSON.parse(innerString);
      if (Array.isArray(inner) && inner.length > 4 && inner[4]) {
        for (const part of inner[4]) {
          if (Array.isArray(part) && Array.isArray(part[1])) {
            for (const candidate of part[1]) {
              if (typeof candidate === 'string' && candidate.length) texts.push(candidate);
            }
          }
        }
      }
    } catch { /* not the line we want */ }
  }

  // Take the last non-empty candidate: later entries are the completed answer.
  for (let i = texts.length - 1; i >= 0; i--) {
    if (texts[i].trim()) return cleanGeminiText(texts[i]);
  }

  // Only treat this as an upstream error when there was no usable text at all;
  // the stream can carry an error marker alongside a perfectly good answer.
  if (raw.includes('BardErrorInfo')) {
    const code = raw.match(/BardErrorInfo\s*\[(\d+)\]/);
    throw new Error(
      `Gemini rejected the request (BardErrorInfo ${code ? code[1] : 'unknown'}). ` +
      'The session has most likely expired — refresh GEMINI_COOKIES.'
    );
  }

  throw new Error('No reply could be read from the Gemini web response.');
}

function buildPayload(prompt) {
  const inner = Array(80).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ['en'];
  inner[2] = ['', '', '', null, null, null, null, null, null, ''];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[4]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [2];
  inner[53] = 0;
  inner[59] = crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = 1;

  const params = new URLSearchParams();
  params.append('f.req', JSON.stringify([null, JSON.stringify(inner)]));
  return params.toString();
}

/**
 * Send a prompt through the Gemini web app.
 *
 * @param {string} prompt
 * @param {{cookies: string, sapisid?: string}} session
 */
export async function callGeminiWeb(prompt, { cookies, sapisid } = {}) {
  if (!cookies) {
    throw new Error(
      'No Gemini web session configured. Set GEMINI_COOKIES, or configure an API ' +
      'backend with GEMINI_API_KEY.'
    );
  }

  const secret = sapisid || sapisidFromCookies(cookies);
  if (!secret) {
    throw new Error('GEMINI_COOKIES contains no SAPISID cookie, so the request cannot be signed.');
  }

  const buildId = await resolveBuildId();
  const reqid = Math.floor(Date.now() / 1000) % 1000000;
  const url = 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
    + `?bl=${encodeURIComponent(buildId)}&hl=en&_reqid=${reqid}&rt=c`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://gemini.google.com',
      Referer: 'https://gemini.google.com/app',
      'X-Same-Domain': '1',
      'User-Agent': BROWSER_UA,
      Cookie: cookies,
      Authorization: makeSapisidHash(secret)
    },
    body: buildPayload(prompt)
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Gemini web returned ${response.status}: the session is no longer valid. Refresh GEMINI_COOKIES.`
      );
    }
    throw new Error(`Gemini web returned ${response.status} ${response.statusText}.`);
  }

  return extractResponseText(await response.text());
}

/**
 * Is the configured session still usable?
 *
 * Worth having because an expired session does not stop the app — captions still
 * get produced, just with guessed emphasis and no script conversion — so it is
 * otherwise easy to miss for weeks.
 */
export async function checkGeminiWebAccess({ cookies, sapisid } = {}) {
  if (!cookies) return { configured: false, ok: false, reason: 'No GEMINI_COOKIES set.' };

  const secret = sapisid || sapisidFromCookies(cookies);
  if (!secret) {
    return { configured: true, ok: false, reason: 'No SAPISID cookie found in GEMINI_COOKIES.' };
  }

  const startedAt = Date.now();
  try {
    const reply = await callGeminiWeb('Reply with only the word OK.', { cookies, sapisid: secret });
    return {
      configured: true,
      ok: true,
      elapsedMs: Date.now() - startedAt,
      buildId: await resolveBuildId(),
      reply: reply.slice(0, 60)
    };
  } catch (err) {
    return { configured: true, ok: false, elapsedMs: Date.now() - startedAt, reason: err.message };
  }
}
