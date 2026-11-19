import { appendFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import * as g from './git.ts';
import * as sup from './paradev.ts';
import { supervise, type AgentResult } from './supervise.ts';
import {
  STAGES, stageIndex,
  type AgentSpec, type Config, type HistoryEntry, type Outcome, type Role, type RunState, type Stage, type Verdict,
} from './types.ts';

/** The operator's own folder: their config, personal profiles and runs. */
export const SUPERPIPE_HOME = process.env.PIPELINE_HOME ?? join(homedir(), '.superpipe');
export const RUNS_DIR = join(SUPERPIPE_HOME, 'runs');
const RUN_REL = '.pipeline/run';
const PROMPTS_REL = `${RUN_REL}/prompts`;
const SUPERPIPE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER_PROMPTS = join(SUPERPIPE_ROOT, 'prompts');

// ───────────────────────── persistence & logging ─────────────────────────

export const runDir = (id: string) => join(RUNS_DIR, id);

/** Frozen with the config, so a `git pull` of superpipe mid-run can't change what that run's agents are told. */
export async function freezePrompts(id: string) {
  await rm(join(runDir(id), 'prompts'), { recursive: true, force: true });
  await cp(DRIVER_PROMPTS, join(runDir(id), 'prompts'), { recursive: true });
}

/** Recorded at start: the prompts and config are frozen, but the driver code isn't. */
export const superpipeCommit = () => g.head(SUPERPIPE_ROOT).catch(() => undefined);

// Parallel reviewers save concurrently, so writes are serialised through one chain.
let saving: Promise<void> = Promise.resolve();
export function save(st: RunState): Promise<void> {
  const snapshot = JSON.stringify(st, null, 2);
  saving = saving.catch(() => undefined).then(async () => {
    await mkdir(runDir(st.id), { recursive: true });
    const file = join(runDir(st.id), 'state.json');
    await writeFile(file + '.tmp', snapshot);
    await rename(file + '.tmp', file);
  });
  return saving;
}

export async function load(id: string): Promise<RunState> {
  return JSON.parse(await readFile(join(runDir(id), 'state.json'), 'utf8'));
}

async function log(st: RunState, msg: string, extra: Record<string, unknown> = {}) {
  const ts = new Date().toISOString();
  console.log(`${ts.slice(11, 19)} [${st.slug}:${st.current}] ${msg}`);
  await appendFile(join(runDir(st.id), 'log.jsonl'), JSON.stringify({ ts, stage: st.current, msg, ...extra }) + '\n');
}

function record(st: RunState, stage: Stage, event: HistoryEntry['event'], detail: string) {
  st.history.push({ ts: new Date().toISOString(), stage, event, detail });
}

async function saveArtifact(st: RunState, name: string, content: string) {
  const dir = join(runDir(st.id), 'artifacts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), content);
  return join(dir, name);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s: string, n = 72) => s.replace(/\s+/g, ' ').trim().slice(0, n);

// ───────────────────────── commit subjects ─────────────────────────

const SUBJECT = /^(feat|fix|docs|test|refactor|perf|chore|build|ci|style|revert)(\([^()\s]+\))?!?: [^A-Z\s]/;
const DEFAULT_TYPE: Record<Stage, string> = { spec: 'docs', tests: 'test', implement: 'feat', review: 'chore', ship: 'chore' };

/** The author's conventional subject if it's well formed; otherwise one built from its summary, never cut mid-word. */
export function subjectFor(stage: Stage, v: Pick<Verdict, 'subject' | 'summary'>): { subject: string; fallback: boolean } {
  const s = v.subject;
  if (typeof s === 'string' && !s.includes('\n') && s.length <= 72 && SUBJECT.test(s)) return { subject: s, fallback: false };
  const prefix = `${DEFAULT_TYPE[stage]}: `;
  let text = v.summary.replace(/\s+/g, ' ').trim().split(/(?<=[.!?]) /)[0];
  // Lowercase "Added", but leave README.md and AGENTS.md alone.
  if (/^[A-Z][a-z]/.test(text)) text = text[0].toLowerCase() + text.slice(1);
  const room = 65 - prefix.length;
  if (text.length > room) {
    const cut = text.lastIndexOf(' ', room);
    text = text.slice(0, cut > 0 ? cut : room);
  }
  text = text.replace(/[\s.,;:!?-]+$/, '');
  return { subject: prefix + (text || `${stage} stage`), fallback: true };
}

// ───────────────────────── write policy ─────────────────────────

export function writePolicy(cfg: Config, slug: string, stage: Stage) {
  const sub = (globs: string[] = []) => globs.map((x) => x.replaceAll('{slug}', slug));
  const spec = sub(cfg.paths.spec), tests = sub(cfg.paths.tests), changelog = sub(cfg.paths.changelog);
  const base: Record<Stage, [string[], string[]]> = {
    spec: [spec, []],
    tests: [tests, []],
    implement: [['**'], [...spec, ...tests]],
    review: [[], []],
    ship: [changelog, []],
  };
  const sc = cfg.stages[stage];
  const writable = [...base[stage][0], ...sub(sc.extraWritable)];
  const forbidden = [...base[stage][1], ...sub(sc.extraForbidden)];
  const except = sub(sc.forbiddenExcept);
  const w = writable.length ? picomatch(writable, { dot: true }) : () => false;
  const f = picomatch(forbidden, { dot: true, ...(except.length ? { ignore: except } : {}) });
  return { writable, forbidden, except, allows: (p: string) => w(p) && !f(p) };
}

// ───────────────────────── context for agents ─────────────────────────

async function writeContext(st: RunState, cfg: Config, stage: Stage, role: Role, authorSummary?: string) {
  const dir = join(st.dir, RUN_REL);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.gitignore'), '*\n');
  await rm(join(st.dir, PROMPTS_REL), { recursive: true, force: true });
  await cp(join(runDir(st.id), 'prompts'), join(st.dir, PROMPTS_REL), { recursive: true });
  const formatFile = join(st.dir, PROMPTS_REL, `format.${cfg.preset ?? 'markdown'}.md`);
  const format = existsSync(formatFile) ? (await readFile(formatFile, 'utf8')).replaceAll('{slug}', st.slug).trim() : undefined;

  const policy = writePolicy(cfg, st.slug, stage);
  const max = cfg.limits?.maxAttemptsPerStage ?? 3;
  const start = st.stageStart[stage]!;
  const specDoc = cfg.paths.specDoc.replaceAll('{slug}', st.slug);
  const out = [
    `# Pipeline context: ${st.slug}`,
    '',
    `- Stage: **${stage}** (${STAGES.join(' → ')})`,
    `- Your role: **${role}**`,
    `- Attempt: ${st.attempts + 1} of ${max}`,
    `- Branch: \`${st.branch}\`. The whole feature so far: \`git diff ${st.baseSha}\``,
    `- Spec document: \`${specDoc}\``,
    `- Test command: \`${cfg.commands.test}\``,
    ...(cfg.commands.checks?.length ? [`- Other checks: ${cfg.commands.checks.map((c) => `\`${c}\``).join(', ')}`] : []),
    ...(stage === 'ship' && cfg.ship?.prBody === 'none' ? ["- PR body: none. This repo's PRs carry a title only, and the driver titles the PR with the implement commit's subject, so don't write `.pipeline/run/pr.md`."] : []),
    '',
    '## Paths',
    role === 'author'
      ? `You may modify files matching: ${policy.writable.length ? policy.writable.map((p) => `\`${p}\``).join(', ') : '(nothing)'}`
      : 'You are a reviewer. Do not modify any file except your verdict file; edits are discarded.',
    ...(policy.forbidden.length ? [`Never modify: ${policy.forbidden.map((p) => `\`${p}\``).join(', ')}${policy.except.length ? `, except ${policy.except.map((p) => `\`${p}\``).join(', ')}` : ''}`] : []),
    ...(format ? ['', '## Spec format', format] : []),
    '',
    '## Brief',
    st.brief.trim(),
  ];
  if (role === 'reviewer') {
    out.push('', '## What you are reviewing');
    if (stage === 'review') out.push(`The complete feature: \`git diff ${st.baseSha}\`.`);
    else out.push(`The ${stage} author's work for this attempt: \`git diff ${start} HEAD\`.`);
    if (authorSummary) out.push('', `Author's summary: ${authorSummary}`);
  }
  if (st.notes?.length) {
    out.push('', '## Notes from the human running this pipeline', 'These apply to every stage. Follow them.', '');
    for (const n of st.notes) out.push(`- ${n}`);
  }
  const hasDraft = role === 'author' && !!st.retryBase && st.retryBase !== start;
  const restored = hasDraft && st.restored?.commit === st.retryBase ? st.restored : undefined;
  if (st.feedback.length) {
    out.push('', '## Why this stage is running again');
    if (hasDraft) {
      out.push('Your previous draft is still in place (committed at HEAD). Revise it to address the points below. Do not start over, and keep everything that was not criticised.');
    }
    out.push('Address all of this before anything else:', '');
    for (const f of st.feedback) out.push(f, '');
  } else if (restored) {
    out.push('', '## Your last draft is restored', `The run came back through this stage. Your last draft (\`${restored.checkpoint}\`) is restored and committed at HEAD, on top of the earlier stages' new work: \`git diff ${start} HEAD\`. Update it so it fits that work, and keep what still applies.`);
  } else if (hasDraft) {
    out.push('', '## Your previous draft is in place', `This stage was interrupted after your last draft was committed at HEAD: \`git diff ${start} HEAD\`. Carry on from it; don't start over.`);
  }
  if (restored?.skipped.length) {
    out.push('', `These files from that draft weren't restored, because an earlier stage may also write them: ${restored.skipped.map((p) => `\`${p}\``).join(', ')}. \`git show ${restored.checkpoint}:<path>\` shows your version.`);
  }
  if (st.revisit && stageIndex(stage) >= stageIndex(st.revisit.target)) {
    out.push('', '## Why the run came back through here', 'An earlier revert sent the run back. Make sure your work accounts for it:', '');
    for (const r of st.revisit.reasons) out.push(r, '');
  }
  const recent = st.history.filter((h) => h.event !== 'enter').slice(-15);
  if (recent.length) {
    out.push('', '## Run history (most recent last)');
    for (const h of recent) out.push(`- ${h.ts.slice(5, 16)} ${h.stage} ${h.event}: ${oneLine(h.detail, 200)}`);
  }
  await writeFile(join(dir, 'context.md'), out.join('\n') + '\n');
}

