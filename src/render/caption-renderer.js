/**
 * caption-renderer.js
 *
 * The one and only caption renderer. Imported directly by the server exporter
 * and loaded as a module by the browser preview, so what you see in the editor
 * is drawn by the exact same code that burns the final MP4.
 *
 * Everything visual is driven by template data — no template's look is encoded
 * here. Adding a template means adding a data file, not editing this renderer.
 *
 * Two layout modes:
 *   karaoke — the whole phrase is on screen and the word being spoken is styled
 *             differently (highlight, pill, colour swap, unblur, ...).
 *   hero    — one chosen word renders large and centred with the surrounding
 *             words stacked above and below it.
 *
 * Templates are authored against a 1080x1920 design canvas and scaled to
 * whatever the render target is, so a template looks the same in the 9:16
 * preview and in a 4K export.
 */

import { applyStyleOverrides, recolorFill } from './style-overrides.js';

// ─── Design space ───────────────────────────────────────────────────────────────

export const DESIGN_WIDTH = 1080;
export const DESIGN_HEIGHT = 1920;

// ─── Colour helpers ─────────────────────────────────────────────────────────────

function parseColor(input) {
  const value = String(input || '#ffffff').trim();

  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255
      };
    }
    return {
      r: parseInt(hex.slice(0, 2), 16) || 0,
      g: parseInt(hex.slice(2, 4), 16) || 0,
      b: parseInt(hex.slice(4, 6), 16) || 0,
      a: 1
    };
  }

  const match = value.match(/rgba?\(([^)]+)\)/i);
  if (match) {
    const parts = match[1].split(',').map(p => parseFloat(p.trim()));
    return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts[3] === undefined ? 1 : parts[3] };
  }

  return { r: 255, g: 255, b: 255, a: 1 };
}

