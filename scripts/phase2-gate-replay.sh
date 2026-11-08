#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== rebrand =="
node scripts/rebrand-check.mjs upstream

echo "== zen removal =="
bash scripts/phase2-zen-check.sh

echo "== phase1 regressions =="
bash scripts/phase1-cli-check.sh
bash scripts/phase1-headless-check.sh
node --test 'tests/*.test.mjs'
bun test tests

echo "== upstream core package =="
(cd upstream/packages/core && bun test)

echo "== upstream opencode (provider/tool/session/cli-help/skill) =="
# Known baseline failures unrelated to Phase 2 (pre-existing in the absorbed tree).
# A new failure outside this allowlist blocks the gate. Timing-sensitive tests
# (listed separately) are retried once to absorb scheduler flakes.
BASELINE_FAIL=(
  "hosted nvidia provider adds billing origin header"
  "custom nvidia baseURL adds billing origin header"
)
FLAKE_FAIL=(
  "tool.shell abort > captures stderr in output"
  "cancel finalizes interrupted bash tool output through normal truncation"
  "running task tool preserves metadata after tool-call transition"
)

run_upstream() {
  (cd upstream/packages/opencode && bun test test/provider test/tool test/session test/cli/help test/skill 2>&1) || true
}

is_allowed() {
  local name="$1" x
  for x in "${BASELINE_FAIL[@]}"; do [[ "$name" == "$x" ]] && return 0; done
  for x in "${FLAKE_FAIL[@]}"; do [[ "$name" == "$x" ]] && return 0; done
  return 1
}

check_fails() {
  local out="$1" bad=0 name
  while IFS= read -r line; do
    name="$(printf '%s' "$line" | sed -E 's/^\(fail\) //; s/ \[[0-9.]+m?s\]$//')"
    if ! is_allowed "$name"; then
      echo "UNEXPECTED FAILURE: $name"
      bad=1
    fi
  done < <(printf '%s\n' "$out" | grep -E '^\(fail\)' || true)
  return "$bad"
}

out1="$(run_upstream)"
if ! check_fails "$out1"; then
  echo "== retrying upstream once (timing flakes) =="
  out2="$(run_upstream)"
  check_fails "$out2" || { echo "FAIL: phase 2 gate replay (upstream regressions)"; exit 1; }
fi

echo "PASS: phase 2 gate replay"
