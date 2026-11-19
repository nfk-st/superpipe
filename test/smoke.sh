#!/usr/bin/env bash
# End-to-end run against a fake `paradev` binary. FAKE_MODE=noverdict|greentests|badrevert for failure paths.
# SMOKE_SETUP_FAIL=1 makes the profile's setup fail once.
# FAKE_MODE=openspec|openspec-bad|openspec-livespec runs a profile on the openspec preset, with the real openspec CLI.
# FAKE_MODE=keepwork|keepwork-forward|keepwork-current exercises resume --goto <stage> --keep-work.
# FAKE_MODE=restore checks that stages re-entered after review's revert get their last drafts back.
# FAKE_MODE=ship pushes to a remote that's missing at first, through a fake gh, for subjects, empty commits and PR args.
# FAKE_MODE=cap hits maxTransitions, then resumes to DONE.
# FAKE_MODE=route has review's reviewers disagree, and tests pass the defect on to implement unchanged.
# FAKE_MODE=flaky makes the test command fail once where it should pass; the driver's re-run must absorb it.
# FAKE_MODE=reviewfail has the tests reviewer block after the tests author's revisit; that author's commit must survive.
# FAKE_MODE=noignore un-ignores .claude/settings.local.json, so the driver must leave it alone.
# Asserts run only in modes that reach DONE.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); P=$(dirname "$HERE"); T=$(mktemp -d)
export PIPELINE_POLL_MS=${PIPELINE_POLL_MS:-200} FAKE_NO_WAIT=${FAKE_NO_WAIT-1}
export REPO=$T/repo FAKE_ROOT=$T/root PIPELINE_HOME=$T/home PARADEV_BIN=$HERE/fake-paradev.mjs
OS=; case "${FAKE_MODE:-}" in openspec*) OS=1 ;; esac
SHIP='"ship": { "push": false },' REMOTE=$T/up.git
if [ "${FAKE_MODE:-}" = ship ]; then
  SHIP='"ship": { "push": true, "prBody": "none" },' REMOTE=$T/origin.git
  mkdir -p $T/bin && printf '#!/bin/sh\nprintf "%%s\\n" "$@" > %s/gh-args\necho https://example.test/pr/1\n' "$T" > $T/bin/gh && chmod +x $T/bin/gh
  export PATH="$T/bin:$PATH"
fi
# Spelled out in full: gates merge key by key over defaults.json's, which also pause before ship and before a revert to spec.
BEFORE='[]'; if [ "${FAKE_MODE:-}" = keepwork ]; then BEFORE='["ship"]'; fi
GATES="\"approveAfter\": [\"spec\"], \"approveBefore\": $BEFORE, \"approveRevertTo\": []"
LIMITS='"stallSec": 1'
TESTCMD='sh tests/add.test.sh'
# Only once the suite would pass, so the tests stage's red gate never trips the marker.
if [ "${FAKE_MODE:-}" = flaky ]; then TESTCMD="sh tests/add.test.sh && { [ -e $T/flaked ] || { touch $T/flaked; exit 1; }; }"; fi
# Six runs after the spec gate end at review's revert to tests, so the cap pauses at implement.
if [ "${FAKE_MODE:-}" = cap ]; then LIMITS="$LIMITS, \"maxTransitions\": 6"; fi
mkdir -p $REPO $FAKE_ROOT && cd $REPO && git init -q -b main && git config user.email t@t && git config user.name t
export PIPELINE_CLAUDE_CONFIG=$T/claude.json PIPELINE_CODEX_CONFIG=$T/codex.toml
echo "{ \"projects\": { \"$(pwd -P)\": { \"hasTrustDialogAccepted\": true } } }" > $PIPELINE_CLAUDE_CONFIG && echo '{ "projects": {} }' > $T/claude-untrusted.json
printf '[projects."%s"]\ntrust_level = "trusted"\n' "$(pwd -P)" > $PIPELINE_CODEX_CONFIG
printf 'model = "x"\n\n[projects."%s"]\ntrust_level = "trusted"\n' "$(dirname "$(pwd -P)")" > $T/codex-untrusted.toml # a trusted parent must not count
# spec's reviewer is its author's model, which start must warn about.
STAGES='"stages": { "spec": { "author": {"agent":"claude"}, "reviewers": [{"agent":"claude"}] },
              "tests": { "author": {"agent":"codex"}, "reviewers": [{"agent":"glm"}] },
              "implement": { "author": {"agent":"glm"} },
              "review": { "reviewers": [{"agent":"claude"}, {"agent":"codex"}] },
              "ship": { "author": {"agent":"claude"} } }'
