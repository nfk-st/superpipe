#!/usr/bin/env bash
# `superpipe profile` against a temporary home and team folder. No Paradev, no network.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); P=$(dirname "$HERE"); T=$(mktemp -d)
export PIPELINE_HOME=$T/home PIPELINE_REPOS_DIR=$T/team
REPO=$T/repo
# Mixed case, because profiles match on remoteKey, which lowercases.
mkdir -p $REPO $T/team && git -C $REPO init -q -b main && git -C $REPO remote add origin git@github.com:Acme/Widget.git
# Through a symlink, as `npm link` installs it.
mkdir -p $T/bin && ln -s $P/bin/superpipe $T/bin/superpipe
sp() { $T/bin/superpipe "$@"; }
fails=0
expect() { local what=$1; shift; if "$@"; then echo "ok   $what"; else echo "FAIL $what"; fails=$((fails + 1)); fi; }
json() { jq -e "$1" "$2" > /dev/null; }
refused() { local why=$1; shift; ! "$@" > $T/refused.log 2>&1 && grep -qF -- "$why" $T/refused.log; }

# ── export ──
echo '{ "remote": "https://github.com/acme/widget", "commands": { "test": "team" }, "paths": { "tests": ["**/*.test.ts"] } }' > $T/team/widget.json
sp profile export --repo $REPO > $T/out.json
expect 'a team-only profile exports' json '.commands.test == "team"' $T/out.json

mkdir -p $PIPELINE_HOME/repos
echo '{ "remote": "ssh://git@github.com/acme/widget", "commands": { "test": "personal" }, "paths": { "tests": ["**/*.test.ts"] }, "paradev": { "projectId": "p-1" } }' > $PIPELINE_HOME/repos/mine.json
sp profile export --repo $REPO > $T/out.json
expect 'export takes the personal profile over the team one' json '.commands.test == "personal" and .remote == "ssh://git@github.com/acme/widget"' $T/out.json
expect 'and drops paradev.projectId, with paradev itself once empty' json 'has("paradev") | not' $T/out.json

# ── import, into a second home that starts empty ──
H2=$T/home2
imp() { PIPELINE_HOME=$H2 sp profile import "$@"; }
jq '.commands.test = "v1"' $T/out.json > $T/v1.json
imp $T/v1.json > $T/imp.log
expect 'import into an empty home writes a file named for the whole remote' json '.commands.test == "v1"' $H2/repos/github-com-acme-widget.json
expect 'and says it saved it' grep -qxF "Saved $H2/repos/github-com-acme-widget.json" $T/imp.log

mv $H2/repos/github-com-acme-widget.json $H2/repos/older.json
jq '.commands.test = "v2"' $T/v1.json > $T/v2.json
imp $T/v2.json > $T/imp.log
expect 're-import replaces the differently named file that matches' json '.commands.test == "v2"' $H2/repos/older.json
expect 'leaving one profile for the remote' test "$(ls $H2/repos | wc -l | tr -d ' ')" = 1
expect 'and says it replaced it' grep -qxF "Replaced $H2/repos/older.json" $T/imp.log

jq '. + { "paradev": { "projectId": "p-2" } } | .commands.test = "v3"' $T/v2.json > $T/pid.json
imp $T/pid.json > $T/imp.log 2>&1
expect 'import drops paradev.projectId' json '(has("paradev") | not) and .commands.test == "v3"' $H2/repos/older.json
expect 'and says so' grep -qF 'Dropped paradev.projectId' $T/imp.log

jq '. + { "gates": { "approveAfter": [] } }' $T/v2.json > $T/gates.json
expect 'a profile that sets gates is refused' refused 'sets gates' imp $T/gates.json
expect 'and the saved one is left alone' json '.commands.test == "v3"' $H2/repos/older.json
echo '{ "commands": {} }' > $T/noremote.json
expect 'a file with no remote is refused' refused 'needs a "remote" string' imp $T/noremote.json
echo '{ nope' > $T/bad.json
expect 'bad JSON is refused, naming the file' refused "$T/bad.json isn't valid JSON" imp $T/bad.json

# ── check ──
gitc() { git -C $REPO -c user.email=t@t -c user.name=t "$@"; }
echo 'node_modules/' > $REPO/.gitignore
mkdir -p $REPO/tests && echo 'exit 0' > $REPO/tests/a.test.sh
gitc add -A && gitc commit -qm init
WT=$PIPELINE_HOME/checks/github-com-acme-widget
prof() { # setup, test, checks (JSON), and optionally paths.tests (JSON)
  local tests='["tests/**"]'; [ -z "${4:-}" ] || tests=$4
  cat > $PIPELINE_HOME/repos/mine.json <<JSON
{ "remote": "git@github.com:acme/widget.git", "setup": "$1", "commands": { "test": "$2", "checks": $3 },
  "paths": { "spec": ["docs/specs/{slug}.md"], "specDoc": "docs/specs/{slug}.md", "tests": $tests } }
JSON
}
passes() { sp profile check --repo $REPO > $T/check.log 2>&1; }
only_main() { [ "$(git -C $REPO worktree list | wc -l | tr -d ' ')" = 1 ] && [ ! -e $WT ]; }

prof 'true' 'echo boom-output; exit 3' '["true"]'
expect 'a failing test command fails the check, naming the exit' refused 'failed (exit 3)' sp profile check --repo $REPO
expect 'and keeps its output in the log' grep -qF boom-output $WT.log
expect 'and removes its worktree' only_main

