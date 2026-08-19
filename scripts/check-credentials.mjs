/**
 * check-credentials.mjs
 *
 * Confirms every credential the app depends on still works, and says what to do
 * about anything that does not.
 *
 * Worth running whenever captions get worse for no obvious reason: an expired
 * Google session does not make the app fail, it makes it quietly stop choosing
 * emphasis words properly and stop converting non-Latin script.
 *
 * Usage: node scripts/check-credentials.mjs
 */

import '../src/load-env.js';
import { envFileLoaded, ENV_PATH } from '../src/load-env.js';
import { verifySonioxAccess, getSupportedLanguages, DEFAULT_STT_MODEL } from '../src/soniox.js';
import { verifyGeminiAccess, GOOGLE_API_BASE, DEFAULT_GEMINI_MODEL } from '../src/gemini.js';
import { checkGeminiWebAccess, sapisidFromCookies } from '../src/gemini-web.js';
import { LANGUAGES, validateLanguages } from '../src/languages.js';

const SONIOX_API_KEY = process.env.SONIOX_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_BASE = process.env.GEMINI_API_BASE || GOOGLE_API_BASE;
const GEMINI_API_MODEL = process.env.GEMINI_API_MODEL || DEFAULT_GEMINI_MODEL;
const GEMINI_COOKIES = process.env.GEMINI_COOKIES || '';
const GEMINI_SAPISID = process.env.GEMINI_SAPISID || '';

const problems = [];
const advice = [];

function heading(text) {
  console.log(`\n${text}`);
  console.log('─'.repeat(text.length));
}

function line(state, label, detail = '') {
  const marks = { ok: ' ok ', bad: 'FAIL', warn: 'warn', off: ' -- ' };
  console.log(`  ${marks[state]}  ${label}${detail ? ` — ${detail}` : ''}`);
}

console.log('Muft Captions — credential check');
console.log(envFileLoaded ? `Loaded ${ENV_PATH}` : `No .env found at ${ENV_PATH} (using the process environment)`);

// ─── Transcription ─────────────────────────────────────────────────────────────

heading('Speech to text (Soniox)');
if (!SONIOX_API_KEY) {
  line('bad', 'SONIOX_API_KEY is not set');
  problems.push('Transcription cannot run at all without SONIOX_API_KEY.');
  advice.push('Set SONIOX_API_KEY in .env — see .env.example.');
} else {
  const soniox = await verifySonioxAccess(SONIOX_API_KEY, DEFAULT_STT_MODEL);
  if (soniox.ok) {
    line('ok', `key valid, ${DEFAULT_STT_MODEL} available`, `${soniox.languageCount} languages`);

    // The picker must not offer languages the model cannot handle.
    const supported = await getSupportedLanguages(SONIOX_API_KEY, DEFAULT_STT_MODEL);
    const { unsupported } = validateLanguages(supported);
    if (unsupported.length) {
      line('warn', 'some offered languages are not supported by the model', unsupported.join(', '));
      advice.push(`Remove these from src/languages.js: ${unsupported.join(', ')} (they are hidden at runtime).`);
    } else {
      line('ok', `all ${LANGUAGES.length} offered languages are supported`);
    }
  } else {
    line('bad', 'Soniox rejected the key', soniox.reason);
    problems.push('Transcription will fail.');
    advice.push('Get a new key from https://console.soniox.com and update SONIOX_API_KEY.');
  }
}

// ─── Caption composition ───────────────────────────────────────────────────────

heading('Caption composition — preferred path (API or proxy)');
const usingProxy = !GEMINI_API_BASE.startsWith('https://generativelanguage.googleapis.com');
if (!GEMINI_API_KEY) {
  line('off', 'not configured', usingProxy ? `base URL set to ${GEMINI_API_BASE} but no key` : 'no GEMINI_API_KEY');
  advice.push(
    'Configure a composition backend. Either point GEMINI_API_BASE at an AIStudioToAPI\n' +
    '    instance (free, uses your Google login) or set GEMINI_API_KEY from\n' +
    '    https://aistudio.google.com/apikey — see the README.'
  );
} else {
  const api = await verifyGeminiAccess(GEMINI_API_KEY, GEMINI_API_MODEL, GEMINI_API_BASE);
  if (api.ok) {
    line('ok', `${api.model} reachable`, api.backend === 'proxy' ? api.base : "Google's API");
  } else {
    line('bad', 'not usable', api.reason);
    problems.push('The preferred composition backend is not working; the web session will be used instead.');
    if (api.available?.length) {
      advice.push(`Models this backend offers: ${api.available.slice(0, 10).join(', ')}`);
    }
  }
}

heading('Caption composition — fallback (gemini.google.com session)');
if (!GEMINI_COOKIES) {
  line('off', 'no GEMINI_COOKIES set');
} else {
  const sapisid = GEMINI_SAPISID || sapisidFromCookies(GEMINI_COOKIES);
  line(sapisid ? 'ok' : 'bad', 'cookie string parsed',
    `${GEMINI_COOKIES.length} chars, SAPISID ${sapisid ? 'found' : 'MISSING'}`);

  const web = await checkGeminiWebAccess({ cookies: GEMINI_COOKIES, sapisid: GEMINI_SAPISID });
  if (web.ok) {
    line('ok', 'session is live', `replied in ${web.elapsedMs}ms, build ${web.buildId}`);
  } else {
    line('bad', 'session is not working', web.reason);
    problems.push('The Google session has expired or been invalidated.');
    advice.push(
      'Refresh GEMINI_COOKIES: open gemini.google.com signed in, DevTools > Network,\n' +
      '    pick any request, copy the whole Cookie request header, paste it into .env.'
    );
  }
}

// ─── Verdict ───────────────────────────────────────────────────────────────────

heading('Summary');
const compositionWorks = (GEMINI_API_KEY && (await verifyGeminiAccess(GEMINI_API_KEY, GEMINI_API_MODEL, GEMINI_API_BASE)).ok)
  || (GEMINI_COOKIES && (await checkGeminiWebAccess({ cookies: GEMINI_COOKIES, sapisid: GEMINI_SAPISID })).ok);

if (SONIOX_API_KEY && compositionWorks) {
  console.log('  Captions will generate properly: transcription and composition both work.');
} else if (SONIOX_API_KEY) {
  console.log('  Captions will generate, but composition is DEGRADED: lines are grouped by');
  console.log('  pauses only, the emphasis word becomes the longest word in each line, and');
  console.log('  non-Latin script is not converted.');
} else {
  console.log('  Captions cannot be generated: transcription is not configured.');
}

if (advice.length) {
  console.log('\nWhat to do:');
  for (const item of advice) console.log(`  - ${item}`);
}

process.exit(problems.length && !compositionWorks && !SONIOX_API_KEY ? 1 : 0);