export PIPELINE_REPOS_DIR=$T/repos
SETUP='echo installing; mkdir -p node_modules'
# A settings file of the repo's own, which the driver's deny rules must merge into and leave behind.
echo '{ "permissions": { "deny": ["WebFetch"] }, "env": { "KEEP": "1" } }' > $T/seed-claude-local.json
[ "${FAKE_MODE:-}" = noignore ] || SETUP="$SETUP; mkdir -p .claude; cp $T/seed-claude-local.json .claude/settings.local.json"
[ -z "${SMOKE_SETUP_FAIL:-}" ] || SETUP="[ -e $T/setup-failed ] || { touch $T/setup-failed; echo boom; exit 1; }; $SETUP"
PRESET=markdown SPEC='"spec": ["docs/specs/{slug}.md"], "specDoc": "docs/specs/{slug}.md",'
[ -z "$OS" ] || PRESET=openspec SPEC=
mkdir -p $T/repos $PIPELINE_HOME/repos
# The operator's lineup, gates and limits, merged over superpipe's own defaults.json.
cat > $PIPELINE_HOME/config.json <<JSON
{ $STAGES, "gates": { $GATES }, "limits": { $LIMITS } }
JSON
PROFILES=$T/repos
# With no FAKE_MODE the profile is personal, and a team decoy for the same remote must lose to it.
if [ -z "${FAKE_MODE:-}" ]; then
  PROFILES=$PIPELINE_HOME/repos
  echo "{ \"remote\": \"$REMOTE\", \"commands\": { \"test\": \"exit 1\" }, \"paths\": { $SPEC \"tests\": [\"**/tests/**\"] } }" > $T/repos/decoy.json
fi
# setupReadyFile: the fake's workspace create writes it, standing in for a repo's own setup script running in the background.
cat > $PROFILES/demo.json <<JSON
{ "remote": "$REMOTE", "preset": "$PRESET", "setup": "$SETUP", $SHIP
  "setupReadyFile": "node_modules/.setup-done",
  "commands": { "test": "$TESTCMD", "checks": ["true"] },
  "paths": { $SPEC "tests": ["**/tests/**"], "changelog": ["CHANGELOG.md"] } }
JSON
echo 'Keep scripts POSIX.' > CLAUDE.md
if [ "${FAKE_MODE:-}" = restore ]; then mkdir -p src && echo 'echo old' > src/old.sh; fi
if [ -n "$OS" ]; then
  mkdir -p openspec/specs/x
  printf '# x\n\n## Requirements\n\n### Requirement: X\nX SHALL exist.\n\n#### Scenario: X\n- **WHEN** asked\n- **THEN** it exists\n' > openspec/specs/x/spec.md
