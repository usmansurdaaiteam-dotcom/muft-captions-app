/**
 * composition-engine.js
 *
 * Turns a flat list of transcribed words into caption compositions: groups of
 * words, each with one word marked as the hero and a type saying how the line
 * should be presented.
 *
 * A composition's `comp_type` is the whole basis of pacing:
 *   plain     — every word in the base style, nothing picked out
 *   emphasis  — the hero word large and coloured, support words around it
 *   spotlight — the hero word alone
 *
 * How often emphasis fires is what makes or breaks the look, so it is enforced
 * here rather than left to whatever the composer returned. See
 * enforceEmphasisBudget.
 */

// ─── Emphasis pacing ────────────────────────────────────────────────────────────

/**
 * One emphasised word per this many seconds of speech.
 *
 * Measured from the reference style by scanning every frame of a clip for the
 * hero colour: six hero words across twenty-six seconds. Budgeting against time
 * rather than against a share of lines matters, because fast speech is cut into
 * many more lines and a percentage target quietly turns into a flood.
 */
export const REFERENCE_SECONDS_PER_EMPHASIS = 4.3;

/**
 * Plain lines required between two emphasised lines.
 *
 * One, not two. The reference does place emphasis close together when the
 * content is parallel — it lands "JACK" and then "MASTER" about a second apart
 * for "jack of all trades, master of none" — so a wider gap is stricter than
 * what is being copied and pushes the overall rate well below it. What has to be
 * prevented is a wall of highlights, and the time budget above already does that.
 */
export const MIN_PLAIN_BETWEEN_EMPHASIS = 1;

/** Lowest heroScore that may be emphasised at all. */
const MIN_HERO_SCORE = 1;

const EMPHATIC_TYPES = new Set(['emphasis', 'spotlight']);
const COMP_TYPES = new Set(['emphasis', 'plain', 'spotlight']);

/**
 * Words that carry no weight of their own. Emphasising one is the clearest sign
 * that a highlight was placed by position rather than by meaning. Covers English
 * and the Roman Urdu the transcript is romanised into.
 */
const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'if', 'then', 'than', 'as', 'at',
  'by', 'for', 'from', 'in', 'into', 'of', 'on', 'to', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'have', 'has', 'had',
  'i', 'me', 'my', 'you', 'your', 'he', 'she', 'it', 'we', 'they', 'them',
  'this', 'that', 'these', 'those', 'there', 'here', 'what', 'which', 'who',
  'will', 'would', 'can', 'could', 'should', 'just', 'very', 'really', 'like',
  'ok', 'okay', 'yeah', 'yes', 'no', 'not', 'now', 'also', 'about', 'up', 'out',
  'hai', 'hain', 'tha', 'thi', 'the', 'ho', 'hota', 'hoti', 'karna', 'karta',
  'ki', 'ka', 'ke', 'ko', 'se', 'me', 'mein', 'par', 'aur', 'ya', 'to', 'bhi',
  'yeh', 'ye', 'woh', 'wo', 'main', 'hum', 'aap', 'tum', 'kya', 'kyun', 'kaise',
  'phir', 'abhi', 'bas', 'toh', 'na', 'nahi', 'acha', 'matlab'
]);

const wordKey = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * How well a word carries a highlight, from the signals available without a
 * language model: what kind of word it is, how long the speaker spent on it, and
 * whether they paused after it.
 *
 * Used to choose which lines keep their emphasis when there are more than the
 * budget allows, and to place emphasis at all when there is no composer output
 * to work from.
 */
function heroScore(compTokens, heroToken, gapAfterMs) {
  const text = String(heroToken.text || '').trim();
  const key = wordKey(text);
  if (!key) return -Infinity;

  let score = 0;

  // A number, price or year is almost always the point of the sentence.
  if (/\d/.test(text)) score += 4;
  // Longer words carry more meaning; single syllables rarely deserve the size.
  if (key.length >= 8) score += 2;
  else if (key.length >= 5) score += 1;
  if (FILLER_WORDS.has(key)) score -= 6;

  // A word the speaker lingered on, or landed on before a pause, is a word they
  // were emphasising themselves.
  const durationMs = Math.max(0, (heroToken.end_ms || 0) - (heroToken.start_ms || 0));
  if (durationMs >= 420) score += 2;
  else if (durationMs >= 260) score += 1;
  if (gapAfterMs >= 400) score += 2;
  else if (gapAfterMs >= 220) score += 1;

  // A hero surrounded by nothing has no support text to play against.
  if (compTokens.length >= 3) score += 1;

  return score;
}