/** Same colour at a different alpha. Alpha multiplies any alpha already present. */
export function withAlpha(color, alpha) {
  const { r, g, b, a } = parseColor(color);
  const finalAlpha = Math.max(0, Math.min(1, a * (alpha === undefined ? 1 : alpha)));
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${finalAlpha})`;
}

/** Shift a colour toward white (amount > 0) or black (amount < 0). */
function shade(color, amount) {
  const { r, g, b, a } = parseColor(color);
  const mix = (channel) => amount >= 0
    ? Math.round(channel + (255 - channel) * amount)
    : Math.round(channel * (1 + amount));
  return `rgba(${mix(r)}, ${mix(g)}, ${mix(b)}, ${a})`;
}

// ─── Maths helpers ──────────────────────────────────────────────────────────────

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeOutQuad = t => 1 - (1 - t) * (1 - t);

/** Overshoot easing — settles just past the target then back, for "pop". */
function easeOutBack(t, overshoot = 1.7) {
  const c = overshoot + 1;
  return 1 + c * Math.pow(t - 1, 3) + overshoot * Math.pow(t - 1, 2);
}

// ─── Script detection ───────────────────────────────────────────────────────────

const ARABIC_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export function hasArabicScript(text) {
  return ARABIC_SCRIPT_RE.test(String(text || ''));
}

// ─── Text casing ────────────────────────────────────────────────────────────────

function applyCasing(text, casing) {
  switch (casing) {
    case 'upper': return text.toUpperCase();
    case 'lower': return text.toLowerCase();
    case 'title': return text.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    default: return text;
  }
}

// ─── Style resolution ───────────────────────────────────────────────────────────

/**
 * Neutral starting point. A template only needs to specify what differs, and
 * per-word state styles only need to specify what differs from the base.
 */
const DEFAULT_STYLE = {
  fill: { type: 'solid', color: '#FFFFFF' },
  sizeScale: 1,
  opacity: 1,
  blur: 0,
  scale: 1,
  offsetY: 0,
  stroke: null,
  shadow: null,
  glow: null,
  background: null
};

function mergeStyle(base, override) {
  if (!override) return base;
  const merged = { ...base, ...override };
  // Nested blocks merge rather than replace, so `active` can tweak one shadow
  // property without restating the whole shadow.
  for (const key of ['fill', 'stroke', 'shadow', 'glow', 'background']) {
    if (override[key] === null) {
      merged[key] = null;
    } else if (override[key] && base[key]) {
      merged[key] = { ...base[key], ...override[key] };
    }
  }
  return merged;
}

function resolveStyle(template, stateName) {
  const base = mergeStyle(DEFAULT_STYLE, template.word);
  if (stateName === 'base') return base;
  return mergeStyle(base, template[stateName]);
}

// ─── Animation ──────────────────────────────────────────────────────────────────

/**
 * Evaluate an entry animation.
 * Returns transform values applied around the word's own centre.
 */
export function evalAnimation(anim, elapsedMs) {
  const none = { scale: 1, opacity: 1, dx: 0, dy: 0 };
  if (!anim || !anim.type || anim.type === 'none') return none;

  const duration = Math.max(1, anim.durationMs || 220);
  const raw = clamp(elapsedMs / duration, 0, 1);
  if (raw >= 1) return none;

  const distance = anim.distance === undefined ? 60 : anim.distance;

  switch (anim.type) {
    case 'fade':
      return { ...none, opacity: easeOutQuad(raw) };

    case 'pop': {
      const from = anim.from === undefined ? 0.55 : anim.from;
      const t = easeOutBack(raw, anim.overshoot === undefined ? 2.2 : anim.overshoot);
      return { ...none, scale: from + (1 - from) * t, opacity: Math.min(1, raw * 3) };
    }

    case 'scale': {
      const from = anim.from === undefined ? 0.85 : anim.from;
      const t = easeOutCubic(raw);
      return { ...none, scale: from + (1 - from) * t, opacity: Math.min(1, raw * 3) };
    }

    case 'zoom': {
      const from = anim.from === undefined ? 1.8 : anim.from;
      const t = easeOutCubic(raw);
      return { ...none, scale: from + (1 - from) * t, opacity: easeOutQuad(raw) };
    }

    case 'slide_up':
      return { ...none, dy: (1 - easeOutCubic(raw)) * distance, opacity: easeOutQuad(raw) };
    case 'slide_down':
      return { ...none, dy: -(1 - easeOutCubic(raw)) * distance, opacity: easeOutQuad(raw) };
    case 'slide_left':
      return { ...none, dx: (1 - easeOutCubic(raw)) * distance, opacity: easeOutQuad(raw) };
    case 'slide_right':
      return { ...none, dx: -(1 - easeOutCubic(raw)) * distance, opacity: easeOutQuad(raw) };

    case 'float':
      // Drifts up into place and keeps a gentle bob afterwards.
      return { ...none, dy: (1 - easeOutCubic(raw)) * distance * 0.6, opacity: easeOutQuad(raw) };

    case 'flicker': {
      // Strobe a few times before settling — analogue/CRT feel.
      const flickers = anim.flickers === undefined ? 3 : anim.flickers;
      const phase = Math.floor(raw * flickers * 2);
      return { ...none, opacity: phase % 2 === 0 ? 0.15 : 1 };
    }

    case 'shake': {
      const amount = anim.amount === undefined ? 10 : anim.amount;
      const decay = 1 - raw;
      return {
        ...none,
        dx: Math.sin(raw * Math.PI * 8) * amount * decay,
        dy: Math.cos(raw * Math.PI * 6) * amount * decay * 0.6,
        scale: 1 + 0.12 * decay
      };
    }

    default:
      return none;
  }
}

/**
 * A short scale overshoot fired the moment a word becomes active, then settled
 * back. This is the punch that makes word-by-word captions feel alive; it is
 * deliberately transient so it never affects where anything sits.
 */
function activeKick(template, word, timeMs) {
  const pop = template.active && template.active.pop;
  if (!pop) return 1;
  const duration = Math.max(1, pop.durationMs || 180);
  const elapsed = timeMs - word.startMs;
  if (elapsed < 0 || elapsed > duration) return 1;
  // Rises to the peak and comes back to rest.
  const curve = Math.sin(Math.PI * (elapsed / duration));
  return 1 + ((pop.scale === undefined ? 1.15 : pop.scale) - 1) * curve;
}

/**
 * Progress of the transition into (or out of) the active state, 0..1.
 * Lets an active word grow/recolour smoothly instead of snapping.
 */
function activeBlend(template, word, timeMs) {
  const duration = Math.max(1, template.activeTransitionMs === undefined ? 90 : template.activeTransitionMs);
  if (timeMs < word.startMs) return 0;
  if (timeMs <= word.endMs) return clamp((timeMs - word.startMs) / duration, 0, 1);
  return clamp(1 - (timeMs - word.endMs) / duration, 0, 1);
}

function lerpStyle(from, to, t) {
  if (t <= 0) return from;
  if (t >= 1) return to;
  return {
    ...to,
    sizeScale: from.sizeScale + (to.sizeScale - from.sizeScale) * t,
    scale: from.scale + (to.scale - from.scale) * t,
    opacity: from.opacity + (to.opacity - from.opacity) * t,
    blur: from.blur + (to.blur - from.blur) * t
  };
}

// ─── Font strings ───────────────────────────────────────────────────────────────

/**
 * Injected by the host so the renderer stays free of environment-specific
 * font plumbing. Both the browser and the server pass in the same resolver
 * from src/render/fonts.js.
 */
let fontResolver = (family, weight, size) => `${weight} ${Math.round(size)}px sans-serif`;
let arabicResolver = null;

export function configureFonts({ fontString, arabicFontString }) {
  if (typeof fontString === 'function') fontResolver = fontString;
  if (typeof arabicFontString === 'function') arabicResolver = arabicFontString;
}

function fontFor(text, family, weight, size) {
  if (arabicResolver && hasArabicScript(text)) return arabicResolver(size);
  return fontResolver(family, weight, size);
}

// ─── Measurement & layout ───────────────────────────────────────────────────────

const layoutCache = new Map();
const LAYOUT_CACHE_LIMIT = 400;

export function clearLayoutCache() {
  layoutCache.clear();
  effectiveTemplateCache.clear();
}

function cacheGet(key) {
  return layoutCache.get(key);
}

function cacheSet(key, value) {
  if (layoutCache.size >= LAYOUT_CACHE_LIMIT) {
    // Cheap eviction: drop the oldest insertion.
    const oldest = layoutCache.keys().next().value;
    layoutCache.delete(oldest);
  }
  layoutCache.set(key, value);
  return value;
}

/**
 * Signature covering every template field that can change measured geometry.
 * Colours are deliberately excluded so recolouring never busts the cache.
 */
function layoutSignature(template) {
  const f = template.font || {};
  const l = template.layout || {};
  return [
    template.id, template.mode,
    f.family, f.weight, f.size, f.casing, f.letterSpacing, f.lineHeight,
    l.x, l.y, l.maxWidthPct, l.maxLines, l.align, l.reveal,
    (template.active && template.active.sizeScale) || 1,
    template.heroSizeScale, template.heroSupportSizeScale,
    template.heroCasing, template.heroSupportAlign, template.heroGapEm
  ].join('|');
}

/**
 * Whether this composition gets the hero treatment: one word large and styled,
 * the rest as supporting text. Only hero-mode templates do it, and only on the
 * lines the composer actually marked as carrying emphasis — a `plain` line in a
 * hero template is an ordinary subtitle with no highlighted word at all.
 */
function heroApplies(comp, template) {
  if (!template || template.mode !== 'hero') return false;
  const type = (comp && comp.comp_type) || 'emphasis';
  return type === 'emphasis' || type === 'spotlight';
}

/**
 * Style keys a single word may override, on top of whatever its line resolves
 * to. Deliberately small: everything here is either a pure paint change or
 * something the layout can account for exactly. Anything that would need its own
 * layout pass belongs at line level instead.
 */
const WORD_OVERRIDE_KEYS = ['color', 'sizeScale', 'fontFamily', 'fontWeight', 'casing'];

function wordOverrideFor(comp, tokenId) {
  const all = comp && comp.wordOverrides;
  if (!all) return null;
  const raw = all[tokenId] || all[String(tokenId)];
  if (!raw || typeof raw !== 'object') return null;
  let found = null;
  for (const key of WORD_OVERRIDE_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    found = found || {};
    found[key] = value;
  }
  return found;
}

/** Text for a token after casing, plus its timing and any per-word style. */
function displayWords(comp, tokenMap, template) {
  const casing = (template.font && template.font.casing) || 'none';
  // The hero word can be cased independently of the words around it, which is
  // how a template shouts one word in caps while the support text stays as
  // spoken.
  const heroCasing = template.heroCasing || casing;
  const heroStyled = heroApplies(comp, template);
  const ids = comp.token_ids || [];
  const words = [];
  for (const id of ids) {
    const token = tokenMap.get(id);
    if (!token) continue;
    const raw = String(token.text || '').trim();
    if (!raw) continue;
    const isHero = id === comp.hero_token_id;
    const override = wordOverrideFor(comp, id);
    const lineCasing = isHero && heroStyled ? heroCasing : casing;
    words.push({
      id,
      text: applyCasing(raw, (override && override.casing) || lineCasing),
      startMs: token.start_ms,
      endMs: token.end_ms,
      isHero,
      override,
      family: (override && override.fontFamily) || template.font.family,
      weight: (override && override.fontWeight) || template.font.weight,
      sizeScale: (override && Number(override.sizeScale)) || 1
    });
  }
  return words;
}

/**
 * How much room, in pixels either side of a word, must be left free so that the
 * word's *largest* state still fits without touching its neighbours.
 *
 * A word can grow (an active word with sizeScale > 1) and can gain a pill or
 * box background that extends past the glyphs. Laying out at the base size and
 * ignoring both is what makes highlighted words collide with the words next to
 * them, so the slack is reserved up front for every word.
 */
function wordSlack(template, glyphWidth, scale) {
  let maxSizeScale = 1;
  let maxPadX = 0;
  for (const state of ['word', 'active', 'pending', 'spoken']) {
    const style = template[state];
    if (!style) continue;
    if (style.sizeScale) maxSizeScale = Math.max(maxSizeScale, style.sizeScale);
    if (style.pop && style.pop.scale) {
      maxSizeScale = Math.max(maxSizeScale, (style.sizeScale || 1) * style.pop.scale);
    }
    const bg = style.background;
    if (bg && bg.enabled !== false) {
      maxPadX = Math.max(maxPadX, (bg.padX === undefined ? 18 : bg.padX) * scale);
    }
  }
  const growth = (glyphWidth * (maxSizeScale - 1)) / 2;
  return Math.max(growth, maxPadX);
}

/**
 * Greedy word wrap that shrinks the font until the text fits maxLines.
 * Prevents long phrases from overflowing the frame, which is otherwise the
 * most common way burnt-in captions get clipped.
 *
 * Each word carries the gap that precedes it, sized so that whichever word is
 * highlighted still clears its neighbours (see wordSlack).
 */
function wrapWords(ctx, words, template, fontSize, maxWidth, maxLines, scale) {
  const family = template.font.family;
  const weight = template.font.weight;
  const letterSpacing = (template.font.letterSpacing || 0) * scale;

  let size = fontSize;
  for (let attempt = 0; attempt < 14; attempt++) {
    const sizeRatio = size / fontSize;
    ctx.letterSpacing = `${letterSpacing * sizeRatio}px`;

    const measured = words.map(word => {
      // A word carrying its own font or size is measured at that font and size,
      // so a resized word takes the room it actually needs instead of
      // overlapping the words beside it.
      const wordSize = size * (word.sizeScale || 1);
      ctx.font = fontFor(word.text, word.family || family, word.weight || weight, wordSize);
      const width = ctx.measureText(word.text).width;
      return {
        ...word,
        width,
        slack: wordSlack(template, width, scale * sizeRatio),
        size: wordSize
      };
    });

    ctx.font = fontFor(' ', family, weight, size);
    const spaceWidth = ctx.measureText(' ').width || size * 0.28;

    // Only one word is highlighted at a time, so the clearance between two
    // neighbours only has to satisfy whichever of the two is currently active —
    // max of their slack, not the sum. Reserving both would leave the whole
    // line looking spaced out even though the extra room is never needed twice.
    const gapAfter = measured.map((word, idx) => {
      const next = measured[idx + 1];
      if (!next) return 0;
      // A highlight needs its slack *plus* a visible space, otherwise a pill or
      // marker background ends up flush against the word next to it.
      const needed = Math.max(word.slack, next.slack) + spaceWidth * 0.6;
      return Math.max(spaceWidth, needed);
    });

    // Keep room at the line ends so an edge highlight cannot be clipped.
    const edgeSlack = measured.reduce((max, w) => Math.max(max, w.slack), 0);
    const wrapWidth = Math.max(maxWidth * 0.4, maxWidth - edgeSlack * 2);

    const lines = [];
    let line = [];
    let lineWidth = 0;
    for (let idx = 0; idx < measured.length; idx++) {
      const word = measured[idx];
      const gap = line.length ? gapAfter[idx - 1] : 0;
      if (line.length && lineWidth + gap + word.width > wrapWidth) {
        lines.push({ words: line, width: lineWidth });
        line = [{ ...word, gapBefore: 0 }];
        lineWidth = word.width;
      } else {
        line.push({ ...word, gapBefore: gap });
        lineWidth += gap + word.width;
      }
    }
    if (line.length) lines.push({ words: line, width: lineWidth });

    const tooTall = lines.length > maxLines;
    const tooWide = lines.some(l => l.width > wrapWidth);
    if ((!tooTall && !tooWide) || size <= fontSize * 0.45) {
      ctx.letterSpacing = '0px';
      return { lines, spaceWidth, size };
    }
    size *= 0.93;
  }

  ctx.letterSpacing = '0px';
  return { lines: [], spaceWidth: 0, size };
}

/**
 * Compute the on-screen box for every word in a composition.
 * Cached, because export re-renders the same composition for every frame it
 * spans and re-measuring text thousands of times is the main cost.
 */
function layoutComposition(ctx, comp, tokenMap, template, width, height) {
  // Per-word overrides can change a word's font, size and casing, all of which
  // are measured, so they belong in the cache key.
  const wordSignature = comp.wordOverrides ? JSON.stringify(comp.wordOverrides) : '';
  const key = `${comp.id}:${layoutSignature(template)}:${Math.round(width)}x${Math.round(height)}:${(comp.token_ids || []).join(',')}:${comp.hero_token_id}:${comp.comp_type}:${wordSignature}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  // Sizes scale with the frame's shorter side rather than its width. Scaling by
  // width alone made text roughly three times larger relative to the frame on
  // landscape video than on vertical, and put the vertical anchor outside the
  // frame entirely, because the design canvas is 1080x1920.
  const scale = Math.min(width, height) / DESIGN_WIDTH;

  const words = displayWords(comp, tokenMap, template);
  if (!words.length) return cacheSet(key, { words: [], lines: [] });


  const layout = template.layout || {};
  const font = template.font || {};
  const compType = comp.comp_type || 'emphasis';

  const baseSize = (font.size || 72) * scale;
  // Horizontal extents follow the frame's width and the vertical anchor follows
  // its height, so a template lands in the same relative place at any aspect.
  const maxWidth = width * (layout.maxWidthPct === undefined ? 0.86 : layout.maxWidthPct);
  const maxLines = layout.maxLines === undefined ? 2 : layout.maxLines;
  const lineHeight = layout.lineHeight || font.lineHeight || 1.15;

  const centerX = width * (layout.x === undefined ? 0.5 : layout.x);
  const centerY = height * (layout.y === undefined ? 0.72 : layout.y);

  // Spotlight compositions collapse to the hero word alone, whatever the mode.
  const effectiveWords = compType === 'spotlight'
    ? words.filter(w => w.isHero).map(w => ({ ...w, isHero: true }))
    : words;

  const placed = [];
  const lineBoxes = [];

  if (heroApplies(comp, template) && compType === 'emphasis' && effectiveWords.some(w => w.isHero)) {
    placeHeroLayout(ctx, effectiveWords, template, baseSize, scale, maxWidth, centerX, centerY, placed);
  } else {
    placeKaraokeLayout(
      ctx, effectiveWords, template, baseSize, scale, maxWidth, maxLines,
      lineHeight, centerX, centerY, layout.align || 'center', placed, lineBoxes
    );
  }

  return cacheSet(key, { words: placed, lines: lineBoxes });
}

