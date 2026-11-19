#!/usr/bin/env bash
# test/cites.mjs against a throwaway repo: shifted cites, a cite into changed lines, and cites it must leave alone.
set -euo pipefail
CHECK=$(cd "$(dirname "$0")" && pwd)/cites.mjs
cd "$(mktemp -d)"
git init -q && git config user.email t@t && git config user.name t
mkdir src && for i in 1 2 3 4 5 6 7 8 9 10; do echo "line $i"; done > src/a.ts
cat > HANDOFF.md <<'EOF'
Shifts: `a.ts:8`.
Spans the insertion: `src/a.ts:3-8`.
Rewritten: `a.ts:6`.
Before the change: `a.ts:3`.
Someone else's: `lib/a.ts:8`, `card.ts:8`.
EOF
git add . && git commit -qm init
# Two lines after line 4, and line 6 rewritten.
{ head -4 src/a.ts; echo new; echo new; sed -n 5p src/a.ts; echo changed; tail -4 src/a.ts; } > src/b && mv src/b src/a.ts

fails=0
expect() { local what=$1; shift; if "$@"; then echo "ok   $what"; else echo "FAIL $what"; fails=$((fails + 1)); fi; }
out=$(node "$CHECK") && rc=0 || rc=$?
expect 'a moved cite fails the check' test $rc = 1
expect 'a cite after the insertion is re-pointed' grep -qF 'HANDOFF.md:1: a.ts:8 → a.ts:10' <<< "$out"
expect 'so is the end of a range, keeping its path' grep -qF 'HANDOFF.md:2: src/a.ts:3-8 → src/a.ts:3-10' <<< "$out"
expect 'a cite into rewritten lines is flagged for a hand check' grep -qF 'HANDOFF.md:3: a.ts:6 points into changed lines' <<< "$out"
expect 'and nothing else is listed' test "$(wc -l <<< "$out" | tr -d ' ')" = 4

git add src/a.ts
expect '--staged fails while HANDOFF.md is staged unchanged' bash -c "! node '$CHECK' --staged > /dev/null"
{ echo 'Shifts: `a.ts:10`.'; echo 'Spans the insertion: `src/a.ts:3-10`.'; tail -3 HANDOFF.md; } > h && mv h HANDOFF.md
git add HANDOFF.md
out=$(node "$CHECK" --staged) && rc=0 || rc=$?
expect 'once re-pointed and staged, it passes' test $rc = 0
expect 'still naming the cite to check by hand' grep -qF 'a.ts:6 points into changed lines' <<< "$out"
[ $fails = 0 ]