fi
# The settings file is ignored here as in the target repos, not by this machine's global ignore.
printf 'node_modules/\n.claude/settings.local.json\n' > .gitignore
if [ "${FAKE_MODE:-}" = noignore ]; then echo '!.claude/settings.local.json' >> .gitignore; fi
git add -A && git commit -qm init && echo "Add add.sh" > $T/brief.md
# Profiles match on it, so it's set before the first start. ship's is created only after the first push fails.
git remote add origin $REMOTE
# Through a symlink, as `npm link` installs it.
mkdir -p $T/bin && ln -s $P/bin/superpipe $T/bin/superpipe
pipeline() { $T/bin/superpipe "$@"; }
fails=0
expect() { local what=$1; shift; if "$@"; then echo "ok   $what"; else echo "FAIL $what"; fails=$((fails + 1)); fi; }
refused() { local why=$1; shift; ! "$@" > $T/refused.log 2>&1 && grep -q "$why" $T/refused.log && [ -z "$(ls $FAKE_ROOT | grep '^wt-')" ]; }
claude_untrusted() { PIPELINE_CLAUDE_CONFIG=$T/claude-untrusted.json pipeline "$@"; }
codex_untrusted() { PIPELINE_CODEX_CONFIG=$T/codex-untrusted.toml pipeline "$@"; }
codex_missing() { PIPELINE_CODEX_CONFIG=$T/no-codex.toml pipeline "$@"; }
expect 'a repo Claude Code has not trusted is refused before any workspace exists' refused "Claude Code hasn't trusted" claude_untrusted start --slug demo --brief $T/brief.md --repo $REPO
expect 'a repo only a parent of which Codex trusts is refused' refused "Codex hasn't trusted" codex_untrusted start --slug demo --brief $T/brief.md --repo $REPO
expect 'and so is a lineup using Codex where it has no config at all' refused 'has never trusted a repo on this machine' codex_missing start --slug demo --brief $T/brief.md --repo $REPO
# Team profiles alone, with no operator home, so the demo profile can't win in the default mode.
team_only() { PIPELINE_REPOS_DIR=$1 PIPELINE_HOME=$T/no-home pipeline "${@:2}"; }
mkdir -p $T/bad-gates $T/bad-project
jq '. + { "gates": { "approveAfter": [] } }' $PROFILES/demo.json > $T/bad-gates/demo.json
jq '. + { "paradev": { "projectId": "p" } }' $PROFILES/demo.json > $T/bad-project/demo.json
expect 'a profile that sets the gates is refused before any workspace exists' refused 'sets gates' team_only $T/bad-gates start --slug demo --brief $T/brief.md --repo $REPO
expect 'and so is a team profile that names a Paradev project' refused 'sets paradev.projectId' team_only $T/bad-project start --slug demo --brief $T/brief.md --repo $REPO
if [ -n "$OS" ]; then expect 'a slug naming a living spec is refused before any workspace exists' refused 'already has openspec/specs/x' pipeline start --slug x --brief $T/brief.md --repo $REPO; fi
if [ "${FAKE_MODE:-}" != ship ]; then # ship's origin doesn't exist yet, so its check is skipped
  git init -q --bare -b main $T/up.git && git push -q origin main
  git clone -q $T/up.git $T/elsewhere && git -C $T/elsewhere -c user.email=t@t -c user.name=t commit -q --allow-empty -m elsewhere && git -C $T/elsewhere push -q origin main
  expect 'a base branch behind origin is refused before any workspace exists' refused 'main is 1 commit(s) behind origin/main' pipeline start --slug demo --brief $T/brief.md --repo $REPO
  git merge -q --ff-only origin/main && git commit -q --allow-empty -m unpushed
  expect 'and so is one with unpushed commits' refused "main has 1 commit(s) that aren't on origin/main" pipeline start --slug demo --brief $T/brief.md --repo $REPO
  git -C $T/elsewhere -c user.email=t@t -c user.name=t commit -q --allow-empty -m elsewhere-again && git -C $T/elsewhere push -q origin main
  expect 'and so is one that has diverged' refused 'main has diverged from origin/main (1 ahead, 1 behind). .* Rebase it onto origin/main' pipeline start --slug demo --brief $T/brief.md --repo $REPO
  git reset -q --hard origin/main