// ───────────────────────── Claude Code deny rules ─────────────────────────

const CLAUDE_LOCAL = '.claude/settings.local.json';
// Work that outlives an agent's turn is lost when the driver judges the turn over; rule 10 alone didn't
// stop Fable starting it. A bare tool name removes the tool even under --dangerously-skip-permissions.
// Not CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: with these denies it also removed Bash (measured 25 Oct).
const CLAUDE_DENY = ['Agent', 'Monitor', 'Workflow', 'CronCreate', 'Bash(run_in_background:true)'];
const warnedNotIgnored = new Set<string>();

async function readClaudeLocal(st: RunState): Promise<Record<string, any> | undefined> {
  const file = join(st.dir, CLAUDE_LOCAL);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    await log(st, `${CLAUDE_LOCAL} isn't valid JSON, so the driver leaves it alone`);
    return undefined;
  }
}

/** Through `.pipeline/run`, which is ignored, so a crash mid-write leaves no stray file for the write policy. */
async function writeClaudeLocal(st: RunState, s: Record<string, any>) {
  const tmp = join(st.dir, RUN_REL, `claude-settings.${process.pid}.${Math.random().toString(36).slice(2)}`);
  await mkdir(join(st.dir, RUN_REL), { recursive: true });
  await mkdir(join(st.dir, '.claude'), { recursive: true });
  await writeFile(tmp, JSON.stringify(s, null, 2) + '\n');
  await rename(tmp, join(st.dir, CLAUDE_LOCAL));
}