/** Standard subtitle block: wrapped lines centred on the anchor point. */
function placeKaraokeLayout(ctx, words, template, baseSize, scale, maxWidth, maxLines, lineHeight, centerX, centerY, align, out, lineBoxes) {
  // A lone spotlight word gets to fill much more of the frame.
  const spotlightScale = words.length === 1 && words[0].isHero ? 1.6 : 1;

  const { lines, spaceWidth, size } = wrapWords(
    ctx, words, template, baseSize * spotlightScale, maxWidth, maxLines, scale
  );

  // Line spacing follows the tallest word on the line rather than the line's
  // nominal size, so a word the user has enlarged does not collide with the line
  // above it.
  const lineSize = line => Math.max(size, ...line.words.map(w => w.size || size));
  const step = Math.max(...lines.map(lineSize), size) * lineHeight;
  const blockHeight = step * lines.length;
  let y = centerY - blockHeight / 2 + step / 2;

  for (const line of lines) {
    let cursor;
    if (align === 'left') cursor = centerX - maxWidth / 2;
    else if (align === 'right') cursor = centerX + maxWidth / 2 - line.width;
    else cursor = centerX - line.width / 2;

    const lineStart = cursor;
    for (const word of line.words) {
      cursor += word.gapBefore || 0;
      out.push({ ...word, x: cursor, y, lineIndex: lineBoxes.length });
      cursor += word.width;
    }
    lineBoxes.push({ x0: lineStart, x1: cursor, y, size: lineSize(line) });
    y += step;
  }
}

