# superpipe

Drives a **spec → tests → implement → review → ship** pipeline through the Paradev CLI, with the agent, model and effort you choose for each stage, and reverts from any stage to any earlier one.

Agents do the judgement work. The driver does everything that should be deterministic: which files each stage may touch, running tests, committing, reverting, loop caps and human gates. Agents talk to it through one file each, a JSON verdict.

It's optional, per person and per repo. Nothing pipeline-related is committed to a repo, and stopping leaves nothing to tidy up (see "Stop using superpipe"). The vocabulary is in `CONTEXT.md`.

## Install

You need:

- **macOS, with the Paradev desktop app open during runs.** It runs the host service the CLI talks to, and installs the `paradev` command the driver calls. It has no Windows or Linux build yet.
- **Node 22 or later, git, and the GitHub CLI (`gh`), signed in.** Ship opens the PR with `gh`.
- **Claude Code.** The starter lineup uses nothing else.
- **Any other agent your own lineup uses,** such as Codex, and the `openspec` CLI for a repo on the openspec preset.

```bash
git clone git@github.com:nfk-st/superpipe.git
cd superpipe
npm ci
npm link    # puts `superpipe` on your PATH
```

**Update with `git pull` between runs.** A run freezes its config and prompts at `start`, but the driver is whatever is checked out. `resume` warns when superpipe has moved since the run started.

## Before a repo's first run

- **Add the repo to Paradev as a project.** `start` finds the project by the repo's path.
- **Trust the repo once in each agent your lineup uses.** Run `claude`, and `codex` if your lineup has it, in the repo's main checkout, and accept the trust prompt.
  - A worktree inherits its main checkout's trust. For Codex, a trusted parent folder doesn't count.
  - The prompt appears before anything reports "needs input", so an untrusted repo's first stage would hang silently. `start` refuses such a repo. It also refuses when an agent in your lineup has no config file at all, because then it has never trusted any repo.
- **Keep the base branch level with origin.** `start` fetches, then refuses a local base branch that's behind, ahead of, or diverged from `origin/<base>`, saying what to do. A run must start from exactly the code its PR merges into.
- **The repo needs a profile.** `superpipe profile --repo <path>` has Claude Code write one with you, then checks it. Running it first also gets you Claude Code's trust prompt for the repo. See "Getting a profile".

## How a run works

One Paradev workspace (one worktree) per feature. Stages run sequentially inside it.

At `start`, the driver resolves the repo's config, then freezes it and the prompts into the run directory. It then runs the profile's `setup` in the new worktree. For each stage it:

1. Copies the frozen prompts into the worktree's self-ignoring `.pipeline/run/prompts/`. It also writes `.pipeline/run/context.md` with the brief, stage, writable paths, spec format, human notes, run history, and why the stage is re-running if it is.
2. Launches the stage's **author** with `paradev agents create`, pointing it at the contract, the repo's instruction file (`AGENTS.md` or `CLAUDE.md`), the stage prompt and the context, in that order.
3. Watches it: with `paradev agents wait` if the agent reports state through Paradev's hooks, otherwise by its screen. If the agent goes idle without a verdict it gets one nudge. If it's waiting for input, you get a desktop notification and the clock pauses.
4. Reads the verdict. On `advance` it diffs the worktree against the stage's start commit and **discards the whole attempt if any file outside the stage's writable paths changed**. Then it runs the stage's own checks, then the gates, and commits.
   - **The stage's work since its start becomes one commit,** whatever built it: revise rounds, a restored draft, kept work. So the branch carries one commit per author stage.
   - **The commit subject** is the one the stage's work already carries: its earliest commit since its start, or for a restored draft, the checkpoint it came from. Failing that, it's the author's conventional `subject`, such as `test: cover the CSV writer`. A missing or malformed one becomes `<type>: <summary>`, cut at a word boundary within 65 characters.
   - **A stage that changed nothing** makes no commit.
   - **A failing test command is re-run once** before the driver acts on it, so one flaky test doesn't cost the stage. A command the driver killed for hanging isn't re-run, and nor are the other checks.
5. Launches the stage's **reviewers** in parallel against that commit. Any revert sends the work back. If several revert, the earliest target wins. When they named different stages, the reason says so and tells each stage to do only its own part. Edits made by reviewers are thrown away, commits included. Whatever the reviewers decide, a reset within the stage returns to the author's commit, not past it.
6. Advances: records a checkpoint, `refs/superpipe/<run>/<nn>-<stage>`, then enters the next stage. Or retries, reverts or pauses.