/** Merged into what's there, and only where git ignores the file: an untracked one would fail every write policy. */
async function denyBackgroundWork(st: RunState) {
  if (!(await g.isIgnored(st.dir, CLAUDE_LOCAL))) {
    if (!warnedNotIgnored.has(st.dir)) await log(st, `${CLAUDE_LOCAL} isn't ignored here, so Claude agents run without the driver's deny rules`);
    warnedNotIgnored.add(st.dir);
    return;
  }
  const created = !existsSync(join(st.dir, CLAUDE_LOCAL));
  const s = await readClaudeLocal(st);
  if (!s) return;
  const deny: string[] = s.permissions?.deny ?? [];
  const missing = CLAUDE_DENY.filter((d) => !deny.includes(d));
  if (!missing.length) return;
  st.claudeDeny = { added: [...new Set([...(st.claudeDeny?.added ?? []), ...missing])], created: st.claudeDeny?.created ?? created };
  // Saved before the write, so a crash between them leaves `resume` knowing what to take back.
  await save(st);
  await writeClaudeLocal(st, { ...s, permissions: { ...s.permissions, deny: [...deny, ...missing] } });
}

/** The person's own sessions in this workspace shouldn't silently lose these tools, at a pause or after they stop using superpipe. */
export async function releaseDenies(st: RunState) {
  const mine = st.claudeDeny;
  if (!mine) return;
  delete st.claudeDeny;
  const s = await readClaudeLocal(st);
  if (!s) return;
  const deny = (s.permissions?.deny ?? []).filter((d: string) => !mine.added.includes(d));
  const permissions = { ...s.permissions, deny };
  if (!deny.length) delete permissions.deny;
  const rest = { ...s, permissions };
  if (!Object.keys(permissions).length) delete rest.permissions;
  if (mine.created && !Object.keys(rest).length) await rm(join(st.dir, CLAUDE_LOCAL), { force: true });
  else await writeClaudeLocal(st, rest);
}

/**
 * Around one launch, or a whole batch of parallel reviewers: a release per reviewer could pull the
 * rules while a sibling is still launching or running.
 */
async function withDenies<T>(st: RunState, run: () => Promise<T>): Promise<T> {
  await denyBackgroundWork(st);
  try {
    return await run();
  } finally {
    await releaseDenies(st);
  }
}

// ───────────────────────── agent supervision ─────────────────────────

const labelOf = (a: AgentSpec) => a.label ?? (a.model ? `${a.agent}:${a.model}` : a.agent);

