export const STAGES = ['spec', 'tests', 'implement', 'review', 'ship'] as const;
export type Stage = (typeof STAGES)[number];
export type Role = 'author' | 'reviewer';

export const stageIndex = (s: Stage) => STAGES.indexOf(s);
export const isStage = (s: unknown): s is Stage => typeof s === 'string' && (STAGES as readonly string[]).includes(s);

/** One agent launch: a Paradev preset id ("claude", "codex") or a host agent row UUID. */
export interface AgentSpec {
  agent: string;
  model?: string;
  effort?: string;
  /** Display name for logs and notifications. Defaults to agent[:model]. */
  label?: string;
}

export interface StageConfig {
  /** The agent that produces the stage's output. Omit for review-only stages. */
  author?: AgentSpec;
  /** Run in parallel after the author's work passes the gates. Any revert sends the work back. */
  reviewers?: AgentSpec[];
  /** Per-agent working time limit, excluding time spent waiting for a human. */
  timeoutSec?: number;
  extraWritable?: string[];
  extraForbidden?: string[];
  /** Carved out of this stage's forbidden globs. The pipeline's own files stay forbidden regardless. */
  forbiddenExcept?: string[];
  /** Author stages only. Run after the write-policy check, before the gate, with `{slug}` substituted. At tests they mustn't need the implementation. */
  checks?: string[];
}

export interface Config {
  /** The spec format. A profile's preset is merged between the operator's config and the profile. Default markdown. */
  preset?: 'markdown' | 'openspec';
  /** The profile file this config was resolved from. */
  profile?: string;
  paradev?: {
    /** Skip auto-detection from `paradev projects list`. Personal profiles only: the id belongs to one Paradev install. */
    projectId?: string;
  };
  commands: {
    /** Exit 0 = pass. Run by the driver, never trusted from an agent's claim. */
    test: string;
    /** Typecheck, lint, build: run after implement, review, ship. */
    checks?: string[];
  };
  paths: {
    /** Globs the spec stage owns. `{slug}` is substituted. */
    spec: string[];
    /** The single file agents are told to write/read as the spec. */
    specDoc: string;
    /** Globs the tests stage owns. Implement can never touch these. */
    tests: string[];
    /** Globs the ship stage may touch. */
    changelog?: string[];
  };
  stages: Record<Stage, StageConfig>;
  gates?: {
    /** Pause for human approval after these stages advance. */
    approveAfter?: Stage[];
    /** Pause for human approval before these stages start. */
    approveBefore?: Stage[];
    /** Pause before executing any revert that targets these stages. */
    approveRevertTo?: Stage[];
  };
  limits?: {
    /** Failed attempts at one stage before escalating. Default 3. */
    maxAttemptsPerStage?: number;
    /** Reviewer-requested revision rounds at one stage before escalating. Default 4. */
    maxReviewRounds?: number;
    /** Stage runs (advances + retries + reverts) since the run started or was last resumed, before escalating. Default 25. */
    maxTransitions?: number;
    /** How long an agent may sit waiting for your input. Default 4h. */
    humanWaitSec?: number;
    defaultTimeoutSec?: number;
    /** Polling (a CLI without `agents wait`, or an agent that reports no state): a screen unchanged this long counts as idle. Default 240. */
    stallSec?: number;
  };
  /** Setup scripts run in the background; the driver waits for this file (worktree-relative) before starting. */
  setupReadyFile?: string;
  /** Default 900. */
  setupTimeoutSec?: number;
  /** Run by the driver in a new worktree before the first stage. Anything it writes must be ignored, or no stage could pass its write policy. */
  setup?: string;
  /** The repo's own agent instructions, worktree-relative. Default: AGENTS.md, else CLAUDE.md. */
  instructions?: string;
  /** After the tests stage the suite must fail. Turn off for pure refactors. Default true. */
  testsMustFailBeforeImplement?: boolean;
  ship?: {
    /** Push and open a PR after ship. Default true. */
    push?: boolean;
    draftPr?: boolean;
    /** "none": PRs get a title only, for repos where a bot writes the summary. Default "pr.md". */
    prBody?: 'pr.md' | 'none';
    /** Default: origin's HEAD branch. */
    baseBranch?: string;
  };
}

export interface Verdict {
  stage: Stage;
  verdict: 'advance' | 'revert' | 'blocked';
  target?: Stage;
  summary: string;
  reason: string;
  /** The commit subject for an author's work. Untrusted: the driver checks its shape and falls back to the summary. */
  subject?: string;
}

export interface HistoryEntry {
  ts: string;
  stage: Stage;
  event: 'enter' | 'advance' | 'retry' | 'revise' | 'revert' | 'escalate' | 'pause' | 'approve' | 'goto' | 'restore';
  detail: string;
}

export interface Pause {
  kind: 'approval' | 'escalation';
  message: string;
  gates?: string[];
  pendingRevert?: { from: Stage; target: Stage; reason: string };
}

export interface RunState {
  id: string;
  slug: string;
  repo: string;
  dir: string;
  workspaceId: string;
  branch: string;
  baseBranch: string;
  /** Commit the run forked from. `git diff baseSha` is the whole feature. */
  baseSha: string;
  brief: string;
  /** superpipe's commit when the run started, so `resume` can warn that the driver has moved under it. */
  superpipe?: string;
  /** False until setup has succeeded. Unset on runs started before the driver ran setup. */
  setupDone?: boolean;
  current: Stage;
  status: 'running' | 'paused' | 'done';
  pause?: Pause;
  /** Failed attempts at the current stage since it was entered. */
  attempts: number;
  /** Reviewer-requested revision rounds at the current stage. Counted separately from failures. */
  reviewRounds?: number;
  /** Where a reset within the current stage goes. Unset means the stage's start; otherwise the latest committed draft: the author's last commit, a restored or kept draft. */
  retryBase?: string;
  /** The current stage was entered after a revert, or on the way back through; `runStage` restores its last draft once. */
  restorePending?: boolean;
  /** The draft `restoreDraft` last committed. Agents are told about it only while `retryBase` is still `commit`. */
  restored?: { checkpoint: string; commit: string; skipped: string[] };
  /** Why the run went back. Shown at every stage from `target` on, until `from` advances again. */
  revisit?: { target: Stage; from: Stage; reasons: string[] };
  /** Deny rules the driver added to the worktree's `.claude/settings.local.json` for the agents now running. `resume` removes any a crash left. */
  claudeDeny?: { added: string[]; created: boolean };
  /** Stage runs since the run started or was last resumed. */
  transitions: number;
  seq: number;
  /** HEAD when each stage was (last) entered going forward. Reverts reset to these. */
  stageStart: Partial<Record<Stage, string>>;
  /** Delivered to the next agent launched for the current stage, then cleared on advance. */
  feedback: string[];
  /** Human notes from resume --note. Shown to every agent for the rest of the run. */
  notes: string[];
  history: HistoryEntry[];
  activeTerminals: string[];
}

export type Outcome =
  | { kind: 'advance'; summary: string }
  | { kind: 'retry'; reason: string }
  /** Reviewers want changes to the author's work: keep it and have the author revise it. */
  | { kind: 'revise'; reason: string }
  | { kind: 'revert'; target: Stage; reason: string }
  | { kind: 'escalate'; reason: string };
