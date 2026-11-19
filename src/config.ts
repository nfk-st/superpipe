/**
 * Where a run's config comes from, each layer merged over the one before: superpipe's `defaults.json`,
 * the operator's own `config.json`, the spec preset, then the repo's profile. A profile is found by the
 * repo's `origin` remote, among the operator's personal profiles first and then superpipe's team ones.
 * The resolved config is frozen into the run directory at start, so no later edit to any layer changes
 * a run already under way.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDir, SUPERPIPE_HOME } from './driver.ts';
import * as g from './git.ts';
import type { Config } from './types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEAM_REPOS = process.env.PIPELINE_REPOS_DIR ?? join(ROOT, 'repos');
export const PERSONAL_REPOS = join(SUPERPIPE_HOME, 'repos');
const DEFAULTS_FILE = join(ROOT, 'defaults.json');
const OPERATOR_FILE = join(SUPERPIPE_HOME, 'config.json');

export type Json = Record<string, unknown>;

/** Names the file on a parse error: profile lookup parses every profile, so one bad file breaks it for every repo. */
export async function readJson(file: string): Promise<Json> {
  const text = await readFile(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} isn't valid JSON: ${(e as Error).message}`);
  }
}
export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Objects merge key by key; anything else, arrays included, is replaced by the later layer.
 * So is an `author`: an operator's codex author must not inherit the default's Claude model.
 */
export function merge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k !== 'author' && isObject(v) && isObject(out[k]) ? merge(out[k] as Json, v) : v;
  return out;
}

/** `git@host:org/repo.git`, `ssh://git@host/org/repo` and `https://host/org/repo` all key as `host/org/repo`. A local path keys as itself. */
export function remoteKey(url: string): string {
  const u = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const scheme = u.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?(.+)$/i);
  const scp = scheme ? null : u.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
  return (scheme ? scheme[1] : scp ? `${scp[1]}/${scp[2]}` : u).toLowerCase();
}

/** The first profile in `dir`, in file-name order, whose remote keys as `want`. */
async function firstMatch(dir: string, want: string): Promise<{ file: string; profile: Json } | undefined> {
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith('.json')).sort() : [];
  for (const f of files) {
    const profile = await readJson(join(dir, f));
    if (typeof profile.remote === 'string' && remoteKey(profile.remote) === want) return { file: join(dir, f), profile };
  }
  return undefined;
}

/** Personal profiles first, so an operator can stand in for a broken team profile without waiting for its fix. */
export async function findProfile(repo: string): Promise<{ file: string; profile: Json; team: boolean }> {
  const origin = await g.git(repo, ['remote', 'get-url', 'origin']).catch((e: Error) => {
    throw new Error(`A profile is matched by the repo's origin remote, and ${repo} has none: ${e.message}`);
  });
  const want = remoteKey(origin);
  for (const dir of [PERSONAL_REPOS, TEAM_REPOS]) {
    const hit = await firstMatch(dir, want);
    if (hit) return { ...hit, team: dir === TEAM_REPOS };
  }
  throw new Error(`No profile in ${PERSONAL_REPOS} or ${TEAM_REPOS} whose "remote" is ${want}, the origin of ${repo}.`);
}

/**
 * Where a built or imported profile is saved: over the personal profile that already matches, since a second
 * one could sort first and silently outrank it. Otherwise a file named for the whole remote, so no two remotes share one.
 */
export async function profileTarget(remote: string): Promise<string> {
  return (await firstMatch(PERSONAL_REPOS, remoteKey(remote)))?.file ?? join(PERSONAL_REPOS, `${remoteSlug(remote)}.json`);
}

/** A file name for the whole remote: `git@github.com:Org/Repo.git` → `github-com-org-repo`. */
export const remoteSlug = (remote: string) => remoteKey(remote).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** What a profile may not set: the lineup, gates, limits and timeouts follow the operator's accounts and taste, not the repo. */
export function operatorKeys(profile: Json, team: boolean): string[] {
  const keys = ['gates', 'limits'].filter((k) => k in profile);
  for (const [stage, sc] of Object.entries(isObject(profile.stages) ? profile.stages : {})) {
    if (isObject(sc)) keys.push(...['author', 'reviewers', 'timeoutSec'].filter((k) => k in sc).map((k) => `stages.${stage}.${k}`));
  }
  // A project id names a project in one Paradev install, so every teammate's differs.
  if (team && isObject(profile.paradev) && 'projectId' in profile.paradev) keys.push('paradev.projectId');
  return keys;
}

const SPEC_CHANGE = 'openspec/changes/{slug}';

/** Spec formats. A markdown profile names its own spec paths. */
const PRESETS: Record<NonNullable<Config['preset']>, Json> = {
  markdown: {},
  openspec: {
    paths: { spec: [`${SPEC_CHANGE}/**`], specDoc: `${SPEC_CHANGE}/` },
    stages: {
      // `validate` never reads proposal.md, and `--type change` stops it checking that one exists.
      spec: { extraForbidden: [`${SPEC_CHANGE}/tasks.md`], checks: [`test -s ${SPEC_CHANGE}/proposal.md`, 'openspec validate {slug} --type change --strict'] },
      // Living specs are synced when a change is archived, after it merges, so implement may only write its own tasks.
      implement: { extraForbidden: ['openspec/**'], forbiddenExcept: [`${SPEC_CHANGE}/tasks.md`], checks: [`test -s ${SPEC_CHANGE}/tasks.md`] },
    },
  },
};

const REQUIRED = ['commands.test', 'paths.spec', 'paths.specDoc', 'paths.tests', 'stages'];

export async function resolveConfig(repo: string): Promise<Config> {
  const { file, profile, team } = await findProfile(repo);
  const { remote: _remote, ...facts } = profile;
  const owned = operatorKeys(facts, team);
  if (owned.length) {
    throw new Error(`${file} sets ${owned.join(', ')}. The lineup, gates, limits and timeouts are each operator's own, in ${OPERATOR_FILE}, and a team profile can't name one Paradev install's project.`);
  }
  const preset = (facts.preset ?? 'markdown') as string;
  if (!Object.hasOwn(PRESETS, preset)) throw new Error(`${file} has preset "${preset}"; use ${Object.keys(PRESETS).join(' or ')}.`);
  const operator = existsSync(OPERATOR_FILE) ? await readJson(OPERATOR_FILE) : {};
  const cfg = merge(merge(merge(await readJson(DEFAULTS_FILE), operator), PRESETS[preset as keyof typeof PRESETS]), { ...facts, preset, profile: file });
  const missing = REQUIRED.filter((path) => path.split('.').reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), cfg) === undefined);
  if (missing.length) throw new Error(`${file} is missing ${missing.join(', ')} (and neither ${DEFAULTS_FILE} nor ${OPERATOR_FILE} supplies them).`);
  return cfg as unknown as Config;
}

export const freezeConfig = (id: string, cfg: Config) => writeFile(join(runDir(id), 'config.json'), JSON.stringify(cfg, null, 2));
export const frozenConfig = async (id: string) => (await readJson(join(runDir(id), 'config.json'))) as unknown as Config;