/**
 * Hold the emphasis rate to the reference, whatever the composer returned.
 *
 * The prompt asks for a budget, but a prompt is a request and this is the
 * guarantee. Two directions:
 *
 *   - Over budget: the weakest emphasis lines are demoted to plain. Strength is
 *     scored from the hero word itself, so what survives is the numbers, names
 *     and payoff words rather than whichever lines happened to come first.
 *   - No emphasis at all: the best-scoring lines are promoted up to the budget.
 *     Without this an emphasis template renders every line plain and looks
 *     broken — which is exactly what happens on the fallback path, where there
 *     is no composer output to carry a type at all.
 *
 * A composer that returns *some* emphasis under budget is left alone: choosing
 * three moments where six were allowed is an editorial judgement worth keeping.
 *
 * Spacing and repetition are enforced in both directions: never two emphasised
 * lines within MIN_PLAIN_BETWEEN_EMPHASIS of each other, and never the same word
 * emphasised twice in one clip.
 */
export function enforceEmphasisBudget(compositions, tokens, options = {}) {
  if (!Array.isArray(compositions) || compositions.length === 0) return compositions;

  const secondsPer = options.secondsPerEmphasis || REFERENCE_SECONDS_PER_EMPHASIS;
  const minGap = options.minPlainBetween === undefined
    ? MIN_PLAIN_BETWEEN_EMPHASIS
    : options.minPlainBetween;

  const spanMs = Math.max(...compositions.map(c => c.end_ms || 0))
    - Math.min(...compositions.map(c => c.start_ms || 0));
  const budget = Math.max(1, Math.round(spanMs / 1000 / secondsPer));

  const tokenMap = new Map((tokens || []).map(t => [t.id, t]));
  const gapAfter = new Map();
  for (let i = 0; i < (tokens || []).length; i++) {
    const next = tokens[i + 1];
    gapAfter.set(tokens[i].id, next ? Math.max(0, next.start_ms - tokens[i].end_ms) : Infinity);
  }

  const scored = compositions.map((comp, index) => {
    const compTokens = (comp.token_ids || []).map(id => tokenMap.get(id)).filter(Boolean);
    const hero = tokenMap.get(comp.hero_token_id);
    return {
      index,
      wasEmphatic: EMPHATIC_TYPES.has(comp.comp_type),
      word: hero ? wordKey(hero.text) : '',
      score: hero ? heroScore(compTokens, hero, gapAfter.get(hero.id) || 0) : -Infinity
    };
  });

  const alreadyEmphatic = scored.filter(s => s.wasEmphatic);
  // Promote only when there is nothing to trim — see the note above.
  const pool = alreadyEmphatic.length ? alreadyEmphatic : scored;

  const chosen = [];
  const usedWords = new Set();
  for (const candidate of [...pool].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (chosen.length >= budget) break;
    // Spacing usually binds before the budget does, which leaves only a few
    // legal positions. Without a floor, a line whose hero is a filler word gets
    // emphasised simply because it was the last slot that fitted. Leaving the
    // budget unspent is always better than pointing at "the" or "aap".
    if (candidate.score < MIN_HERO_SCORE) continue;
    if (candidate.word && usedWords.has(candidate.word)) continue;
    if (chosen.some(c => Math.abs(c.index - candidate.index) <= minGap)) continue;
    chosen.push(candidate);
    if (candidate.word) usedWords.add(candidate.word);
  }

  const keep = new Set(chosen.map(c => c.index));
  return compositions.map((comp, index) => {
    const shouldEmphasise = keep.has(index);
    const isEmphatic = EMPHATIC_TYPES.has(comp.comp_type);
    if (shouldEmphasise === isEmphatic) return comp;
    if (!shouldEmphasise) return { ...comp, comp_type: 'plain' };
    // A promoted single-word line reads better alone than as a hero with no
    // support text around it.
    return { ...comp, comp_type: (comp.token_ids || []).length === 1 ? 'spotlight' : 'emphasis' };
  });
}

// ─── Line breaks ────────────────────────────────────────────────────────────────

/**
 * A pause this long is a clause or sentence boundary. A caption line that runs
 * across one reads as though it were cut to fit rather than written.
 */
