/**
 * gemini-doctor.mjs
 *
 * Checks the caption-composition backend and, optionally, compares models on the
 * real prompt so the choice can be made from actual output rather than guesswork.
 *
 * Works against either backend:
 *   - Google's API:        GEMINI_API_KEY=...
 *   - AIStudioToAPI proxy: GEMINI_API_BASE=http://localhost:7860/v1beta GEMINI_API_KEY=<one of its API_KEYS>
 *
 * Usage:
 *   node scripts/gemini-doctor.mjs              # check config, list models
 *   node scripts/gemini-doctor.mjs --compare    # also run the real prompt on each candidate
 *   node scripts/gemini-doctor.mjs --compare --models a,b,c
 */

import {
  callGeminiApi,
  verifyGeminiAccess,
  listAvailableModels,
  GEMINI_MODELS,
  DEFAULT_GEMINI_MODEL,
  GOOGLE_API_BASE
} from '../src/gemini.js';
import {
  makeV2CompositionPrompt,
  parseV2CompositionResponse,
  V2_COMPOSITION_SCHEMA
} from '../src/caption-utils.js';
import { getLanguage } from '../src/languages.js';

const API_KEY = process.env.GEMINI_API_KEY || '';
const API_BASE = process.env.GEMINI_API_BASE || GOOGLE_API_BASE;
const MODEL = process.env.GEMINI_API_MODEL || DEFAULT_GEMINI_MODEL;

const args = process.argv.slice(2);
const wantCompare = args.includes('--compare');
const modelsArg = args.find(a => a.startsWith('--models'));
const requestedModels = modelsArg
  ? (modelsArg.split('=')[1] || args[args.indexOf(modelsArg) + 1] || '').split(',').map(s => s.trim()).filter(Boolean)
  : null;

/** A realistic bilingual sample: the point is to judge emphasis and transliteration. */
const SAMPLE_WORDS = [
  'so', 'aaj', 'main', 'aapko', 'dikhata', 'hoon', 'ke', 'kaise',
  'yeh', 'tool', 'bilkul', 'مفت', 'mein', 'captions', 'banata', 'hai',
  'aur', 'quality', 'itni', 'insane', 'hai', 'ke', 'aap', 'believe',
  'nahi', 'karenge', 'chalo', 'shuru', 'karte', 'hain'
];

const tokens = SAMPLE_WORDS.map((text, i) => ({
  id: i + 1,
  text,
  start_ms: i * 360,
  end_ms: i * 360 + 320,
  language: /[\u0600-\u06FF]/.test(text) ? 'ur' : 'en',
  contains_urdu_script: /[\u0600-\u06FF]/.test(text)
}));

function heading(text) {
  console.log(`\n${text}`);
  console.log('─'.repeat(text.length));
}

