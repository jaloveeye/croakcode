#!/usr/bin/env bash
# Link upstream/.croakcode/plugins/node_modules to the opencode package's
# node_modules so the TUI plugins resolve @opentui/solid and solid-js from
# Bun tests and tsgo. The link sits under plugins/, not .croakcode/, because
# the runtime installs @croakcode/plugin into .croakcode/node_modules and must
# not write through a link into the opencode package.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LINK="$ROOT/upstream/.croakcode/plugins/node_modules"
TARGET="../../packages/opencode/node_modules"

if [[ ! -d "$ROOT/upstream/packages/opencode/node_modules/@opentui/solid" ]]; then
  echo "FAIL: run bun install in upstream first (@opentui/solid missing)" >&2
  exit 1
fi
if [[ -L "$LINK" ]]; then
  [[ "$(readlink "$LINK")" == "$TARGET" ]] && { echo "plugin deps link ok"; exit 0; }
  rm "$LINK"
elif [[ -e "$LINK" ]]; then
  echo "FAIL: $LINK exists and is not a symlink; remove it first" >&2
  exit 1
fi
ln -s "$TARGET" "$LINK"
echo "plugin deps linked: $LINK -> $TARGET"
