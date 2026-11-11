#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../upstream/packages/opencode"
out="$(bun run --conditions=browser src/index.ts --help 2>&1)"
echo "$out" | grep -q "resume" || { echo "FAIL: resume missing"; exit 1; }
echo "$out" | grep -q "croakcode " || { echo "FAIL: croakcode command name missing"; exit 1; }
if echo "$out" | grep -qiE '(^|[^a-z])opencode([^a-z]|$)'; then
  echo "FAIL: leftover opencode branding in help output"
  echo "$out" | grep -iE '(^|[^a-z])opencode([^a-z]|$)' | head -5
  exit 1
fi
bun run --conditions=browser src/index.ts --version >/dev/null 2>&1 || { echo "FAIL: version"; exit 1; }
echo "PASS: cli help+version ok"
