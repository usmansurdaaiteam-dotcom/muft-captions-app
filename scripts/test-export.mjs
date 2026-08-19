/**
 * test-export.mjs
 *
 * End-to-end check of the export pipeline against a running server: logs in,
 * queues a render for a video already in uploads/, polls until it finishes,
 * downloads the result and verifies the output is a real video of the expected
 * shape with captions actually burned into the pixels.
 *
 * Usage: node scripts/test-export.mjs [baseUrl] [videoFilename]
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, stat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const BASE = process.argv[2] || 'http://localhost:3111';
const VIDEO = process.argv[3] || 'test-input.mp4';
const PASSWORD = process.env.ACCESS_PASSWORD || 'muftcaptions2026';

const WORDS = ['yeh', 'template', 'bilkul', 'insane', 'hai', 'bhai'];
const tokens = WORDS.map((text, i) => ({
  id: i + 1,
  text,
  start_ms: i * 700,
  end_ms: i * 700 + 650
}));
const compositions = [
  {
    id: 1,
    token_ids: [1, 2, 3],
    hero_token_id: 3,
    comp_type: 'emphasis',
    start_ms: 0,
    end_ms: 2100
  },
  {
    id: 2,
    token_ids: [4, 5, 6],
    hero_token_id: 4,
    comp_type: 'emphasis',
    start_ms: 2100,
    end_ms: 4300
  }
];

function fail(message) {
  console.error(`\nFAILED: ${message}`);
  process.exit(1);
}

async function main() {
  console.log(`Testing export against ${BASE}`);

  // 1. Authenticate
  const authRes = await fetch(`${BASE}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD })
  });
  if (!authRes.ok) fail(`auth failed with ${authRes.status}`);
  const { token } = await authRes.json();
  const authHeaders = { 'Content-Type': 'application/json', 'x-access-token': token };
  console.log('  auth ok');

  // 2. Queue the export
  const startRes = await fetch(`${BASE}/api/export`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      videoUrl: `/uploads/${VIDEO}`,
      compositions,
      tokens,
      templateId: 'bold-yellow',
      styleOverrides: {},
      title: 'export-test'
    })
  });
  if (!startRes.ok) fail(`queueing export failed: ${startRes.status} ${await startRes.text()}`);
  const { jobId } = await startRes.json();
  console.log(`  queued job ${jobId}`);

  // 3. Poll to completion, checking that progress genuinely advances
  const seenProgress = new Set();
  let job;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/export/${jobId}`, { headers: authHeaders });
    if (!res.ok) fail(`status poll failed with ${res.status}`);
    job = await res.json();
    seenProgress.add(job.progress);
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') break;
    await new Promise(r => setTimeout(r, 400));
  }

  if (!job) fail('no job status received');
  if (job.status !== 'completed') fail(`job ended as "${job.status}": ${job.error || 'no error given'}`);
  console.log(`  render completed (${job.totalFrames} frames, saw ${seenProgress.size} distinct progress values)`);
  if (seenProgress.size < 2) {
    fail('progress never changed — reported progress is not tracking real work');
  }

  // 4. Download
  const dlRes = await fetch(`${BASE}${job.downloadUrl}`, { headers: { 'x-access-token': token } });
  if (!dlRes.ok) fail(`download failed with ${dlRes.status}`);
  const dir = await mkdtemp(path.join(tmpdir(), 'mc-export-'));
  const outPath = path.join(dir, 'out.mp4');
  await writeFile(outPath, Buffer.from(await dlRes.arrayBuffer()));
  const { size } = await stat(outPath);
  console.log(`  downloaded ${(size / 1024 / 1024).toFixed(2)} MB`);
  if (size < 20000) fail('output file is implausibly small');

  // 5. Verify container and streams
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', outPath
  ], { maxBuffer: 8 * 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const video = probe.streams.find(s => s.codec_type === 'video');
  const audio = probe.streams.find(s => s.codec_type === 'audio');
  if (!video) fail('output has no video stream');
  console.log(`  video ${video.width}x${video.height} ${video.codec_name}, audio ${audio ? audio.codec_name : 'none'}`);
  if (!audio) fail('audio from the source was not carried through to the export');
  if (Number(video.width) !== 1080 || Number(video.height) !== 1920) {
    fail(`unexpected output size ${video.width}x${video.height}`);
  }

  // 6. Confirm captions are actually in the pixels.
  //    Compare a frame inside a caption against one after the captions end:
  //    the captioned frame must differ from the source at that timestamp.
  const framePath = path.join(dir, 'frame.png');
  const cleanPath = path.join(dir, 'clean.png');
  await execFileAsync('ffmpeg', ['-y', '-ss', '1.0', '-i', outPath, '-frames:v', '1', framePath]);
  await execFileAsync('ffmpeg', ['-y', '-ss', '1.0', '-i', `uploads/${VIDEO}`, '-frames:v', '1', cleanPath]);

  const { stdout: diffOut } = await execFileAsync('ffmpeg', [
    '-i', framePath, '-i', cleanPath,
    '-filter_complex', 'blend=all_mode=difference,blackframe=amount=0:threshold=24',
    '-f', 'null', '-'
  ], { maxBuffer: 8 * 1024 * 1024 }).catch(err => ({ stdout: '', stderr: err.stderr || '' }));

  // blackframe reports the percentage of near-black pixels in the difference.
  // A fully identical pair would be 100% black, so anything meaningfully below
  // that means pixels changed, i.e. captions were drawn.
  const combined = String(diffOut || '');
  console.log('  compared captioned frame against source frame');

  const { stdout: statsOut, stderr: statsErr } = await execFileAsync('ffmpeg', [
    '-i', framePath, '-i', cleanPath,
    '-filter_complex', 'blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f', 'null', '-'
  ], { maxBuffer: 8 * 1024 * 1024 }).catch(err => ({ stdout: '', stderr: String(err.stderr || '') }));

  const match = String(statsErr || statsOut || combined).match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
  if (!match) fail('could not measure the difference between captioned and source frames');
  const yavg = parseFloat(match[1]);
  console.log(`  mean luma difference: ${yavg.toFixed(2)}`);
  if (yavg < 1.0) {
    fail(`captioned frame is nearly identical to the source (diff ${yavg.toFixed(2)}) — captions were not burned in`);
  }

  console.log('\nExport pipeline OK.');
}

main().catch(err => fail(err.stack || err.message));
