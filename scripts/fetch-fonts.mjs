/**
 * fetch-fonts.mjs
 *
 * Downloads every font used by the template library into assets/fonts/.
 *
 * Google Fonts now ships most families as variable fonts only, and
 * @napi-rs/canvas cannot select a weight axis from a variable font — every
 * weight renders identically. So variable sources are instanced down to real
 * static TTFs (one file per weight) with fonttools. Each file is then a single
 * concrete weight, which both the browser and the export renderer can load
 * without any weight resolution guesswork.
 *
 * Requires: python3 with fonttools (pip install fonttools).
 *
 * Usage: node scripts/fetch-fonts.mjs
 */

import { mkdir, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FONTS_DIR = path.join(ROOT, 'assets', 'fonts');
const TMP_DIR = path.join(ROOT, '.font-tmp');

const GF = 'https://raw.githubusercontent.com/google/fonts/main';

/** Fonts that already ship as single-weight static TTFs. */
const STATIC_FONTS = [
  { out: 'Anton-Regular.ttf', url: `${GF}/ofl/anton/Anton-Regular.ttf` },
  { out: 'BebasNeue-Regular.ttf', url: `${GF}/ofl/bebasneue/BebasNeue-Regular.ttf` },
  { out: 'ArchivoBlack-Regular.ttf', url: `${GF}/ofl/archivoblack/ArchivoBlack-Regular.ttf` },
  { out: 'Bangers-Regular.ttf', url: `${GF}/ofl/bangers/Bangers-Regular.ttf` },
  { out: 'PressStart2P-Regular.ttf', url: `${GF}/ofl/pressstart2p/PressStart2P-Regular.ttf` },
  { out: 'VT323-Regular.ttf', url: `${GF}/ofl/vt323/VT323-Regular.ttf` },
  { out: 'Poppins-Black.ttf', url: `${GF}/ofl/poppins/Poppins-Black.ttf` },
  { out: 'Poppins-Bold.ttf', url: `${GF}/ofl/poppins/Poppins-Bold.ttf` }
];

/**
 * Variable sources to instance into static weights.
 * `axes` pins every axis of the variable font; `wght` is substituted per weight.
 */
const VARIABLE_FONTS = [
  {
    family: 'Inter',
    url: `${GF}/ofl/inter/Inter%5Bopsz,wght%5D.ttf`,
    weights: [500, 600, 700, 800, 900],
    extraAxes: { opsz: 32 }
  },
  {
    family: 'DMSans',
    url: `${GF}/ofl/dmsans/DMSans%5Bopsz,wght%5D.ttf`,
    weights: [700, 900],
    extraAxes: { opsz: 40 }
  },
  {
    family: 'SpaceGrotesk',
    url: `${GF}/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf`,
    weights: [700]
  },
  {
    family: 'Outfit',
    url: `${GF}/ofl/outfit/Outfit%5Bwght%5D.ttf`,
    weights: [600, 900]
  },
  {
    family: 'Montserrat',
    url: `${GF}/ofl/montserrat/Montserrat%5Bwght%5D.ttf`,
    weights: [900]
  },
  {
    family: 'SourceSerif4',
    url: `${GF}/ofl/sourceserif4/SourceSerif4%5Bopsz,wght%5D.ttf`,
    weights: [700],
    extraAxes: { opsz: 20 }
  },
  {
    family: 'Nunito',
    url: `${GF}/ofl/nunito/Nunito%5Bwght%5D.ttf`,
    weights: [900]
  },
  {
    family: 'Oswald',
    url: `${GF}/ofl/oswald/Oswald%5Bwght%5D.ttf`,
    weights: [700]
  },
  {
    // Urdu / Arabic script fallback. Soniox returns Urdu script when the
    // Roman-Urdu cleanup step is unavailable, and the Latin fonts have no
    // Arabic glyphs — without this those words render as empty boxes.
    family: 'NotoSansArabic',
    url: `${GF}/ofl/notosansarabic/NotoSansArabic%5Bwdth,wght%5D.ttf`,
    weights: [700],
    extraAxes: { wdth: 100 }
  }
];

const WEIGHT_NAMES = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black'
};

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`Suspiciously small download (${buf.length}B) for ${url}`);
  await writeFile(dest, buf);
  return buf.length;
}

async function instance(srcPath, outPath, axes) {
  const axisArgs = Object.entries(axes).map(([k, v]) => `${k}=${v}`);
  await execFileAsync('python3', [
    '-m', 'fontTools.varLib.instancer',
    srcPath,
    ...axisArgs,
    '-o', outPath
  ], { maxBuffer: 32 * 1024 * 1024 });
}

async function main() {
  await mkdir(FONTS_DIR, { recursive: true });
  await mkdir(TMP_DIR, { recursive: true });

  const written = [];

  for (const font of STATIC_FONTS) {
    const dest = path.join(FONTS_DIR, font.out);
    if (await exists(dest)) {
      console.log(`skip   ${font.out} (already present)`);
      written.push(font.out);
      continue;
    }
    const size = await download(font.url, dest);
    console.log(`static ${font.out} (${(size / 1024).toFixed(0)} KB)`);
    written.push(font.out);
  }

  for (const font of VARIABLE_FONTS) {
    const srcPath = path.join(TMP_DIR, `${font.family}-var.ttf`);
    const needed = font.weights
      .map(w => `${font.family}-${WEIGHT_NAMES[w]}.ttf`)
      .filter(async name => !(await exists(path.join(FONTS_DIR, name))));

    if (!needed.length) continue;

    if (!(await exists(srcPath))) {
      const size = await download(font.url, srcPath);
      console.log(`fetch  ${font.family} variable source (${(size / 1024).toFixed(0)} KB)`);
    }

    for (const weight of font.weights) {
      const out = `${font.family}-${WEIGHT_NAMES[weight]}.ttf`;
      const dest = path.join(FONTS_DIR, out);
      if (await exists(dest)) {
        console.log(`skip   ${out} (already present)`);
        written.push(out);
        continue;
      }
      await instance(srcPath, dest, { ...(font.extraAxes || {}), wght: weight });
      const { size } = await stat(dest);
      console.log(`static ${out} (${(size / 1024).toFixed(0)} KB)`);
      written.push(out);
    }
  }

  await rm(TMP_DIR, { recursive: true, force: true });
  console.log(`\nDone. ${written.length} font files in assets/fonts/`);
}

main().catch(err => {
  console.error('Font fetch failed:', err.message);
  process.exit(1);
});
