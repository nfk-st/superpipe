/**
 * Watches one agent until it writes a valid verdict, gives up, or dies.
 *
 * Two strategies, picked per agent:
 * - wait:    `paradev agents wait` (CLI after 1.37), for agents that report state
 *            through Paradev's hooks. Event-driven, and can see "waiting for input".
 * - polling: CLI 1.37, and any agent that reports no state (a custom row such as
 *            `exec opencode run`). `agents wait` only returns for those when the
 *            process exits, so a hang would sit out the stage timeout. Polls for the
 *            verdict file, checks `terminals list` for an exited process, and treats
 *            a screen that hasn't changed for stallSec as idle. Safe because
 *            Paradev's presets launch every agent with permission prompts bypassed,
 *            so a quiet screen is never a prompt.
 *
 * Either way the verdict file is the source of truth.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as sup from './paradev.ts';
import { tail } from './git.ts';
import { STAGES, isStage, type Stage, type Verdict } from './types.ts';

export type AgentResult =
  | { kind: 'verdict'; verdict: Verdict }
  /** fatal: retrying won't help (quota, auth), so the driver escalates instead. */
  | { kind: 'fail'; reason: string; fatal?: boolean };

export interface SuperviseOpts {
  workspaceId: string;
  terminalId: string;
  label: string;
  stage: Stage;
  verdictAbs: string;
  /** Sent once if the agent goes idle without a verdict. */
  nudgeText: string;
  /** Sent once if the verdict file is malformed. */
  invalidText: (error: string) => string;
  timeoutSec: number;
  humanWaitSec: number;
  stallSec: number;
  log: (msg: string) => Promise<void>;
  /** Wait strategy only: the agent is asking for input. */
  onBlocked: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The agent CLIs' own words for a spent quota or a lost login: retrying is pointless until a human sorts out the account.
 * Whole phrases only, because the repos' own output is full of billing, 401, quota and rate-limit words.
 */
const FATAL_PHRASES = [
  // Claude Code 2.1.328's binary
  'usage limit reached', "you're out of extra usage", 'please run /login',
  'fix external api key', 'fix external auth token',
  // Codex 0.167.2's binary
  'hit your usage limit', 'check your plan and billing details', 'your access token could not be refreshed', 'run codex login again',
  // Z.ai, for GLM
  'weekly/monthly limit exhausted',
];
const FATAL = new RegExp(FATAL_PHRASES.join('|'), 'i');

function failFrom(label: string, what: string, screen: string): AgentResult {
  const out = tail(screen.trim(), 20);
  const fatal = FATAL.test(out);
  return {
    kind: 'fail',
    fatal,
    reason: `${label} ${what}.${fatal ? ' This looks like a quota or account problem, so it was not retried.' : ''}${out ? `\nLast output:\n\`\`\`\n${out}\n\`\`\`` : ''}`,
  };
}

const filled = (s: unknown) => typeof s === 'string' && s.trim() !== '';

export async function readVerdict(file: string, stage: Stage):
  Promise<{ kind: 'missing' } | { kind: 'invalid'; error: string } | { kind: 'ok'; verdict: Verdict; reasonFilled: boolean }> {
  if (!existsSync(file)) return { kind: 'missing' };
  let v: any;
  try { v = JSON.parse(await readFile(file, 'utf8')); } catch (e) { return { kind: 'invalid', error: `not valid JSON (${(e as Error).message})` }; }
  // An advance's summary carries its substance; only a revert or a block needs a reason of its own.
  const reasonFilled = v?.verdict === 'advance' && !filled(v?.reason) && filled(v?.summary);
  if (reasonFilled) v.reason = v.summary;
  const errs: string[] = [];
  if (v?.stage !== stage) errs.push(`"stage" must be "${stage}"`);
  if (!['advance', 'revert', 'blocked'].includes(v?.verdict)) errs.push('"verdict" must be advance, revert or blocked');
  if (v?.verdict === 'revert' && !isStage(v?.target)) errs.push(`"target" must be one of ${STAGES.join(', ')} for a revert`);
  if (!filled(v?.summary)) errs.push('"summary" must be a non-empty string');
  if (!filled(v?.reason)) errs.push('"reason" must be a non-empty string');
  return errs.length ? { kind: 'invalid', error: errs.join('; ') } : { kind: 'ok', verdict: v, reasonFilled };
}

async function accepted(o: SuperviseOpts, v: { verdict: Verdict; reasonFilled: boolean }): Promise<AgentResult> {
  if (v.reasonFilled) await o.log(`${o.label}'s advance had no "reason"; using its summary`);
  return { kind: 'verdict', verdict: v.verdict };
}

export async function supervise(o: SuperviseOpts): Promise<AgentResult> {
  if (!(await sup.hasAgentsWait())) return byPolling(o);
  if (await reportsState(o)) return byWait(o);
  await o.log(`${o.label} reports no state hooks; watching its screen`);
  return byPolling(o);
}

/** Hooked agents leave "none" within ~2s of launch on 1.39; a slower one just falls back to polling. */
async function reportsState(o: SuperviseOpts): Promise<boolean> {
  const until = Date.now() + Number(process.env.PIPELINE_STATE_GRACE_MS ?? 15_000);
  for (;;) {
    const ex = await sup.agentsExplain(o.workspaceId, o.terminalId).catch(() => null);
    if (ex && ex.state !== 'none') return true;
    const left = until - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(1000, left));
  }
}

