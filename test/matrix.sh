#!/usr/bin/env bash
# Every smoke configuration in turn, with a pass/fail table. Exits non-zero if any fails.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); LOGS=$(mktemp -d)
CONFIGS=(
  'default'
  'setup-fail SMOKE_SETUP_FAIL=1'
  'no-wait FAKE_NO_WAIT='
  'hookless FAKE_NO_WAIT= FAKE_HOOKLESS=1 PIPELINE_STATE_GRACE_MS=500'
)
for m in openspec openspec-bad openspec-livespec keepwork keepwork-forward keepwork-current restore ship cap route flaky \
  reviewfail noignore noverdict greentests badrevert quota specrevise specrevise-forever; do CONFIGS+=("$m FAKE_MODE=$m"); done

failed=0
for c in "${CONFIGS[@]}"; do
  read -r name vars <<< "$c"
  # shellcheck disable=SC2086 # vars is a list of NAME=value words
  if env $vars bash "$HERE/smoke.sh" > "$LOGS/$name.log" 2>&1; then result=pass; else result=FAIL; failed=$((failed + 1)); fi
  printf '%-18s %s  %3s ok\n' "$name" "$result" "$(grep -c '^ok' "$LOGS/$name.log")"
done
echo "${#CONFIGS[@]} configurations, $failed failed. Logs: $LOGS"
[ "$failed" = 0 ]