async function runAgent(st: RunState, cfg: Config, stage: Stage, role: Role, spec: AgentSpec, n: number): Promise<AgentResult> {
  const verdictRel = `${RUN_REL}/verdict-${stage}-${role}${n ? `-${n}` : ''}.json`;
  const verdictAbs = join(st.dir, verdictRel);
  await rm(verdictAbs, { force: true });
  const authorFile = stage === 'spec' && cfg.preset === 'openspec' ? 'spec.openspec.md' : `${stage}.md`;
  const promptFile = role === 'author' ? authorFile : stage === 'review' ? 'review.md' : `${stage}.review.md`;
  // Codex reads only AGENTS.md on its own, so a CLAUDE.md-only repo has to be named here.
  const instructions = cfg.instructions ?? ['AGENTS.md', 'CLAUDE.md'].find((f) => existsSync(join(st.dir, f)));
  const files = [`${PROMPTS_REL}/_contract.md`, ...(instructions ? [instructions] : []), `${PROMPTS_REL}/${promptFile}`, `${RUN_REL}/context.md`];
  const prompt = [
    'You are one stage of an automated pipeline. Read these files in order and follow them exactly:',
    ...files.map((f, i) => `${i + 1}. ${f}`),
    `Your verdict file is ${verdictRel}. Writing it is your final action.`,
  ].join('\n');
  const label = labelOf(spec);

  let terminalId: string;
  try {
    terminalId = (await sup.agentsCreate({ ...spec, workspaceId: st.workspaceId, prompt })).sessionId;
  } catch (e) {
    return { kind: 'fail', reason: `Failed to launch ${label}: ${(e as Error).message}` };
  }
  st.activeTerminals.push(terminalId);
  await save(st);
  await log(st, `launched ${role} ${label}`, { terminalId });
  try {
    return await supervise({
      workspaceId: st.workspaceId, terminalId, label, stage, verdictAbs,
      timeoutSec: cfg.stages[stage].timeoutSec ?? cfg.limits?.defaultTimeoutSec ?? 3600,
      humanWaitSec: cfg.limits?.humanWaitSec ?? 4 * 3600,
      stallSec: cfg.limits?.stallSec ?? 240,
      nudgeText: `You stopped without writing ${verdictRel}. Finish the stage if it isn't finished, then write the verdict per ${PROMPTS_REL}/_contract.md.`,
      invalidText: (err) => `Your verdict file ${verdictRel} is invalid: ${err}. Rewrite it per ${PROMPTS_REL}/_contract.md.`,
      log: (m) => log(st, m, { terminalId }),
      onBlocked: async () => {
        await log(st, `${label} is waiting for input`, { terminalId });
        await sup.notify(`${st.slug}: ${stage} needs you`, `${label} is waiting for input.`, { workspaceId: st.workspaceId, terminalId });
      },
    });
  } finally {
    await sup.terminalsClose(st.workspaceId, terminalId).catch(() => undefined);
    st.activeTerminals = st.activeTerminals.filter((t) => t !== terminalId);
    await save(st);
  }
}

// ───────────────────────── gates ─────────────────────────

type GateResult = { ok: true } | { ok: false; reason: string };

/**
 * Runs each command in turn; the first to fail stops the rest and becomes the reason. A failing
 * `testCmd` is run once more first, so one flaky test doesn't cost the stage, unless it was killed for hanging.
 */
async function runCommands(st: RunState, stage: Stage, cmds: string[], testCmd?: string): Promise<GateResult> {
  const visit = `${st.seq}-${stage}-a${st.attempts + 1}${st.reviewRounds ? `v${st.reviewRounds}` : ''}`;
  for (const cmd of cmds) {
    const runOnce = async (n: number) => {
      const r = await g.sh(cmd, st.dir);
      return { ...r, file: await saveArtifact(st, `${visit}-r${n}-${cmd.replace(/\W+/g, '_').slice(0, 40)}.log`, r.output) };
    };
    await log(st, `gate: ${cmd}`);
    let r = await runOnce(1);
    if (r.code !== 0 && cmd === testCmd && !r.killed) {
      const again = await runOnce(2);
      if (again.code === 0) await log(st, `flaky: \`${cmd}\` failed, then passed on a re-run (${r.file})`);
      r = again;
    }
    if (r.code !== 0) {
      return { ok: false, reason: `The driver ran \`${cmd}\` and it failed (exit ${r.code}). Full log: ${r.file}. Last lines:\n\n\`\`\`\n${g.tail(r.output, 120)}\n\`\`\`` };
    }
  }
  return { ok: true };
}

async function runGates(st: RunState, cfg: Config, stage: Stage): Promise<GateResult> {
  if (stage === 'spec') return { ok: true };
  if (stage === 'tests') {
    if (cfg.testsMustFailBeforeImplement === false) return { ok: true };
    const r = await g.sh(cfg.commands.test, st.dir);
    await saveArtifact(st, `${st.seq}-tests-red.log`, r.output);
    if (r.code === 0) {
      return {
        ok: false,
        reason: `\`${cfg.commands.test}\` passes with no implementation, so the new tests either don't exercise the new behaviour or aren't picked up by the test command. Make them fail because the behaviour is missing.`,
      };
    }
    return { ok: true };
  }
  return runCommands(st, stage, [cfg.commands.test, ...(cfg.commands.checks ?? [])], cfg.commands.test);
}

// ───────────────────────── one stage ─────────────────────────

function revertOrRetry(from: Stage, target: Stage, reason: string): Outcome {
  if (target === from) return { kind: 'retry', reason };
  if (stageIndex(target) > stageIndex(from)) {
    return { kind: 'retry', reason: `Invalid verdict: reverts can only target ${from} or an earlier stage, not ${target}. Original reason: ${reason}` };
  }
  return { kind: 'revert', target, reason };
}