/**
 * Hero layout: the emphasised word large, the words spoken before it on a line
 * above and the words spoken after it on a line below.
 *
 * Geometry follows what the reference style actually does, measured frame by
 * frame: the hero is horizontally centred at a fixed size (it does not grow or
 * shrink to fill the width), the support lines align to the hero's left edge,
 * and the whole stack is centred on the vertical anchor — so the hero sits a
 * little lower when there are words above it and a little higher when there are
 * words below, rather than being pinned in place while the support text moves.
 *
 * The hero's size multiplier lives at the template level rather than in the
 * `active` style because layout has to know the real size to place the lines,
 * whereas `active.sizeScale` is an animated in-place effect applied at draw
 * time. Keeping them separate stops the two from multiplying together.
 */
function placeHeroLayout(ctx, words, template, baseSize, scale, maxWidth, centerX, centerY, out) {
  const family = template.font.family;
  const weight = template.font.weight;
  const heroScale = template.heroSizeScale === undefined ? 1.8 : template.heroSizeScale;
  const supportScale = template.heroSupportSizeScale === undefined ? 1 : template.heroSupportSizeScale;
  const supportAlign = template.heroSupportAlign || 'left';
  const gapEm = template.heroGapEm === undefined ? 0.16 : template.heroGapEm;

  const heroIdx = words.findIndex(w => w.isHero);
  const hero = words[heroIdx];
  const before = words.slice(0, heroIdx);
  const after = words.slice(heroIdx + 1);

  let heroSize = baseSize * heroScale;
  let supportSize = baseSize * supportScale;

  // The hero is authored at a fixed size and normally left to run wide, but a
  // long word still has to stay inside the frame, so shrink the whole stack
  // proportionally if it would not fit. Scaling the support text by the same
  // factor keeps the size relationship between them intact.
  const heroFamily = hero.family || family;
  const heroWeight = hero.weight || weight;
  heroSize *= hero.sizeScale || 1;

  ctx.font = fontFor(hero.text, heroFamily, heroWeight, heroSize);
  let heroWidth = ctx.measureText(hero.text).width;
  if (heroWidth > maxWidth) {
    const shrink = maxWidth / heroWidth;
    heroSize *= shrink;
    supportSize *= shrink;
    ctx.font = fontFor(hero.text, heroFamily, heroWeight, heroSize);
    heroWidth = ctx.measureText(hero.text).width;
  }

  ctx.font = fontFor(' ', family, weight, supportSize);
  const spaceWidth = ctx.measureText(' ').width || supportSize * 0.28;

  const measure = (list) => list.map(word => {
    const size = supportSize * (word.sizeScale || 1);
    ctx.font = fontFor(word.text, word.family || family, word.weight || weight, size);
    return { ...word, width: ctx.measureText(word.text).width, size };
  });

  const beforeWords = measure(before);
  const afterWords = measure(after);

  const lineWidth = (list) => list.reduce((sum, w) => sum + w.width, 0)
    + Math.max(0, list.length - 1) * spaceWidth;

  // Vertical layout, in ink terms: cap height for the hero (it is the tallest
  // thing on its line) and a full em for the support lines.
  const gap = heroSize * gapEm;
  const heroBand = heroSize * 0.74;
  const supportBand = Math.max(
    supportSize,
    ...beforeWords.map(w => w.size),
    ...afterWords.map(w => w.size)
  ) * 0.8;

  const stackHeight = heroBand
    + (beforeWords.length ? supportBand + gap : 0)
    + (afterWords.length ? supportBand + gap : 0);
  const stackTop = centerY - stackHeight / 2;

  let cursorY = stackTop;
  const beforeY = beforeWords.length ? cursorY + supportBand / 2 : 0;
  if (beforeWords.length) cursorY += supportBand + gap;
  const heroY = cursorY + heroBand / 2;
  cursorY += heroBand + gap;
  const afterY = cursorY + supportBand / 2;

  const heroLeft = centerX - heroWidth / 2;
  const heroRight = centerX + heroWidth / 2;

  // 'left' aligns both support lines to the hero's left edge, which is what the
  // reference does. 'edges' fans them out — before-text on the left, after-text
  // on the right — for a more diagonal arrangement.
  const startX = (list) => {
    if (supportAlign === 'center') return centerX - lineWidth(list) / 2;
    if (supportAlign === 'edges' && list === afterWords) return heroRight - lineWidth(list);
    return heroLeft;
  };

  let x = startX(beforeWords);
  for (const word of beforeWords) {
    out.push({ ...word, x, y: beforeY });
    x += word.width + spaceWidth;
  }

  out.push({ ...hero, x: heroLeft, y: heroY, size: heroSize, width: heroWidth });

  x = startX(afterWords);
  for (const word of afterWords) {
    out.push({ ...word, x, y: afterY });
    x += word.width + spaceWidth;
  }
}