Who may write what:

| Stage | Writable | Gate after author |
|---|---|---|
| spec | `paths.spec` | none |
| tests | `paths.tests` | suite must **fail** (`testsMustFailBeforeImplement`) |
| implement | everything except spec and tests | test + checks pass |
| review | nothing | test + checks run *before* reviewers |
| ship | `paths.changelog` (+ `.pipeline/run/pr.md`) | test + checks pass, then push and open a PR |

Any author stage can also have its own `checks`, which run before its gate. The openspec preset uses them at spec and implement.

A revert to stage X does `git reset --hard` to the commit where X started, drops everything downstream, and re-runs X with the reason as feedback.

- **Drafts come back.** X, and every later stage the run passes through again, starts from its own last draft. The driver restores the files that stage owns from its last checkpoint, on top of the earlier stages' new work, and tells the author to adapt the draft rather than start over.
- **The reason travels.** Every stage from X on is told why the run came back, until the stage that sent it back advances again.
- **A retry** resets within one stage: to the stage's start, or to its latest committed draft.

Run state lives outside the worktree, in `~/.superpipe/runs/<id>/`: the state, the frozen config and prompts, `log.jsonl` and gate logs. So agents can't tamper with it.

## Your lineup

The **lineup** is which agent, model and effort fill each stage's author and reviewer roles. It's yours, not the repo's, because it depends on your accounts.

With no config of your own, you get the **starter lineup** from `defaults.json`. It needs only Claude Code:

| Stage | Author | Reviewers |
|---|---|---|
| spec | `claude` `fable` max | `claude` `opus` max |
| tests | `claude` `opus` xhigh | `claude` `fable` high |
| implement | `claude` `sonnet` xhigh | none |
| review | none | `claude` `fable` max, `claude` `opus` max |
| ship | `claude` `sonnet` medium | none |

No reviewer runs the model of the author it reviews. `start` warns when your own lineup does.

To change it, write `~/.superpipe/config.json`. It's merged over `defaults.json`:

- **Objects merge key by key.** Arrays and an `author` replace the default outright.
- **So `gates` merges per key.** To turn a gate off, set it to `[]`.

Mixing vendors is recommended. For example, Codex reviewing the spec and writing the tests:

```json
{
  "stages": {
    "spec": { "reviewers": [{ "agent": "codex", "model": "gpt-6-sol", "effort": "max" }] },
    "tests": { "author": { "agent": "codex", "model": "gpt-6-sol", "effort": "max" } }
  }
}
```

Your config also owns:

- **`gates`:** when the run pauses for you. The defaults pause after spec, before ship, and before any revert to spec.
- **`limits`:** `maxAttemptsPerStage` (3), `maxReviewRounds` (4), `maxTransitions` (25), `humanWaitSec` (4 hours), `stallSec` (240) and `defaultTimeoutSec` (3600).
- **`stages.<stage>.timeoutSec`:** an agent's working time, not counting time waiting for you. The starter gives implement 5400 and ship 1200.

A profile can't set any of these.

## Agents, models and effort

- **`claude`:** Paradev's stock preset. It takes `fable`, `opus`, `sonnet`, `haiku` or a pinned id, and effort `low`, `medium`, `high`, `xhigh` or `max`.
- **`codex`:** the stock preset. It takes `gpt-6-astra`, `gpt-6-sol` or `gpt-6-luna`, and effort `low` to `max`. Astra and Sol also take `ultra`.
- **A custom Paradev agent row,** named by its UUID, with an optional `label` for logs. Paradev's CLI can't create one, so make it in the app.

Paradev rejects unknown models and efforts before launch, which surfaces as a retry reason.

### GLM through Claude Code

GLM runs inside Claude Code, through Z.ai's Anthropic-compatible endpoint, on a custom row.

