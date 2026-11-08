#!/usr/bin/env bash
# Phase 3 final gate: replay every Phase 3 suite, preserving logs, and classify
# pre-existing failures instead of silently passing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${LOG_DIR:-$(mktemp -d /tmp/phase3-gate.XXXXXX)}"
mkdir -p "$LOG_DIR"
echo "== logs preserved in: $LOG_DIR =="

# tee hides the real exit code; check PIPESTATUS[0] instead.
run() {
  local name="$1"; shift
  echo "== $name =="
  set +e
  "$@" 2>&1 | tee "$LOG_DIR/$name.log"
  local rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: $name (rc=$rc) — see $LOG_DIR/$name.log"
    exit 1
  fi
}

echo "== rebrand =="
node scripts/rebrand-check.mjs upstream

echo "== zen removal =="
bash scripts/phase2-zen-check.sh

# Phase 2 core regressions (baseline/stale-rebrand failures are classified there;
# that script already treats the plugin.xai / parsePluginSpecifier tests as
# pre-existing).
run phase2-regression bash scripts/phase2-gate-replay.sh

# Phase 3 plugin unit tests. Run BOTH ways: node --test (plain ESM plugins) and
# bun test (also covers .ts fixtures and TS plugin imports).
run plugin-units-node node --test 'tests/*.test.mjs'
run plugin-units-bun bun test tests

run usage-panel bash -c '( cd upstream/packages/opencode && bun test test/usage-panel )'
run plugin-registration-tests bash -c '( cd upstream/packages/opencode && bun test test/plugins )'

# §5.4 five bypass scenarios: unit (1/2/3/4a) + real request path E2E (4/5).
run bypass-unit node --test tests/security-context.test.mjs tests/phase3-bypass.test.mjs
run bypass-e2e node --test tests/phase3-context-e2e.test.mjs

# Option A wiring regression.
run connection-mode node --test tests/connection-context.test.mjs

# §4.5 recovery.
run recovery node --test tests/recovery.test.mjs tests/phase1-recovery.e2e.test.mjs

# Phase 2 contract preservation (§3.4 order, §4.7 gate, §4.8 todo, §4.9 idle).
run contracts node --test tests/permission-order.test.mjs tests/phase2-todo-contract.test.mjs tests/phase2-stream-guard-contract.test.mjs tests/contracts.conformance.test.mjs tests/phase2-harness-contract.test.mjs tests/phase2-harness-runtime.test.mjs tests/phase2-todo-parity.test.mjs tests/phase2-zen-removal.test.mjs

# Core typecheck must stay clean after the Task 12a product-code change.
run typecheck bash -c '( cd upstream/packages/opencode && bun run typecheck )'

# Task 15 loader smoke: auto-scan must actually load plugins (0 = FAIL).
run loader-smoke bash scripts/phase3-loader-smoke.sh

echo "PASS: phase 3 gate replay — logs: $LOG_DIR"
