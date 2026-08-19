/**
 * fonts-node.js
 *
 * Server-side font registration. Registers every file from the shared font
 * registry under its unique alias and wires the renderer's font resolver, so
 * the export path resolves fonts identically to the browser preview.
 */

import { GlobalFonts } from '@napi-rs/canvas';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FONT_FILES, aliasFor, fontString, ARABIC_FALLBACK_ALIAS } from './fonts.js';
import { configureFonts } from './caption-renderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FONTS_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

let registered = false;

/** Register all fonts and point the renderer at them. Safe to call repeatedly. */
export function registerFonts() {
  if (registered) return;

  const missing = [];
  for (const font of FONT_FILES) {
    const filePath = path.join(FONTS_DIR, font.file);
    if (!existsSync(filePath)) {
      missing.push(font.file);
      continue;
    }
    GlobalFonts.registerFromPath(filePath, aliasFor(font.family, font.weight));
  }

  if (missing.length) {
    console.warn(
      `[fonts] ${missing.length} font file(s) missing from assets/fonts — ` +
      `run "npm run fonts" to fetch them. Missing: ${missing.slice(0, 5).join(', ')}` +
      (missing.length > 5 ? ', ...' : '')
    );
  }

  configureFonts({
    fontString,
    arabicFontString: (size) => `400 ${Math.round(size)}px "${ARABIC_FALLBACK_ALIAS}", sans-serif`
  });

  registered = true;
  console.log(`[fonts] Registered ${FONT_FILES.length - missing.length} caption fonts.`);
}
