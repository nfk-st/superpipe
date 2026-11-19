#!/usr/bin/env node
// Lists doc cites (`driver.ts:417`) that uncommitted changes to superpipe's own src and test files have moved.
// Usage: node test/cites.mjs [--staged]. Exits 1 when a cite needs re-pointing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const staged = process.argv.includes('--staged');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: 'pipe' });
const show = (rev, path) => { try { return git('show', `${rev}:${path}`); } catch { return null; } };
const current = (path) => { try { return staged ? show('', path) : readFileSync(path, 'utf8'); } catch { return null; } };

// PLAN.md is a finished plan: its cites record the code it was written against.
const DOCS = ['HANDOFF.md', 'README.md'];
const files = new Map(git('ls-files', 'src', 'test').split('\n').filter(Boolean).map((p) => [basename(p), p]));
// A bare name or a src/ or test/ path. A longer path, like a target repo's helpers/git.ts, is someone else's file.
const CITE = /(?<![\w/.-])(?:src\/|test\/)?([\w.-]+\.(?:ts|mjs|sh)):(\d+)(?:-(\d+))?/g;

// Each changed file's hunks, as [oldStart, oldCount, newCount].
const hunks = new Map();
let file;
const diff = git('diff', ...(staged ? ['--cached'] : ['HEAD']), '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--', 'src', 'test');
for (const line of diff.split('\n')) {
  const to = line.match(/^\+\+\+ b\/(.+)$/);
  if (to) hunks.set((file = to[1]), []);
  const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
  if (h && hunks.has(file)) hunks.get(file).push([+h[1], h[2] === undefined ? 1 : +h[2], h[3] === undefined ? 1 : +h[3]]);
}

/** Where old line n is now, or null if the change rewrote it. */
function moved(path, n) {
  let delta = 0;
  for (const [start, count, newCount] of hunks.get(path)) {
    // A zero-length old range is an insertion after line `start`.
    if (count === 0 ? start < n : start + count - 1 < n) delta += newCount - count;
    else if (count > 0 && n >= start) return null;
  }
  return n + delta;
}

const fixes = [];
const unsure = [];
for (const doc of DOCS) {
  const before = show('HEAD', doc);
  const now = current(doc);
  if (before === null || now === null) continue;
  const lineNo = new Map();
  now.split('\n').forEach((l, i) => { if (!lineNo.has(l)) lineNo.set(l, i + 1); });
  for (const line of new Set(before.split('\n'))) {
    // A line rewritten since HEAD has had its author's eyes on it, so only untouched lines are checked.
    const at = lineNo.get(line);
    if (!at) continue;
    for (const [cite, name, a, b] of line.matchAll(CITE)) {
      const path = files.get(name);
      if (!path || !hunks.has(path)) continue;
      const na = moved(path, +a);
      const nb = b === undefined ? undefined : moved(path, +b);
      if (na === null || nb === null) unsure.push(`${doc}:${at}: ${cite} points into changed lines; check it by hand`);
      else if (na !== +a || (b !== undefined && nb !== +b)) fixes.push(`${doc}:${at}: ${cite} → ${cite.replace(/:[\d-]+$/, `:${na}${b === undefined ? '' : `-${nb}`}`)}`);
    }
  }
}

if (fixes.length) console.log(`These doc cites point at lines your change moved. Re-point them${staged ? ', or commit with --no-verify' : ''}:\n${fixes.join('\n')}`);
if (unsure.length) console.log(unsure.join('\n'));
process.exit(fixes.length ? 1 : 0);
