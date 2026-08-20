/**
 * check-line-breaks.mjs
 *
 * Checks where a project's caption lines break, against the two things that
 * make burnt-in captions readable:
 *
 *   - a line should not run across a pause in the speech. Breaking where the
 *     speaker breathes is what makes captions feel written rather than chopped
 *     into equal lengths.
 *   - a line should stay on screen long enough to read, and hold few enough
 *     words to take in at a glance.
 *
 * The composer is asked for all of this, but asking is not the same as getting,
 * and the failure is invisible in a still frame — it only shows up as captions
 * that feel slightly wrong to watch.
 *
 * Usage:
 *   node scripts/check-line-breaks.mjs                  every saved project
 *   node scripts/check-line-breaks.mjs projects/x.json  specific files
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = path.join(ROOT, 'projects');

// A pause this long is a sentence or clause boundary; a line should end there.
const PAUSE_MS = 300;
// Below this a line flashes past before it can be read.
const MIN_ON_SCREEN_MS = 600;
// Above this a line is more than a glance can take in.
const MAX_WORDS = 8;
// Share of lines allowed to miss the readability targets. Real speech runs
// together, so a handful of short or long lines is unavoidable; a large share
// means the grouping rules are not being followed at all.
const TOLERATED_SHARE = 0.2;

function analyse(project) {
  const comps = Array.isArray(project.compositions) ? project.compositions : [];
  const tokens = Array.isArray(project.tokens) ? project.tokens : [];
  if (!comps.length || !tokens.length) return null;

  const tokenMap = new Map(tokens.map(t => [t.id, t]));
  const acrossPause = [];
  const tooShort = [];
  const tooLong = [];
  let totalWords = 0;

  comps.forEach((comp, index) => {
    const compTokens = (comp.token_ids || []).map(id => tokenMap.get(id)).filter(Boolean);
    if (!compTokens.length) return;
    totalWords += compTokens.length;

    for (let i = 1; i < compTokens.length; i++) {
      const gap = compTokens[i].start_ms - compTokens[i - 1].end_ms;
      if (gap >= PAUSE_MS) {
        acrossPause.push({
          line: index + 1,
          gap,
          at: `${compTokens[i - 1].text.trim()} | ${compTokens[i].text.trim()}`
        });
      }
    }

    const duration = (comp.end_ms || 0) - (comp.start_ms || 0);
    if (duration < MIN_ON_SCREEN_MS) tooShort.push({ line: index + 1, duration });
    if (compTokens.length > MAX_WORDS) tooLong.push({ line: index + 1, words: compTokens.length });
  });

  return {
    lines: comps.length,
    wordsPerLine: totalWords / comps.length,
    acrossPause,
    tooShort,
    tooLong
  };
}

async function targets() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (args.length) return args.map(a => path.resolve(ROOT, a));
  const files = await readdir(PROJECTS_DIR).catch(() => []);
  return files.filter(f => f.endsWith('.json')).map(f => path.join(PROJECTS_DIR, f));
}

async function run() {
  const files = await targets();
  if (!files.length) {
    console.log('\n  No projects to check. Run `npm run fixtures` or pass a file path.\n');
    return 0;
  }

  console.log(`\n  Lines should end at pauses of ${PAUSE_MS}ms or more, stay up for at least ` +
    `${MIN_ON_SCREEN_MS}ms, and hold at most ${MAX_WORDS} words`);
  console.log(`  Up to ${Math.round(TOLERATED_SHARE * 100)}% of lines may miss the readability targets\n`);

  let failures = 0;
  for (const file of files) {
    const name = path.basename(file);
    let project;
    try {
      project = JSON.parse(await readFile(file, 'utf-8'));
    } catch (err) {
      console.log(`  SKIP ${name} — ${err.message}`);
      continue;
    }

    const a = analyse(project);
    if (!a) {
      console.log(`  SKIP ${name} — nothing to measure`);
      continue;
    }

    const limit = Math.ceil(a.lines * TOLERATED_SHARE);
    const pauseOk = a.acrossPause.length === 0;
    const shortOk = a.tooShort.length <= limit;
    const longOk = a.tooLong.length === 0;
    const ok = pauseOk && shortOk && longOk;
    if (!ok) failures++;

    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    console.log(`       ${a.lines} lines, ${a.wordsPerLine.toFixed(1)} words per line on average`);
    console.log(`       ${pauseOk ? 'ok  ' : 'FAIL'} ${a.acrossPause.length} line(s) run across a pause`);
    for (const p of a.acrossPause.slice(0, 4)) {
      console.log(`            line ${p.line}: ${p.gap}ms pause inside "${p.at}"`);
    }
    console.log(`       ${shortOk ? 'ok  ' : 'FAIL'} ${a.tooShort.length} line(s) on screen under ${MIN_ON_SCREEN_MS}ms` +
      ` (up to ${limit} tolerated)`);
    console.log(`       ${longOk ? 'ok  ' : 'FAIL'} ${a.tooLong.length} line(s) over ${MAX_WORDS} words`);
  }

  if (failures) {
    console.log(`\n  ${failures} project${failures === 1 ? '' : 's'} break lines against the rules\n`);
    return 1;
  }
  console.log('\n  line breaks follow the speech\n');
  return 0;
}

process.exit(await run());
