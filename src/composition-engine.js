/**
 * composition-engine.js
 * 
 * Core engine for building, editing, and rendering caption compositions.
 * A composition = a group of tokens (words) with one hero word, a layout,
 * and per-word timing from Soniox.
 */

// ─── Layout Definitions ────────────────────────────────────────────────────────
// Each layout defines how to position hero + before + after word groups
// on a 1080×1920 canvas. All positions are in pixels.

const CANVAS_W = 1080;
const CANVAS_H = 1920;
const CENTER_X = CANVAS_W / 2;
// Caption zone: roughly 40-60% down the vertical frame
const CAPTION_CENTER_Y = Math.round(CANVAS_H * 0.52);

export const LAYOUTS = {
  hero_only: {
    id: 'hero_only',
    name: 'Hero Only',
    description: 'Single hero word, centered.',
    resolve(heroText, beforeText, afterText) {
      return {
        hero:   { x: CENTER_X, y: CAPTION_CENTER_Y, anchor: 'center' },
        before: beforeText ? { x: CENTER_X, y: CAPTION_CENTER_Y - 90, anchor: 'center' } : null,
        after:  afterText  ? { x: CENTER_X, y: CAPTION_CENTER_Y + 90, anchor: 'center' } : null
      };
    }
  },

  stack_center: {
    id: 'stack_center',
    name: 'Stacked Center',
    description: 'Before words above, hero center, after words below.',
    resolve(heroText, beforeText, afterText) {
      return {
        before: beforeText ? { x: CENTER_X, y: CAPTION_CENTER_Y - 100, anchor: 'center' } : null,
        hero:   { x: CENTER_X, y: CAPTION_CENTER_Y, anchor: 'center' },
        after:  afterText  ? { x: CENTER_X, y: CAPTION_CENTER_Y + 100, anchor: 'center' } : null
      };
    }
  },

  before_left_after_right: {
    id: 'before_left_after_right',
    name: 'Left-Right Split',
    description: 'Before words left, hero center, after words right.',
    resolve(heroText, beforeText, afterText) {
      return {
        before: beforeText ? { x: CENTER_X - 40, y: CAPTION_CENTER_Y - 85, anchor: 'right' } : null,
        hero:   { x: CENTER_X, y: CAPTION_CENTER_Y + 10, anchor: 'center' },
        after:  afterText  ? { x: CENTER_X + 40, y: CAPTION_CENTER_Y + 95, anchor: 'left' } : null
      };
    }
  },

  hero_left_support_right: {
    id: 'hero_left_support_right',
    name: 'Hero Left',
    description: 'Hero word left-aligned, support words stacked right.',
    resolve(heroText, beforeText, afterText) {
      return {
        hero:   { x: CENTER_X - 120, y: CAPTION_CENTER_Y, anchor: 'center' },
        before: beforeText ? { x: CENTER_X + 160, y: CAPTION_CENTER_Y - 45, anchor: 'center' } : null,
        after:  afterText  ? { x: CENTER_X + 160, y: CAPTION_CENTER_Y + 45, anchor: 'center' } : null
      };
    }
  }
};

export const LAYOUT_IDS = Object.keys(LAYOUTS);
export const DEFAULT_LAYOUT = 'stack_center';

// ─── Glow Template ─────────────────────────────────────────────────────────────

export const GLOW_TEMPLATE = {
  id: 'glow',
  name: 'Muft Glow',
  description: 'Muft-style amber emphasis with neon glow, Inter Extra Bold, pop bounce.',
  hero: {
    color: '#f5b942',
    fontSize: 120,
    fontWeight: 800,
    fontFamily: "'Inter', 'Arial Black', sans-serif",
    uppercase: true,
    strokeColor: '#000000',
    strokeWidth: 5,
    // Multi-pass glow: draw shadow multiple times for a strong neon effect
    glowPasses: 3,
    glowBlur: 24,
    glowColor: 'rgba(245, 185, 66, 0.7)',
    shadowBlur: 30,
    shadowColor: 'rgba(245, 185, 66, 0.55)',
    animation: {
      type: 'pop_bounce',
      scaleFrom: 0.82,
      scalePeak: 1.15,
      scaleTo: 1.0,
      durationMs: 220,
      peakAtMs: 130
    }
  },
  support: {
    color: '#FFFFFF',
    fontSize: 46,
    fontWeight: 800,
    fontFamily: "'Inter', 'Arial Black', sans-serif",
    uppercase: false,
    strokeColor: '#000000',
    strokeWidth: 2,
    glowPasses: 0,
    glowBlur: 0,
    glowColor: 'transparent',
    shadowBlur: 8,
    shadowColor: 'rgba(0, 0, 0, 0.85)',
    animation: {
      type: 'fade_in',
      durationMs: 50,
      opacity: { from: 0, to: 1 }
    }
  }
};