prof 'touch stray.txt' 'true' '[]'
expect 'setup that leaves an unignored file fails the check, naming the file' refused 'stray.txt' sp profile check --repo $REPO
expect 'and removes its worktree' only_main

# What a check killed mid-run leaves: a registered worktree, and a log from an earlier failure.
gitc worktree add -q --detach $WT main && echo stale > $WT.log
prof 'mkdir -p node_modules && touch node_modules/x' 'sh tests/a.test.sh' '["true"]'
expect 'a profile whose commands pass passes, clearing a leftover worktree first' passes
expect 'and counts the tracked test files' grep -qF 'paths.tests matches 1 tracked file(s)' $T/check.log
expect 'and removes its worktree, ignored setup output and all' only_main
expect 'and deletes the stale log' test ! -e $WT.log
mkdir -p $WT/junk
expect "a leftover folder git doesn't know is cleared too" passes
gitc worktree add -q --detach $WT main && rm -rf $WT
expect 'and so is a registration whose folder is gone' passes
expect 'leaving only the main checkout' only_main

OLD=$(git -C $REPO rev-parse HEAD)
echo 'exit 0' > $REPO/tests/b.test.sh && gitc add -A && gitc commit -qm second
gitc update-ref refs/remotes/origin/main $OLD
prof 'true' 'test ! -e tests/b.test.sh' '[]'
expect "the check runs origin's base branch when there is one" passes
gitc update-ref -d refs/remotes/origin/main
expect 'and the local one when there is not' refused 'failed (exit 1)' sp profile check --repo $REPO

prof 'true' 'true' '[]' '["nothing/**"]'
expect 'a paths.tests matching no tracked file passes' passes
expect 'with a warning' grep -qF 'matches no tracked file' $T/check.log

# ── build, with a fake Claude that records how it was started and writes what FAKE_CLAUDE says ──
cat > $T/bin/fake-claude <<'SH'
#!/bin/sh
printf '%s' "$#" > "$OUT/argc"; printf '%s' "$1" > "$OUT/prompt"; pwd -P > "$OUT/cwd"
target=$(printf '%s\n' "$1" | sed -n '1s/^Write the profile to: //p')
case $FAKE_CLAUDE in
  write) cp "$FAKE_PROFILE" "$target" ;;
  wrongremote) jq '.remote = "git@github.com:acme/other.git"' "$FAKE_PROFILE" > "$target" ;;
  bad) echo '{ nope' > "$target" ;;
esac
SH
chmod +x $T/bin/fake-claude
cat > $T/good.json <<'JSON'
{ "remote": "git@github.com:Acme/Widget.git", "commands": { "test": "sh tests/a.test.sh", "checks": [] },
  "paths": { "spec": ["docs/specs/{slug}.md"], "specDoc": "docs/specs/{slug}.md", "tests": ["tests/**"] } }
JSON
H3=$T/home3 C=$T/claude; mkdir -p $C $T/noteam
build() { # mode, then the team folder (default: an empty one)
  FAKE_CLAUDE=$1 PIPELINE_HOME=$H3 PIPELINE_REPOS_DIR=${2:-$T/noteam} CLAUDE_BIN=$T/bin/fake-claude OUT=$C FAKE_PROFILE=$T/good.json \
    sp profile --repo $REPO > $T/build.log 2>&1
}
stops() { local why=$1; shift; ! "$@" && grep -qF -- "$why" $T/build.log; }
NEW=$H3/repos/github-com-acme-widget.json

expect 'build with no profile yet writes one and checks it' build write
expect 'which passes' grep -qF 'Profile check passed.' $T/build.log
expect 'into a file named for the whole remote' cmp -s $T/good.json $NEW
expect 'Claude gets the prompt as its only argument' test "$(cat $C/argc)" = 1
expect "and runs in the repo's main checkout" test "$(cat $C/cwd)" = "$(cd $REPO && pwd -P)"
expect 'and the prompt names the file to write and the README' test "$(sed -n 1,2p $C/prompt)" = "Write the profile to: $NEW
superpipe's README, whose \"Profiles\" section documents every field: $P/README.md"
expect 'and carries prompts/profile.md' grep -qF '# Write a superpipe profile' $C/prompt
expect 'with nothing to start from' bash -c "! grep -q '^Start from' $C/prompt"

mkdir -p $H3/checks && echo failed > $H3/checks/github-com-acme-widget.log
expect "a build where Claude writes nothing says so and stops" stops "Claude didn't write or change $NEW" build none
expect 'its prompt said to start from the current profile' grep -qxF "Start from the current profile: $NEW" $C/prompt
expect "and named the last check's log" grep -qxF "The last \`superpipe profile check\` failed. Its log: $H3/checks/github-com-acme-widget.log" $C/prompt
expect 'a profile with the wrong remote is refused' stops "but this repo's origin is git@github.com:Acme/Widget.git" build wrongremote
expect 'invalid JSON is refused, naming the file' stops "$NEW isn't valid JSON" build bad
rm $NEW
expect 'a build can start from a team profile' stops "Claude didn't write or change" build none $T/team
expect 'which its prompt names' grep -qxF "Start from the current profile: $T/team/widget.json" $C/prompt
expect 'a missing Claude Code is reported' refused 'Building a profile needs Claude Code on your PATH' env CLAUDE_BIN=$T/no-such-claude PIPELINE_HOME=$H3 $T/bin/superpipe profile --repo $REPO

echo "$fails failed"
[ "$fails" = 0 ]
