/**
 * analyze.js
 *
 * Derives the timeline's visual aids from a source video: an audio waveform and
 * a strip of thumbnails.
 *
 * Both are produced with FFmpeg and cached on disk. Decoding audio or decoding
 * frames takes seconds even for a short clip, and the timeline needs them every
 * time a project opens, so doing this per request would make the editor feel
 * broken. Cache files are keyed by the source file's size and modification time,
 * so replacing a video invalidates them without any bookkeeping.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);

/** Number of peaks in a waveform. Enough detail to see speech vs silence. */
const WAVEFORM_BUCKETS = 1600;

/**
 * Filmstrip density. Roughly two thumbnails per second, bounded so a very short
 * clip still gets enough frames to look like a strip and a long one does not
 * produce an enormous image.
 */
const FILMSTRIP_PER_SECOND = 2;
const FILMSTRIP_MIN_FRAMES = 10;
const FILMSTRIP_MAX_FRAMES = 140;
const FILMSTRIP_HEIGHT = 56;

function filmstripFrameCount(durationSec) {
  return Math.max(
    FILMSTRIP_MIN_FRAMES,
    Math.min(FILMSTRIP_MAX_FRAMES, Math.round(durationSec * FILMSTRIP_PER_SECOND))
  );
}

let cacheDir = null;

export function configureCache(dir) {
  cacheDir = dir;
}

async function ensureCacheDir() {
  if (!cacheDir) throw new Error('Media cache directory was never configured.');
  await mkdir(cacheDir, { recursive: true });
  return cacheDir;
}

/**
 * Cache key for a source file. Includes size and mtime so a replaced video
 * produces a different key rather than serving the previous video's waveform.
 */
async function cacheKey(filePath, kind) {
  const info = await stat(filePath);
  const hash = crypto.createHash('sha1')
    .update(`${path.basename(filePath)}:${info.size}:${info.mtimeMs}:${kind}`)
    .digest('hex')
    .slice(0, 16);
  return `${kind}-${hash}`;
}

/**
 * Peak amplitude per time bucket, each 0..1.
 *
 * Audio is decoded to low-rate mono PCM because only the envelope matters here;
 * decoding at full quality would move far more data for an identical picture.
 */
export async function getWaveform(videoPath, buckets = WAVEFORM_BUCKETS) {
  const dir = await ensureCacheDir();
  const key = await cacheKey(videoPath, `wave${buckets}`);
  const cachePath = path.join(dir, `${key}.json`);

  try {
    return JSON.parse(await readFile(cachePath, 'utf-8'));
  } catch { /* not cached yet */ }

  const SAMPLE_RATE = 8000;
  const chunks = [];

  await new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-v', 'error',
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 's16le',
      '-'
    ]);

    let stderr = '';
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    ffmpeg.stderr.on('data', chunk => { stderr += chunk.toString(); });
    ffmpeg.on('error', err => reject(new Error(`Could not run FFmpeg: ${err.message}`)));
    ffmpeg.on('close', code => {
      // A video with no audio track is normal, not an error.
      if (code === 0 || chunks.length) resolve();
      else reject(new Error(`FFmpeg could not read audio: ${stderr.slice(-300)}`));
    });
  });

  const pcm = Buffer.concat(chunks);
  const sampleCount = Math.floor(pcm.length / 2);
  const result = {
    peaks: new Array(buckets).fill(0),
    sampleRate: SAMPLE_RATE,
    durationSec: sampleCount / SAMPLE_RATE,
    hasAudio: sampleCount > 0
  };

  if (sampleCount > 0) {
    const perBucket = Math.max(1, Math.floor(sampleCount / buckets));
    for (let bucket = 0; bucket < buckets; bucket++) {
      const start = bucket * perBucket;
      const end = Math.min(sampleCount, start + perBucket);
      let peak = 0;
      for (let i = start; i < end; i++) {
        const value = Math.abs(pcm.readInt16LE(i * 2));
        if (value > peak) peak = value;
      }
      result.peaks[bucket] = Math.min(1, peak / 32768);
    }

    // Normalise to the loudest peak so quiet recordings are still readable.
    const loudest = Math.max(...result.peaks);
    if (loudest > 0.02) {
      result.peaks = result.peaks.map(p => Math.min(1, p / loudest));
    }
  }

  await writeFile(cachePath, JSON.stringify(result));
  return result;
}

/**
 * A horizontal strip of evenly spaced thumbnails as a single JPEG.
 * One image rather than many keeps the timeline to a single request.
 */
export async function getFilmstrip(videoPath, durationSec, frames = null) {
  if (!durationSec || durationSec <= 0) {
    throw new Error('Cannot build a filmstrip without a duration.');
  }

  const count = frames || filmstripFrameCount(durationSec);
  const dir = await ensureCacheDir();
  const key = await cacheKey(videoPath, `strip${count}`);
  const imagePath = path.join(dir, `${key}.jpg`);
  const metaPath = path.join(dir, `${key}.json`);

  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    await stat(imagePath);
    return { ...meta, imagePath };
  } catch { /* not cached yet */ }

  // `fps=count/duration` spaces the frames evenly across the whole clip.
  const filter = `fps=${count}/${durationSec},scale=-1:${FILMSTRIP_HEIGHT},tile=${count}x1`;

  await execFileAsync('ffmpeg', [
    '-v', 'error',
    '-i', videoPath,
    '-vf', filter,
    '-frames:v', '1',
    '-q:v', '4',
    '-y', imagePath
  ], { maxBuffer: 16 * 1024 * 1024, timeout: 180000 });

  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', imagePath
  ]);
  const probe = JSON.parse(stdout);
  const image = probe.streams.find(s => s.codec_type === 'video') || {};

  const meta = {
    frames: count,
    frameWidth: Math.round((image.width || 0) / count),
    frameHeight: image.height || FILMSTRIP_HEIGHT,
    totalWidth: image.width || 0,
    durationSec
  };
  await writeFile(metaPath, JSON.stringify(meta));
  return { ...meta, imagePath };
}

/**
 * Delete cache entries whose source file is gone.
 * Called after a project is removed so the cache does not outlive its media.
 */
export async function pruneCache(liveKeys) {
  if (!cacheDir) return 0;
  let removed = 0;
  let entries;
  try {
    entries = await readdir(cacheDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const key = entry.replace(/\.(json|jpg)$/, '');
    if (!liveKeys.has(key)) {
      await rm(path.join(cacheDir, entry), { force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

export async function cacheKeysFor(videoPath, durationSec) {
  return new Set([
    await cacheKey(videoPath, `wave${WAVEFORM_BUCKETS}`),
    await cacheKey(videoPath, `strip${filmstripFrameCount(durationSec || 0)}`)
  ]);
}

export { WAVEFORM_BUCKETS, FILMSTRIP_HEIGHT, filmstripFrameCount };