// ─── Build Compositions from Gemini Output ─────────────────────────────────────

/**
 * Merge Gemini's composition suggestions with the raw Soniox tokens.
 * Gemini returns: { compositions: [ { token_ids, hero_token_id, layout_id } ] }
 * Each token has: { id, text, start_ms, end_ms, language }
 * 
 * @param {Array} tokens - Raw Soniox tokens with IDs and timestamps
 * @param {Object} geminiOutput - Parsed Gemini response
 * @returns {Array} Array of composition objects ready for rendering
 */
export function buildCompositions(tokens, geminiOutput) {
  const tokenMap = new Map(tokens.map(t => [t.id, t]));
  const compositions = [];

  if (!geminiOutput?.compositions?.length) {
    // Fallback: if Gemini fails, create simple compositions
    return buildFallbackCompositions(tokens);
  }

  for (const comp of geminiOutput.compositions) {
    const compTokens = (comp.token_ids || [])
      .map(id => tokenMap.get(id))
      .filter(Boolean);

    if (!compTokens.length) continue;

    const heroTokenId = comp.hero_token_id;
    const heroIdx = compTokens.findIndex(t => t.id === heroTokenId);
    const validHeroIdx = heroIdx >= 0 ? heroIdx : Math.floor(compTokens.length / 2);
    const actualHeroId = compTokens[validHeroIdx].id;

    const beforeTokens = compTokens.slice(0, validHeroIdx);
    const heroToken = compTokens[validHeroIdx];
    const afterTokens = compTokens.slice(validHeroIdx + 1);

    // comp_type from Gemini: 'emphasis' | 'plain' | 'spotlight'
    const compType = ['emphasis', 'plain', 'spotlight'].includes(comp.comp_type)
      ? comp.comp_type
      : 'emphasis'; // default if Gemini didn't provide

    compositions.push({
      id: compositions.length + 1,
      token_ids: compTokens.map(t => t.id),
      hero_token_id: actualHeroId,
      before_token_ids: beforeTokens.map(t => t.id),
      after_token_ids: afterTokens.map(t => t.id),
      hero_text: heroToken.text.trim(),
      before_text: joinTexts(beforeTokens),
      after_text: joinTexts(afterTokens),
      comp_type: compType,
      start_ms: compTokens[0].start_ms,
      end_ms: compTokens[compTokens.length - 1].end_ms,
      tokens: compTokens
    });
  }

  return compositions;
}

/**
 * Kalakar Emphasis Randomizer
 * 
 * Not every composition gets emphasis — that would be visually exhausting.
 * This randomizer assigns comp_type to each composition:
 *   - 'emphasis' (~65%): hero word + before/after support text
 *   - 'plain' (~27%): all white text, no hero, just readable captions
 *   - 'spotlight' (~8%): single hero word alone, big and centered
 * 
 * Rules:
 *   - Max 2 consecutive emphasis compositions
 *   - Single-word compositions become spotlight if selected for emphasis
 *   - First composition is always emphasis (strong opening)
 */
export function applyEmphasisRandomizer(compositions) {
  const EMPHASIS_RATE = 0.65;
  const SPOTLIGHT_RATE = 0.08;
  // remainder is plain

  let consecutiveEmphasis = 0;

  for (let i = 0; i < compositions.length; i++) {
    const comp = compositions[i];
    
    // First composition is always emphasis for a strong opening
    if (i === 0) {
      comp.comp_type = 'emphasis';
      consecutiveEmphasis = 1;
      continue;
    }

    const roll = Math.random();
    const isSingleWord = comp.token_ids.length === 1;

    if (consecutiveEmphasis >= 2) {
      // Force a break — plain text to give viewer breathing room
      comp.comp_type = 'plain';
      consecutiveEmphasis = 0;
    } else if (roll < SPOTLIGHT_RATE && isSingleWord) {
      // Spotlight: single hero word, centered, dramatic
      comp.comp_type = 'spotlight';
      consecutiveEmphasis = 0;
    } else if (roll < EMPHASIS_RATE) {
      // Emphasis: hero word with before/after support
      if (isSingleWord) {
        // Single-word comps look better as spotlight
        comp.comp_type = 'spotlight';
      } else {
        comp.comp_type = 'emphasis';
      }
      consecutiveEmphasis++;
    } else {
      // Plain: all white text, readable, no hero
      comp.comp_type = 'plain';
      consecutiveEmphasis = 0;
    }
  }

  return compositions;
}

