import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as g from './git.ts';
import * as sup from './paradev.ts';
import { freezeConfig, frozenConfig, resolveConfig } from './config.ts';
import { buildProfile, checkProfile, exportProfile, importProfile } from './profile.ts';
import { claimRun, drive, freezePrompts, jumpTo, jumpToDraft, load, releaseDenies, runDir, save, setUp, superpipeCommit } from './driver.ts';
import { supervise } from './supervise.ts';
import { STAGES, isStage, type AgentSpec, type Config, type RunState } from './types.ts';

const USAGE = `
superpipe start  --slug <name> --brief <file.md> [--repo <path>] [--branch <name>]
superpipe resume <run-id> [--approve] [--note "..."] [--goto <stage>] [--keep-work]
superpipe status <run-id>
superpipe log    <run-id> [--verdicts]
superpipe config [--repo <path>]
superpipe profile        [--repo <path>]
superpipe profile check  [--repo <path>]
superpipe profile export [--repo <path>]
superpipe profile import <file>
superpipe probe --workspace <ws-id> --agent <preset|uuid> [--model m] [--effort e] [--mode verdict|idle|hang] [--stall-sec n]

Stages: ${STAGES.join(' → ')}
`;

async function resolveProject(repo: string): Promise<string> {
  const want = await realpath(repo);
  const projects = await sup.projectsList();
  for (const p of projects) {
    const path = p.repoPath ?? p.path;
    if (path && (await realpath(path).catch(() => path)) === want) return p.id;
  }
  throw new Error(`No Paradev project on this host for ${want}. Known: ${projects.map((p) => `${p.name} (${p.repoPath ?? p.path})`).join(', ')}. Add the repo to Paradev as a project, or set paradev.projectId in a personal profile.`);
}

async function start(o: { slug?: string; brief?: string; repo?: string; branch?: string }) {
  if (!o.slug || !o.brief) throw new Error(USAGE);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(o.slug)) throw new Error('--slug must be lowercase letters, digits and dashes');
  const repo = resolve(o.repo ?? '.');
  const cfg = await resolveConfig(repo);
  warnSameModel(cfg);
  const brief = await readFile(o.brief, 'utf8');
  const projectId = cfg.paradev?.projectId ?? (await resolveProject(repo));
  const baseBranch = cfg.ship?.baseBranch ?? (await g.defaultBranch(repo));
  const branch = o.branch ?? o.slug;
  await g.git(repo, ['check-ref-format', '--branch', branch]).catch(() => { throw new Error(`--branch ${branch} isn't a valid git branch name`); });
  await checkAgentTrust(repo, cfg);
  if (cfg.preset === 'openspec') await openspecPreflight(repo, o.slug, baseBranch);
  await checkBaseCurrent(repo, baseBranch);

  const ws = await sup.workspaceCreate({ projectId, name: o.slug, branch, baseBranch });
  if (ws.alreadyExists) throw new Error(`A workspace for ${branch} already exists. Resume its run, or archive it first.`);
  const dir = await sup.workspaceField(ws.id, 'worktreePath');
  const baseSha = await g.head(dir);

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const st: RunState = {
    id: `${o.slug}-${stamp}`, slug: o.slug, repo, dir, workspaceId: ws.id,
    branch: (await sup.workspaceField(ws.id, 'branch').catch(() => branch)) || branch,
    baseBranch, baseSha, brief, superpipe: await superpipeCommit(), setupDone: false,
    current: 'spec', status: 'running', attempts: 0, transitions: 0, seq: 0,
    stageStart: { spec: baseSha }, feedback: [], notes: [], history: [], activeTerminals: [],
  };
  // Saved before anything that can fail, so the new workspace always has a run to resume.
  await save(st);
  await claimRun(st.id);
  console.log(`Run ${st.id}\nProfile ${cfg.profile}\nWorkspace ${ws.id}\nWorktree ${dir}\n`);
  await freezeConfig(st.id, cfg);
  await freezePrompts(st.id);
  if (!(await setUp(st, cfg))) return;
  await drive(st, cfg);
}

/**
 * Claude Code and Codex ask whether to trust a repo before anything reports "needs input", so an untrusted
 * repo's first stage on either waits on the prompt unseen. Both key a worktree's trust to its main checkout,
 * and Codex ignores a trusted parent folder.
 */