fi
expect 'a malformed --branch is refused before any workspace exists' refused "isn't a valid git branch name" pipeline start --slug demo --brief $T/brief.md --repo $REPO --branch 'feat/..demo'
# Hooks that would fail every driver commit, as a repo's lefthook can. --no-verify alone still runs prepare-commit-msg.
for h in pre-commit prepare-commit-msg commit-msg post-commit; do printf '#!/bin/sh\necho %s >> %s/hooks-ran\nexit 1\n' $h "$T" > .git/hooks/$h && chmod +x .git/hooks/$h; done
pipeline start --slug demo --brief $T/brief.md --repo $REPO --branch feat/demo 2>&1 | tee $T/start.log
expect 'start warned that the spec reviewer runs its author model' grep -q "spec's reviewer claude runs the same model" $T/start.log
ID=$(ls $PIPELINE_HOME/runs)
WT=$FAKE_ROOT/wt-demo R=$PIPELINE_HOME/runs/$ID C=$FAKE_ROOT/contexts.log
# One stage's checkpoints, oldest first.
checkpoints() { git -C $WT for-each-ref --format='%(refname)' "refs/superpipe/$ID" | grep -- "-$1\$" | sort || true; }
# After start a worktree exists, so a refusal here is judged by its message and an unchanged state.
refused_now() { local why=$1; shift; ! "$@" > $T/refused.log 2>&1 && grep -q "$why" $T/refused.log; }
expect 'the paused driver removed its pid file' test ! -e $R/driver.pid
echo $$ > $R/driver.pid # this shell stands in for a live driver
expect 'resume refuses while another driver holds the run' refused_now "pid $$" pipeline resume $ID
expect "and leaves that driver's pid file alone" test "$(cat $R/driver.pid)" = $$
rm $R/driver.pid
if [ -n "${SMOKE_SETUP_FAIL:-}" ]; then pipeline resume $ID; fi
if [ "${FAKE_MODE:-}" != noignore ]; then
  expect "at the first pause the settings file holds only the repo's own rules" jq -e '.permissions.deny == ["WebFetch"] and .env.KEEP == "1"' $WT/.claude/settings.local.json
fi
# The run's prompts are frozen, so this marker must reach every later launch; a moved superpipe only warns.
echo '<!-- frozen after start -->' >> $R/prompts/_contract.md
jq '.superpipe = "0000000000000000000000000000000000000000"' $R/state.json > $T/state.json && mv $T/state.json $R/state.json
pipeline resume $ID --approve --note "keep it POSIX" 2>&1 | tee $T/resume.log
expect 'resume warned that superpipe has moved since the run started' grep -q 'superpipe has moved from 00000000' $T/resume.log
paused_at() { grep -q "\"current\": \"$1\"" "$R/state.json" && grep -q '"status": "paused"' "$R/state.json"; }
visit_has() { awk -v h="===== $1" '$0 == h { f = 1; next } /^===== / { f = 0 } f' "$C" | grep -qF -- "$2"; }
# Like visit_has, but only within one "## " section of that visit's context.
section_has() { awk -v h="===== $1" -v s="## $2" '$0 == h { f = 1; next } /^===== / { f = 0 } f && /^## / { in_s = ($0 == s); next } f && in_s' "$C" | grep -qF -- "$3"; }
lacks() { ! "$@"; }
DRAFT='echo $(($1 + $2))'
case "${FAKE_MODE:-}" in
  keepwork)
    expect 'the run waits at the ship gate' paused_at ship
    pipeline resume $ID --goto implement --keep-work --note "add a comment to add.sh"
    pipeline resume $ID --approve ;;
  keepwork-forward)
    expect 'tests escalated after the review revert' paused_at tests
    expect 'review has no author, so it has no draft to keep' refused_now 'review has no author' pipeline resume $ID --goto review --keep-work
    expect 'a jump two stages ahead is refused' refused_now 'more than one stage after tests' pipeline resume $ID --goto ship --keep-work
    touch $WT/stray.txt
    expect 'a reset over uncommitted changes is refused' refused_now 'uncommitted changes' pipeline resume $ID --goto implement --keep-work
    rm $WT/stray.txt
    expect 'the refusals left the run where it was' paused_at tests
    pipeline resume $ID --goto implement --keep-work --note "implement against the existing tests" ;;
  keepwork-current)
    expect 'tests escalated after the review revert' paused_at tests
    pipeline resume $ID --goto tests --keep-work --note "keep the cases you had" ;;
  restore)
    expect 'implement escalated on its restored draft' paused_at implement
    pipeline resume $ID --keep-work ;;
  ship)
    expect 'the failed push paused the run at ship' paused_at ship
    expect 'before ship was checkpointed' test -z "$(checkpoints ship)"
    expect 'saying why' grep -q 'Pushing failed' "$R/state.json"
    git init -q --bare $T/origin.git
    pipeline resume $ID --keep-work ;;
  cap)
    expect 'the cap paused the run at implement' paused_at implement
    pipeline resume $ID ;;
  reviewfail)
    expect "the tests reviewer's block paused the run at tests" paused_at tests
    expect "and the tests author's revisit survived it" grep -q 'add.sh 0 0' $WT/tests/add.test.sh
    expect 'with retryBase on that commit, not the restore commit' test "$(jq -r .retryBase "$R/state.json")" != "$(jq -r .restored.commit "$R/state.json")"
    pipeline resume $ID --keep-work ;;
  noverdict)
    expect "billing, 401 and rate-limit words on the idle author's screen were retried, not fatal" grep -q 'spec failed 3 attempts' "$R/state.json"
    expect 'so nothing was escalated as an account problem' lacks grep -q 'not retried' "$R/log.jsonl" ;;
  quota)
    expect "Z.ai's quota error escalated at once, as an account problem" grep -q 'not retried' "$R/state.json"
    expect 'without a retry' lacks grep -q '"stage":"implement","msg":"retry' "$R/log.jsonl" ;;