async function runStage(st: RunState, cfg: Config, stage: Stage): Promise<Outcome> {
  // Here rather than at entry: after any gate pause, and inside drive's try, so a git failure escalates.
  if (st.restorePending) await restoreDraft(st, cfg, stage);
  const sc = cfg.stages[stage];
  const start = st.stageStart[stage]!;
  let authorSummary: string | undefined;

  if (sc.author) {
    const author = sc.author;
    await writeContext(st, cfg, stage, 'author');
    const r = await withDenies(st, () => runAgent(st, cfg, stage, 'author', author, 0));
    if (r.kind === 'fail') return r.fatal ? { kind: 'escalate', reason: r.reason } : { kind: 'retry', reason: r.reason };
    const v = r.verdict;
    await log(st, `author verdict: ${v.verdict}${v.target ? ` → ${v.target}` : ''}`, { verdict: v });
    if (v.verdict === 'blocked') return { kind: 'escalate', reason: `${labelOf(sc.author)} is blocked: ${v.reason}` };
    if (v.verdict === 'revert') {
      if (v.target === stage) return { kind: 'retry', reason: `Invalid verdict: an author can't revert to its own stage. Reason given: ${v.reason}` };
      return revertOrRetry(stage, v.target!, v.reason);
    }

    const policy = writePolicy(cfg, st.slug, stage);
    const bad = (await g.changedFiles(st.dir, start)).filter((f) => !policy.allows(f));
    if (bad.length) {
      return {
        kind: 'retry',
        reason: `Your previous attempt modified files outside this stage's writable paths, so the whole attempt was discarded: ${bad.map((b) => `\`${b}\``).join(', ')}. If one of those genuinely has to change, return a revert verdict targeting the stage that owns it.`,
      };
    }
    const checks = await runCommands(st, stage, (sc.checks ?? []).map((c) => c.replaceAll('{slug}', st.slug)));
    if (!checks.ok) return { kind: 'retry', reason: checks.reason };
    const gate = await runGates(st, cfg, stage);
    if (!gate.ok) return { kind: 'retry', reason: gate.reason };
    // Everything since the stage's start becomes one commit, so the PR shows the stage's work once,
    // whatever built it: a restored draft, revise rounds, kept work. A soft reset, not --amend, because
    // an amend fails when the author has undone every change.
    const kept = await keptSubject(st, start);
    await g.git(st.dir, ['reset', '--soft', start]);
    const offered = subjectFor(stage, v);
    const subject = kept ?? offered.subject;
    // Whatever the reviewers decide, a reset within this stage comes back to this commit, not past it.
    const { sha, committed } = await g.commitAll(st.dir, subject);
    st.retryBase = sha;
    await save(st);
    if (committed) {
      if (kept && kept !== offered.subject) await log(st, `keeping ${stage}'s first commit subject "${kept}"; the author offered "${offered.subject}"`);
      else if (offered.fallback) await log(st, `no usable commit subject from the author; using "${subject}"`);
    }
    authorSummary = v.summary;
  } else {
    // Review-only stage: don't spend reviewer time on a tree that's already red.
    const gate = await runGates(st, cfg, stage);
    if (!gate.ok) return { kind: 'revert', target: 'implement', reason: gate.reason };
  }

  if (!sc.reviewers?.length) return { kind: 'advance', summary: authorSummary ?? '' };
  const reviewers = sc.reviewers;

  const before = await g.head(st.dir);
  await writeContext(st, cfg, stage, 'reviewer', authorSummary);
  const results = await withDenies(st, () => Promise.all(reviewers.map((a, i) => runAgent(st, cfg, stage, 'reviewer', a, i + 1))));
  if (!(await g.isClean(st.dir)) || (await g.head(st.dir)) !== before) {
    await log(st, 'discarding edits made by reviewers');
    await g.resetHard(st.dir, before);
  }

  const failed = results.flatMap((r, i) => (r.kind === 'fail' ? [`${labelOf(sc.reviewers![i])}: ${r.reason}`] : []));
  if (failed.length) return { kind: 'escalate', reason: `Reviewer(s) failed:\n${failed.join('\n')}` };
  const verdicts = results.map((r) => (r as Extract<AgentResult, { kind: 'verdict' }>).verdict);
  for (const [i, v] of verdicts.entries()) {
    await log(st, `reviewer ${labelOf(sc.reviewers[i])}: ${v.verdict}${v.target ? ` → ${v.target}` : ''}`, { verdict: v });
  }

  const blocked = verdicts.filter((v) => v.verdict === 'blocked');
  if (blocked.length) return { kind: 'escalate', reason: blocked.map((v) => v.reason).join('\n\n') };

  const reverts = verdicts.flatMap((v, i) => (v.verdict === 'revert' ? [{ v, who: labelOf(sc.reviewers![i]) }] : []));
  if (reverts.length) {
    const earliest = reverts.reduce((a, b) => (stageIndex(b.v.target!) < stageIndex(a.v.target!) ? b : a)).v.target!;
    const reason = reverts.map(({ v, who }) => `Reviewer ${who} (sends to ${v.target}): ${v.reason}`).join('\n\n');
    if (earliest === stage && !sc.author) {
      return { kind: 'escalate', reason: `Reviewers can't send ${stage} back to itself; target implement or earlier.\n\n${reason}` };
    }
    if (earliest === stage) return { kind: 'revise', reason };
    const named = [...new Set(reverts.map(({ v }) => v.target!))].sort((a, b) => stageIndex(a) - stageIndex(b));
    // Appended, so the truncated views (status, notifications, run history) still lead with the reviewers' words.
    const split = named.length > 1 && stageIndex(earliest) < stageIndex(stage)
      ? `\n\nThese reviewers named different stages (${named.join(', ')}). Do the part that belongs to your stage, and leave the rest to the stage it names.`
      : '';
    return revertOrRetry(stage, earliest, reason + split);
  }

  return { kind: 'advance', summary: authorSummary ?? verdicts.map((v) => v.summary).join(' / ') };
}

// ───────────────────────── transitions ─────────────────────────

