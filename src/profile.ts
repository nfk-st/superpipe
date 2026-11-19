/**
 * Getting a profile right and sharing it: build has Claude Code write one, check runs it the way a run would,
 * export prints the one superpipe would use for a repo, and import saves one into the operator's own folder.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import { findProfile, isObject, operatorKeys, PERSONAL_REPOS, profileTarget, readJson, remoteKey, remoteSlug, resolveConfig, type Json } from './config.ts';
import { SUPERPIPE_HOME } from './driver.ts';
import * as g from './git.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKS = join(SUPERPIPE_HOME, 'checks');

const readIfExists = (file: string) => (existsSync(file) ? readFile(file, 'utf8') : Promise.resolve(undefined));

/** Claude Code writes or revises the repo's profile with the operator at the keyboard, then the profile is checked. */
export async function buildProfile(repo: string) {
  const origin = (await g.git(repo, ['remote', 'get-url', 'origin']).catch((e: Error) => {
    throw new Error(`A profile is matched by the repo's origin remote, and ${repo} has none: ${e.message}`);
  })).trim();
  const target = await profileTarget(origin);
  const current = await findProfile(repo).catch(() => undefined);
  const lastCheck = join(CHECKS, `${remoteSlug(origin)}.log`);
  const prompt = [
    `Write the profile to: ${target}`,
    `superpipe's README, whose "Profiles" section documents every field: ${join(ROOT, 'README.md')}`,
    ...(current ? [`Start from the current profile: ${current.file}`] : []),
    ...(existsSync(lastCheck) ? [`The last \`superpipe profile check\` failed. Its log: ${lastCheck}`] : []),
    '',
    await readFile(join(ROOT, 'prompts', 'profile.md'), 'utf8'),
  ].join('\n');

  await mkdir(PERSONAL_REPOS, { recursive: true });
  const before = await readIfExists(target);
  const bin = process.env.CLAUDE_BIN ?? 'claude';
  await new Promise<void>((resolve, reject) => {
    // No --add-dir for the profile folder: it opens the session on a trust prompt of its own. Claude asks once, when it writes.
    const child = spawn(bin, [prompt], { cwd: repo, stdio: 'inherit' });
    child.on('error', (e) => reject(new Error(`Couldn't start ${bin}: ${e.message}. Building a profile needs Claude Code on your PATH.`)));
    child.on('close', () => resolve());
  });

  const after = await readIfExists(target);
  if (after === undefined || after === before) throw new Error(`Claude didn't write or change ${target}. To check it as it is, run \`superpipe profile check\`.`);
  const written = await readJson(target);
  if (typeof written.remote !== 'string' || remoteKey(written.remote) !== remoteKey(origin)) {
    throw new Error(`${target} has remote ${JSON.stringify(written.remote)}, but this repo's origin is ${origin}.`);
  }
  console.log(`\nWrote ${target}. Checking it.\n`);
  await checkProfile(repo);
}

/** A project id names a project in one Paradev install, so it never travels with a shared profile. */
function withoutProjectId(p: Json): { profile: Json; dropped: boolean } {
  if (!isObject(p.paradev) || !('projectId' in p.paradev)) return { profile: p, dropped: false };
  const { projectId: _id, ...paradev } = p.paradev;
  const { paradev: _old, ...rest } = p;
  return { profile: Object.keys(paradev).length ? { ...rest, paradev } : rest, dropped: true };
}

export async function exportProfile(repo: string) {
  const { profile } = await findProfile(repo);
  console.log(JSON.stringify(withoutProjectId(profile).profile, null, 2));
}

export async function importProfile(file: string) {
  const parsed = await readJson(file);
  if (!isObject(parsed) || typeof parsed.remote !== 'string') throw new Error(`${file} isn't a profile: it needs a "remote" string.`);
  const owned = operatorKeys(parsed, false);
  if (owned.length) throw new Error(`${file} sets ${owned.join(', ')}. The lineup, gates, limits and timeouts are each operator's own, so a profile can't set them.`);
  const { profile, dropped } = withoutProjectId(parsed);
  if (dropped) console.warn('Dropped paradev.projectId: it names a project in one Paradev install.');
  const target = await profileTarget(parsed.remote);
  const existed = existsSync(target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(profile, null, 2)}\n`);
  console.log(`${existed ? 'Replaced' : 'Saved'} ${target}`);
}

/** Also clears what a check killed mid-run leaves: a registered worktree, a bare folder, or a registration whose folder is gone. */
async function clearWorktree(repo: string, dir: string) {
  if (existsSync(dir)) await g.git(repo, ['worktree', 'remove', '--force', dir]).catch(() => rm(dir, { recursive: true, force: true }));
  await g.git(repo, ['worktree', 'prune']);
}

/**
 * Runs the profile's setup, test and checks in a fresh worktree of the base branch, as a run would.
 * Not the main checkout: its gitignored build output can hide a step that setup is missing.
 */
export async function checkProfile(repo: string) {
  const cfg = await resolveConfig(repo);
  const dir = join(CHECKS, remoteSlug(await g.git(repo, ['remote', 'get-url', 'origin'])));
  const logFile = `${dir}.log`;
  const base = cfg.ship?.baseBranch ?? (await g.defaultBranch(repo));
  // start refuses a local base that differs from origin's, so origin's is the code a run would test.
  const ref = await g.git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]).then(() => `origin/${base}`, () => base);
  console.log(`Profile ${cfg.profile}`);
  console.log("Not covered: a re-run of a failing test command, stages.<stage>.checks, and the repo's own Paradev setup script.");
  await mkdir(CHECKS, { recursive: true });
  await rm(logFile, { force: true });
  await clearWorktree(repo, dir);
  await g.git(repo, ['worktree', 'add', '--detach', dir, ref]);
  try {
    console.log(`Worktree ${dir} at ${ref} (${(await g.head(dir)).slice(0, 8)})`);
    const isTest = picomatch(cfg.paths.tests, { dot: true });
    const tests = (await g.git(dir, ['ls-files', '-z'])).split('\0').filter((f) => f && isTest(f)).length;
    console.log(tests ? `paths.tests matches ${tests} tracked file(s)` : 'Warning: paths.tests matches no tracked file. Check it against where the repo keeps its tests.');
    if (cfg.setupReadyFile) console.warn(`Warning: skipping setupReadyFile (${cfg.setupReadyFile}). It waits for Paradev's own setup script, which doesn't run here.`);
    const run = async (cmd: string) => {
      // Before, not after: g.sh holds the output until the command ends, and setup can take minutes.
      console.log(`→ ${cmd}`);
      const t0 = Date.now();
      const r = await g.sh(cmd, dir);
      const secs = Math.round((Date.now() - t0) / 1000);
      if (r.code === 0) return console.log(`  passed in ${secs}s`);
      await writeFile(logFile, r.output);
      throw new Error(`\`${cmd}\` failed (exit ${r.code}) after ${secs}s. Full log: ${logFile}. Last lines:\n\n${g.tail(r.output, 40)}`);
    };
    if (cfg.setup) await run(cfg.setup);
    const dirty = await g.changedFiles(dir, 'HEAD');
    if (dirty.length) throw new Error(`Setup left files that aren't ignored, so every stage's write policy would reject them: ${dirty.join(', ')}. Make setup write only ignored files.`);
    for (const cmd of [cfg.commands.test, ...(cfg.commands.checks ?? [])]) await run(cmd);
    console.log('\nProfile check passed.');
  } finally {
    await clearWorktree(repo, dir);
  }
}
