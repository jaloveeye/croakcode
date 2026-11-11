#!/usr/bin/env bash
# Builds croakcode release binaries from this checkout (Phase 6 Task 1).
#
#   scripts/build-release.sh                      # all release targets
#   scripts/build-release.sh linux-x64 windows-x64  # only these
#
# Version:
#   - HEAD has a tag vX.Y.Z and the tree is clean: X.Y.Z (a release)
#   - otherwise: <latest vX.Y.Z tag, or 0.6.0>-dev.<short commit> (a test build)
# Output: upstream/packages/opencode/dist/croakcode-<os>-<arch>/bin/croakcode[.exe]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$REPO/upstream/packages/opencode"
DEFAULT_TARGETS="linux-x64,linux-arm64,darwin-x64,darwin-arm64,windows-x64"
FIRST_VERSION="0.6.0"

die() { echo "error: $*" >&2; exit 1; }

targets="$DEFAULT_TARGETS"
if [[ $# -gt 0 ]]; then targets="$(IFS=,; echo "$*")"; fi

cd "$REPO"
tag="$(git tag --points-at HEAD --list 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -1)"
if [[ -n "$tag" && -z "$(git status --porcelain)" ]]; then
  version="${tag#v}"
else
  base="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -1)"
  version="${base:+${base#v}}"
  version="${version:-$FIRST_VERSION}-dev.$(git rev-parse --short HEAD)"
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-dev\.[0-9a-f]+)?$ ]] || die "unexpected version: $version"

# The build installs every platform's native packages, which rewrites these
# two files; put them back afterwards. Refuse if they already have changes.
touched=(upstream/packages/opencode/package.json upstream/bun.lock)
[[ -z "$(git status --porcelain -- "${touched[@]}")" ]] || die "${touched[*]} have local changes; commit or stash them first"
trap 'git -C "$REPO" checkout -- "${touched[@]}"' EXIT

echo "building croakcode $version for $targets"
cd "$PKG"
# channel "latest": the binaries use croakcode.db, not a per-branch database.
CROAKCODE_VERSION="$version" CROAKCODE_CHANNEL=latest CROAKCODE_BUILD_TARGETS="$targets" \
  bun run script/build.ts --skip-embed-web-ui

echo
for dir in dist/croakcode-*/; do
  bin="$(ls "$dir"bin/croakcode* 2>/dev/null | head -1)"
  [[ -n "$bin" ]] || die "no binary in $dir"
  printf '%-28s %6s MB  %s\n' "$(basename "$dir")" "$(( $(stat -c %s "$bin") / 1024 / 1024 ))" "$(sha256sum "$bin" | cut -c1-16)"
done
echo "version $version"
