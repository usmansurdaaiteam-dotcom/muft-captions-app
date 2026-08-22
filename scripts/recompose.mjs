/**
 * recompose.mjs
 *
 * Re-runs composition on a project's existing transcript and reports how the
 * result paces its emphasis, without re-transcribing the audio.
 *
 * Useful for two things: checking a prompt change against a real transcript
 * rather than a synthetic one, and bringing a project composed under older rules
 * up to date. Nothing is written unless --write is passed.
 *
 * Usage:
 *   node scripts/recompose.mjs projects/<id>.json
 *   node scripts/recompose.mjs projects/<id>.json --write
 */

import './../src/load-env.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeV2CompositionPrompt, parseV2CompositionResponse, V2_COMPOSITION_SCHEMA } from '../src/caption-utils.js';
import { buildCompositions, REFERENCE_SECONDS_PER_EMPHASIS } from '../src/composition-engine.js';
import { composeInChunks } from '../src/compose-chunks.js';
import { countUnromanised } from '../src/caption-utils.js';
import { callGeminiApi } from '../src/gemini.js';
import { callGeminiWeb } from '../src/gemini-web.js';

const file = process.argv[2];
const write = process.argv.includes('--write');

if (!file) {
  console.error('Usage: node scripts/recompose.mjs projects/<id>.json [--write]');
  process.exit(2);
}

async function compose(prompt, schema = V2_COMPOSITION_SCHEMA) {
  if (process.env.GEMINI_API_KEY) {
    try {
      const result = await callGeminiApi(prompt, {
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_API_MODEL,
        base: process.env.GEMINI_API_BASE,
        schema
      });
      return { text: result.text, via: `API (${process.env.GEMINI_API_MODEL || 'default model'})` };
    } catch (err) {
      console.warn(`  API call failed (${err.message}); falling back to the web session.`);
    }
  }
  const text = await callGeminiWeb(prompt, {
    cookies: process.env.GEMINI_COOKIES,
    sapisid: process.env.GEMINI_SAPISID
  });
  return { text, via: 'gemini.google.com session' };
}

function pacing(compositions, tokens) {
  const marked = compositions.filter(c => c.comp_type === 'emphasis' || c.comp_type === 'spotlight');
  const span = (Math.max(...compositions.map(c => c.end_ms))
    - Math.min(...compositions.map(c => c.start_ms))) / 1000;
  const textFor = new Map(tokens.map(t => [t.id, String(t.text || '').trim()]));

  const indices = compositions
    .map((c, i) => (c.comp_type !== 'plain' ? i : -1))
    .filter(i => i >= 0);
  let closest = Infinity;
  for (let i = 1; i < indices.length; i++) closest = Math.min(closest, indices[i] - indices[i - 1]);

  return {
    lines: compositions.length,
    span,
    count: marked.length,
    per: marked.length ? span / marked.length : Infinity,
    closest,
    words: marked.map(c => textFor.get(c.hero_token_id)).filter(Boolean)
  };
}

const project = JSON.parse(await readFile(file, 'utf-8'));
const tokens = project.tokens || [];
if (!tokens.length) {
  console.error('That project has no transcript to compose.');
  process.exit(1);
}

const beforePacing = pacing(project.compositions || [], tokens);

console.log(`\n  ${path.basename(file)} — ${tokens.length} words, ${beforePacing.span.toFixed(1)}s`);
console.log(`  reference pacing: one emphasised word every ${REFERENCE_SECONDS_PER_EMPHASIS}s\n`);
console.log(`  as saved:  ${beforePacing.lines} lines, ${beforePacing.count} emphasised, ` +
  `one every ${beforePacing.per.toFixed(1)}s, closest pair ${beforePacing.closest} lines apart`);
console.log(`             ${beforePacing.words.join(', ')}\n`);

const language = { label: 'English + Urdu (Roman Urdu output)', romanize: true };
const probe = makeV2CompositionPrompt(tokens, { language });
const budgetLine = probe.split('\n').find(l => l.includes('Mark AT MOST'));
console.log(`  whole transcript as one prompt: ${(probe.length / 1024).toFixed(1)}KB`);
console.log(`  prompt says: ${budgetLine ? budgetLine.trim() : '(no budget line)'}\n`);

const beforeScript = countUnromanised(tokens);
console.log(`  before: ${beforeScript.remaining} of ${beforeScript.total} words in their original script\n`);

console.log('  composing in chunks...');
const composed = await composeInChunks(
  tokens,
  {
    callComposer: (prompt, schema) => compose(prompt, schema).then(r => r.text),
    makePrompt: makeV2CompositionPrompt,
    parseResponse: parseV2CompositionResponse,
    schema: V2_COMPOSITION_SCHEMA
  },
  {
    language,
    onProgress: (p) => {
      if (p.failed) console.log(`    chunk ${p.chunk}/${p.of} (${p.words} words) FAILED: ${p.error}`);
      else if (p.error) console.log(`    chunk ${p.chunk}/${p.of} attempt ${p.attempt} failed: ${p.error}`);
      else console.log(`    chunk ${p.chunk}/${p.of} (${p.words} words) -> ${p.lines} lines`);
    }
  }
);

const afterScript = countUnromanised(composed.tokens);
console.log(`\n  after: ${afterScript.remaining} of ${afterScript.total} words in their original script`);
console.log(`  ${composed.chunks} chunks, ${composed.failedRanges.length} failed`);
if (composed.failedRanges.length) {
  for (const range of composed.failedRanges) {
    console.log(`    words ${range.from}–${range.to} (${range.words} words) grouped by pause`);
  }
}
console.log('');

const parsed = { compositions: composed.compositions };
tokens.length = 0;
tokens.push(...composed.tokens);
const rebuilt = buildCompositions(tokens, { compositions: parsed.compositions });
const afterPacing = pacing(rebuilt, tokens);

console.log(`  ${parsed.compositions.length} lines returned across ${composed.chunks} chunks\n`);
const returnedEmphasis = parsed.compositions.filter(c => c.comp_type === 'emphasis' || c.comp_type === 'spotlight').length;
console.log(`  composer marked ${returnedEmphasis} of ${parsed.compositions.length} lines for emphasis`);
console.log(`  after enforcement: ${afterPacing.lines} lines, ${afterPacing.count} emphasised, ` +
  `one every ${afterPacing.per.toFixed(1)}s, closest pair ${afterPacing.closest} lines apart`);
console.log(`             ${afterPacing.words.join(', ')}`);

const duplicates = afterPacing.words.filter((w, i, all) =>
  all.findIndex(x => x.toLowerCase() === w.toLowerCase()) !== i);
console.log(`\n  repeated emphasis words: ${duplicates.length ? duplicates.join(', ') : 'none'}`);

if (write) {
  await writeFile(file, JSON.stringify({ ...project, compositions: rebuilt }, null, 2));
  console.log(`\n  written back to ${file}\n`);
} else {
  console.log('\n  nothing written — pass --write to save this over the project\n');
}