async function pause(st: RunState, p: NonNullable<RunState['pause']>) {
  st.status = 'paused';
  st.pause = p;
  record(st, st.current, p.kind === 'approval' ? 'pause' : 'escalate', p.message);
  await save(st);
  await log(st, `PAUSED (${p.kind}): ${p.message}`);
  await sup.notify(`${st.slug}: ${p.kind === 'approval' ? 'approval needed' : 'needs you'}`, oneLine(p.message, 180), { workspaceId: st.workspaceId });
  console.log(`\nResume with: superpipe resume ${st.id} [--approve] [--note "..."] [--goto <stage>]\n`);
}

async function enter(st: RunState, stage: Stage) {
  st.current = stage;
  st.stageStart[stage] = await g.head(st.dir);
  st.attempts = 0;
  st.reviewRounds = 0;
  delete st.retryBase;
  record(st, stage, 'enter', `at ${st.stageStart[stage]!.slice(0, 8)}`);
}

/** Keeps the earliest target, the furthest stage the run came back from, and every reason, until that stage advances. */
function noteRevisit(st: RunState, target: Stage, reason: string) {
  const r = st.revisit;
  st.revisit = {
    target: r && stageIndex(r.target) < stageIndex(target) ? r.target : target,
    from: STAGES[Math.max(stageIndex(st.current), stageIndex(target), r ? stageIndex(r.from) : -1)],
    reasons: [...(r?.reasons ?? []), reason],
  };
}

/** Restarts `target` from its start commit. A caller that wants its last draft back sets `restorePending` afterwards. */
export async function jumpTo(st: RunState, target: Stage, reason: string, event: 'revert' | 'goto') {
  const sha = st.stageStart[target];
  if (!sha) throw new Error(`${target} hasn't run in this pipeline yet`);
  await g.resetHard(st.dir, sha);
  for (const s of STAGES) if (stageIndex(s) > stageIndex(target)) delete st.stageStart[s];
  record(st, target, event, `from ${st.current}: ${reason}`);
  noteRevisit(st, target, reason);
  st.current = target;
  st.attempts = 0;
  st.reviewRounds = 0;
  delete st.retryBase;
  delete st.restorePending;
  st.feedback = [reason];
}

/**
 * `--goto <target> --keep-work`: the target's author revises its last draft instead of restarting.
 * Later stages are dropped and re-run, as after `jumpTo`. A draft is HEAD (the current stage's
 * committed work) or the stage's last checkpoint. Every check runs before anything changes.
 */
export async function jumpToDraft(st: RunState, cfg: Config, target: Stage, reason: string) {
  function refuse(why: string): never {
    throw new Error(`Can't keep ${target}'s work: ${why}`);
  }
  if (!cfg.stages[target].author) refuse(`${target} has no author to revise a draft.`);
  const from = st.current;
  const ahead = stageIndex(target) - stageIndex(from);
  if (ahead > 1) refuse(`it's more than one stage after ${from}.`);
  const head = await g.head(st.dir);

  let start = st.stageStart[target];
  if (ahead === 1) {
    // A revert dropped the target's start; its draft was built on the current stage's last advance.
    start = (await g.latestCheckpoint(st.dir, st.id, from))?.commit;
    if (!start) refuse(`${from} never advanced, so ${target} has nothing to build on.`);
    // A restore commit holds the same tree as the checkpoint it came from without descending from it.
    const contained = (await g.isAncestor(st.dir, head, start)) || (await g.treeOf(st.dir, head)) === (await g.treeOf(st.dir, start));
    if (!contained) refuse(`${from}'s last advance doesn't contain HEAD, so jumping would drop work. Resume without --goto instead.`);
  }
  if (!start) refuse(`${target} has no recorded start.`);
  const draft = ahead === 0 && head !== start ? head : (await g.latestCheckpoint(st.dir, st.id, target))?.commit;
  if (!draft || draft === start || !(await g.isAncestor(st.dir, start, draft))) {
    refuse(`${target} has no draft built on its start${ahead < 1 ? `. Use --goto ${target} without --keep-work to restart it` : ''}.`);
  }
  if (draft !== head && !(await g.isClean(st.dir))) refuse('the worktree has uncommitted changes that resetting to the draft would destroy.');

  if (draft !== head) await g.resetHard(st.dir, draft);
  for (const s of STAGES) if (stageIndex(s) > stageIndex(target)) delete st.stageStart[s];
  st.stageStart[target] = start;
  record(st, target, 'goto', `from ${from}, keeping the draft at ${draft.slice(0, 8)}: ${reason}`);
  noteRevisit(st, target, reason);
  st.current = target;
  st.attempts = 0;
  st.reviewRounds = 0;
  st.retryBase = draft;
  delete st.restorePending;
  st.feedback = [reason];
}

/**
 * Puts a re-entered stage's last draft back on top of the earlier stages' new work, so its author adapts
 * it instead of starting over. Only paths this stage may write and no earlier stage may.
 */