/**
 * When Gemini fails or returns nothing, create simple compositions
 * by grouping tokens into phrases based on pauses.
 */
export function buildFallbackCompositions(tokens) {
  const PAUSE_THRESHOLD_MS = 400;
  const MAX_TOKENS_PER_GROUP = 8;
  const compositions = [];
  let group = [];

  const flush = () => {
    if (!group.length) return;
    // Pick the longest word as hero (simple heuristic)
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
    const layoutIdx = compositions.length % LAYOUT_IDS.length;

    compositions.push({
      id: compositions.length + 1,
      token_ids: group.map(t => t.id),
      hero_token_id: heroToken.id,
      before_token_ids: beforeTokens.map(t => t.id),
      after_token_ids: afterTokens.map(t => t.id),
      hero_text: heroToken.text.trim(),
      before_text: joinTexts(beforeTokens),
      after_text: joinTexts(afterTokens),
      layout_id: LAYOUT_IDS[layoutIdx],
      start_ms: group[0].start_ms,
      end_ms: group[group.length - 1].end_ms,
      tokens: [...group]
    });
    group = [];
  };

  for (const token of tokens) {
    if (group.length > 0) {
      const gap = token.start_ms - group[group.length - 1].end_ms;
      if (gap > PAUSE_THRESHOLD_MS || group.length >= MAX_TOKENS_PER_GROUP) {
        flush();
      }
    }
    group.push(token);
  }
  flush();

  return compositions;
}

/**
 * Recompute a composition when user changes the hero word.
 * Returns a new composition with updated before/after splits.
 */
export function recomputeComposition(composition, newHeroTokenId, tokens) {
  const tokenMap = new Map(tokens.map(t => [t.id, t]));
  const compTokens = composition.token_ids
    .map(id => tokenMap.get(id))
    .filter(Boolean);

  const heroIdx = compTokens.findIndex(t => t.id === newHeroTokenId);
  if (heroIdx < 0) return composition; // token not in this composition

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

/**
 * Resolve positions for a composition's visual elements.
 * Returns { hero, before, after } with x, y, anchor for each group.
 */
export function resolvePositions(composition) {
  const layout = LAYOUTS[composition.layout_id] || LAYOUTS[DEFAULT_LAYOUT];
  return layout.resolve(
    composition.hero_text,
    composition.before_text,
    composition.after_text
  );
}

/**
 * Get per-word render data for a composition.
 * Each word gets: text, x, y, startMs, endMs, isHero, style config
 * This is what both the browser preview and the canvas exporter consume.
 */
export function getWordRenderData(composition, tokens, template = GLOW_TEMPLATE) {
  const tokenMap = new Map(tokens.map(t => [t.id, t]));
  const positions = resolvePositions(composition);
  const words = [];
  const compositionEndMs = composition.end_ms;

  // Before words
  if (positions.before && composition.before_token_ids.length) {
    const beforeTokens = composition.before_token_ids.map(id => tokenMap.get(id)).filter(Boolean);
    for (const token of beforeTokens) {
      words.push({
        tokenId: token.id,
        text: token.text.trim(),
        groupPosition: positions.before,
        startMs: token.start_ms,
        endMs: compositionEndMs,
        isHero: false,
        style: template.support
      });
    }
  }

  // Hero word
  const heroToken = tokenMap.get(composition.hero_token_id);
  if (heroToken) {
    words.push({
      tokenId: heroToken.id,
      text: template.hero.uppercase ? heroToken.text.trim().toUpperCase() : heroToken.text.trim(),
      groupPosition: positions.hero,
      startMs: heroToken.start_ms,
      endMs: compositionEndMs,
      isHero: true,
      style: template.hero
    });
  }

  // After words
  if (positions.after && composition.after_token_ids.length) {
    const afterTokens = composition.after_token_ids.map(id => tokenMap.get(id)).filter(Boolean);
    for (const token of afterTokens) {
      words.push({
        tokenId: token.id,
        text: token.text.trim(),
        groupPosition: positions.after,
        startMs: token.start_ms,
        endMs: compositionEndMs,
        isHero: false,
        style: template.support
      });
    }
  }

  return words;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function joinTexts(tokens) {
  return tokens.map(t => (t.text || '').trim()).filter(Boolean).join(' ');
}

export const CANVAS_WIDTH = CANVAS_W;
export const CANVAS_HEIGHT = CANVAS_H;
