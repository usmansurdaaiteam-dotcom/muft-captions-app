/**
 * check-emphasis-rate.mjs
 *
 * Reports how often a project actually emphasises a word, and checks it against
 * how often the reference style does.
 *
 * This exists because "the highlights feel too frequent" is not a fixable
 * report. The reference clip highlights one word every 4.3 seconds of speech,
 * measured by scanning every frame for the hero colour: six hero words in
 * twenty-six seconds. That is a number a composition set can be held to.
 *
 * Rate is measured per second of speech rather than as a share of lines. A
 * share-of-lines target quietly becomes a flood on fast speech, because the same
 * minute of talking is cut into far more lines.
 *
 * Usage:
 *   node scripts/check-emphasis-rate.mjs                  every saved project
 *   node scripts/check-emphasis-rate.mjs projects/x.json  specific files
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCompositions,
  buildFallbackCompositions,
  enforceEmphasisBudget,
  REFERENCE_SECONDS_PER_EMPHASIS
} from '../src/composition-engine.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = path.join(ROOT, 'projects');
// How far the rate may drift before it is called wrong. Emphasising less often
// than the reference is a style choice; emphasising much more often is the
// failure this script exists to catch, so the ceiling is the tighter bound.
const MIN_SECONDS_PER_EMPHASIS = 3.0;
const MIN_PLAIN_BETWEEN = 2;

const EMPHATIC = new Set(['emphasis', 'spotlight']);

function analyse(project) {
  const comps = Array.isArray(project.compositions) ? project.compositions : [];
  const tokens = Array.isArray(project.tokens) ? project.tokens : [];
  if (!comps.length) return null;

  const spanMs = Math.max(
    0,
    Math.max(...comps.map(c => c.end_ms || 0)) - Math.min(...comps.map(c => c.start_ms || 0))
  );
  const seconds = spanMs / 1000;

  const marked = comps.filter(c => EMPHATIC.has(c.comp_type));
  const secondsPer = marked.length ? seconds / marked.length : Infinity;

  // Adjacency and spacing.
  const adjacent = [];
  const tooClose = [];
  let lastIndex = -Infinity;
  for (let i = 0; i < comps.length; i++) {
    if (!EMPHATIC.has(comps[i].comp_type)) continue;
    if (i - lastIndex === 1) adjacent.push(i);
    else if (i - lastIndex - 1 < MIN_PLAIN_BETWEEN && lastIndex > -Infinity) tooClose.push(i);
    lastIndex = i;
  }

  // Repeated hero words: emphasising the same word twice spends the effect.
  const textFor = new Map(tokens.map(t => [t.id, String(t.text || '').trim().toLowerCase()]));
  const seen = new Map();
  const repeats = [];
  for (const c of marked) {
    const word = textFor.get(c.hero_token_id);
    if (!word) continue;
    if (seen.has(word)) repeats.push(word);
    else seen.set(word, true);
  }

  return {
    lines: comps.length,
    seconds,
    marked: marked.length,
    secondsPer,
    sharePct: marked.length / comps.length * 100,
    adjacent,
    tooClose,
    repeats: [...new Set(repeats)],
    heroWords: marked.map(c => textFor.get(c.hero_token_id)).filter(Boolean)
  };
}

// ─── Enforcement, checked against cases with known right answers ───────────────

/**
 * A composer can return anything, so the pacing has to hold whatever it says.
 * These cases pin the three behaviours that matter: trim an over-emphasised
 * transcript, place emphasis when there is none at all, and leave a composer
 * that chose fewer moments than the budget allows alone.
 */