- **Its command:** `exec env ANTHROPIC_MODEL=glm-5.3[1m] ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic ANTHROPIC_AUTH_TOKEN=<your Z.ai key> API_TIMEOUT_MS=3000000 claude --dangerously-skip-permissions`
- **The other fields:** prompt transport `argv`, no prompt-only args, resume args `--resume`, fork args `--resume {sessionId} --fork-session`.
- **Paste the key's literal value.** Paradev single-quotes each argument when it types the command into zsh, so `$GLM_API_KEY` would never expand. The same quoting is what makes `[1m]` safe; it tells Claude Code about GLM's 1M-token window.
- **The `exec`** ends the terminal when Claude Code exits.
- **Because it's Claude Code,** Paradev's global Claude hooks report its state, so the driver supervises it with `agents wait`. It also needs the repo trusted in Claude Code.
- **Unverified:** Claude Code shows GLM at "xhigh effort". Whether Z.ai honours that, or applies GLM 5.3's own default of `max`, isn't known.

## Profiles

A **profile** holds a repo's facts and conventions: how to set it up and test it, which paths each stage owns, and how its PRs look.

- **Your profiles** live in `~/.superpipe/repos/`, one per repo. Profiles are personal, shared by export and import (`docs/adr/0002-profiles-are-personal.md`).
- **Team profiles:** superpipe ships none, but still reads a `repos/` folder in its own checkout. A personal profile for the same repo wins outright over a team one.
- **A profile matches the repo's `origin` by its `remote`.** `git@github.com:org/repo.git`, `ssh://git@github.com/org/repo` and `https://github.com/org/repo` all match, whatever the case. An ssh host alias such as `git@github-work:` doesn't. `start` prints the profile it used.

```json
{
  "remote": "git@github.com:acme/widget.git",
  "preset": "openspec",
  "setup": "npm ci",
  "commands": { "test": "npm test", "checks": ["npm run typecheck"] },
  "paths": { "tests": ["src/**/*.test.ts"] },
  "ship": { "draftPr": false }
}
```

- **`preset`:** the spec format, `markdown` (the default) or `openspec`. See "Spec formats".
- **`setup`:** run by the driver in each new worktree before the first stage. Anything it writes must be gitignored. If it fails, or leaves files that aren't ignored, the run pauses and `resume` runs it again.
- **`setupReadyFile`:** for a repo whose own Paradev setup script runs in the background. End the script by touching a file, such as `node_modules/.setup-done`, and name that file here. The driver waits for it before the first stage.
- **`commands.test` and `commands.checks`:** what the gates run. Exit 0 is a pass.
- **`paths.tests`:** what the tests stage owns. Implement can't touch anything that matches, so keep it as narrow as the repo's real test layout.
- **`paths.spec` and `paths.specDoc`:** markdown only, for example `docs/specs/{slug}.md` for both. The openspec preset supplies them.
- **`paths.changelog`:** what ship may write.
- **`stages.<stage>.checks`:** extra checks for one author stage, run before its gate.
- **`instructions`:** the repo's instruction file, if it's neither `AGENTS.md` nor `CLAUDE.md`. Codex reads only `AGENTS.md` by itself, so a `CLAUDE.md`-only repo depends on this pointer.
- **`ship.prBody`:** `"none"` for a repo whose PRs carry a title only, because a bot writes the summary. The PR is then opened with `--body ""`, and titled with the implement commit's subject. The default, `"pr.md"`, uses the body the ship author writes.
- **`ship.draftPr`, `ship.push` and `ship.baseBranch`:** default `true`, `true`, and origin's default branch.
- **`paradev.projectId`:** personal profiles only, since the id belongs to one Paradev install. It skips the lookup by path.

**Repo knowledge every agent needs belongs in the repo's committed `AGENTS.md`,** not in a profile. That way it reaches people and agents outside the pipeline too.

**A run freezes its resolved config and prompts at `start`,** so editing a profile, your config or the prompts doesn't change a run under way. The exception is a run whose setup hasn't succeeded yet: `resume` re-reads them then. To change a live run's prompts, edit `~/.superpipe/runs/<id>/prompts/`.

### Getting a profile

```bash
superpipe profile --repo ~/code/widget                       # Claude Code writes or revises it with you, then it's checked
superpipe profile check --repo ~/code/widget                 # setup, test and checks in a throwaway worktree
superpipe profile export --repo ~/code/widget > widget.json  # to hand to a teammate
superpipe profile import widget.json
```

- **Build** opens Claude Code in the repo, with a prompt (`prompts/profile.md`) naming the file to write and any profile or failed check to start from.
  - Claude asks you whatever the repo doesn't settle, such as which projects a monorepo's tests should cover.
  - It asks permission once, to write the file outside the repo.
  - When you `/exit`, superpipe checks what it wrote.
