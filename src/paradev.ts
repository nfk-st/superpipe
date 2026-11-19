/**
 * Thin wrapper over the `paradev` CLI (beta). Every call passes --local: several
 * commands default to the cloud when the account has cloud workspaces.
 * Shapes below are from the CLI reference docs as of Oct 2026; the
 * ones marked VERIFY weren't documented precisely and are read defensively.
 */
import { execFile } from 'node:child_process';
import type { AgentSpec } from './types.ts';

const BIN = process.env.PARADEV_BIN ?? 'paradev';

export class ParadevError extends Error {
  constructor(public args: string[], public code: number, public stderr: string) {
    super(`${BIN} ${args.join(' ')} exited ${code}: ${stderr.trim().slice(0, 500)}`);
  }
}

interface Raw { code: number; stdout: string; stderr: string }

function call(args: string[], timeoutMs = 120_000): Promise<Raw> {
  return new Promise((resolve) => {
    execFile(BIN, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) });
    });
  });
}

async function json<T>(args: string[], timeoutMs?: number): Promise<T> {
  const full = [...args, '--json'];
  const r = await call(full, timeoutMs);
  if (r.code !== 0) throw new ParadevError(full, r.code, r.stderr);
  return JSON.parse(r.stdout) as T;
}

async function plain(args: string[]): Promise<string> {
  const r = await call(args);
  if (r.code !== 0) throw new ParadevError(args, r.code, r.stderr);
  return r.stdout.trim();
}

export async function projectsList(): Promise<Array<{ id: string; name: string; repoPath?: string; path?: string }>> {
  return json(['projects', 'list', '--local']);
}

export async function workspaceCreate(o: {
  projectId: string; name: string; branch: string; baseBranch: string;
}): Promise<{ id: string; alreadyExists: boolean }> {
  // VERIFY: assumed to mirror the SDK's WorkspaceCreateResult ({ workspace, alreadyExists }).
  const r = await json<any>([
    'workspaces', 'create', '--local',
    '--project', o.projectId, '--name', o.name,
    '--branch', o.branch, '--base-branch', o.baseBranch, '--skip-branch-prefix',
  ]);
  const id = r?.workspace?.id ?? r?.id;
  if (!id) throw new Error(`Couldn't find a workspace id in: ${JSON.stringify(r).slice(0, 300)}`);
  return { id, alreadyExists: Boolean(r?.alreadyExists) };
}

// Not `--field`: CLI 1.39 turns on --json when it sees an agent env var (CLAUDECODE, CI, …),
// and --json overrides --field, so a driver launched from an agent shell got the whole object.
export async function workspaceField(id: string, field: string): Promise<string> {
  const ws = await json<Record<string, unknown>>(['workspaces', 'get', id]);
  const v = ws[field];
  if (typeof v !== 'string') throw new Error(`No string ${field} in: ${JSON.stringify(ws).slice(0, 300)}`);
  return v;
}

export async function agentsCreate(o: AgentSpec & { workspaceId: string; prompt: string }) {
  const args = ['agents', 'create', '--local', '--workspace', o.workspaceId, '--agent', o.agent, '--prompt', o.prompt];
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  return json<{ kind: 'terminal' | 'chat'; sessionId: string; label: string }>(args);
}

export type AgentState = 'starting' | 'working' | 'blocked' | 'idle';

/**
 * Blocks until the agent reaches `until`. `settled` = finished its turn OR needs input,
 * so callers must check the state. Exits non-zero on timeout and when the agent exits;
 * `ok: false` covers both, use agentsExplain to tell them apart.
 */
export async function agentsWait(workspaceId: string, terminalId: string, o: {
  until?: 'settled' | 'idle' | 'blocked' | 'working'; timeoutSec: number;
}): Promise<{ ok: true; state: AgentState; lastEventType: string | null } | { ok: false; stderr: string }> {
  const args = ['agents', 'wait', '--local', '--workspace', workspaceId, '--terminal', terminalId,
    '--until', o.until ?? 'settled', '--timeout', String(Math.max(1, Math.floor(o.timeoutSec))), '--json'];
  const r = await call(args, (o.timeoutSec + 60) * 1000);
  if (r.code !== 0) return { ok: false, stderr: r.stderr };
  const p = JSON.parse(r.stdout);
  return { ok: true, state: p.state, lastEventType: p.lastEventType ?? null };
}

export async function agentsExplain(workspaceId: string, terminalId: string) {
  return json<{
    state: AgentState | 'exited' | 'none'; because: string; details: string[];
    lastEventType: string | null; lastEventAt: number | null;
  }>(['agents', 'explain', '--local', '--workspace', workspaceId, '--terminal', terminalId]);
}

export interface TerminalSession {
  terminalId: string; exited: boolean; exitCode: number; title: string | null;
}

export async function terminalsList(workspaceId: string): Promise<TerminalSession[]> {
  const r = await json<{ sessions: TerminalSession[] }>(['terminals', 'list', '--local', '--workspace', workspaceId]);
  return r.sessions ?? [];
}

export async function terminalsRead(workspaceId: string, terminalId: string, maxLines = 80): Promise<string> {
  const r = await json<{ text: string }>(['terminals', 'read', '--local', '--workspace', workspaceId,
    '--terminal', terminalId, '--max-lines', String(maxLines)]);
  return r.text ?? '';
}

let waitSupported: boolean | undefined;
/** `agents wait`/`explain` arrived after CLI 1.37. Detected once from `agents --help`. */
export async function hasAgentsWait(): Promise<boolean> {
  if (waitSupported === undefined) {
    if (process.env.PIPELINE_NO_WAIT === '1') return (waitSupported = false);
    const r = await call(['agents', '--help']);
    waitSupported = /^\s+wait\b/m.test(r.stdout + r.stderr);
  }
  return waitSupported;
}

export async function terminalsSend(workspaceId: string, terminalId: string, text: string) {
  await plain(['terminals', 'send', '--local', '--workspace', workspaceId, '--terminal', terminalId, '--text', text]);
}

export async function terminalsClose(workspaceId: string, terminalId: string) {
  await plain(['terminals', 'close', '--local', '--workspace', workspaceId, '--terminal', terminalId]);
}

/** Best effort: a failed notification must never break the run. */
export async function notify(title: string, body: string, target?: { workspaceId: string; terminalId?: string }) {
  const args = ['notifications', 'show', title, '--body', body, '--sound'];
  if (target) {
    args.push('--workspace', target.workspaceId);
    if (target.terminalId) args.push('--terminal', target.terminalId);
  }
  await call(args).catch(() => undefined);
}