export const PAUSE_BREAK_MS = 300;

/** More words than a viewer takes in at a glance. */
export const MAX_WORDS_PER_LINE = 8;

/**
 * Split a run that is still too long, at its widest internal pause.
 *
 * Ties are broken toward the middle: splitting a nine-word run into eight and
 * one leaves a line that flashes past, so a slightly narrower gap nearer the
 * centre is the better break.
 */
function splitLongRun(run) {
  if (run.length <= MAX_WORDS_PER_LINE) return [run];

  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let i = 1; i < run.length; i++) {
    const gap = Math.max(0, run[i].start_ms - run[i - 1].end_ms);
    const balance = 1 - Math.abs(i - run.length / 2) / (run.length / 2);
    const score = gap + balance * 150;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return [...splitLongRun(run.slice(0, bestIndex)), ...splitLongRun(run.slice(bestIndex))];
}

/**
 * Break lines where the speech breaks, whatever the composer returned.
 *
 * The prompt asks for this and the answer varies run to run: composed live
 * against a real 32-second transcript, the model returned lines averaging 6.2
 * words with five over eight words and two running straight through a pause.
 * None of that is visible in a still frame — it shows up only as captions that
 * feel slightly wrong to watch — so it is worth settling here rather than hoping.
 *
 * A split line keeps the composer's hero if it still contains it, and otherwise
 * takes its longest word as a placeholder; enforceEmphasisBudget rescores every
 * candidate afterwards, so this only has to be reasonable, not final.
 */
export function enforceLineBreaks(compositions, tokens) {
  if (!Array.isArray(compositions) || !compositions.length) return compositions;

  const tokenMap = new Map((tokens || []).map(t => [t.id, t]));
  const out = [];

  for (const comp of compositions) {
    const compTokens = (comp.token_ids || []).map(id => tokenMap.get(id)).filter(Boolean);
    if (!compTokens.length) continue;

    // First break at every real pause, then thin any run still over length.
    const runs = [];
    let run = [compTokens[0]];
    for (let i = 1; i < compTokens.length; i++) {
      if (compTokens[i].start_ms - compTokens[i - 1].end_ms >= PAUSE_BREAK_MS) {
        runs.push(run);
        run = [];
      }
      run.push(compTokens[i]);
    }
    runs.push(run);

    const pieces = runs.flatMap(splitLongRun);

    for (const piece of pieces) {
      const hero = piece.find(t => t.id === comp.hero_token_id)
        || piece.reduce((best, t) => (t.text.trim().length > best.text.trim().length ? t : best), piece[0]);
      const heroIdx = piece.indexOf(hero);

      out.push({
        ...comp,
        id: out.length + 1,
        token_ids: piece.map(t => t.id),
        hero_token_id: hero.id,
        before_token_ids: piece.slice(0, heroIdx).map(t => t.id),
        after_token_ids: piece.slice(heroIdx + 1).map(t => t.id),
        hero_text: hero.text.trim(),
        before_text: joinTexts(piece.slice(0, heroIdx)),
        after_text: joinTexts(piece.slice(heroIdx + 1)),
        // Only the piece that kept the composer's own hero keeps its type; the
        // rest start plain and have to earn emphasis from the budget pass.
        comp_type: piece.includes(tokenMap.get(comp.hero_token_id)) ? comp.comp_type : 'plain',
        start_ms: piece[0].start_ms,
        end_ms: piece[piece.length - 1].end_ms,
        tokens: piece
      });
    }
  }

  return out;
}

// ─── Build compositions from composer output ───────────────────────────────────

/**
 * Merge the composer's grouping with the transcribed tokens.
 *
 * @param {Array} tokens words with ids and timestamps
 * @param {Object} composerOutput { compositions: [{ token_ids, hero_token_id, comp_type }] }
 * @returns {Array} compositions ready to render
 */