- **Check** runs in a fresh worktree at origin's base branch, as a run would. So gitignored build output in your checkout can't hide a step that setup is missing.
  - It stops at the first failure, and keeps that command's output in `~/.superpipe/checks/`.
  - It doesn't cover the re-run of a failing test command, `stages.<stage>.checks`, `setupReadyFile`, or the repo's own Paradev setup script.
- **Export** drops `paradev.projectId`, which names a project in one Paradev install.
- **Import** drops it too, and refuses a profile that sets what an operator owns. It saves over the profile you already have for that repo, so no stale copy can outrank it.

## Spec formats

- **`markdown`**: one spec document. Its acceptance criteria are numbered `AC-1`, `AC-2`, and so on.
- **`openspec`**: the spec is an OpenSpec change at `openspec/changes/<slug>/`, with a proposal, delta specs, and a design if one is needed.
  - After the spec author, the driver checks that `proposal.md` isn't empty and runs `openspec validate <slug> --type change --strict`. A failure discards the attempt, with the validate output as the reason.
  - Implement writes and ticks `tasks.md`, which the driver checks exists. It can't touch `openspec/specs/` or any other change.
  - The pipeline never archives. Living specs update when you archive the change, after it merges.
  - `start` checks the slug against OpenSpec's naming rules. It refuses a slug that already names a spec or change on the base branch, and it needs `openspec` on the PATH.

## Usage

```bash
superpipe start --slug csv-export --brief ~/briefs/csv-export.md --repo ~/code/widget --branch feat/widget-csv-export
superpipe status csv-export-202610230505
superpipe log csv-export-202610230505 --verdicts    # every agent verdict, with its full reason; drop --verdicts for the whole log
superpipe config --repo ~/code/widget               # the config a run in that repo would freeze at start
superpipe profile --repo ~/code/widget              # write the repo's profile with Claude Code; see "Getting a profile"
superpipe resume csv-export-202610230505 --approve
superpipe resume <id> --approve --note "use the existing CsvWriter"
superpipe resume <id> --goto spec --note "AC-4 is wrong: totals exclude tax"
superpipe resume <id> --goto implement --keep-work --note "the saved-reports row has no CSV button"
```

The run's branch is the slug unless `--branch` names one in the repo's own convention, such as `feature/WID-142-csv-export`. The driver pushes and opens the PR from it, so pick it at `start`: renaming a pushed branch on GitHub closes its open PR.

**If the repo's commit subjects carry a scope, name it in the brief,** for example "Commit scope: `reports`". Otherwise implement guesses one from the code's history, and a title-only PR takes its title from implement's commit.

`--goto <stage>` restarts that stage from its start commit. Add `--keep-work` to have its author revise its last draft instead. Later stages re-run either way, each from its own restored draft.

- It works for the current stage, any earlier stage, and the stage right after the current one. The last undoes a revert that went too far back.
- It's refused for review, which has no author, and for a stage with no draft built on its start.
- It's also refused when the reset to the draft would destroy uncommitted changes. All of these are checked before anything changes.
- `--goto` at a pending revert passes the reviewers' reason to the target stage, with or without `--keep-work`.

`--note` persists. Every agent sees it for the rest of the run. Ctrl-C is safe: `resume` closes leftover agent terminals and restarts the interrupted stage from its latest committed draft, which is the author's commit if reviewers were running. `--keep-work` keeps whatever is committed and makes it the stage's draft.

`resume` refuses while another superpipe process is still driving the run. The driver's pid is in `driver.pid` in the run's folder until it exits. After a reboot or a `kill -9` that pid can belong to another process, and the error then tells you to delete the file.

The run pauses when:

- **An approval gate is reached.** The defaults are after spec, before ship, and before any revert to spec.
- **Setup fails,** or leaves files that aren't ignored.
- **A stage fails `maxAttemptsPerStage` times.** The default is 3.
- **The run hits `maxTransitions`.** It counts stage runs since the run started or was last resumed, 25 by default. This catches ping-pong between stages. Any resume starts a fresh count.
- **An agent returns `blocked`, or a reviewer fails to run.**
- **The push fails.** No checkpoint or history entry is recorded first. Fix the cause, then `resume --keep-work`; the ship author re-runs with the error in its context.

**After the PR merges,** archive the run's workspace, then delete its branch:

```bash
paradev workspaces archive <ws-id> --local     # the Workspace line `start` printed, or workspaceId in ~/.superpipe/runs/<id>/state.json
git -C <repo> branch -D <branch>               # -D: a rebase or squash merge leaves the branch's own commits off main
```