async function restoreDraft(st: RunState, cfg: Config, stage: Stage) {
  const last = cfg.stages[stage].author ? await g.latestCheckpoint(st.dir, st.id, stage) : undefined;
  if (last) {
    const own = writePolicy(cfg, st.slug, stage);
    const earlier = STAGES.slice(0, stageIndex(stage)).map((s) => writePolicy(cfg, st.slug, s));
    const paths = (await g.diffNameStatus(st.dir, 'HEAD', last.commit)).map((d) => d.path).filter((p) => own.allows(p));
    const skipped = paths.filter((p) => earlier.some((e) => e.allows(p)));
    const restore = paths.filter((p) => !skipped.includes(p));
    if (restore.length) {
      await g.restorePaths(st.dir, last.commit, restore);
      const { sha, committed } = await g.commitAll(st.dir, `chore: restore the last ${stage} draft`);
      if (committed) {
        st.retryBase = sha;
        st.restored = { checkpoint: last.ref, commit: sha, skipped };
        record(st, stage, 'restore', `${restore.length} file(s) from ${last.ref}${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}`);
        await log(st, `restored ${restore.length} file(s) from ${last.ref}`);
      }
    }
  }
  // Cleared only once it has worked, so a restore that failed runs again on resume.
  delete st.restorePending;
}

/**
 * The subject a stage's work already carries: that of its earliest commit since `start`, or for a
 * restored draft, of the checkpoint it came from. A restarted stage has none, so takes its author's.
 */
async function keptSubject(st: RunState, start: string): Promise<string | undefined> {
  const first = (await g.git(st.dir, ['log', '--reverse', '--format=%H', `${start}..HEAD`])).split('\n')[0];
  if (!first) return undefined;
  const from = first === st.restored?.commit ? `${st.restored.checkpoint}^{commit}` : first;
  return (await g.git(st.dir, ['log', '-1', '--format=%s', from])).trim() || undefined;
}

async function onAdvance(st: RunState, cfg: Config, stage: Stage, summary: string) {
  let shipped: string | undefined;
  if (stage === 'ship') {
    // Before any bookkeeping, so a failed push leaves the run where ship's author left it.
    try {
      shipped = await ship(st, cfg);
    } catch (e) {
      const error = (e as Error).message;
      st.feedback = [`The driver couldn't push the branch: ${error}`];
      await pause(st, { kind: 'escalation', message: `Pushing failed: ${error}. Fix it and resume; --keep-work keeps ship's work.` });
      return;
    }
  }

  st.seq++;
  await g.checkpoint(st.dir, st.id, `${String(st.seq).padStart(2, '0')}-${stage}`);
  record(st, stage, 'advance', summary || '(no summary)');
  st.feedback = [];
  delete st.retryBase;
  delete st.restored;
  if (st.revisit?.from === stage) delete st.revisit;

  if (stage === 'ship') {
    st.status = 'done';
    delete st.pause;
    await save(st);
    await log(st, 'DONE');
    await sup.notify(`${st.slug}: shipped`, shipped ?? (summary || 'Pipeline finished.'), { workspaceId: st.workspaceId });
    return;
  }

  const next = STAGES[stageIndex(stage) + 1];
  await enter(st, next);
  st.restorePending = true;
  const gates = [
    ...(cfg.gates?.approveAfter?.includes(stage) ? [`after:${stage}`] : []),
    ...(cfg.gates?.approveBefore?.includes(next) ? [`before:${next}`] : []),
  ];
  if (gates.length) {
    await pause(st, { kind: 'approval', gates, message: `${stage} done; approve to start ${next}. ${stage} summary: ${summary}` });
  }
}