esac
pipeline status $ID | tee $T/status.log
echo "Worktree: $WT   Agent contexts: $C"

case "${FAKE_MODE:-}" in noverdict|quota|badrevert|greentests|specrevise-forever) exit $fails ;; esac
expect 'run reached DONE' grep -q '"status": "done"' "$R/state.json"
expect 'the run left no tags' test -z "$(git -C $WT tag -l)"
expect 'and checkpointed every stage under refs/superpipe' test "$(git -C $WT for-each-ref "refs/superpipe/$ID" | wc -l)" -ge 5
expect 'driver commits ran no git hooks' test ! -e $T/hooks-ran
if [ -z "${FAKE_MODE:-}" ]; then expect 'the personal profile beat the team decoy for the same remote' test "$(jq -r .profile "$R/config.json")" = "$PIPELINE_HOME/repos/demo.json"; fi
expect 'nothing under .pipeline is tracked' test -z "$(git -C "$WT" ls-files .pipeline)"
expect "the copied contract is the run's frozen one" cmp -s "$WT/.pipeline/run/prompts/_contract.md" "$R/prompts/_contract.md"
expect 'which kept the marker added after start' grep -q 'frozen after start' "$WT/.pipeline/run/prompts/_contract.md"
expect 'the launch prompt names CLAUDE.md' grep -q '^2\. CLAUDE\.md$' "$C"
expect 'context.md has a Spec format section' grep -q '^## Spec format$' "$C"
expect 'setup ran and logged' grep -q installing "$R/artifacts/setup.log"
if [ "${FAKE_MODE:-}" != noignore ]; then
  SPEC_LOCAL=$FAKE_ROOT/claude-local-spec-author-0-1.json
  expect "the spec author launched with the driver's five deny rules" jq -e '.permissions.deny as $d | ["Agent", "Monitor", "Workflow", "CronCreate", "Bash(run_in_background:true)"] | all(. as $x | $d | index($x))' $SPEC_LOCAL
  expect "merged into the repo's own settings" jq -e '(.permissions.deny | index("WebFetch")) and .env.KEEP == "1"' $SPEC_LOCAL
  expect 'and at DONE the repo is left with only its own' jq -e '.permissions.deny == ["WebFetch"] and .env.KEEP == "1"' $WT/.claude/settings.local.json
fi
expect 'a non-ASCII test file passed the write policy' git -C "$WT" cat-file -e "HEAD:tests/$(printf 'caf\303\251').test.sh"
SUBJECTS=$(git -C "$WT" log --format=%s main..HEAD)
expect 'every commit subject on the branch is conventional' test -z "$(echo "$SUBJECTS" | grep -vE '^(feat|fix|docs|test|refactor|perf|chore|build|ci|style|revert)(\([^()[:space:]]+\))?!?: [^A-Z[:space:]]')"
expect 'and none is a pipeline() subject' lacks grep -q '^pipeline(' <<< "$SUBJECTS"
expect 'no commit type appears twice, so each stage is one commit' test -z "$(sed -E 's/^([a-z]+).*/\1/' <<< "$SUBJECTS" | sort | uniq -d)"
if [ -n "${SMOKE_SETUP_FAIL:-}" ]; then expect 'the failed setup paused the run' grep -q 'PAUSED (escalation): Setup' "$R/log.jsonl"; fi
if [ -n "$OS" ]; then
  expect 'the spec author got spec.openspec.md' grep -q '^3\. \.pipeline/run/prompts/spec\.openspec\.md$' "$C"
  expect 'the Spec format names the change' grep -q 'openspec new change demo`' "$C"
  expect 'implement is told tasks.md is the exception' grep -q 'except `openspec/changes/demo/tasks.md`' "$C"
  expect 'tasks.md is on the branch' git -C "$WT" cat-file -e HEAD:openspec/changes/demo/tasks.md
  expect 'the living spec is untouched' git -C "$WT" diff --quiet main HEAD -- openspec/specs