- Paradev gives the worktree's removal 120 seconds, and a worktree with a full pnpm install can take longer. If the archive fails with "Failed to verify worktree removal", run it again: it carries on from where it stopped.
- The branch delete is refused until the archive has removed the worktree.

## Supervision

On CLI 1.39 and later the driver uses `agents wait`. It polls instead on older CLIs, and for any agent that reports no state after launch; it logs "reports no state hooks" when it does.

Polling looks for the verdict file, checks `terminals list` for an exited process, and treats a screen unchanged for `limits.stallSec` as idle. The stock Claude and Codex presets bypass permission prompts, so a quiet screen is normally not a prompt.

- **An agent on the polling path that stays silent for longer than `stallSec` reads as a stall.**
- **Claude Code's removal safety check still prompts under bypass mode.** It once fired on a command with no removal in it. Unanswered, it times out after about two minutes and denies the command.

Test any agent through the driver's real supervision code:

```bash
superpipe probe --workspace <ws-id> --agent claude --model fable --effort low
superpipe probe --workspace <ws-id> --agent claude --mode idle --stall-sec 30   # exercises the idle nudge
superpipe probe --workspace <ws-id> --agent <row-uuid> --mode idle              # a custom row: nudged, then a verdict
```

## Stop using superpipe

Nothing in a repo depends on superpipe, so stopping is local to your machine:

- **Remove the command and the clone:** `npm rm -g superpipe`, then delete the clone.
- **Remove your folder:** `rm -rf ~/.superpipe`. It holds your config, your profiles, failed profile checks' logs, and every run's state and logs.
  - A profile check killed mid-run leaves its worktree registered in the repo. `git worktree prune` clears that once the folder is gone.
- **Workspaces and branches:** a run's Paradev workspace and branch are ordinary ones. Archive them as you would any other.
- **Checkpoints:** each run's checkpoints are refs under `refs/superpipe/`, which `git tag`, `git branch` and `git push --tags` never show. To remove them from a clone: `git for-each-ref --format='delete %(refname)' refs/superpipe | git update-ref --stdin`.
- **Deny rules:** these sit in a worktree's `.claude/settings.local.json` only while a pipeline agent is running, so a paused or abandoned run leaves none behind.

## Tests

```bash
npm run typecheck
bash test/matrix.sh                      # every smoke configuration below, with a pass/fail table, in about 3 minutes
bash test/smoke.sh                       # a run from a personal profile, against a fake paradev binary
bash test/profile.sh                     # superpipe profile: build with a fake Claude, check, export and import
SMOKE_SETUP_FAIL=1 bash test/smoke.sh    # the profile's setup fails once
FAKE_MODE=openspec bash test/smoke.sh    # the openspec preset, with the real openspec CLI; also openspec-bad, openspec-livespec
FAKE_MODE=keepwork bash test/smoke.sh    # resume --goto --keep-work from the ship gate; also keepwork-forward, keepwork-current
FAKE_MODE=restore bash test/smoke.sh     # drafts restored after review's revert, including a deleted file
FAKE_MODE=ship bash test/smoke.sh        # commit subjects, no empty ship commit, a failed push, and gh's arguments
FAKE_MODE=cap bash test/smoke.sh         # maxTransitions pauses the run, and a resume carries on to DONE
FAKE_MODE=route bash test/smoke.sh       # reviewers disagree on the target; tests pass the defect on to implement
FAKE_MODE=flaky bash test/smoke.sh       # the test command fails once where it should pass, and the re-run absorbs it
FAKE_MODE=reviewfail bash test/smoke.sh  # a reviewer blocks after the author's revisit, whose commit must survive
FAKE_MODE=noignore bash test/smoke.sh    # .claude/settings.local.json isn't ignored, so the driver leaves it alone
```

Other `FAKE_MODE`s cover failure paths: `noverdict`, `greentests`, `badrevert`, `quota`, `specrevise` and `specrevise-forever`. `noverdict` checks that billing, 401 and rate-limit words on an agent's screen aren't taken for an account problem, and `quota` that Z.ai's quota error is. `FAKE_NO_WAIT=` (empty) exercises the `agents wait` path; add `FAKE_HOOKLESS=1 PIPELINE_STATE_GRACE_MS=500` for an agent with no state hooks. `test/matrix.sh` holds the full list of 23 configurations.