const TRUST = {
  claude: {
    name: 'Claude Code',
    env: 'PIPELINE_CLAUDE_CONFIG',
    file: process.env.PIPELINE_CLAUDE_CONFIG ?? join(homedir(), '.claude.json'),
    trusted: (text: string, repo: string) => JSON.parse(text).projects?.[repo]?.hasTrustDialogAccepted === true,
  },
  codex: {
    name: 'Codex',
    env: 'PIPELINE_CODEX_CONFIG',
    file: process.env.PIPELINE_CODEX_CONFIG ?? join(homedir(), '.codex', 'config.toml'),
    // No TOML parser here: each chunk is one table, running until the next header.
    trusted: (text: string, repo: string) => text.split(/^\[/m).some((t) => t.startsWith(`projects.${JSON.stringify(repo)}]`) && /^trust_level\s*=\s*"trusted"/m.test(t)),
  },
};

async function checkAgentTrust(repo: string, cfg: Config) {
  const agents = new Set(STAGES.flatMap((s) => [cfg.stages[s].author, ...(cfg.stages[s].reviewers ?? [])]).map((a) => a?.agent));
  const real = await realpath(repo);
  for (const [agent, t] of Object.entries(TRUST)) {
    if (!agents.has(agent)) continue;
    // No file means the tool has never trusted any repo here, or isn't installed: either way its first stage would hang or fail.
    if (!existsSync(t.file)) {
      throw new Error(`The lineup uses ${t.name}, and ${t.file} doesn't exist, so it has never trusted a repo on this machine. Run \`${agent}\` in ${real} once and accept the prompt, or set ${t.env} if your ${t.name} config lives elsewhere, then start again.`);
    }
    if (!t.trusted(await readFile(t.file, 'utf8'), real)) {
      throw new Error(`${t.name} hasn't trusted ${real}, so its first stage would sit on a trust prompt with nothing reporting it. Run \`${agent}\` in ${real} once, accept the prompt, then start again.`);
    }
  }
}

/** A reviewer on the model of the author it reviews shares that author's blind spots. A warning, since a single-model lineup is the operator's call. */
function warnSameModel(cfg: Config) {
  const key = (a: AgentSpec) => `${a.agent}:${a.model ?? ''}`;
  for (const s of STAGES) {
    const author = cfg.stages[s].author ?? (s === 'review' ? cfg.stages.implement.author : undefined);
    if (!author) continue;
    for (const r of cfg.stages[s].reviewers ?? []) {
      if (key(r) === key(author)) console.warn(`Warning: ${s}'s reviewer ${r.label ?? (r.model ? `${r.agent}:${r.model}` : r.agent)} runs the same model as the author it reviews.`);
    }
  }
}

/** Each of these would otherwise surface only once a workspace exists and the spec author is running. */
async function openspecPreflight(repo: string, slug: string, baseBranch: string) {
  // OpenSpec's change-name grammar (change-utils.js), stricter than the driver's.
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug)) throw new Error('--slug must be an OpenSpec change name: a letter first, then lowercase letters and digits in dash-separated words');
  const has = async (path: string) => (await g.git(repo, ['ls-tree', '--name-only', baseBranch, path])).trim() !== '';
  if (await has(`openspec/specs/${slug}`)) throw new Error(`${baseBranch} already has openspec/specs/${slug}. Pick another slug.`);
  // A proposal merged ahead of its code is the spec stage's first draft.
  if (await has(`openspec/changes/${slug}`)) console.log(`${baseBranch} already has openspec/changes/${slug}, so the spec stage starts from it.`);
  const v = await g.sh('openspec --version', repo);
  if (v.code !== 0) throw new Error(`The openspec preset needs the openspec CLI on PATH: ${v.output.trim()}`);
}

/** The PR merges into origin's base branch, so the run must start from exactly that, whichever ref Paradev forks from. */
async function checkBaseCurrent(repo: string, base: string) {
  const remote = `origin/${base}`;
  await g.git(repo, ['fetch', '--quiet', 'origin', base]).catch((e: Error) => console.warn(`Couldn't fetch ${remote}, so ${base} is checked against the last fetch: ${e.message}`));
  const exists = (ref: string) => g.git(repo, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false);
  if (!(await exists(`refs/heads/${base}`)) || !(await exists(`refs/remotes/${remote}`))) return;
  const [ahead, behind] = (await g.git(repo, ['rev-list', '--left-right', '--count', `${base}...${remote}`])).trim().split(/\s+/).map(Number);
  if (!ahead && !behind) return;
  const worktrees = (await g.git(repo, ['worktree', 'list', '--porcelain'])).split('\n\n');
  const where = worktrees.find((w) => w.split('\n').includes(`branch refs/heads/${base}`))?.match(/^worktree (.+)$/m)?.[1];
  const [state, fix] = ahead && behind
    ? [`has diverged from ${remote} (${ahead} ahead, ${behind} behind)`, `Rebase it onto ${remote}${where ? ` in ${where}` : ''}`]
    : ahead
      ? [`has ${ahead} commit(s) that aren't on ${remote}, which would ride into the PR`, `Push them, or move them off ${base}`]
      : [`is ${behind} commit(s) behind ${remote}`, `Fast-forward it: \`${where ? `git -C ${where} merge --ff-only ${remote}` : `git -C ${repo} fetch origin ${base}:${base}`}\``];
  throw new Error(`${base} ${state}. A run must start from exactly the code its PR merges into. ${fix}, then start again.`);
}

