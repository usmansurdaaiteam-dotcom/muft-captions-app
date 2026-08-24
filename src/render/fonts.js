/**
 * fonts.js
 *
 * The single source of truth for which fonts exist and how they are named.
 *
 * Every font file is a real static instance of one concrete weight. Each file
 * is registered under its own unique alias (e.g. "mc-Inter-800") rather than
 * sharing a family name across weights, because @napi-rs/canvas does not
 * resolve a weight axis from a variable font and does not reliably pick between
 * several static files sharing one family name. Binding one alias to one file
 * removes weight resolution from the picture entirely: the alias *is* the
 * weight, so the browser preview and the server export always land on the same
 * glyphs.
 *
 * Shared verbatim by the browser (via @font-face) and the export renderer
 * (via GlobalFonts.registerFromPath).
 */

/** Alias prefix, kept short since it appears in every canvas font string. */
const PREFIX = 'mc';

/**
 * Every available font file.
 * `family` + `weight` is what templates and the UI refer to; `file` is the
 * actual TTF in assets/fonts/.
 *
 * Mutable so uploaded fonts can be added at runtime. Both the browser and the
 * server register the same custom list, which keeps a custom font resolving to
 * the same file in the preview and in the export.
 */
export const FONT_FILES = [
  { family: 'Inter', weight: 500, file: 'Inter-Medium.ttf' },
  { family: 'Inter', weight: 600, file: 'Inter-SemiBold.ttf' },
  { family: 'Inter', weight: 700, file: 'Inter-Bold.ttf' },
  { family: 'Inter', weight: 800, file: 'Inter-ExtraBold.ttf' },
  { family: 'Inter', weight: 900, file: 'Inter-Black.ttf' },

  { family: 'DM Sans', weight: 700, file: 'DMSans-Bold.ttf' },
  { family: 'DM Sans', weight: 900, file: 'DMSans-Black.ttf' },

  { family: 'Space Grotesk', weight: 700, file: 'SpaceGrotesk-Bold.ttf' },

  { family: 'Outfit', weight: 600, file: 'Outfit-SemiBold.ttf' },
  { family: 'Outfit', weight: 900, file: 'Outfit-Black.ttf' },

  { family: 'Poppins', weight: 700, file: 'Poppins-Bold.ttf' },
  { family: 'Poppins', weight: 900, file: 'Poppins-Black.ttf' },

  { family: 'Montserrat', weight: 900, file: 'Montserrat-Black.ttf' },
  { family: 'Nunito', weight: 900, file: 'Nunito-Black.ttf' },
  { family: 'Oswald', weight: 700, file: 'Oswald-Bold.ttf' },
  { family: 'Source Serif 4', weight: 700, file: 'SourceSerif4-Bold.ttf' },

  // Display faces that only exist at a single weight.
  { family: 'Anton', weight: 400, file: 'Anton-Regular.ttf' },
  { family: 'Bebas Neue', weight: 400, file: 'BebasNeue-Regular.ttf' },
  { family: 'Archivo Black', weight: 400, file: 'ArchivoBlack-Regular.ttf' },
  { family: 'Bangers', weight: 400, file: 'Bangers-Regular.ttf' },
  { family: 'Press Start 2P', weight: 400, file: 'PressStart2P-Regular.ttf' },
  { family: 'VT323', weight: 400, file: 'VT323-Regular.ttf' },

  // Arabic-script fallback for Urdu that was not converted to Roman Urdu.
  { family: 'Noto Sans Arabic', weight: 700, file: 'NotoSansArabic-Bold.ttf' }
];

/** Used when a template asks for a family that isn't installed. */
export const FALLBACK_FAMILY = 'Inter';

/**
 * Appended to every font string so Urdu/Arabic words render real glyphs
 * instead of empty boxes when the primary face has no Arabic coverage.
 */
export const ARABIC_FALLBACK_ALIAS = aliasFor('Noto Sans Arabic', 700);

/** Stable canvas/CSS font-family name for one font file. */
export function aliasFor(family, weight) {
  // Strip anything that would need escaping in a CSS font-family name.
  return `${PREFIX}-${family.replace(/[^\w]+/g, '')}-${weight}`;
}

/**
 * Add uploaded fonts to the registry.
 *
 * Called on the server at startup and in the browser once the font list has
 * been fetched, so both resolve a custom family to the same file. Replacing an
 * existing entry rather than appending keeps repeat calls idempotent.
 */
export function registerCustomFonts(entries = []) {
  for (const entry of entries) {
    if (!entry || !entry.family || !entry.file) continue;
    const weight = Number(entry.weight) || 400;
    const existing = FONT_FILES.findIndex(f => f.family === entry.family && f.weight === weight);
    const record = { family: entry.family, weight, file: entry.file, custom: true };
    if (existing >= 0) FONT_FILES[existing] = record;
    else FONT_FILES.push(record);
  }
  return FONT_FILES.length;
}

/** Where a font file lives relative to the fonts directory. */
export function relativePathFor(font) {
  return font.custom ? `custom/${font.file}` : font.file;
}

/** All distinct families, with their available weights, for the font picker. */
export function listFamilies() {
  const byFamily = new Map();
  for (const font of FONT_FILES) {
    if (!byFamily.has(font.family)) byFamily.set(font.family, { weights: [], custom: false });
    const entry = byFamily.get(font.family);
    entry.weights.push(font.weight);
    if (font.custom) entry.custom = true;
  }
  return [...byFamily.entries()].map(([family, entry]) => ({
    family,
    weights: entry.weights.sort((a, b) => a - b),
    custom: entry.custom
  }));
}

/**
 * Find the closest installed file for a requested family/weight.
 * Falls back to the nearest weight in the same family, then to Inter, so a
 * template referencing something unavailable degrades instead of rendering
 * with a silently wrong face.
 */
export function resolveFont(family, weight = 700) {
  const wanted = Number(weight) || 700;
  const inFamily = FONT_FILES.filter(f => f.family === family);
  const pool = inFamily.length
    ? inFamily
    : FONT_FILES.filter(f => f.family === FALLBACK_FAMILY);

  let best = pool[0];
  let bestDelta = Infinity;
  for (const font of pool) {
    const delta = Math.abs(font.weight - wanted);
    if (delta < bestDelta) {
      best = font;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Build a canvas/CSS font string for a family/weight/size.
 *
 * The numeric weight is intentionally always `400`: the resolved file already
 * *is* the requested weight, and asking the rasterizer to also synthesize a
 * weight on top of it would make the browser and the export disagree.
 */
export function fontString(family, weight, sizePx) {
  const resolved = resolveFont(family, weight);
  const alias = aliasFor(resolved.family, resolved.weight);
  return `400 ${Math.round(sizePx)}px "${alias}", "${ARABIC_FALLBACK_ALIAS}", sans-serif`;
}

/** CSS @font-face block for the browser preview. */
export function buildFontFaceCss(baseUrl = '/assets/fonts') {
  return FONT_FILES.map(font => {
    const alias = aliasFor(font.family, font.weight);
    const format = /\.otf$/i.test(font.file) ? 'opentype' : 'truetype';
    return [
      '@font-face {',
      `  font-family: "${alias}";`,
      `  src: url("${baseUrl}/${encodeURI(relativePathFor(font))}") format("${format}");`,
      '  font-weight: 400;',
      '  font-style: normal;',
      '  font-display: block;',
      '}'
    ].join('\n');
  }).join('\n\n');
}