// ─── Drawing ────────────────────────────────────────────────────────────────────

function buildFill(ctx, style, box) {
  const fill = style.fill || DEFAULT_STYLE.fill;

  if (fill.type === 'gradient' && Array.isArray(fill.stops) && fill.stops.length > 1) {
    const angle = ((fill.angle || 0) * Math.PI) / 180;
    const halfW = box.width / 2;
    const halfH = box.height / 2;
    const cx = box.x + halfW;
    const cy = box.y;
    const dx = Math.cos(angle) * halfW;
    const dy = Math.sin(angle) * halfH;
    const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    for (const stop of fill.stops) {
      gradient.addColorStop(clamp(stop.offset === undefined ? 0 : stop.offset, 0, 1), stop.color);
    }
    return gradient;
  }

  if (fill.type === 'depth') {
    // Soft centre-lit fill that gives heavy display text a sense of volume.
    const gradient = ctx.createRadialGradient(
      box.x + box.width / 2, box.y, 0,
      box.x + box.width / 2, box.y, Math.max(box.width * 0.65, box.height)
    );
    gradient.addColorStop(0, shade(fill.color, 0.45));
    gradient.addColorStop(0.55, fill.color);
    gradient.addColorStop(1, shade(fill.color, -0.2));
    return gradient;
  }

  return fill.color || '#FFFFFF';
}

