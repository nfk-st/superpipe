# Write a superpipe profile

You're writing the profile superpipe needs to run its pipeline in this repo. The lines above this prompt give the file to write, superpipe's README, and any profile or failed check to start from.

superpipe runs each feature in a fresh worktree of this repo. It runs the profile's `setup` there, then agents write a spec, tests and an implementation. Its gates run `commands.test` and `commands.checks`, and need exit 0. The exception is after the tests stage, where `commands.test` must fail because the new behaviour is missing. So the test command must run the tests a change in this repo would add.

## What to find out

Read the README's "Profiles" section first: it documents every field. Then read this repo: its instruction file (`AGENTS.md` or `CLAUDE.md`), package manifests and lockfiles, CI config, task runners (Makefile, nx, turbo and the like), where its tests live, and how recent merged PRs look (`gh pr list --state merged --limit 20 --json title,body,headRefName`).

- **`remote`:** exactly what `git remote get-url origin` prints.
- **`setup`:** what a fresh clone needs before the tests and checks can run, such as a frozen-lockfile install and any build whose output they need. It runs in a fresh worktree, so don't count on anything this checkout has already built or keeps gitignored. Anything it writes must be gitignored.
- **`commands.test`:** the repo's unit tests. Non-interactive, no watch mode, and no services or credentials a fresh worktree won't have.
- **`commands.checks`:** what a PR must pass that the tests don't cover, such as a typecheck, lint and format check.
- **`paths.tests`:** globs for the files the tests stage may write: where this repo keeps tests, fixtures and snapshots. Keep them narrow, because the implement stage can't touch anything they match.
- **`preset`:** `openspec` if the repo has an `openspec/` folder. Otherwise leave it out, and set `paths.spec` and `paths.specDoc`, for example `docs/specs/{slug}.md` for both.
- **`ship.prBody`:** `"none"` if the repo's PRs carry a title only, because a bot writes the summary. Set `ship.baseBranch` only if PRs don't merge into origin's default branch.
- **`instructions`:** only if the repo's instruction file is neither `AGENTS.md` nor `CLAUDE.md`.

**Ask the user** whatever the repo doesn't settle, rather than guessing. In a monorepo, ask which projects their changes touch. The test command and checks should cover those projects, and running every project may be too slow.

## Rules

- Write only the profile file. Change nothing in this repo, and don't commit.
- Don't set the lineup, gates, limits or timeouts: `gates`, `limits`, or a stage's `author`, `reviewers` or `timeoutSec`. They're each operator's own, and superpipe refuses a profile that sets them. Don't set `paradev.projectId` either.
- Try the commands you choose here, if the user lets you. superpipe checks the profile in a fresh worktree once you finish.
- If you learn something every agent in this repo should know, suggest adding it to the repo's instruction file. Don't write it yourself.
- Once the file is written, tell the user to exit (`/exit`), so superpipe can check it.
