/**
 * exporter.js
 *
 * Burns captions into a video by rendering each frame with the shared caption
 * renderer and piping raw RGBA into FFmpeg, which overlays it on the source.
 *
 * Exports run as tracked background jobs rather than inside the HTTP request.
 * A long video takes minutes, which is longer than proxies and browsers are
 * willing to hold a response open, and doing it inline also meant progress
 * could only ever be guessed at and cancelling could not actually stop the
 * work. Jobs report real frame progress and can be cancelled for real.
 */

import { createCanvas } from '@napi-rs/canvas';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import crypto from 'node:crypto';
import { renderCaptionFrameClean, clearLayoutCache } from './caption-renderer.js';

const execFileAsync = promisify(execFile);

/** Only one render at a time: each one saturates CPU and memory. */
const MAX_CONCURRENT = 1;

const jobs = new Map();
const queue = [];
let running = 0;

/** Finished jobs are kept briefly so the client can still fetch the result. */
const JOB_TTL_MS = 30 * 60 * 1000;

/**
 * Is FFmpeg usable?
 *
 * Checked up front because it is the one external dependency and a missing one
 * surfaces as `spawn ffprobe ENOENT`, which tells a user nothing. Cached after
 * the first success, since it cannot become unavailable while the process runs.
 */
let ffmpegChecked = null;

export async function checkFfmpeg({ force = false } = {}) {
  if (ffmpegChecked && !force) return ffmpegChecked;

  const results = {};
  for (const binary of ['ffmpeg', 'ffprobe']) {
    try {
      const { stdout } = await execFileAsync(binary, ['-version'], { timeout: 15000 });
      results[binary] = { ok: true, version: String(stdout).split('\n')[0].slice(0, 60) };
    } catch (err) {
      results[binary] = {
        ok: false,
        missing: err.code === 'ENOENT',
        reason: err.code === 'ENOENT' ? 'not found on PATH' : err.message
      };
    }
  }

  const ok = results.ffmpeg.ok && results.ffprobe.ok;
  ffmpegChecked = {
    ok,
    ...results,
    message: ok ? null 
      : 'FFmpeg is required to read and render video, and it is not available. '
      + 'Install it and make sure "ffmpeg -version" and "ffprobe -version" both work '
      + 'in a new terminal, then restart the app. '
      + 'Windows: winget install Gyan.FFmpeg · macOS: brew install ffmpeg · Linux: apt install ffmpeg'
  };
  return ffmpegChecked;
}

export async function getVideoInfo(videoPath) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      videoPath
    ], { maxBuffer: 8 * 1024 * 1024 }));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error((await checkFfmpeg({ force: true })).message);
    }
    throw new Error(`Could not read the video: ${err.message}`);
  }

  const info = JSON.parse(stdout);
  const videoStream = info.streams.find(s => s.codec_type === 'video');
  if (!videoStream) throw new Error('No video stream found in file.');

  const [num, den] = String(videoStream.r_frame_rate || '30/1').split('/').map(Number);
  const fps = den ? Math.round(num / den) : 30;

  return {
    width: videoStream.width,
    height: videoStream.height,
    duration: parseFloat(info.format.duration) || 0,
    fps: Math.min(120, Math.max(1, fps || 30)),
    hasAudio: info.streams.some(s => s.codec_type === 'audio')
  };
}

/**
 * Queue an export. Returns the job id immediately.
 */
export function startExport({ videoPath, outputPath, compositions, tokens, template, downloadName }) {
  const id = 'job-' + crypto.randomUUID().slice(0, 8);
  const job = {
    id,
    status: 'queued',
    progress: 0,
    frame: 0,
    totalFrames: 0,
    outputPath,
    downloadName: downloadName || 'captions.mp4',
    error: null,
    cancelRequested: false,
    process: null,
    createdAt: Date.now(),
    finishedAt: null,
    payload: { videoPath, compositions, tokens, template }
  };
  jobs.set(id, job);
  queue.push(id);
  pump();
  return id;
}

