#!/usr/bin/env bash
# Phase 3 loader smoke: prove that the config-dir auto-scan actually loads the
# ported server plugins, and that none of them fails to load.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CROAKCODE_CONFIG_DIR="$ROOT/upstream/.croakcode"

OUT="$(mktemp /tmp/phase3-loader-smoke.XXXXXX.out)"
trap 'rm -f "$OUT"' EXIT

# `models` resolves config AND scans `.croakcode/plugins` (unlike --help, which
# only parses CLI flags). Capture stderr too: plugin load logs go there.
( cd "$ROOT/upstream" && LITELLM_BASE_URL="${LITELLM_BASE_URL:-http://127.0.0.1:4000}" \
    bun run --conditions=browser packages/opencode/src/index.ts --print-logs --log-level INFO models ) >"$OUT" 2>&1
RC=$?
[ "$RC" -eq 0 ] || { echo "FAIL: models command exited $RC"; sed -n '1,40p' "$OUT"; exit 1; }

if grep -qE "failed to load plugin|must export id|is not a function|neither server nor tool|does not expose a server entrypoint" "$OUT"; then
  echo "FAIL: plugin load error in this run"
  grep -E "failed to load plugin|must export id|is not a function|neither server nor tool|does not expose a server entrypoint" "$OUT"
  exit 1
fi

COUNT=$(grep -c "loading plugin" "$OUT" || true)
echo "loader smoke: $COUNT plugin load line(s)"
[ "$COUNT" -ge 7 ] || { echo "FAIL: expected >=7 auto-scanned plugins, got $COUNT"; sed -n '1,40p' "$OUT"; exit 1; }

# Every ported server plugin must be among the loaded paths.
for f in croak-auth-server tool-policy gate-identity secret-paths local-stability hwp-read usage-meter; do
  grep -q "\.croakcode/plugins/$f\.js" "$OUT" || { echo "FAIL: $f.js was not loaded"; exit 1; }
done

echo "PASS: loader smoke (7 server plugins auto-scanned and loaded)"
