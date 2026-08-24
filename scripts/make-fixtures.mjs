/**
 * make-fixtures.mjs
 *
 * Creates the sample video and projects the browser tests run against, so a test
 * run always starts from a known state. The UI tests edit captions and styles as
 * part of what they verify, which would otherwise leave the fixtures changed and
 * make the next run behave differently.
 *
 * Usage: node scripts/make-fixtures.mjs
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPLOADS = path.join(ROOT, 'uploads');
const PROJECTS = path.join(ROOT, 'projects');
const VIDEO = 'test-input.mp4';

const WORDS = [
  'yeh', 'template', 'system', 'bilkul', 'insane', 'hai',
  'bhai', 'dekho', 'kaise', 'chalta', 'hai', 'ab'
];

async function ensureVideo() {
  const target = path.join(UPLOADS, VIDEO);
  try {
    await stat(target);
    return;
  } catch { /* needs creating */ }

  await mkdir(UPLOADS, { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5,tremolo=f=1.5:d=0.85',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    target
  ], { maxBuffer: 16 * 1024 * 1024 });
  console.log(`created uploads/${VIDEO}`);
}

function buildProject() {
  const tokens = WORDS.map((text, i) => ({
    id: i + 1,
    text,
    start_ms: 200 + i * 380,
    end_ms: 200 + i * 380 + 330,
    language: 'en',
    contains_urdu_script: false
  }));

  // Only the middle line carries emphasis. A fixture where every line is an
  // emphasis line does not resemble real output and leaves the plain-line path
  // — the one most lines actually take — untested.
  const COMP_TYPES = ['plain', 'emphasis', 'plain'];

  const compositions = [[0, 4], [4, 8], [8, 12]].map(([from, to], index) => {
    const slice = tokens.slice(from, to);
    const hero = slice[2];
    return {
      id: index + 1,
      token_ids: slice.map(t => t.id),
      hero_token_id: hero.id,
      before_token_ids: slice.slice(0, 2).map(t => t.id),
      after_token_ids: slice.slice(3).map(t => t.id),
      hero_text: hero.text,
      before_text: slice.slice(0, 2).map(t => t.text).join(' '),
      after_text: slice.slice(3).map(t => t.text).join(' '),
      comp_type: COMP_TYPES[index],
      start_ms: slice[0].start_ms,
      end_ms: slice[slice.length - 1].end_ms
    };
  });

  return { tokens, compositions };
}

async function main() {
  await ensureVideo();
  await mkdir(PROJECTS, { recursive: true });

  const { tokens, compositions } = buildProject();

  const current = {
    id: 'proj-demo-1',
    version: 2,
    title: 'Demo Reel.mp4',
    videoUrl: `/uploads/${VIDEO}`,
    createdAt: 1700000000000,
    tokens,
    compositions,
    templateId: 'muft-default',
    styleOverrides: {}
  };
  await writeFile(path.join(PROJECTS, 'proj-demo-1.json'), JSON.stringify(current, null, 2));

  // A version-1 project, to keep the migration path covered. These embedded a
  // whole template in a style format the renderer no longer understands.
  const legacy = {
    id: 'proj-legacy-1',
    title: 'Legacy Project.mp4',
    videoUrl: `/uploads/${VIDEO}`,
    createdAt: 1699000000000,
    tokens,
    compositions,
    template: {
      id: 'muft-glow',
      name: 'Muft Glow',
      hero: { color: '#f5b942', fontSize: 120, fontWeight: 800, fontFamily: "'Inter', sans-serif" },
      support: { color: '#FFFFFF', fontSize: 46, fontWeight: 800, fontFamily: "'Inter', sans-serif" }
    }
  };
  await writeFile(path.join(PROJECTS, 'proj-legacy-1.json'), JSON.stringify(legacy, null, 2));

  console.log('fixtures ready: proj-demo-1 (current), proj-legacy-1 (version 1)');
}

main().catch(err => {
  console.error('Could not create fixtures:', err.message);
  process.exit(1);
});