function selfTest() {
  const WORDS = ('main aaj aap ko batata hoon ke research kaise karni hai aur uska purpose kya hai ' +
    'trading me analysis zaroori hai 2008 me market crash hua tha aur log million dollars ' +
    'kho baithe the phir research ne unko bacha liya bas yahi baat hai').split(' ');
  const tokens = WORDS.map((text, i) => ({
    id: i + 1, text, start_ms: i * 640, end_ms: i * 640 + 560
  }));

  const groups = [];
  for (let i = 0; i < tokens.length; i += 4) groups.push(tokens.slice(i, i + 4));
  const seconds = (tokens.at(-1).end_ms - tokens[0].start_ms) / 1000;

  const idOf = word => tokens.find(t => t.text === word).id;

  /** Build one composition per group, choosing hero and type per line. */
  const asComps = (heroWord, typeFor) => groups.map((g, i) => {
    const hero = g.find(t => t.text === heroWord(i)) || g[Math.min(2, g.length - 1)];
    return {
      id: i + 1,
      token_ids: g.map(t => t.id),
      hero_token_id: hero.id,
      hero_text: hero.text,
      comp_type: typeFor(i),
      start_ms: g[0].start_ms,
      end_ms: g.at(-1).end_ms
    };
  });

  const rate = comps => {
    const marked = comps.filter(c => EMPHATIC.has(c.comp_type));
    return { count: marked.length, per: marked.length ? seconds / marked.length : Infinity, marked };
  };

  const cases = [];

  // Everything marked emphasis, which is what the old prompt produced.
  const trimmed = buildCompositions(tokens, {
    compositions: groups.map(g => ({
      token_ids: g.map(t => t.id),
      hero_token_id: g[Math.min(2, g.length - 1)].id,
      comp_type: 'emphasis'
    }))
  });
  const t = rate(trimmed);
  cases.push({
    name: `every line marked emphasis (${groups.length} lines, ${seconds.toFixed(0)}s)`,
    ok: t.per >= MIN_SECONDS_PER_EMPHASIS,
    detail: `trimmed to ${t.count}, one every ${t.per.toFixed(1)}s`
  });

  // No composer output at all.
  const fallback = buildFallbackCompositions(tokens);
  const f = rate(fallback);
  cases.push({
    name: 'no composer output, fallback grouping',
    ok: f.count > 0 && f.per >= MIN_SECONDS_PER_EMPHASIS,
    detail: f.count
      ? `placed ${f.count}, one every ${f.per.toFixed(1)}s: ${f.marked.map(c => c.hero_text).join(', ')}`
      : 'placed none, so an emphasis template would render every line plain'
  });

  // A composer that was already more sparing than the budget, with two heroes
  // that genuinely deserve the size and are far enough apart.
  const sparse = enforceEmphasisBudget(
    asComps(i => (i === 1 ? 'research' : i === 7 ? 'million' : null),
      i => (i === 1 || i === 7 ? 'emphasis' : 'plain')),
    tokens);
  const s = rate(sparse);
  cases.push({
    name: 'composer chose 2 where the budget allowed 7',
    ok: s.count === 2 && s.marked.every(c => ['research', 'million'].includes(c.hero_text)),
    detail: `left ${s.count} in place: ${s.marked.map(c => c.hero_text).join(', ') || '(none)'}`
  });

  // Filler words must never be emphasised, even to fill an unspent budget.
  const fillerOnly = enforceEmphasisBudget(
    groups.map((g, i) => ({
      id: i + 1,
      token_ids: g.map(t => t.id),
      hero_token_id: idOf('hai'),
      hero_text: 'hai',
      comp_type: 'emphasis',
      start_ms: g[0].start_ms,
      end_ms: g.at(-1).end_ms
    })), tokens);
  cases.push({
    name: 'every hero is a filler word',
    ok: rate(fillerOnly).count === 0,
    detail: `${rate(fillerOnly).count} emphasised`
  });

  console.log('  enforcement');
  let failed = 0;
  for (const c of cases) {
    if (!c.ok) failed++;
    console.log(`    ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`);
    console.log(`         ${c.detail}`);
  }
  return failed;
}

async function targets() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (args.length) return args.map(a => path.resolve(ROOT, a));
  const files = await readdir(PROJECTS_DIR).catch(() => []);
  return files.filter(f => f.endsWith('.json')).map(f => path.join(PROJECTS_DIR, f));
}

async function run() {
  console.log(`\n  Reference style: one emphasised word every ${REFERENCE_SECONDS_PER_EMPHASIS}s of speech`);
  console.log(`  Flagged if more often than every ${MIN_SECONDS_PER_EMPHASIS}s, ` +
    `or if emphasis lines sit closer than ${MIN_PLAIN_BETWEEN} plain lines apart\n`);

  let failures = selfTest();

  const files = await targets();
  if (!files.length) {
    console.log('\n  No projects to audit. Run `npm run fixtures` or pass a file path.\n');
    return failures ? 1 : 0;
  }
  console.log('\n  saved projects');
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
      console.log(`  SKIP ${name} — no compositions`);
      continue;
    }

    const rateOk = a.secondsPer >= MIN_SECONDS_PER_EMPHASIS;
    const spacingOk = !a.adjacent.length && !a.tooClose.length;
    const repeatsOk = !a.repeats.length;
    const ok = rateOk && spacingOk && repeatsOk;
    if (!ok) failures++;

    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    console.log(`       ${a.lines} lines over ${a.seconds.toFixed(1)}s, ` +
      `${a.marked} emphasised (${a.sharePct.toFixed(0)}% of lines)`);
    console.log(`       ${rateOk ? 'ok  ' : 'FAIL'} one every ` +
      `${a.secondsPer === Infinity ? '∞' : a.secondsPer.toFixed(1)}s ` +
      `(reference ${REFERENCE_SECONDS_PER_EMPHASIS}s)`);
    if (!spacingOk) {
      if (a.adjacent.length) console.log(`       FAIL ${a.adjacent.length} emphasis line(s) directly after another`);
      if (a.tooClose.length) console.log(`       FAIL ${a.tooClose.length} emphasis line(s) with fewer than ${MIN_PLAIN_BETWEEN} plain lines before`);
    }
    if (!repeatsOk) {
      console.log(`       FAIL same word emphasised more than once: ${a.repeats.join(', ')}`);
    }
    if (a.heroWords.length) {
      console.log(`       emphasised: ${a.heroWords.join(', ')}`);
    }

    // A project composed before the pacing rules existed keeps whatever it was
    // saved with, since rewriting it on read would throw away the user's own
    // edits. Showing what enforcement would do makes the difference concrete
    // and says plainly that re-composing is what applies it.
    if (!ok) {
      const fixed = analyse({ ...project, compositions: enforceEmphasisBudget(project.compositions, project.tokens) });
      console.log(`       after re-composing: ${fixed.marked} emphasised, ` +
        `one every ${fixed.secondsPer === Infinity ? '∞' : fixed.secondsPer.toFixed(1)}s` +
        (fixed.heroWords.length ? ` — ${fixed.heroWords.join(', ')}` : ''));
    }
  }

  if (failures) {
    console.log(`\n  ${failures} failure${failures === 1 ? '' : 's'}\n`);
    return 1;
  }
  console.log('\n  emphasis rate and spacing are in line with the reference\n');
  return 0;
}

process.exit(await run());