/** Run one agent through the driver's real supervision code, outside any pipeline run. */
async function probe(o: { workspace?: string; agent?: string; model?: string; effort?: string; mode?: string; 'stall-sec'?: string }) {
  if (!o.workspace || !o.agent) throw new Error(USAGE);
  const mode = o.mode ?? 'verdict';
  const dir = await sup.workspaceField(o.workspace, 'worktreePath');
  await mkdir(join(dir, '.pipeline/run'), { recursive: true });
  await writeFile(join(dir, '.pipeline/run/.gitignore'), '*\n');
  const rel = '.pipeline/run/verdict-probe.json';
  await rm(join(dir, rel), { force: true });
  const json = JSON.stringify({ stage: 'spec', verdict: 'advance', summary: 'probe', reason: 'probe' });
  const write = `write exactly this JSON on one line to the file ${rel}, then stop: ${json}`;
  const prompt = mode === 'idle'
    ? 'Reply with the single word hello. Do not create or modify any files.'
    : mode === 'hang'
      // opencode kills a shell command after 120s by default, so the stall must fire first:
      // run with PIPELINE_POLL_MS=1000 and --stall-sec 20 or less.
      ? `Run exactly this shell command and wait for it to finish: sleep 900. Then ${write}`
      : `Do nothing except this: ${write}`;

  const strategy = (await sup.hasAgentsWait()) ? 'agents wait, or polling if it reports no state' : 'polling';
  console.log(`Probing ${o.agent}${o.model ? `:${o.model}` : ''} (mode: ${mode}, supervision: ${strategy})`);
  const t0 = Date.now();
  const { sessionId } = await sup.agentsCreate({ agent: o.agent, model: o.model, effort: o.effort, workspaceId: o.workspace, prompt });
  console.log(`terminal ${sessionId}`);
  try {
    const r = await supervise({
      workspaceId: o.workspace, terminalId: sessionId, label: o.agent, stage: 'spec',
      verdictAbs: join(dir, rel), timeoutSec: 600, humanWaitSec: 600,
      stallSec: Number(o['stall-sec'] ?? 60),
      nudgeText: `Now ${write}`,
      invalidText: (e) => `That file is invalid (${e}). Now ${write}`,
      log: async (m) => console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s ${m}`),
      onBlocked: async () => console.log('  agent is waiting for input'),
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(r.kind === 'verdict' ? `\nPASS after ${secs}s: got a valid verdict` : `\nFAIL after ${secs}s${r.fatal ? ' (fatal)' : ''}: ${r.reason}`);
  } finally {
    await sup.terminalsClose(o.workspace, sessionId).catch(() => undefined);
    await rm(join(dir, rel), { force: true });
  }
}

async function resume(id: string, o: { approve?: boolean; note?: string; goto?: string; 'keep-work'?: boolean }) {
  const st = await load(id);
  if (st.status === 'done') throw new Error('That run is already done.');
  await claimRun(id);
  // No stage runs before setup succeeds, so a profile fixed after a failed setup can still apply.
  const cfg = st.setupDone === false ? await resolveConfig(st.repo) : await frozenConfig(id);
  const now = await superpipeCommit();
  if (st.setupDone === false) {
    await freezeConfig(id, cfg);
    await freezePrompts(id);
    st.superpipe = now;
  } else if (st.superpipe && now && now !== st.superpipe) {
    console.warn(`Warning: superpipe has moved from ${st.superpipe.slice(0, 8)} to ${now.slice(0, 8)} since this run started. Its prompts and config are frozen, but the driver running it is the new one.`);
  }
  st.notes ??= [];
  if (o.note) st.notes.push(o.note);

  for (const t of st.activeTerminals) await sup.terminalsClose(st.workspaceId, t).catch(() => undefined);
  st.activeTerminals = [];
  // A crash mid-launch leaves its deny rules behind.
  await releaseDenies(st);

  if (o.goto) {
    if (!isStage(o.goto)) throw new Error(`--goto must be one of ${STAGES.join(', ')}`);
    const pending = st.pause?.pendingRevert;
    const reason = [
      o.note ? `The human sent the run back here: ${o.note}` : 'The human sent the run back here.',
      // Redirecting a pending revert keeps what the reviewers found, wherever the work goes.
      ...(pending ? [`The reviewers had asked for a revert to ${pending.target}: ${pending.reason}`] : []),
    ].join('\n\n');
    if (o['keep-work']) await jumpToDraft(st, cfg, o.goto, reason);
    else await jumpTo(st, o.goto, reason, 'goto');
  } else if (st.status === 'paused' && st.pause) {
    const p = st.pause;
    if (p.kind === 'approval' && !o.approve) throw new Error(`Paused for approval: ${p.message}\nPass --approve, or --goto <stage> --note "..." to redirect.`);
    if (p.pendingRevert) {
      await jumpTo(st, p.pendingRevert.target, p.pendingRevert.reason, 'revert');
      st.restorePending = true;
    } else if (p.kind === 'escalation') {
      st.attempts = 0;
      st.reviewRounds = 0;
      if (o['keep-work']) {
        // Continue from whatever is committed in the worktree now (e.g. a draft restored from the reflog).
        st.retryBase = await g.head(st.dir);
      } else {
        // Re-run the stage from its start, with a fresh attempt budget.
        await g.resetHard(st.dir, st.stageStart[st.current]!);
        delete st.retryBase;
      }
    }
    st.history.push({ ts: new Date().toISOString(), stage: st.current, event: 'approve', detail: o.note ?? p.message });
  } else if (!o['keep-work']) {
    // Interrupted mid-stage (Ctrl-C, crash, reboot): throw away the partial attempt.
    await g.resetHard(st.dir, st.retryBase ?? st.stageStart[st.current]!);
  } else {
    // Interrupted, keeping what's committed: a later retry must come back to it, not reset past it.
    st.retryBase = await g.head(st.dir);
  }

  st.status = 'running';
  // The cap catches ping-pong while nobody is watching, so a human resume starts a fresh count.
  st.transitions = 0;
  delete st.pause;
  await save(st);
  if (st.setupDone === false && !(await setUp(st, cfg))) return;
  await drive(st, cfg);
}

async function status(id: string) {
  const st = await load(id);
  console.log(`${st.id}: ${st.status} at ${st.current} (attempt ${st.attempts + 1}, ${st.transitions} transitions since the run started or was last resumed)`);
  console.log(`worktree ${st.dir}  branch ${st.branch}`);
  if (st.pause) console.log(`\nPaused (${st.pause.kind}): ${st.pause.message}`);
  console.log('\nHistory:');
  for (const h of st.history.slice(-20)) console.log(`  ${h.ts.slice(5, 16)} ${h.stage.padEnd(9)} ${h.event.padEnd(8)} ${h.detail.replace(/\s+/g, ' ').slice(0, 140)}`);
}

async function showLog(id: string, o: { verdicts?: boolean }) {
  for (const line of (await readFile(join(runDir(id), 'log.jsonl'), 'utf8')).split('\n').filter(Boolean)) {
    const e = JSON.parse(line);
    if (o.verdicts && !e.verdict) continue;
    console.log(`${e.ts.slice(5, 19)} ${e.stage.padEnd(9)} ${e.msg}`);
    if (e.verdict?.reason) console.log(`  reason: ${e.verdict.reason}`);
    if (e.verdict?.summary && e.verdict.summary !== e.verdict.reason) console.log(`  summary: ${e.verdict.summary}`);
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      slug: { type: 'string' }, brief: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' },
      approve: { type: 'boolean' }, note: { type: 'string' }, goto: { type: 'string' }, 'keep-work': { type: 'boolean' },
      workspace: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
      mode: { type: 'string' }, 'stall-sec': { type: 'string' }, verdicts: { type: 'boolean' },
    },
  });
  const [cmd, id] = positionals;

  // Ahead of the SIGINT handler, whose advice is about resuming a run.
  if (cmd === 'profile' && !id) return buildProfile(resolve(values.repo ?? '.'));
  if (cmd === 'profile' && id === 'check') return checkProfile(resolve(values.repo ?? '.'));
  if (cmd === 'profile' && id === 'export') return exportProfile(resolve(values.repo ?? '.'));
  if (cmd === 'profile' && id === 'import' && positionals[2]) return importProfile(positionals[2]);

  // Ctrl-C leaves state.json saying "running" with activeTerminals listed;
  // resume closes those terminals and restarts the interrupted stage cleanly.
  process.on('SIGINT', () => {
    console.log('\nInterrupted. Resume with `superpipe resume <run-id>`.');
    process.exit(130);
  });

  if (cmd === 'start') return start(values);
  if (cmd === 'resume' && id) return resume(id, values);
  if (cmd === 'status' && id) return status(id);
  if (cmd === 'log' && id) return showLog(id, values);
  if (cmd === 'config') return console.log(JSON.stringify(await resolveConfig(resolve(values.repo ?? '.')), null, 2));
  if (cmd === 'probe') return probe(values);
  console.log(USAGE);
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