export function buildCompositions(tokens, composerOutput) {
  const tokenMap = new Map(tokens.map(t => [t.id, t]));
  const compositions = [];

  if (!composerOutput?.compositions?.length) {
    return buildFallbackCompositions(tokens);
  }

  for (const comp of composerOutput.compositions) {
    const compTokens = (comp.token_ids || [])
      .map(id => tokenMap.get(id))
      .filter(Boolean);

    if (!compTokens.length) continue;

    const heroIdx = compTokens.findIndex(t => t.id === comp.hero_token_id);
    const validHeroIdx = heroIdx >= 0 ? heroIdx : Math.floor(compTokens.length / 2);

    const beforeTokens = compTokens.slice(0, validHeroIdx);
    const heroToken = compTokens[validHeroIdx];
    const afterTokens = compTokens.slice(validHeroIdx + 1);

    compositions.push({
      id: compositions.length + 1,
      token_ids: compTokens.map(t => t.id),
      hero_token_id: heroToken.id,
      before_token_ids: beforeTokens.map(t => t.id),
      after_token_ids: afterTokens.map(t => t.id),
      hero_text: heroToken.text.trim(),
      before_text: joinTexts(beforeTokens),
      after_text: joinTexts(afterTokens),
      // Plain is the default when the composer did not say. Defaulting to
      // emphasis meant a composer that omitted the field shouted every line.
      comp_type: COMP_TYPES.has(comp.comp_type) ? comp.comp_type : 'plain',
      start_ms: compTokens[0].start_ms,
      end_ms: compTokens[compTokens.length - 1].end_ms,
      tokens: compTokens
    });
  }

  return enforceEmphasisBudget(enforceLineBreaks(compositions, tokens), tokens);
}

/**
 * Group tokens into lines without a composer, by breaking at speech pauses.
 *
 * Used when composition is unavailable or fails. The result is plainer than a
 * composed transcript but it is still watchable, and enforceEmphasisBudget gives
 * it emphasis at the reference rate so an emphasis template still works.
 */
export function buildFallbackCompositions(tokens) {
  const compositions = [];
  let group = [];

  const flush = () => {
    if (!group.length) return;
    // Longest word as hero: a rough stand-in for "most significant", and the
    // budget pass rescores it properly before anything is emphasised.
    let heroIdx = 0;
    let maxLen = 0;
    for (let i = 0; i < group.length; i++) {
      if (group[i].text.trim().length > maxLen) {
        maxLen = group[i].text.trim().length;
        heroIdx = i;
      }
    }

    const beforeTokens = group.slice(0, heroIdx);
    const heroToken = group[heroIdx];
    const afterTokens = group.slice(heroIdx + 1);

    compositions.push({
      id: compositions.length + 1,
      token_ids: group.map(t => t.id),
      hero_token_id: heroToken.id,
      before_token_ids: beforeTokens.map(t => t.id),
      after_token_ids: afterTokens.map(t => t.id),
      hero_text: heroToken.text.trim(),
      before_text: joinTexts(beforeTokens),
      after_text: joinTexts(afterTokens),
      comp_type: 'plain',
      start_ms: group[0].start_ms,
      end_ms: group[group.length - 1].end_ms,
      tokens: [...group]
    });
    group = [];
  };

  for (const token of tokens) {
    if (group.length > 0) {
      const gap = token.start_ms - group[group.length - 1].end_ms;
      if (gap >= PAUSE_BREAK_MS || group.length >= MAX_WORDS_PER_LINE) {
        flush();
      }
    }
    group.push(token);
  }
  flush();

  return enforceEmphasisBudget(enforceLineBreaks(compositions, tokens), tokens);
}

/**
 * Recompute a composition after the user picks a different hero word.
 * Returns a new composition with updated before/after splits.
 */
export function recomputeComposition(composition, newHeroTokenId, tokens) {
  const tokenMap = new Map(tokens.map(t => [t.id, t]));
  const compTokens = composition.token_ids
    .map(id => tokenMap.get(id))
    .filter(Boolean);

  const heroIdx = compTokens.findIndex(t => t.id === newHeroTokenId);
  if (heroIdx < 0) return composition;

  const beforeTokens = compTokens.slice(0, heroIdx);
  const heroToken = compTokens[heroIdx];
  const afterTokens = compTokens.slice(heroIdx + 1);

  return {
    ...composition,
    hero_token_id: newHeroTokenId,
    before_token_ids: beforeTokens.map(t => t.id),
    after_token_ids: afterTokens.map(t => t.id),
    hero_text: heroToken.text.trim(),
    before_text: joinTexts(beforeTokens),
    after_text: joinTexts(afterTokens)
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function joinTexts(tokens) {
  return tokens.map(t => (t.text || '').trim()).filter(Boolean).join(' ');
}
