import { execFile, spawn } from 'node:child_process';

export function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')}: ${String(stderr || err.message).trim()}`));
      else resolve(String(stdout));
    });
  });
}

export const head = async (dir: string) => (await git(dir, ['rev-parse', 'HEAD'])).trim();

/** Back to `sha`, discarding tracked and untracked changes. Ignored files (.pipeline/run) survive. */
export async function resetHard(dir: string, sha: string) {
  await git(dir, ['reset', '--hard', sha]);
  await git(dir, ['clean', '-fd']);
}

/** Every path that differs from `base`: committed, staged, unstaged and untracked. `-z`: a quoted non-ASCII path matches no glob. */
export async function changedFiles(dir: string, base: string): Promise<string[]> {
  const tracked = await git(dir, ['diff', '--name-only', '--no-renames', '-z', base]);
  const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))];
}

export async function isClean(dir: string) {
  return (await git(dir, ['status', '--porcelain', '--untracked-files=all'])).trim() === '';
}

/** Commits everything, or nothing when nothing is staged: an empty commit only clutters the PR. */
export async function commitAll(dir: string, message: string): Promise<{ sha: string; committed: boolean }> {
  await git(dir, ['add', '-A']);
  // Not `status`: it lists a dirty submodule with nothing staged, and the commit would then fail.
  if (await gitTest(dir, ['diff', '--cached', '--quiet'])) return { sha: await head(dir), committed: false };
  // No hooks at all: the driver runs the project's checks itself, and a hook failing or hanging here would
  // wedge the pipeline with no agent around to fix it. --no-verify alone still runs prepare-commit-msg.
  await git(dir, ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', message]);
  return { sha: await head(dir), committed: true };
}

/** Outside `refs/tags/`, so a run leaves nothing in `git tag` or `git push --tags`. */
export const checkpoint = (dir: string, runId: string, name: string) => git(dir, ['update-ref', `refs/superpipe/${runId}/${name}`, 'HEAD']);

/** A run's highest-numbered `<nn>-<stage>` checkpoint and its commit, or undefined if that stage never advanced. */
export async function latestCheckpoint(dir: string, runId: string, stage: string): Promise<{ ref: string; commit: string } | undefined> {
  const seq = (r: string) => Number(r.slice(r.lastIndexOf('/') + 1).split('-')[0]);
  const refs = (await git(dir, ['for-each-ref', '--format=%(refname)', `refs/superpipe/${runId}`])).split('\n').filter((r) => r.endsWith(`-${stage}`));
  const ref = refs.sort((a, b) => seq(a) - seq(b)).at(-1);
  return ref ? { ref, commit: (await git(dir, ['rev-parse', `${ref}^{commit}`])).trim() } : undefined;
}

/** Not `<nn>-<stage>`, so `latestCheckpoint` never takes a saved draft for an advance. */
const draftRef = (runId: string, stage: string) => `refs/superpipe/${runId}/drafts/${stage}`;

/** Saves HEAD plus the worktree's changes, except `skip`, as the stage's draft. Leaves HEAD and the worktree as they were. */
export async function saveDraft(dir: string, runId: string, stage: string, skip: string[], message: string) {
  await git(dir, ['add', '-A']);
  if (skip.length) await git(dir, ['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', ...skip]);
  const tree = (await git(dir, ['write-tree'])).trim();
  const commit = (await git(dir, ['commit-tree', tree, '-p', 'HEAD', '-m', message])).trim();
  await git(dir, ['update-ref', draftRef(runId, stage), commit]);
  await git(dir, ['reset', '-q']);
  return draftRef(runId, stage);
}

export async function savedDraft(dir: string, runId: string, stage: string): Promise<{ ref: string; commit: string } | undefined> {
  const ref = draftRef(runId, stage);
  const commit = (await git(dir, ['for-each-ref', '--format=%(objectname)', ref])).trim();
  return commit ? { ref, commit } : undefined;
}

export const dropDraft = (dir: string, runId: string, stage: string) => git(dir, ['update-ref', '-d', draftRef(runId, stage)]);

export const treeOf = async (dir: string, rev: string) => (await git(dir, ['rev-parse', `${rev}^{tree}`])).trim();

/** Paths that differ between two commits, with their A/M/D status. `-z`: without it git quotes non-ASCII paths. */
export async function diffNameStatus(dir: string, from: string, to: string): Promise<{ status: string; path: string }[]> {
  const parts = (await git(dir, ['diff', '--name-status', '--no-renames', '-z', from, to])).split('\0');
  const out: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i], path: parts[i + 1] });
  return out;
}

/** Makes `paths` match `source` in the index and worktree, deleting those it lacks. Literal: `[id].vue` isn't a glob. */
export const restorePaths = (dir: string, source: string, paths: string[]) =>
  git(dir, ['--literal-pathspecs', 'restore', `--source=${source}`, '--staged', '--worktree', '--', ...paths]);

/** A git command whose exit status is the answer: 0 is yes, 1 is no. `git()` would treat 1 as a failure. */
function gitTest(dir: string, args: string[]): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], (err, _stdout, stderr) => {
      if (!err) resolve(true);
      else if ((err as { code?: unknown }).code === 1) resolve(false);
      else reject(new Error(`git ${args.join(' ')}: ${String(stderr || err.message).trim()}`));
    });
  });
}

/** Whether git ignores `path`, which needn't exist yet. A tracked file counts as not ignored. */
export const isIgnored = (dir: string, path: string) => gitTest(dir, ['check-ignore', '-q', path]);

/** Whether `a` is `b` or an ancestor of it. */
export const isAncestor = (dir: string, a: string, b: string) => gitTest(dir, ['merge-base', '--is-ancestor', a, b]);

export async function defaultBranch(dir: string) {
  try {
    return (await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '');
  } catch {
    return 'main';
  }
}

/** Run a shell command, interleaving stdout and stderr like a terminal would. */
export function sh(cmd: string, cwd: string, timeoutMs = 30 * 60 * 1000): Promise<{ code: number; output: string; killed: boolean }> {
  return new Promise((resolve) => {
    // OpenSpec stands down for CI=true only, not CI=1.
    const child = spawn('/bin/sh', ['-c', cmd], { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0', OPENSPEC_TELEMETRY: '0' } });
    let output = '', killed = false;
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => { killed = true; output += `\n[driver] killed after ${timeoutMs / 1000}s`; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output, killed }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, output: output + String(e), killed }); });
  });
}

export const tail = (s: string, lines: number) => s.split('\n').slice(-lines).join('\n');
