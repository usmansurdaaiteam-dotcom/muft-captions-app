/**
 * check-chunked-composition.mjs
 *
 * Composition has to survive a long video, and the way it failed before was
 * quiet: the composer's reply came back truncated, so it was not valid JSON, so
 * it looked like a parse error rather than "the transcript is too long". The
 * whole video then fell back to pause-grouping with no transliteration.
 *
 * The stub here behaves the way the real backend did — it answers properly up to
 * a prompt size and truncates past it — so the check is that a long transcript
 * still gets composed, and still gets transliterated.
 *
 * Usage: node scripts/check-chunked-composition.mjs
 */

import {
  makeV2CompositionPrompt,
  parseV2CompositionResponse,
  countUnromanised,
  V2_COMPOSITION_SCHEMA
} from '../src/caption-utils.js';
import { composeInChunks, splitIntoChunks, fillUncovered } from '../src/compose-chunks.js';
import { buildCompositions } from '../src/composition-engine.js';

const checks = [];
const check = (label, ok, detail = '') => {
  checks.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

// ─── A transcript long enough to have broken the old path ──────────────────────

// Urdu-script words, so transliteration is measurable rather than assumed.
const URDU = ['یار', 'پچھلے', 'ہفتوں', 'میں', 'لوگوں', 'نے', 'پوری', 'بات', 'سنی', 'ہے'];
const ROMAN = ['yaar', 'pichle', 'hafton', 'mein', 'logon', 'ne', 'poori', 'baat', 'suni', 'hai'];
const ENGLISH = ['thank', 'you', 'so', 'much', 'for', 'the', 'crazy', 'support', 'and', 'here'];

const romanFor = new Map(URDU.map((u, i) => [u, ROMAN[i]]));

const tokens = [];
for (let i = 0; i < 729; i++) {
  // Mixed script, as a real bilingual clip is.
  const text = i % 3 === 0 ? ENGLISH[i % ENGLISH.length] : URDU[i % URDU.length];
  // A longer gap every eight words, so there are real pauses to break on.
  const start = i * 420 + Math.floor(i / 8) * 300;
  tokens.push({ id: i + 1, text, start_ms: start, end_ms: start + 380 });
}

const language = { label: 'English + Urdu (Roman Urdu output)', romanize: true };

// ─── A composer that truncates a long reply, as the real one did ───────────────

const TRUNCATE_ABOVE_BYTES = 40000;
let calls = 0;
let truncatedReplies = 0;

async function stubComposer(prompt) {
  calls++;
  // The prompt embeds the tokens as JSON; compose from those.
  const ids = [...prompt.matchAll(/"id":\s*(\d+)/g)].map(m => Number(m[1]));
  const texts = [...prompt.matchAll(/"text":\s*"([^"]*)"/g)].map(m => m[1]);

  const compositions = [];
  for (let i = 0; i < ids.length; i += 5) {
    const groupIds = ids.slice(i, i + 5);
    const cleaned = {};
    groupIds.forEach((id, k) => {
      const text = texts[i + k];
      if (romanFor.has(text)) cleaned[id] = romanFor.get(text);
    });
    compositions.push({
      token_ids: groupIds,
      hero_token_id: groupIds[Math.min(2, groupIds.length - 1)],
      comp_type: i % 15 === 0 ? 'emphasis' : 'plain',
      cleaned_texts: cleaned
    });
  }

  const reply = JSON.stringify({ compositions });
  if (prompt.length > TRUNCATE_ABOVE_BYTES) {
    truncatedReplies++;
    // Exactly the old failure: a reply cut off mid-structure.
    return reply.slice(0, 2056);
  }
  return reply;
}

// ─── The old behaviour, for comparison ─────────────────────────────────────────

const wholePrompt = makeV2CompositionPrompt(tokens, { language });
console.log(`\n  ${tokens.length} words, ${(wholePrompt.length / 1024).toFixed(1)}KB as a single prompt\n`);

let singleShotFailed = false;
try {
  parseV2CompositionResponse(await stubComposer(wholePrompt), tokens);
} catch {
  singleShotFailed = true;
}
check('one request for the whole transcript fails, as it did in production',
  singleShotFailed, 'reply truncated, JSON incomplete');

// ─── Chunked ───────────────────────────────────────────────────────────────────

const chunks = splitIntoChunks(tokens);
check('the transcript is split into several pieces', chunks.length >= 4, `${chunks.length} chunks`);
check('every word lands in exactly one piece',
  chunks.reduce((n, c) => n + c.length, 0) === tokens.length &&
  new Set(chunks.flatMap(c => c.map(t => t.id))).size === tokens.length);

// Pieces should start after a real pause rather than mid-sentence.
const boundaryGaps = chunks.slice(1).map(c => {
  const first = c[0];
  const prev = tokens[tokens.findIndex(t => t.id === first.id) - 1];
  return first.start_ms - prev.end_ms;
});
check('pieces break where the speaker paused',
  boundaryGaps.every(g => g >= 300), `smallest boundary gap ${Math.min(...boundaryGaps)}ms`);

calls = 0;
truncatedReplies = 0;
const composed = await composeInChunks(
  tokens,
  {
    callComposer: stubComposer,
    makePrompt: makeV2CompositionPrompt,
    parseResponse: parseV2CompositionResponse,
    schema: V2_COMPOSITION_SCHEMA
  },
  { language }
);

check('no chunk reply was truncated', truncatedReplies === 0,
  `${calls} requests, all under the limit`);
check('nothing failed', composed.failedRanges.length === 0,
  `${composed.failedRanges.length} failed ranges`);
check('every word is covered by a line',
  new Set(composed.compositions.flatMap(c => c.token_ids)).size === tokens.length);

const before = countUnromanised(tokens);
const after = countUnromanised(composed.tokens);
check('the transcript came back transliterated',
  after.remaining === 0 && before.remaining > 300,
  `${before.remaining} of ${before.total} words were in Urdu script, now ${after.remaining}`);

// Pacing is applied once over the joined result, not per chunk.
const built = buildCompositions(composed.tokens, { compositions: composed.compositions });
const spanSeconds = (Math.max(...built.map(c => c.end_ms)) - Math.min(...built.map(c => c.start_ms))) / 1000;
const emphasised = built.filter(c => c.comp_type !== 'plain').length;
const secondsPer = spanSeconds / emphasised;
check('emphasis is paced across the whole clip, not per chunk',
  secondsPer >= 3, `one every ${secondsPer.toFixed(1)}s over ${spanSeconds.toFixed(0)}s`);

// ─── One chunk failing must not cost the rest ──────────────────────────────────

let failNext = 2;
const flakyComposer = async (prompt) => {
  if (failNext-- > 0) throw new Error('backend hiccup');
  return stubComposer(prompt);
};

const partial = await composeInChunks(
  tokens,
  {
    callComposer: flakyComposer,
    makePrompt: makeV2CompositionPrompt,
    parseResponse: parseV2CompositionResponse,
    schema: V2_COMPOSITION_SCHEMA
  },
  { language }
);

check('a failing chunk does not take the others down',
  partial.failedRanges.length === 1 && partial.compositions.length > 0,
  `${partial.failedRanges.length} chunk failed, ${partial.compositions.length} lines kept`);
check('failed-chunk words still have lines',
  new Set(partial.compositions.flatMap(c => c.token_ids)).size === tokens.length,
  'every word is covered, including the stretch that failed');

const partialRomanised = countUnromanised(partial.tokens);
check('the chunks that succeeded are still transliterated',
  partialRomanised.remaining < before.remaining * 0.5,
  `${partialRomanised.remaining} of ${partialRomanised.total} words still in Urdu script`);

const half = tokens.slice(0, 200);
const filled = fillUncovered(tokens, [{
  token_ids: half.map(t => t.id),
  hero_token_id: half[0].id,
  comp_type: 'plain'
}]);
check('fillUncovered only adds lines for the missing half',
  filled.length > 1 &&
  new Set(filled.flatMap(c => c.token_ids)).size === tokens.length &&
  filled[0].token_ids.length === 200);

const failed = checks.filter(ok => !ok).length;
console.log(failed
  ? `\n  ${failed} check(s) failed\n`
  : '\n  composition survives a long transcript\n');
process.exit(failed ? 1 : 0);