fi
if [ "${FAKE_MODE:-}" = openspec-bad ]; then
  expect "validate's output became the retry reason" grep -q 'ran `openspec validate demo --type change --strict` and it failed.*must include at least one scenario' "$R/state.json"
  expect 'implement without tasks.md was retried' grep -q 'ran `test -s openspec/changes/demo/tasks.md` and it failed' "$R/state.json"
fi
if [ "${FAKE_MODE:-}" = openspec-livespec ]; then expect 'the living-spec edit discarded the attempt' grep -q 'outside this stage.s writable paths.*openspec/specs/x/spec.md' "$R/state.json"; fi
case "${FAKE_MODE:-}" in
  keepwork)
    expect 'implement found its draft after the goto' grep -qF -- "$DRAFT" $FAKE_ROOT/found-implement-author-0-4.add.sh
    expect 'and still found it after a discarded attempt' grep -qF -- "$DRAFT" $FAKE_ROOT/found-implement-author-0-5.add.sh
    expect 'its context says the draft is in place' visit_has 'implement-author-0 #5' 'previous draft is still in place'
    expect 'and carries the note' visit_has 'implement-author-0 #5' 'add a comment to add.sh'
    expect 'the revision shipped' grep -qF 'revised after the ship gate' $WT/src/add.sh
    expect 'history names the kept draft' grep -q 'keeping the draft at' "$R/state.json" ;;
  keepwork-forward)
    expect 'implement found its checkpointed draft' grep -qF -- "$DRAFT" $FAKE_ROOT/found-implement-author-0-3.add.sh
    expect 'its context says the draft is in place' visit_has 'implement-author-0 #3' 'previous draft is still in place'
    expect "implement's start is the last tests advance" test "$(node -p "require('$R/state.json').stageStart.implement")" = "$(git -C $WT rev-parse "refs/superpipe/$ID/02-tests^{commit}")" ;;
  keepwork-current)
    expect 'tests found its checkpointed draft' grep -qF -- 'src/add.sh -1 1' $FAKE_ROOT/found-tests-author-0-4.test.sh
    expect 'its context says the draft is in place' visit_has 'tests-author-0 #4' 'previous draft is still in place' ;;
  restore)
    expect 'tests, the revert target, found its last draft' grep -qF -- 'src/add.sh -1 1' $FAKE_ROOT/found-tests-author-0-3.test.sh
    expect 'implement found its last draft on re-entry' grep -qF -- "$DRAFT" $FAKE_ROOT/found-implement-author-0-3.add.sh
    expect "and the file that draft deleted stayed deleted" test ! -e $FAKE_ROOT/found-implement-author-0-3.old.sh
    expect 'its context says the draft is restored' visit_has 'implement-author-0 #3' '## Your last draft is restored'
    expect 'its revisit section carries the review reason' section_has 'implement-author-0 #3' 'Why the run came back through here' 'Zero case untested'
    expect 'resume --keep-work kept the restored draft' grep -qF -- "$DRAFT" $FAKE_ROOT/found-implement-author-0-4.add.sh
    expect 'review saw why the run came back' visit_has 'review-reviewer-1 #2' '## Why the run came back through here'
    expect 'ship, after review advanced, did not' lacks visit_has 'ship-author-0 #1' '## Why the run came back through here'
    expect 'no restore commit is left on the branch' lacks sh -c "git -C $WT log --format=%s main..HEAD | grep -q restore"
    expect 'the deletion shipped' test ! -e $WT/src/old.sh
    expect "the tests commit keeps the stage's first subject, from visit 1, though it last ran in visit 3" grep -q '^test: tests-author-0 visit 1$' <<< "$SUBJECTS"
    expect 'a single revert target adds no disagreement line' lacks visit_has 'tests-author-0 #3' 'named different stages' ;;
  route)
    expect 'tests were told the reviewers disagreed' section_has 'tests-author-0 #3' 'Why this stage is running again' 'These reviewers named different stages (tests, implement)'
    expect 'and advanced with their tests unchanged' git -C $WT diff --quiet "$(checkpoints tests | head -1)" "$(checkpoints tests | tail -1)" -- tests
    expect "their reviewer saw why, in the author's summary" visit_has 'tests-reviewer-1 #3' 'left the zero case to implement'
    expect 'implement got the reason aimed at it' section_has 'implement-author-0 #3' 'Why the run came back through here' 'fix add.sh directly'
    expect 'nothing escalated' lacks grep -q '"event": "escalate"' "$R/state.json"
    expect "status leads with the reviewers' words" grep -q 'from review: Reviewer claude (sends to tests)' $T/status.log
    expect 'an advance with no reason was accepted, and the fill logged' grep -q 'advance had no' "$R/log.jsonl" ;;
  reviewfail)
    expect 'the resumed tests author was told its draft is in place' visit_has 'tests-author-0 #4' 'previous draft is still in place'
    expect 'and why the stage stopped' section_has 'tests-author-0 #4' 'Why this stage is running again' 'Needs a human decision on the zero case'
    expect 'with no stale reason left over' lacks section_has 'tests-author-0 #4' 'Why this stage is running again' 'Zero case untested'
    expect "a reviewer's own commit was reset away" lacks git -C $WT cat-file -e HEAD:tests/reviewer-was-here.test.sh ;;
  noignore)
    expect "the driver said it left the un-ignored settings file alone" grep -q "settings.local.json isn't ignored here" "$R/log.jsonl"
    expect 'and wrote none' test ! -e $WT/.claude/settings.local.json ;;
  flaky)
    expect 'the flaky test run was absorbed by a re-run' grep -q '"msg":"flaky: ' "$R/log.jsonl"
    expect 'so implement retried only for its scripted cheat' test "$(grep -c '"stage":"implement","msg":"retry:' "$R/log.jsonl")" = 1
    expect 'and both runs kept their own logs' test "$(ls $R/artifacts | grep -c 'implement-a2-r[12]-sh_tests')" = 2 ;;
  ship)
    checkpoint_of() { git -C $WT rev-parse "$(checkpoints $1 | tail -1)^{commit}"; }
    expect 'the resumed push reached the remote' git -C $T/origin.git rev-parse -q --verify refs/heads/feat/demo
    expect "the spec author's subject was used as is" grep -qx 'docs: spec add.sh' <<< "$SUBJECTS"
    expect "the tests author's bad subject fell back" grep -q '^test: tests-author-0' <<< "$SUBJECTS"
    expect 'ship, which wrote only pr.md, made no commit' test "$(checkpoint_of ship)" = "$(checkpoint_of implement)"
    expect 'so it logged no subject for one' lacks grep -q '"stage":"ship","msg":"no usable commit subject' "$R/log.jsonl"
    expect "the ship author was told the PR is title-only" visit_has 'ship-author-0 #1' 'PR body: none'
    expect 'and, after the failed push, why it ran again' visit_has 'ship-author-0 #2' "couldn't push the branch"
    expect 'gh got an empty --body' grep -qx -- '--body' $T/gh-args
    expect 'right before an empty argument' test "$(awk 'p { print; exit } $0 == "--body" { p = 1 }' $T/gh-args)" = ''
    expect 'and no --body-file' lacks grep -qx -- '--body-file' $T/gh-args
    expect "and implement's commit subject as the title, not pr.md's" test "$(awk 'p { print; exit } $0 == "--title" { p = 1 }' $T/gh-args)" = "$(git -C $WT log -1 --format=%s "$(checkpoint_of implement)")" ;;
  cap)
    expect 'and after the resume it never hit the cap again' test "$(grep -c 'Hit the 6-transition cap' "$R/log.jsonl")" = 1 ;;
esac
[ $fails = 0 ]
