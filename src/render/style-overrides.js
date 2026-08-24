/**
 * style-overrides.js
 *
 * Applies the editor's per-project style tweaks on top of a template.
 *
 * Shared by the browser preview and the server export so both derive the exact
 * same template from the same overrides. If each side applied overrides its own
 * way, the editor would show one thing and the rendered file would contain
 * another.
 *
 * Overrides are stored per project as a flat, human-readable object; anything
 * absent simply leaves the template's own value in place.
 */

/** Every override key the editor may set, with the template path it affects. */
export const OVERRIDE_KEYS = [
  'fontFamily', 'fontWeight', 'fontSize', 'casing', 'letterSpacing', 'lineHeight',
  'x', 'y', 'maxWidthPct', 'maxLines', 'align', 'reveal',
  'baseColor', 'activeColor',
  'strokeEnabled', 'strokeWidth', 'strokeColor',
  'shadowEnabled', 'shadowBlur', 'shadowOpacity',
  'glowEnabled', 'glowColor',
  'animationType', 'animationTarget', 'animationDurationMs',
  'popEnabled', 'popScale',
  'heroSizeScale'
];

const isSet = value => value !== undefined && value !== null && value !== '';

/** Replace a fill's colour while preserving gradient stops where sensible. */
export function recolorFill(fill, color) {
  if (!fill) return { type: 'solid', color };
  if (fill.type === 'gradient' && Array.isArray(fill.stops) && fill.stops.length) {
    // Only the first stop is user-editable; keeping the rest preserves the
    // gradient's character instead of flattening it to a solid colour.
    const stops = fill.stops.map((stop, i) => (i === 0 ? { ...stop, color } : stop));
    return { ...fill, stops };
  }
  return { ...fill, type: fill.type === 'depth' ? 'depth' : 'solid', color };
}

/**
 * @param {object} template a normalised template
 * @param {object} overrides flat override object (may be empty or undefined)
 * @returns {object} a new template; the input is not modified
 */
