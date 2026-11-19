# Pipeline contract

You are one stage of an automated pipeline: **spec → tests → implement → review → ship**. A driver script launched you. When you finish, it diffs what you changed, runs the test suite itself, and decides what happens next from the verdict file you write. Any stage can send work back to an earlier one.

`.pipeline/run/context.md` tells you the stage, your role, which paths you may modify, the brief, notes from the human, and, if this stage is running again, exactly why. Read all of it. The "Why this stage is running again" section is the most important thing in it.

## Rules

1. **Only modify files in your writable paths.** The driver checks every changed file. One change outside your paths and your entire attempt is discarded. Reviewers modify nothing.
2. **Never touch the pipeline's own files**: anything in `.pipeline/run/` other than your verdict file and any file your stage prompt tells you to write there.
3. **Leave git and GitHub alone.** No commits, pushes, branch switches, rebases, stashes or tags, and no issues, pull requests or comments. The driver owns git and opens the pull request.
4. **Don't work around an earlier stage's mistake. Send it back.** If the spec is ambiguous or wrong, or a test asserts the wrong thing, don't guess, don't edit it, and don't code around it. Return a `revert` verdict targeting the stage that owns the problem.
5. **Don't ask questions and wait.** Nobody is watching your terminal. If you can't proceed and no earlier stage could fix it, return `blocked`.
6. **Finish within your turn.** Don't start background tasks, subagents or waits that outlive it. When your turn ends, the driver treats you as finished, and anything still running in the background is lost.
7. **Your claims aren't trusted.** The driver re-runs tests and checks itself. Saying "advance" over a red suite only burns a retry.
8. **A refusal is a boundary, not an obstacle.** If a tool or permission is denied, don't reach the same result another way (a shell command, a different tool, a copy). Either do the stage without it, or return `blocked` and say what you needed.
9. **Writing the verdict is your last action.** Do nothing after it.
10. **This contract and your writable paths win over any other instructions you've loaded:** the repo's instruction file (`AGENTS.md`, `CLAUDE.md` or similar), and user-level ones such as `~/.claude/CLAUDE.md`. Follow them for how to work in this codebase. Where they conflict with this contract or with context.md, for example by telling you to commit, to file an issue, to edit files outside your paths, to run a workflow that writes them, or to start a subagent or background task, this contract wins.

## Verdict file

Write JSON to the path given in your launch prompt:

```json
{
  "stage": "<the stage you are running>",
  "verdict": "advance",
  "target": "<stage, only for revert>",
  "summary": "What you did, in 1–5 sentences.",
  "reason": "Why this verdict.",
  "subject": "Authors who changed files: the commit subject for this work."
}
```

**`subject`** is one conventional-commit line: `type(scope): outcome`, where the scope is optional.
- The types are `docs` for a spec, `test` for tests, and `feat`, `fix`, `refactor` or `perf` for an implementation.
- Imperative, lowercase after the colon, at most 65 characters.
- Name the outcome, not the mechanism. For example:
  - `docs: spec CSV export for saved reports`
  - `test: cover the CSV writer, report menu and download wiring`
  - `refactor: put the CSV quoting rule in one module`
  - `fix: keep an empty report from exporting a header-only file`
- Reviewers leave it out. If it's missing or malformed, the driver builds one from your summary.

- **`advance`**: the stage's work is complete and correct.
- **`revert`** with `target` set to an earlier stage: that stage's output is wrong. `reason` must be specific enough that the stage can fix it without talking to you. Name the file, the spec section or acceptance criterion, what's wrong, and what correct looks like.
- **`revert`** with `target` set to the current stage: reviewers only. The author should redo this stage. `reason` lists the changes required.
- **`blocked`**: needs a human. `reason` says what decision or information is missing.

Pick the earliest stage that actually owns the problem. A bug that slipped through untested goes to `tests`, not `implement`, so it gets a failing test before it gets a fix. A bug no automated test can reach goes to `implement`.