const screenOf = (o: SuperviseOpts) => sup.terminalsRead(o.workspaceId, o.terminalId, 80).catch(() => '');

// ──────────────── polling (CLI 1.37, or an agent with no state hooks) ────────────────

async function byPolling(o: SuperviseOpts): Promise<AgentResult> {
  const POLL_MS = Number(process.env.PIPELINE_POLL_MS ?? 5000);
  const deadline = Date.now() + o.timeoutSec * 1000;
  let nudged = false, invalidNudged = false;
  let lastScreen = '', lastChange = Date.now();

  for (let tick = 1; ; tick++) {
    await sleep(POLL_MS);

    const v = await readVerdict(o.verdictAbs, o.stage);
    if (v.kind === 'ok') return accepted(o, v);
    if (v.kind === 'invalid') {
      if (invalidNudged) return { kind: 'fail', reason: `${o.label} wrote an invalid verdict twice: ${v.error}` };
      invalidNudged = true;
      await o.log(`invalid verdict (${v.error}); asking for a rewrite`);
      await sup.terminalsSend(o.workspaceId, o.terminalId, o.invalidText(v.error)).catch(() => undefined);
      lastChange = Date.now();
      continue;
    }

    if (Date.now() >= deadline) return failFrom(o.label, `ran past its ${o.timeoutSec}s limit without writing a verdict`, await screenOf(o));

    // Has the process ended? (`opencode run` exits when done; TUIs stay open.)
    if (tick % 3 === 0) {
      const sessions = await sup.terminalsList(o.workspaceId).catch(() => null);
      const s = sessions?.find((x) => x.terminalId === o.terminalId);
      if (sessions && (!s || s.exited)) {
        const late = await readVerdict(o.verdictAbs, o.stage);
        if (late.kind === 'ok') return accepted(o, late);
        return failFrom(o.label, `exited${s ? ` with code ${s.exitCode}` : ''} without writing a verdict`, await screenOf(o));
      }
    }

    // Has the screen stopped changing? Claude's and Codex's spinners keep it moving while they
    // work. `opencode run` prints nothing until a tool call finishes, so a long silent command
    // reads as a stall.
    if (tick % 4 === 0) {
      const screen = await screenOf(o);
      if (screen !== lastScreen) {
        lastScreen = screen;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= o.stallSec * 1000) {
        if (nudged) return failFrom(o.label, `went idle twice without writing a verdict`, screen);
        nudged = true;
        await o.log(`${o.label} idle ${o.stallSec}s with no verdict; nudging`);
        await sup.terminalsSend(o.workspaceId, o.terminalId, o.nudgeText).catch(() => undefined);
        lastChange = Date.now();
      }
    }
  }
}

// ───────────────────────── agents wait (newer CLI) ─────────────────────────

async function byWait(o: SuperviseOpts): Promise<AgentResult> {
  let deadline = Date.now() + o.timeoutSec * 1000;
  let nudged = false, invalidNudged = false, flaky = 0;

  for (;;) {
    const remaining = (deadline - Date.now()) / 1000;
    if (remaining <= 0) return failFrom(o.label, `ran past its ${o.timeoutSec}s limit without writing a verdict`, await screenOf(o));
    const w = await sup.agentsWait(o.workspaceId, o.terminalId, { until: 'settled', timeoutSec: remaining });

    const v = await readVerdict(o.verdictAbs, o.stage);
    if (v.kind === 'ok') return accepted(o, v);
    if (v.kind === 'invalid') {
      if (invalidNudged) return { kind: 'fail', reason: `${o.label} wrote an invalid verdict twice: ${v.error}` };
      invalidNudged = true;
      await sup.terminalsSend(o.workspaceId, o.terminalId, o.invalidText(v.error)).catch(() => undefined);
      continue;
    }

    if (!w.ok) {
      const ex = await sup.agentsExplain(o.workspaceId, o.terminalId).catch(() => null);
      if (ex?.state === 'exited') return failFrom(o.label, `exited without a verdict (${ex.because})`, await screenOf(o));
      if (Date.now() >= deadline) {
        const why = ex?.state === 'none' ? ` Paradev never received a state hook from it (${ex.because}).` : '';
        return failFrom(o.label, `ran past its ${o.timeoutSec}s limit without writing a verdict.${why}`, await screenOf(o));
      }
      if (++flaky > 5) return { kind: 'fail', reason: `paradev agents wait keeps failing: ${w.stderr.trim().slice(0, 300)}` };
      await sleep(5000);
      continue;
    }
    flaky = 0;

    if (w.state === 'blocked') {
      await o.onBlocked();
      const t0 = Date.now();
      // `settled` returns at once while blocked, so wait for it to resume working instead.
      const resumed = await sup.agentsWait(o.workspaceId, o.terminalId, { until: 'working', timeoutSec: o.humanWaitSec });
      deadline += Date.now() - t0;
      if (!resumed.ok && !existsSync(o.verdictAbs)) return { kind: 'fail', reason: `${o.label} waited for input for ${o.humanWaitSec}s with no answer` };
      continue;
    }

    if (w.state === 'idle') {
      if (nudged) return failFrom(o.label, 'ended its turn twice without writing a verdict', await screenOf(o));
      nudged = true;
      await o.log(`${o.label} went idle with no verdict; nudging`);
      await sup.terminalsSend(o.workspaceId, o.terminalId, o.nudgeText).catch(() => undefined);
    }
  }
}