export function applyStyleOverrides(template, overrides) {
  if (!template) return template;
  if (!overrides || typeof overrides !== 'object' || !Object.keys(overrides).length) {
    return template;
  }

  const out = {
    ...template,
    font: { ...template.font },
    layout: { ...template.layout },
    word: { ...template.word },
    active: { ...template.active },
    pending: template.pending ? { ...template.pending } : null,
    spoken: template.spoken ? { ...template.spoken } : null,
    animation: { ...template.animation }
  };

  // Typography
  if (isSet(overrides.fontFamily)) out.font.family = overrides.fontFamily;
  if (isSet(overrides.fontWeight)) out.font.weight = Number(overrides.fontWeight);
  if (isSet(overrides.fontSize)) out.font.size = Number(overrides.fontSize);
  if (isSet(overrides.casing)) out.font.casing = overrides.casing;
  if (isSet(overrides.letterSpacing)) out.font.letterSpacing = Number(overrides.letterSpacing);
  if (isSet(overrides.lineHeight)) out.font.lineHeight = Number(overrides.lineHeight);

  // Placement
  if (isSet(overrides.x)) out.layout.x = Number(overrides.x);
  if (isSet(overrides.y)) out.layout.y = Number(overrides.y);
  if (isSet(overrides.maxWidthPct)) out.layout.maxWidthPct = Number(overrides.maxWidthPct);
  if (isSet(overrides.maxLines)) out.layout.maxLines = Number(overrides.maxLines);
  if (isSet(overrides.align)) out.layout.align = overrides.align;
  if (isSet(overrides.reveal)) out.layout.reveal = overrides.reveal;

  // Colours
  if (isSet(overrides.baseColor)) {
    out.word.fill = recolorFill(out.word.fill, overrides.baseColor);
    if (out.pending) out.pending.fill = recolorFill(out.pending.fill, overrides.baseColor);
  }
  if (isSet(overrides.activeColor)) {
    out.active.fill = recolorFill(out.active.fill, overrides.activeColor);
  }

  // Outline, applied to both states so the whole line stays consistent.
  if (overrides.strokeEnabled === false) {
    out.word.stroke = null;
    out.active.stroke = null;
  } else if (overrides.strokeEnabled === true || isSet(overrides.strokeWidth) || isSet(overrides.strokeColor)) {
    const width = isSet(overrides.strokeWidth)
      ? Number(overrides.strokeWidth)
      : ((out.word.stroke && out.word.stroke.width) || 4);
    const color = isSet(overrides.strokeColor)
      ? overrides.strokeColor
      : ((out.word.stroke && out.word.stroke.color) || '#000000');
    out.word.stroke = { width, color };
    out.active.stroke = { width, color };
  }

  // Drop shadow
  if (overrides.shadowEnabled === false) {
    out.word.shadow = null;
    out.active.shadow = null;
  } else if (overrides.shadowEnabled === true || isSet(overrides.shadowBlur) || isSet(overrides.shadowOpacity)) {
    const base = out.word.shadow || { color: '#000000', offsetX: 0, offsetY: 4, blur: 14, opacity: 0.75 };
    const shadow = {
      ...base,
      blur: isSet(overrides.shadowBlur) ? Number(overrides.shadowBlur) : base.blur,
      opacity: isSet(overrides.shadowOpacity) ? Number(overrides.shadowOpacity) : base.opacity
    };
    out.word.shadow = shadow;
    out.active.shadow = out.active.shadow ? { ...out.active.shadow, ...shadow } : shadow;
  }

  // Glow on the highlighted word
  if (overrides.glowEnabled === false) {
    out.active.glow = null;
  } else if (overrides.glowEnabled === true || isSet(overrides.glowColor)) {
    const existing = out.active.glow;
    const color = isSet(overrides.glowColor)
      ? overrides.glowColor
      : (existing && existing.color) || '#FFFFFF';
    out.active.glow = {
      color,
      passes: (existing && existing.passes) || [{ blur: 30, opacity: 0.5 }, { blur: 14, opacity: 0.8 }]
    };
  }

  // Motion
  if (isSet(overrides.animationType)) out.animation.type = overrides.animationType;
  if (isSet(overrides.animationTarget)) out.animation.target = overrides.animationTarget;
  if (isSet(overrides.animationDurationMs)) out.animation.durationMs = Number(overrides.animationDurationMs);

  if (overrides.popEnabled === false) {
    out.active.pop = null;
  } else if (overrides.popEnabled === true || isSet(overrides.popScale)) {
    out.active.pop = {
      scale: isSet(overrides.popScale) ? Number(overrides.popScale) : ((out.active.pop && out.active.pop.scale) || 1.16),
      durationMs: (out.active.pop && out.active.pop.durationMs) || 190
    };
  }

  if (isSet(overrides.heroSizeScale)) out.heroSizeScale = Number(overrides.heroSizeScale);

  return out;
}

/** Strip unknown keys so project files stay predictable. */
export function sanitizeOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object') return {};
  const clean = {};
  for (const key of OVERRIDE_KEYS) {
    if (overrides[key] !== undefined) clean[key] = overrides[key];
  }
  return clean;
}

/**
 * Style keys a single word may carry. Kept to changes the layout can measure
 * exactly, so a restyled word still takes the room it needs.
 */
export const WORD_OVERRIDE_KEYS = ['color', 'sizeScale', 'fontFamily', 'fontWeight', 'casing'];

/**
 * Clean a composition's per-word overrides: known keys only, sane size range,
 * and no empty entries left behind when a word is reset.
 */
export function sanitizeWordOverrides(wordOverrides) {
  if (!wordOverrides || typeof wordOverrides !== 'object') return {};
  const clean = {};
  for (const [tokenId, raw] of Object.entries(wordOverrides)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = {};
    for (const key of WORD_OVERRIDE_KEYS) {
      const value = raw[key];
      if (value === undefined || value === null || value === '') continue;
      if (key === 'sizeScale') {
        const size = Number(value);
        if (!Number.isFinite(size)) continue;
        // A word far outside this range stops being a styled word and starts
        // being a layout problem for the line around it.
        entry[key] = Math.max(0.4, Math.min(2.5, size));
      } else if (key === 'fontWeight') {
        const weight = Number(value);
        if (Number.isFinite(weight)) entry[key] = weight;
      } else {
        entry[key] = value;
      }
    }
    if (Object.keys(entry).length) clean[tokenId] = entry;
  }
  return clean;
}