The smoke runs superpipe through a symlink to `bin/superpipe`, as `npm link` installs it.

**For changes to superpipe itself,** `git config core.hooksPath .githooks` runs the typecheck and `test/cites.mjs` before each commit. The cite check lists every `file.ts:N` cite in `README.md` that the commit's changes moved, with its new line number. Run `node test/cites.mjs` before staging to see the same list, and `bash test/cites.test.sh` to test the check itself.

If the checkout has a gitignored `private/terms` file, one extended regex per line, the hooks also refuse a commit whose diff, message, author or committer matches one of them.

**Every mode asserts these refusals before any workspace exists:**
- a repo Claude Code or Codex hasn't trusted
- a lineup agent with no config file
- a profile that sets the gates
- a team profile that names a Paradev project
- in every mode but `ship`, a base branch that differs from origin's

**Every mode also checks:**
- `start` warned about the spec reviewer sharing its author's model
- `resume` warned about a moved superpipe
- `resume` refused while another driver's pid was live, and left that pid file alone
- every mode but `noignore`: the settings file held only the repo's own rules at the first pause

**Every mode that reaches DONE also checks:**
- **the subjects:** each commit subject on the branch is conventional, and no commit type appears twice
- **the write policy:** a non-ASCII test path passes it
- **the deny rules:** they were merged into the repo's own Claude settings at launch, and gone at DONE
- **frozen prompts:** a marker added after `start` reached later launches
- **checkpoints:** the run left no tags, and checkpointed every stage under `refs/superpipe/`

With no `FAKE_MODE`, the personal profile must beat a broken team profile for the same remote.

## What has run for real

superpipe has opened real PRs end to end, on both spec formats, from a committed config and from profiles, in monorepos and single-package repos. The latest ran from a fresh install, on the Claude-only starter lineup.

Still unverified, or not enforced:

- **Nobody but the maintainer has installed superpipe yet.**
- **Nothing outside the worktree is enforced, for any agent.** The rules against it are in the prompts only.
- **Codex's `blocked` state** is unverified on the `agents wait` path. A Codex agent stuck on a question may look busy until the stage timeout.
- **The CLI is beta.** `paradev schema` dumps the command tree as JSON; diff it after an update.

## Deliberate choices

- **Each stage starts clean from committed artifacts**, never from the previous agent's transcript (no `--from-terminal`). Inheriting another model's reasoning defeats the point of using a different model.
- **Bugs found in review go back to tests by default** (see the `review.md` prompt), so a fix arrives with a failing test first.
  - A bug no automated test can reach goes to implement. That's one on a surface the spec checks by hand, or that the repo's instructions put out of test reach.
  - A tests stage sent one anyway leaves its tests as they are and advances. The defect reaches implement with the reviewers' reasons.
- **No git hooks on driver commits.** The driver runs your checks itself. A commit hook failing or hanging mid-run would wedge it with no agent around to fix things, and a hook that runs the tests can never pass the tests stage's deliberately red commit. `--no-verify` isn't enough, because it still runs `prepare-commit-msg`, which lefthook installs. So the driver commits with `core.hooksPath` pointed at `/dev/null`. The ship gate runs every check before the push, and pre-push hooks still run.
- **Escalation keeps the stage's committed draft, and puts its reason in the author's context.** `resume --keep-work` carries on from that draft. A plain `resume` re-runs the stage from its start commit. A discarded attempt is still in the agent's Paradev terminal history until you archive the workspace.
- **Pipeline Claude agents can't start work that outlives their turn.** Around each launch, and each batch of parallel reviewers, the driver merges deny rules for `Agent`, `Monitor`, `Workflow`, `CronCreate` and `Bash(run_in_background:true)` into the worktree's `.claude/settings.local.json`. It removes them as soon as those agents finish, so your own sessions there are never restricted.
  - **It only writes the file where git ignores it,** because an untracked file would fail every write policy. Otherwise it logs a skip.
  - **A command moved to the background on timeout isn't covered.** `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` would cover it, but combined with these denies it removed Bash in testing.
- **The contract wins over every other instruction an agent loads,** the repo's and the user's alike (rule 10 in `prompts/_contract.md`).
- **Profiles live with each operator, never in the repo** (`docs/adr/0002-profiles-are-personal.md`). Using superpipe is each person's choice, so the repo carries nothing for it.
