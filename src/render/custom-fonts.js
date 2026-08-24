/**
 * custom-fonts.js
 *
 * Storage for user-uploaded fonts.
 *
 * Only TrueType and OpenType are accepted. WOFF and WOFF2 would load in the
 * browser but not in the export rasteriser, so a caption would preview in the
 * uploaded font and then export in a fallback — the exact preview/export
 * mismatch this codebase works hard to avoid. Rejecting them up front is
 * clearer than silently substituting.
 */

import { GlobalFonts } from '@napi-rs/canvas';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { registerCustomFonts, aliasFor, FONT_FILES } from './fonts.js';
import { FONTS_DIR } from './fonts-node.js';

const CUSTOM_DIR = path.join(FONTS_DIR, 'custom');
const MANIFEST = path.join(CUSTOM_DIR, 'fonts.json');

/** Magic bytes for the formats the export renderer can actually rasterise. */
const SIGNATURES = [
  { bytes: [0x00, 0x01, 0x00, 0x00], ext: '.ttf', label: 'TrueType' },
  { bytes: [0x74, 0x72, 0x75, 0x65], ext: '.ttf', label: 'TrueType' }, // 'true'
  { bytes: [0x74, 0x74, 0x63, 0x66], ext: '.ttf', label: 'TrueType collection' }, // 'ttcf'
  { bytes: [0x4f, 0x54, 0x54, 0x4f], ext: '.otf', label: 'OpenType' } // 'OTTO'
];

const REJECTED = {
  '774f4632': 'WOFF2',
  '774f4646': 'WOFF'
};

/** Identify the format from the file's own header, not its filename. */
export function identifyFont(buffer) {
  if (!buffer || buffer.length < 4) return { ok: false, reason: 'File is too small to be a font.' };

  const header = buffer.subarray(0, 4);
  for (const sig of SIGNATURES) {
    if (sig.bytes.every((b, i) => header[i] === b)) {
      return { ok: true, ext: sig.ext, label: sig.label };
    }
  }

  const hex = header.toString('hex');
  if (REJECTED[hex]) {
    return {
      ok: false,
      reason: `${REJECTED[hex]} fonts cannot be used for rendering the exported video. ` +
        'Please upload the TTF or OTF version of this font.'
    };
  }

  return { ok: false, reason: 'This does not look like a TTF or OTF font file.' };
}

/** A tidy family name derived from the uploaded filename. */
export function familyNameFromFilename(filename) {
  return path.basename(filename, path.extname(filename))
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'Custom Font';
}

async function readManifest() {
  try {
    const parsed = JSON.parse(await readFile(MANIFEST, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeManifest(entries) {
  await mkdir(CUSTOM_DIR, { recursive: true });
  await writeFile(MANIFEST, JSON.stringify(entries, null, 2));
}

/** Load stored fonts into the shared registry and the rasteriser. */
export async function loadCustomFonts() {
  const entries = await readManifest();
  if (!entries.length) return [];

  const usable = [];
  for (const entry of entries) {
    const filePath = path.join(CUSTOM_DIR, entry.file);
    try {
      GlobalFonts.registerFromPath(filePath, aliasFor(entry.family, entry.weight || 400));
      usable.push(entry);
    } catch (err) {
      console.warn(`[fonts] Could not register custom font ${entry.file}: ${err.message}`);
    }
  }

  registerCustomFonts(usable);
  if (usable.length) console.log(`[fonts] Registered ${usable.length} custom font(s).`);
  return usable;
}

/**
 * Store an uploaded font and make it immediately available.
 * @returns {{family: string, weight: number, file: string, label: string}}
 */
export async function addCustomFont(buffer, originalName, requestedFamily, requestedWeight) {
  const identified = identifyFont(buffer);
  if (!identified.ok) throw new Error(identified.reason);

  const family = (requestedFamily || familyNameFromFilename(originalName)).trim().slice(0, 60);
  if (!family) throw new Error('The font needs a name.');

  const weight = Number(requestedWeight) || 400;

  // Built-in families must not be shadowed, or a template asking for "Inter"
  // could silently resolve to someone's upload.
  const isBuiltIn = FONT_FILES.some(f => !f.custom && f.family.toLowerCase() === family.toLowerCase());
  if (isBuiltIn) {
    throw new Error(`"${family}" is a built-in font name. Please give the upload a different name.`);
  }

  await mkdir(CUSTOM_DIR, { recursive: true });
  const safeName = `${family.replace(/[^\w]+/g, '-').toLowerCase()}-${weight}${identified.ext}`;
  await writeFile(path.join(CUSTOM_DIR, safeName), buffer);

  // Confirm the rasteriser accepts it before recording it, so a font that would
  // fail at export time never reaches the picker.
  try {
    GlobalFonts.registerFromPath(path.join(CUSTOM_DIR, safeName), aliasFor(family, weight));
  } catch (err) {
    await rm(path.join(CUSTOM_DIR, safeName), { force: true }).catch(() => {});
    throw new Error(`The font could not be loaded for rendering: ${err.message}`);
  }

  const entry = { family, weight, file: safeName, label: identified.label };
  const entries = (await readManifest()).filter(e => !(e.family === family && e.weight === weight));
  entries.push(entry);
  await writeManifest(entries);
  registerCustomFonts([entry]);

  return entry;
}

export async function listCustomFonts() {
  return readManifest();
}

export async function removeCustomFont(family, weight) {
  const entries = await readManifest();
  const target = entries.find(e => e.family === family && e.weight === (Number(weight) || 400));
  if (!target) return false;

  await rm(path.join(CUSTOM_DIR, target.file), { force: true }).catch(() => {});
  await writeManifest(entries.filter(e => e !== target));

  // The in-memory registry keeps the entry until restart; the file is gone, so
  // drop it from the shared list too.
  const index = FONT_FILES.findIndex(f => f.custom && f.family === family && f.weight === target.weight);
  if (index >= 0) FONT_FILES.splice(index, 1);
  return true;
}

export { CUSTOM_DIR };
