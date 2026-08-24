/**
 * compose-chunks.js
 *
 * Composes a transcript in pieces instead of all at once.
 *
 * Why: one request for a whole transcript stops working as the video gets
 * longer, and it fails in the worst way — the reply comes back truncated, so it
 * is not valid JSON, so parsing throws, so the whole thing falls back to
 * pause-grouping with no transliteration. A 242-word clip composed fine on a
 * 35KB prompt; a 729-word one sent a 96KB prompt and got 2KB of an answer back,
 * twice. Nothing about that says "too long" — it just looks like a parse error.
 *
 * So the transcript is cut into pieces small enough that each reply arrives
 * whole, and each piece is composed on its own. Two things matter about how:
 *
 *   Pieces break at the longest pause near the boundary, never mid-sentence, so
 *   the composer always sees complete thoughts.
 *
 *   A piece that fails does not take the rest down. Its words are grouped by
 *   pause so they still have lines, and everything else keeps its proper
 *   composition. One bad reply costing only its own stretch beats it costing
 *   the whole video.
 *
 * Emphasis pacing and line breaks are deliberately not applied here. They are
 * global properties — one emphasised word every few seconds across the whole
 * clip — so they are enforced once, afterwards, over the joined result.
 */

import { PAUSE_BREAK_MS, MAX_WORDS_PER_LINE } from './composition-engine.js';

/** Words per request. Small enough that a reply arrives whole. */
export const CHUNK_TARGET_WORDS = 140;

/** Never leave a piece this small; fold it into the one before instead. */
const MIN_CHUNK_WORDS = 40;

/**
 * Split tokens into runs of roughly CHUNK_TARGET_WORDS, preferring to break
 * where the speaker paused longest so no piece starts mid-sentence.
 */
export function splitIntoChunks(tokens, targetWords = CHUNK_TARGET_WORDS) {
  if (!Array.isArray(tokens) || tokens.length <= targetWords) {
    return tokens && tokens.length ? [tokens] : [];
  }

  const chunks = [];
  let start = 0;

  while (start < tokens.length) {
    const remaining = tokens.length - start;
    if (remaining <= targetWords + MIN_CHUNK_WORDS) {
      chunks.push(tokens.slice(start));
      break;
    }

    // Look for the longest pause in a window around the target, so the break
    // lands on a real boundary rather than an arbitrary word count.
    const ideal = start + targetWords;
    const from = Math.max(start + MIN_CHUNK_WORDS, ideal - 30);
    const to = Math.min(tokens.length - 1, ideal + 30);

    let bestIndex = ideal;
    let bestGap = -1;
    for (let i = from; i <= to; i++) {
      const gap = tokens[i].start_ms - tokens[i - 1].end_ms;
      if (gap > bestGap) {
        bestGap = gap;
        bestIndex = i;
      }
    }

    chunks.push(tokens.slice(start, bestIndex));
    start = bestIndex;
  }

  return chunks;
}

/**
 * Give uncovered words lines of their own, grouped at pauses.
 *
 * A failed chunk would otherwise vanish from the video: buildCompositions only
 * emits lines for the compositions it is given. Grouping here is intentionally
 * plain — no emphasis budget — so the caller can enforce pacing once over the
 * whole clip rather than per leftover stretch.
 */
export function fillUncovered(tokens, compositions) {
  const covered = new Set((compositions || []).flatMap(c => c.token_ids || []));
  const orphans = (tokens || []).filter(t => !covered.has(t.id));
  if (!orphans.length) return compositions || [];

  const extras = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    extras.push({
      token_ids: group.map(t => t.id),
      hero_token_id: group[Math.floor(group.length / 2)].id,
      comp_type: 'plain'
    });
    group = [];
  };

  for (const token of orphans) {
    if (group.length) {
      const gap = token.start_ms - group[group.length - 1].end_ms;
      if (gap >= PAUSE_BREAK_MS || group.length >= MAX_WORDS_PER_LINE) flush();
    }
    group.push(token);
  }
  flush();

  const startOf = (comp) => {
    const firstId = (comp.token_ids || [])[0];
    const first = tokens.find(t => t.id === firstId);
    return first ? first.start_ms : 0;
  };

  return [...compositions, ...extras].sort((a, b) => startOf(a) - startOf(b));
}

/**
 * Compose every chunk and join the results.
 *
 * @param {Array}    tokens        the whole transcript
 * @param {object}   deps          { callComposer, makePrompt, parseResponse, schema }
 * @param {object}   options       { language, preserveTerms, attemptsPerChunk, onProgress }
 * @returns {Promise<{tokens, compositions, chunks, failedRanges}>}
 */
export async function composeInChunks(tokens, deps, options = {}) {
  const { callComposer, makePrompt, parseResponse, schema } = deps;
  const attempts = options.attemptsPerChunk || 2;
  const onProgress = options.onProgress || (() => {});

  const chunks = splitIntoChunks(tokens, options.targetWords);
  const textById = new Map(tokens.map(t => [t.id, t.text]));
  const compositions = [];
  const failedRanges = [];

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    let composed = null;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts && !composed; attempt++) {
      try {
        const prompt = makePrompt(chunk, {
          language: options.language,
          preserveTerms: options.preserveTerms
        });
        const reply = await callComposer(prompt, schema);
        const parsed = parseResponse(reply, chunk);
        if (!parsed || !Array.isArray(parsed.compositions) || !parsed.compositions.length) {
          throw new Error('the reply contained no compositions');
        }
        composed = parsed;
      } catch (err) {
        lastError = err;
        onProgress({
          chunk: index + 1,
          of: chunks.length,
          words: chunk.length,
          attempt,
          error: err.message
        });
      }
    }

    if (!composed) {
      failedRanges.push({ from: chunk[0].id, to: chunk[chunk.length - 1].id, words: chunk.length });
      onProgress({ chunk: index + 1, of: chunks.length, words: chunk.length, failed: true, error: lastError?.message });
      continue;
    }

    // Keep the composer's cleaned text for this chunk's words only, so a chunk
    // cannot rewrite words belonging to another.
    for (const token of composed.tokens || []) {
      if (textById.has(token.id)) textById.set(token.id, token.text);
    }

    // Only keep compositions whose words really belong to this chunk; a composer
    // that invents an id would otherwise pull in words from elsewhere.
    const chunkIds = new Set(chunk.map(t => t.id));
    for (const comp of composed.compositions) {
      const ids = (comp.token_ids || []).filter(id => chunkIds.has(id));
      if (!ids.length) continue;
      compositions.push({ ...comp, token_ids: ids });
    }

    onProgress({ chunk: index + 1, of: chunks.length, words: chunk.length, lines: composed.compositions.length });
  }

  const updatedTokens = tokens.map(t => ({ ...t, text: textById.get(t.id) ?? t.text }));

  return {
    tokens: updatedTokens,
    compositions: fillUncovered(updatedTokens, compositions),
    chunks: chunks.length,
    failedRanges
  };
}