async function main() {
  heading('Configuration');
  const usingProxy = !API_BASE.startsWith('https://generativelanguage.googleapis.com');
  console.log(`  backend   ${usingProxy ? 'Gemini-compatible proxy' : "Google's API"}`);
  console.log(`  base URL  ${API_BASE}`);
  console.log(`  model     ${MODEL}`);
  console.log(`  api key   ${API_KEY ? `set (${API_KEY.length} chars)` : 'NOT SET'}`);

  if (!API_KEY) {
    console.log(
      '\nNo GEMINI_API_KEY, so the app falls back to the cookie-based web client.\n' +
      'Set one of:\n' +
      '  GEMINI_API_KEY=<key from https://aistudio.google.com/apikey>\n' +
      '  GEMINI_API_BASE=http://localhost:7860/v1beta GEMINI_API_KEY=<an AIStudioToAPI API_KEYS value>'
    );
    process.exit(1);
  }

  heading('Access check');
  const access = await verifyGeminiAccess(API_KEY, MODEL, API_BASE);
  if (access.ok) {
    console.log(`  ok — "${MODEL}" is available.`);
  } else {
    console.log(`  PROBLEM — ${access.reason}`);
  }

  heading('Models this backend offers');
  let available = [];
  try {
    available = await listAvailableModels(API_KEY, API_BASE);
    const interesting = available.filter(m => /gemini/i.test(m) && !/embedding|imagen|tts|image|audio|veo/i.test(m));
    for (const id of interesting) {
      const known = GEMINI_MODELS.find(m => m.id === id);
      const marks = [
        id === MODEL ? 'configured' : null,
        known?.recommended ? 'recommended' : null,
        known?.stage
      ].filter(Boolean).join(', ');
      console.log(`  ${id}${marks ? `  (${marks})` : ''}`);
    }
    if (!interesting.length) console.log('  (none matched — full list below)');
    const others = available.filter(m => !interesting.includes(m));
    if (others.length) console.log(`\n  plus ${others.length} other model(s): ${others.slice(0, 8).join(', ')}${others.length > 8 ? ', ...' : ''}`);
  } catch (err) {
    console.log(`  Could not list models: ${err.message}`);
  }

  heading('Recommended for caption composition');
  for (const model of GEMINI_MODELS) {
    const here = available.length ? (available.includes(model.id) ? 'available' : 'not offered here') : 'unknown';
    console.log(`  ${model.id}`);
    console.log(`      ${model.stage}, ${model.availableUntil} — ${here}`);
    console.log(`      ${model.notes}`);
  }

  if (!wantCompare) {
    console.log('\nRun with --compare to try the real caption prompt on each candidate.');
    return;
  }

  const candidates = requestedModels
    || GEMINI_MODELS.filter(m => !available.length || available.includes(m.id)).map(m => m.id).slice(0, 4);

  heading(`Comparing ${candidates.length} model(s) on the real caption prompt`);
  console.log(`  ${tokens.length} words, bilingual, one word in Urdu script.\n`);

  const prompt = makeV2CompositionPrompt(tokens, { language: getLanguage('en-ur') });

  for (const model of candidates) {
    process.stdout.write(`  ${model.padEnd(26)} `);
    const started = Date.now();
    try {
      const result = await callGeminiApi(prompt, {
        apiKey: API_KEY,
        model,
        base: API_BASE,
        schema: V2_COMPOSITION_SCHEMA
      });
      const elapsed = Date.now() - started;

      let parsed;
      try {
        parsed = parseV2CompositionResponse(result.text, tokens);
      } catch (err) {
        console.log(`replied in ${elapsed}ms but the response did not parse: ${err.message}`);
        continue;
      }

      const comps = parsed.compositions;
      const byType = comps.reduce((acc, c) => {
        acc[c.comp_type || 'unset'] = (acc[c.comp_type || 'unset'] || 0) + 1;
        return acc;
      }, {});
      const heroes = comps
        .map(c => parsed.tokens.find(t => t.id === c.hero_token_id)?.text)
        .filter(Boolean);
      const stillUrdu = parsed.tokens.filter(t => /[\u0600-\u06FF]/.test(t.text)).map(t => t.text);

      console.log(`${elapsed}ms, ${comps.length} lines${result.degraded ? ` (${result.degraded})` : ''}`);
      console.log(`      types      ${JSON.stringify(byType)}`);
      console.log(`      emphasis   ${heroes.join(' · ')}`);
      console.log(`      urdu left  ${stillUrdu.length ? stillUrdu.join(', ') + '  <-- not transliterated' : 'none, all converted'}`);
      if (result.usage) {
        console.log(`      tokens     in ${result.usage.promptTokenCount ?? '?'}, out ${result.usage.candidatesTokenCount ?? '?'}`);
      }
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
  }

  console.log(
    '\nJudge on: sensible emphasis words, a healthy mix of line types (mostly plain),\n' +
    'no Urdu script left behind, and acceptable latency. Then set GEMINI_API_MODEL.'
  );
}

main().catch(err => {
  console.error(`\ngemini-doctor failed: ${err.message}`);
  process.exit(1);
});