function drawBackground(ctx, style, box, scale) {
  const bg = style.background;
  if (!bg || bg.enabled === false) return;

  const padX = (bg.padX === undefined ? 18 : bg.padX) * scale;
  const padY = (bg.padY === undefined ? 8 : bg.padY) * scale;
  const type = bg.type || 'box';

  let x = box.x - padX;
  let y = box.y - box.bandAscent - padY;
  let w = box.width + padX * 2;
  let h = box.bandAscent + box.bandDescent + padY * 2;

  if (type === 'marker') {
    // Highlighter pen: a band centred on the word body. It has to cover the
    // full glyph height rather than just the x-height, because marker templates
    // put dark text on top of it — any ascender left outside the band would be
    // dark-on-dark and unreadable.
    const bandHeight = (box.bandAscent + box.bandDescent) * (bg.thickness === undefined ? 0.92 : bg.thickness);
    const bandCenter = box.y - (box.bandAscent - box.bandDescent) / 2;
    y = bandCenter - bandHeight / 2;
    h = bandHeight;
  }

  const radius = type === 'pill'
    ? h / 2
    : (bg.radius === undefined ? 0 : bg.radius) * scale;

  ctx.save();
  ctx.globalAlpha *= (bg.opacity === undefined ? 1 : bg.opacity);
  ctx.fillStyle = bg.color || '#000000';
  if (radius > 0 && typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, w, h);
  }
  if (bg.borderWidth) {
    ctx.strokeStyle = bg.borderColor || '#FFFFFF';
    ctx.lineWidth = bg.borderWidth * scale;
    if (radius > 0 && typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.stroke();
    } else {
      ctx.strokeRect(x, y, w, h);
    }
  }
  ctx.restore();
}

/**
 * Draw a band behind each whole line, before any words.
 *
 * Separate from per-word backgrounds because bar styles want one continuous
 * plate behind the line — stitching that out of per-word boxes leaves visible
 * seams wherever the word gaps fall.
 */
function drawLineBackgrounds(ctx, laid, template, scale) {
  const bg = template.lineBackground;
  if (!bg || bg.enabled === false || !laid.lines || !laid.lines.length) return;

  const padX = (bg.padX === undefined ? 20 : bg.padX) * scale;
  const padY = (bg.padY === undefined ? 10 : bg.padY) * scale;
  const radius = (bg.radius === undefined ? 0 : bg.radius) * scale;

  ctx.save();
  ctx.globalAlpha = bg.opacity === undefined ? 1 : bg.opacity;
  ctx.fillStyle = bg.color || '#000000';

  for (const line of laid.lines) {
    if (line.x1 <= line.x0) continue;
    // Approximate the line's vertical extent from its font size; exact glyph
    // metrics would make the band jump around as words change.
    const half = line.size * 0.62;
    const x = line.x0 - padX;
    const y = line.y - half - padY;
    const w = (line.x1 - line.x0) + padX * 2;
    const h = half * 2 + padY * 2;

    if (radius > 0 && typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, w, h);
    }
  }
  ctx.restore();
}

