/**
 * Server-side frame renderer for caption export.
 * Uses the shared template-engine.js for rendering — single source of truth.
 * Uses @napi-rs/canvas for pixel-perfect rendering.
 */

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderComposition } from './template-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Register fonts with multiple aliases to ensure bulletproof weight resolution in napi-rs canvas
const fontsDir = path.join(__dirname, '..', 'fonts');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Inter-ExtraBold.ttf'), 'Inter');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Inter-ExtraBold.ttf'), 'Inter-ExtraBold');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Inter-Black.ttf'), 'Inter');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Inter-Black.ttf'), 'Inter-Black');

// Load system fonts (Impact, Segoe UI, Arial Black, Georgia etc.)
GlobalFonts.loadSystemFonts();

// --- Main Frame Renderer --------------------------------------------------------

/**
 * Render a single caption frame at the given timestamp.
 * Returns a Buffer of raw RGBA pixel data (width * height * 4 bytes).
 */
export function renderFrame(timestampMs, compositions, tokenMap, template, width, height, animationConfig) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Find active composition
  const comp = compositions.find(c => timestampMs >= c.start_ms && timestampMs <= c.end_ms);
  if (!comp) {
    // No caption at this timestamp — return transparent frame
    return Buffer.alloc(width * height * 4, 0);
  }

  // Use the shared template engine to render
  renderComposition(ctx, timestampMs, compositions, tokenMap, template, width, height, animationConfig);

  // Return raw RGBA data for piping to FFmpeg (using imageData.data ensures correct length/offset)
  const imageData = ctx.getImageData(0, 0, width, height);
  return Buffer.from(imageData.data);
}

/**
 * Get video info using ffprobe.
 * Returns { width, height, duration, fps }
 */
export async function getVideoInfo(videoPath) {
  const { execFile: execFileCb } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFile = promisify(execFileCb);

  const { stdout } = await execFile('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    videoPath
  ]);

  const info = JSON.parse(stdout);
  const videoStream = info.streams.find(s => s.codec_type === 'video');

  if (!videoStream) throw new Error('No video stream found');

  // Parse frame rate (e.g., "30/1" or "30000/1001")
  const [fpsNum, fpsDen] = (videoStream.r_frame_rate || '30/1').split('/').map(Number);
  const fps = Math.round(fpsNum / fpsDen);

  return {
    width: videoStream.width,
    height: videoStream.height,
    duration: parseFloat(info.format.duration),
    fps: fps || 30
  };
}

/**
 * Export video with caption overlay using FFmpeg frame-by-frame piping.
 */
export async function exportVideo(inputVideoPath, outputPath, compositions, tokenMap, template, animationConfig, onProgress) {
  const { spawn } = await import('node:child_process');

  const videoInfo = await getVideoInfo(inputVideoPath);
  const { width, height, fps, duration } = videoInfo;
  const totalFrames = Math.ceil(fps * duration);

  console.log(`[Export] Video: ${width}x${height}, ${fps}fps, ${duration.toFixed(1)}s`);
  console.log(`[Export] Rendering ${totalFrames} frames...`);

  // Create a single canvas and context to reuse across the rendering loop (prevents C++ heap memory expansion)
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  return new Promise((resolve, reject) => {
    // FFmpeg command: read raw RGBA frames from stdin, overlay on source video
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      // Input 1: Original video
      '-i', inputVideoPath,
      // Input 2: Raw RGBA frames from stdin
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${width}x${height}`,
      '-r', String(fps),
      '-i', '-',
      // Filter: overlay the caption frames on top of the video with high-fidelity RGB blending (preserves shadows and glows)
      '-filter_complex', '[0:v][1:v]overlay=0:0:format=rgb',
      // Output settings (changed preset to superfast for 3x-5x faster rendering on VPS)
      '-c:v', 'libx264',
      '-preset', 'superfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      // Copy audio from original
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      outputPath
    ]);

    let stderrOutput = '';
    ffmpeg.stderr.on('data', chunk => { stderrOutput += chunk.toString(); });

    ffmpeg.on('close', code => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderrOutput.slice(-500)}`));
    });

    ffmpeg.on('error', reject);

    // Render frames and pipe to FFmpeg
    (async () => {
      try {
        for (let frame = 0; frame < totalFrames; frame++) {
          const timestampMs = (frame / fps) * 1000;
          
          // Clear canvas for the new frame
          ctx.clearRect(0, 0, width, height);

          // Find active composition
          const comp = compositions.find(c => timestampMs >= c.start_ms && timestampMs <= c.end_ms);
          if (comp) {
            // Render the composition directly onto the shared canvas
            renderComposition(ctx, timestampMs, compositions, tokenMap, template, width, height, animationConfig);
          }

          // Get raw RGBA buffer from the canvas
          const imageData = ctx.getImageData(0, 0, width, height);
          const rgbaData = Buffer.from(imageData.data);
          
          // Write to FFmpeg stdin
          const canWrite = ffmpeg.stdin.write(rgbaData);
          if (!canWrite) {
            await new Promise(r => ffmpeg.stdin.once('drain', r));
          }

          // Progress callback
          if (frame % fps === 0 && onProgress) {
            onProgress(frame, totalFrames);
          }
        }
        ffmpeg.stdin.end();
      } catch (err) {
        ffmpeg.stdin.destroy();
        reject(err);
      }
    })();
  });
}