export function getJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    frame: job.frame,
    totalFrames: job.totalFrames,
    error: job.error,
    outputPath: job.status === 'completed' ? job.outputPath : null,
    downloadName: job.downloadName
  };
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return false;

  job.cancelRequested = true;
  if (job.process) {
    // Killing FFmpeg makes the frame loop's next write fail, which unwinds it.
    try { job.process.kill('SIGKILL'); } catch { /* already gone */ }
  }
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    const idx = queue.indexOf(id);
    if (idx >= 0) queue.splice(idx, 1);
  }
  return true;
}

function sweepOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      if (job.outputPath) rm(job.outputPath, { force: true }).catch(() => {});
      jobs.delete(id);
    }
  }
}

function pump() {
  sweepOldJobs();
  while (running < MAX_CONCURRENT && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job.cancelRequested) continue;
    running++;
    runJob(job)
      .catch(err => {
        job.status = 'failed';
        job.error = err?.message || String(err);
      })
      .finally(() => {
        job.finishedAt = job.finishedAt || Date.now();
        running--;
        pump();
      });
  }
}

async function runJob(job) {
  const { videoPath, compositions, tokens, template } = job.payload;
  job.status = 'probing';

  const info = await getVideoInfo(videoPath);
  const { width, height, fps, duration, hasAudio } = info;
  if (!duration) throw new Error('Could not determine video duration.');

  const totalFrames = Math.max(1, Math.ceil(fps * duration));
  job.totalFrames = totalFrames;
  job.status = 'rendering';

  const tokenMap = new Map(tokens.map(t => [t.id, t]));

  // One canvas reused for every frame: allocating per frame drives native heap
  // growth that a long export will not survive.
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  clearLayoutCache();

  console.log(`[export ${job.id}] ${width}x${height} @${fps}fps, ${duration.toFixed(1)}s, ${totalFrames} frames`);

  const args = [
    '-y',
    '-i', videoPath,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', '-',
    // rgb blending keeps the soft edges of glows and shadows intact.
    '-filter_complex', '[0:v][1:v]overlay=0:0:format=rgb',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '19',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart'
  ];
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k');
  args.push('-shortest', job.outputPath);

  const ffmpeg = spawn('ffmpeg', args);
  job.process = ffmpeg;

  let stderr = '';
  ffmpeg.stderr.on('data', chunk => {
    stderr += chunk.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-10000);
  });

  const done = new Promise((resolve, reject) => {
    ffmpeg.on('close', code => {
      if (job.cancelRequested) return resolve('cancelled');
      if (code === 0) return resolve('ok');
      reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-400)}`));
    });
    ffmpeg.on('error', async err => {
      if (err.code === 'ENOENT') {
        reject(new Error((await checkFfmpeg({ force: true })).message));
        return;
      }
      reject(new Error(`Could not run FFmpeg: ${err.message}`));
    });
  });

  // A dead stdin (FFmpeg gone) must not crash the process.
  ffmpeg.stdin.on('error', () => {});

  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      if (job.cancelRequested) break;

      const timestampMs = (frame / fps) * 1000;
      renderCaptionFrameClean(ctx, timestampMs, compositions, tokenMap, template, width, height);

      const rgba = Buffer.from(ctx.getImageData(0, 0, width, height).data);
      if (!ffmpeg.stdin.writable) break;
      if (!ffmpeg.stdin.write(rgba)) {
        await new Promise(resolve => {
          const onDrain = () => { cleanup(); resolve(); };
          const onClose = () => { cleanup(); resolve(); };
          const cleanup = () => {
            ffmpeg.stdin.off('drain', onDrain);
            ffmpeg.stdin.off('close', onClose);
          };
          ffmpeg.stdin.once('drain', onDrain);
          ffmpeg.stdin.once('close', onClose);
        });
      }

      job.frame = frame + 1;
      job.progress = Math.round(((frame + 1) / totalFrames) * 100);
    }
  } finally {
    try { ffmpeg.stdin.end(); } catch { /* already closed */ }
  }

  const outcome = await done;

  if (job.cancelRequested || outcome === 'cancelled') {
    job.status = 'cancelled';
    job.progress = 0;
    await rm(job.outputPath, { force: true }).catch(() => {});
    console.log(`[export ${job.id}] cancelled`);
    return;
  }

  job.status = 'completed';
  job.progress = 100;
  console.log(`[export ${job.id}] completed`);
}