/** Draw one word with its full effect stack. */
function drawWord(ctx, word, style, template, scale, anim) {
  const text = word.text;
  const size = word.size * (style.sizeScale || 1);
  // The word's own font, which layout already measured it at. Falling back to
  // the template's would draw at a different width than was reserved.
  const font = fontFor(text, word.family || template.font.family, word.weight || template.font.weight, size);

  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (template.font.letterSpacing) {
    ctx.letterSpacing = `${template.font.letterSpacing * scale}px`;
  }

  const metrics = ctx.measureText(text);
  const ascent = metrics.actualBoundingBoxAscent || size * 0.72;
  const descent = metrics.actualBoundingBoxDescent || size * 0.22;
  // Backgrounds use font-level metrics rather than this word's glyph box, so a
  // pill or highlight band is the same height for every word on the line
  // instead of shrinking on words with no ascenders or descenders.
  const bandAscent = metrics.fontBoundingBoxAscent || size * 0.78;
  const bandDescent = metrics.fontBoundingBoxDescent || size * 0.24;
  // Keep the word optically centred on its slot as its size animates.
  const width = metrics.width || word.width;
  const baselineY = word.y + (ascent - descent) / 2;
  const drawX = word.x - (width - word.width) / 2;

  const box = {
    x: drawX,
    y: baselineY,
    width,
    height: ascent + descent,
    ascent,
    descent,
    bandAscent,
    bandDescent
  };

  const totalScale = (style.scale || 1) * (anim.scale || 1);
  const alpha = clamp((style.opacity === undefined ? 1 : style.opacity) * (anim.opacity === undefined ? 1 : anim.opacity), 0, 1);

  // Transform around the word's own centre so scaling doesn't drift position.
  const pivotX = drawX + width / 2;
  const pivotY = baselineY - (ascent - descent) / 2;
  ctx.translate(pivotX + (anim.dx || 0) * scale, pivotY + (anim.dy || 0) * scale + (style.offsetY || 0) * scale);
  ctx.scale(totalScale, totalScale);
  ctx.translate(-pivotX, -pivotY);

  ctx.globalAlpha = alpha;
  if (style.blur > 0) ctx.filter = `blur(${style.blur * scale}px)`;

  drawBackground(ctx, style, box, scale);

  // Glow: soft halo built from blurred copies of the word behind it.
  //
  // Deliberately not using shadowBlur with a near-transparent fill, which is the
  // usual trick: the shadow's strength is scaled by the source alpha, and the
  // browser and the export rasteriser disagree about how, so glow templates
  // looked materially different in the editor than in the rendered file. An
  // explicit blur filter behaves the same in both.
  if (style.glow && style.glow.enabled !== false && Array.isArray(style.glow.passes)) {
    const glowColor = style.glow.color || '#FFFFFF';
    for (const pass of style.glow.passes) {
      ctx.save();
      // CSS blur() takes a standard deviation, roughly half of shadowBlur's
      // radius, so halve the authored value to keep the same visual spread.
      ctx.filter = `blur(${Math.max(1, (pass.blur || 20) * scale * 0.5)}px)`;
      ctx.globalAlpha = alpha * (pass.opacity === undefined ? 0.6 : pass.opacity);
      ctx.fillStyle = glowColor;
      for (let i = 0; i < (pass.repeat || 1); i++) ctx.fillText(text, drawX, baselineY);
      ctx.restore();
    }
  }

  if (style.shadow && style.shadow.enabled !== false) {
    const sh = style.shadow;
    ctx.save();
    ctx.shadowColor = withAlpha(sh.color || '#000000', sh.opacity === undefined ? 0.8 : sh.opacity);
    ctx.shadowBlur = (sh.blur || 0) * scale;
    ctx.shadowOffsetX = (sh.offsetX || 0) * scale;
    ctx.shadowOffsetY = (sh.offsetY || 0) * scale;
    ctx.fillStyle = withAlpha(sh.color || '#000000', sh.opacity === undefined ? 0.8 : sh.opacity);
    ctx.fillText(text, drawX, baselineY);
    ctx.restore();
  }

  // Extruded 3D offsets, drawn back-to-front behind the face.
  if (style.extrude && style.extrude.depth > 0) {
    const depth = style.extrude.depth;
    const angle = ((style.extrude.angle === undefined ? 45 : style.extrude.angle) * Math.PI) / 180;
    ctx.save();
    ctx.fillStyle = style.extrude.color || '#000000';
    for (let i = depth; i >= 1; i--) {
      ctx.fillText(text, drawX + Math.cos(angle) * i * scale, baselineY + Math.sin(angle) * i * scale);
    }
    ctx.restore();
  }

  if (style.stroke && style.stroke.width > 0) {
    ctx.strokeStyle = style.stroke.color || '#000000';
    ctx.lineWidth = style.stroke.width * scale;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeText(text, drawX, baselineY);
  }

  ctx.fillStyle = buildFill(ctx, style, box);
  ctx.fillText(text, drawX, baselineY);

  if (style.underline) {
    ctx.save();
    ctx.strokeStyle = style.underline.color || (style.fill && style.fill.color) || '#FFFFFF';
    ctx.lineWidth = (style.underline.width || 3) * scale;
    ctx.beginPath();
    ctx.moveTo(drawX, baselineY + descent + 4 * scale);
    ctx.lineTo(drawX + width, baselineY + descent + 4 * scale);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

// ─── Main entry ─────────────────────────────────────────────────────────────────

/**
 * A composition may carry its own style overrides so one line can be styled
 * differently from the rest. Resolving that produces a new template object, so
 * the result is memoised — otherwise it would be rebuilt for every frame the
 * composition is on screen.
 */
const effectiveTemplateCache = new Map();

function effectiveTemplateFor(comp, template) {
  const overrides = comp && comp.styleOverrides;
  if (!overrides || !Object.keys(overrides).length) return template;

  const key = `${template.id}:${comp.id}:${JSON.stringify(overrides)}`;
  let resolved = effectiveTemplateCache.get(key);
  if (!resolved) {
    resolved = applyStyleOverrides(template, overrides);
    if (effectiveTemplateCache.size > 200) effectiveTemplateCache.clear();
    effectiveTemplateCache.set(key, resolved);
  }
  return resolved;
}

/** The composition that should be on screen at a given time, or null. */
export function findActiveComposition(compositions, timeMs) {
  if (!Array.isArray(compositions)) return null;
  for (const comp of compositions) {
    // End is exclusive so two adjacent compositions can never both match.
    if (timeMs >= comp.start_ms && timeMs < comp.end_ms) return comp;
  }
  return null;
}

/**
 * Render the caption layer for one moment in time.
 *
 * @param {CanvasRenderingContext2D} ctx target context, already sized
 * @param {number} timeMs playhead position in milliseconds
 * @param {Array} compositions composition list
 * @param {Map} tokenMap token id -> token
 * @param {object} template normalised template
 * @param {number} width target width in pixels
 * @param {number} height target height in pixels
 */
export function renderCaptionFrame(ctx, timeMs, compositions, tokenMap, baseTemplate, width, height) {
  const comp = findActiveComposition(compositions, timeMs);
  if (!comp || !baseTemplate) return false;

  const template = effectiveTemplateFor(comp, baseTemplate);
  const scale = Math.min(width, height) / DESIGN_WIDTH;
  const laid = layoutComposition(ctx, comp, tokenMap, template, width, height);
  if (!laid.words.length) return false;

  drawLineBackgrounds(ctx, laid, template, scale);

  const layout = template.layout || {};
  const reveal = layout.reveal || 'all';
  const anim = template.animation || {};
  const animTarget = anim.target || 'word';

  const baseStyle = resolveStyle(template, 'base');
  const activeStyle = resolveStyle(template, 'active');
  const pendingStyle = template.pending ? resolveStyle(template, 'pending') : null;
  const spokenStyle = template.spoken ? resolveStyle(template, 'spoken') : null;
  const heroStyle = template.mode === 'hero' ? resolveStyle(template, 'active') : activeStyle;
  const heroLine = heroApplies(comp, template);

  for (let i = 0; i < laid.words.length; i++) {
    const word = laid.words[i];
    const isPending = timeMs < word.startMs;
    if (reveal === 'progressive' && isPending) continue;

    const isActive = timeMs >= word.startMs && timeMs < word.endMs;
    const isSpoken = timeMs >= word.endMs;

    let style;
    if (heroLine) {
      // On an emphasis line the chosen word is styled for the whole
      // composition, not only while it is being spoken.
      style = word.isHero ? heroStyle : baseStyle;
      if (!word.isHero && isPending && pendingStyle) style = pendingStyle;
    } else if (template.mode === 'hero') {
      // A plain line in a hero template is an ordinary subtitle: every word in
      // the base style, nothing picked out. Highlighting a word here anyway is
      // what makes an emphasis style feel relentless — the quiet lines are what
      // give the loud ones their impact.
      style = isPending && pendingStyle ? pendingStyle : baseStyle;
    } else if (isActive) {
      const from = isPending && pendingStyle ? pendingStyle : baseStyle;
      style = lerpStyle(from, activeStyle, activeBlend(template, word, timeMs));
    } else if (isPending && pendingStyle) {
      style = pendingStyle;
    } else if (isSpoken && spokenStyle) {
      style = lerpStyle(activeStyle, spokenStyle, activeBlend(template, word, timeMs) === 0 ? 1 : 1 - activeBlend(template, word, timeMs));
    } else {
      style = baseStyle;
    }

    // A word recoloured on its own takes its glow with it — a green halo around
    // a word the user just made red reads as a mistake, not a choice.
    if (word.override && word.override.color) {
      style = { ...style, fill: recolorFill(style.fill, word.override.color) };
      if (style.glow) style.glow = { ...style.glow, color: word.override.color };
    }

    // With reveal 'all' the whole phrase is on screen for the composition, so
    // the entry animation belongs to the composition — keying it to each word's
    // own start time would leave words that haven't been spoken yet stuck at
    // the start of their entry animation (invisible). A per-word target still
    // staggers them slightly so the line doesn't land as one flat block.
    let animStart;
    if (reveal === 'progressive') {
      animStart = word.startMs;
    } else if (animTarget === 'word') {
      animStart = comp.start_ms + i * (anim.staggerMs === undefined ? 45 : anim.staggerMs);
    } else {
      animStart = comp.start_ms;
    }

    const animation = evalAnimation(anim, timeMs - animStart);
    if (heroLine ? word.isHero : isActive) {
      animation.scale = (animation.scale || 1) * activeKick(template, word, timeMs);
    }

    drawWord(ctx, word, style, template, scale, animation);
  }

  return true;
}

/**
 * Bounding box of the caption at a given time, in target pixels, or null.
 *
 * Exposed so the editor can position its selection outline and drag handles
 * from the renderer's own layout instead of reimplementing the layout maths —
 * a second copy would drift from what is actually drawn.
 */
export function getCaptionBounds(ctx, timeMs, compositions, tokenMap, baseTemplate, width, height) {
  const comp = findActiveComposition(compositions, timeMs);
  if (!comp || !baseTemplate) return null;

  const template = effectiveTemplateFor(comp, baseTemplate);
  const laid = layoutComposition(ctx, comp, tokenMap, template, width, height);
  if (!laid.words.length) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const word of laid.words) {
    const half = word.size * 0.62;
    minX = Math.min(minX, word.x);
    maxX = Math.max(maxX, word.x + word.width);
    minY = Math.min(minY, word.y - half);
    maxY = Math.max(maxY, word.y + half);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, compositionId: comp.id };
}

/** Convenience wrapper used by the exporter: clears then draws. */
export function renderCaptionFrameClean(ctx, timeMs, compositions, tokenMap, template, width, height) {
  ctx.clearRect(0, 0, width, height);
  return renderCaptionFrame(ctx, timeMs, compositions, tokenMap, template, width, height);
}