/** Pushes and opens the PR. A failed push throws; a failed `gh` only reports, since the branch is already up. */
async function ship(st: RunState, cfg: Config): Promise<string | undefined> {
  if (cfg.ship?.push === false) return;
  await g.git(st.dir, ['push', '-u', 'origin', st.branch]);
  const prFile = join(st.dir, RUN_REL, 'pr.md');
  const body = existsSync(prFile) ? await readFile(prFile, 'utf8') : `Pipeline run ${st.id}`;
  // Title-only: the feature's own commit subject, rather than the ship author's second guess at it.
  const implement = cfg.ship?.prBody === 'none' ? await g.latestCheckpoint(st.dir, st.id, 'implement') : undefined;
  const title = implement
    ? (await g.git(st.dir, ['log', '-1', '--format=%s', implement.commit])).trim()
    : body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? st.slug;
  const args = ['pr', 'create', '--base', st.baseBranch, '--head', st.branch, '--title', title];
  // Not both: given --body and --body-file, gh silently uses the file.
  if (cfg.ship?.prBody === 'none') args.push('--body', '');
  else args.push('--body-file', await saveArtifact(st, 'pr-body.md', body.replace(/^#\s+.+\n+/, '')));
  if (cfg.ship?.draftPr !== false) args.push('--draft');
  const r = await g.sh(['gh', ...args].map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' '), st.dir);
  await log(st, r.code === 0 ? `PR: ${r.output.trim()}` : `gh pr create failed (push succeeded): ${g.tail(r.output, 5)}`);
  return r.code === 0 ? `PR: ${r.output.trim()}` : `Pushed ${st.branch}, but gh pr create failed; open the PR by hand.`;
}

// ───────────────────────── setup ─────────────────────────

/** Gets a new worktree ready for the first stage. False means the run paused, and `resume` calls this again. */
export async function setUp(st: RunState, cfg: Config): Promise<boolean> {
  const fail = async (message: string) => {
    await pause(st, { kind: 'escalation', message });
    return false;
  };
  if (cfg.setupReadyFile) {
    const file = join(st.dir, cfg.setupReadyFile);
    const timeoutSec = cfg.setupTimeoutSec ?? 900;
    const until = Date.now() + timeoutSec * 1000;
    await log(st, `waiting for the workspace setup script (${cfg.setupReadyFile})`);
    while (!existsSync(file)) {
      if (Date.now() > until) return fail(`The workspace setup script didn't finish within ${timeoutSec}s (no ${file}). Check the "Workspace Setup" terminal in Paradev.`);
      await sleep(3000);
    }
  }
  if (cfg.setup) {
    await log(st, `setup: ${cfg.setup}`);
    const r = await g.sh(cfg.setup, st.dir);
    const file = await saveArtifact(st, 'setup.log', r.output);
    if (r.code !== 0) return fail(`Setup \`${cfg.setup}\` failed (exit ${r.code}). Full log: ${file}. Last lines:\n\n\`\`\`\n${g.tail(r.output, 40)}\n\`\`\``);
  }
  const dirty = await g.changedFiles(st.dir, 'HEAD');
  if (dirty.length) {
    return fail(`Setup left files that aren't ignored, so every stage's write policy would reject them: ${dirty.map((f) => `\`${f}\``).join(', ')}. Make setup write only ignored files.`);
  }
  st.setupDone = true;
  if (cfg.gates?.approveBefore?.includes('spec')) {
    st.status = 'paused';
    st.pause = { kind: 'approval', message: 'Approve to start spec.', gates: ['before:spec'] };
  }
  await save(st);
  return true;
}

// ───────────────────────── main loop ─────────────────────────

export async function drive(st: RunState, cfg: Config) {
  const maxAttempts = cfg.limits?.maxAttemptsPerStage ?? 3;
  const maxRounds = cfg.limits?.maxReviewRounds ?? 4;
  const maxTransitions = cfg.limits?.maxTransitions ?? 25;
  const resetBase = () => st.retryBase ?? st.stageStart[st.current]!;

  while (st.status === 'running') {
    if (st.transitions >= maxTransitions) {
      await pause(st, { kind: 'escalation', message: `Hit the ${maxTransitions}-transition cap. Probably ping-ponging; see history. Resuming starts a fresh count.` });
      break;
    }
    const stage = st.current;
    await log(st, `running ${stage} (attempt ${st.attempts + 1}/${maxAttempts}${st.reviewRounds ? `, revision ${st.reviewRounds}/${maxRounds}` : ''})`);
    st.transitions++;
    await save(st);

    let outcome: Outcome;
    try {
      outcome = await runStage(st, cfg, stage);
    } catch (e) {
      outcome = { kind: 'escalate', reason: `Driver error: ${(e as Error).stack ?? e}` };
    }

    switch (outcome.kind) {
      case 'advance':
        await onAdvance(st, cfg, stage, outcome.summary);
        break;
      case 'revise':
        // Keep the reviewed draft (committed before reviewers ran); the author revises it next.
        st.reviewRounds = (st.reviewRounds ?? 0) + 1;
        st.retryBase = await g.head(st.dir);
        record(st, stage, 'revise', outcome.reason);
        st.feedback = [outcome.reason];
        await log(st, `revise (${st.reviewRounds}/${maxRounds}): ${oneLine(outcome.reason, 160)}`);
        if (st.reviewRounds >= maxRounds) {
          await pause(st, { kind: 'escalation', message: `${stage} went ${st.reviewRounds} review rounds without the reviewers accepting it. Last: ${outcome.reason}` });
        }
        break;
      case 'retry':
        await g.resetHard(st.dir, resetBase());
        st.attempts++;
        record(st, stage, 'retry', outcome.reason);
        st.feedback = [outcome.reason];
        await log(st, `retry: ${oneLine(outcome.reason, 160)}`);
        if (st.attempts >= maxAttempts) {
          await pause(st, { kind: 'escalation', message: `${stage} failed ${st.attempts} attempts. Last: ${outcome.reason}` });
        }
        break;
      case 'revert':
        await g.resetHard(st.dir, resetBase());
        if (cfg.gates?.approveRevertTo?.includes(outcome.target)) {
          await pause(st, {
            kind: 'approval',
            message: `${stage} wants to revert to ${outcome.target}: ${outcome.reason}`,
            pendingRevert: { from: stage, target: outcome.target, reason: outcome.reason },
          });
        } else {
          await jumpTo(st, outcome.target, outcome.reason, 'revert');
          st.restorePending = true;
          await log(st, `reverted ${stage} → ${outcome.target}`);
        }
        break;
      case 'escalate':
        await g.resetHard(st.dir, resetBase());
        st.feedback = [outcome.reason];
        await pause(st, { kind: 'escalation', message: outcome.reason });
        break;
    }
    await save(st);
  }
}

// ───────────────────────── one driver per run ─────────────────────────

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A second driver on a live run would close its agents and reset its worktree under it. */
export async function claimRun(id: string) {
  const file = join(runDir(id), 'driver.pid');
  const pid = Number(await readFile(file, 'utf8').catch(() => ''));
  // shortcut: after a reboot or kill -9 the stale pid can belong to another process, so the error says how to clear it; check the process name if that bites.
  if (pid && isAlive(pid)) throw new Error(`Another superpipe (pid ${pid}) is still driving this run. Stop it first, or delete ${file} if that process isn't superpipe.`);
  await writeFile(file, String(process.pid));
  process.on('exit', () => rmSync(file, { force: true }));
}
