#!/usr/bin/env bash
# opencode v1.15.12 태그 트리를 upstream/에 새 이력으로 흡수하고 8개 패치를 반영한다.
set -euo pipefail

REF="${CROAKCODE_REF:-/Users/herace/workspace/ideas/codefrog-opencode}"
SRC="$REF/opencode/work"
PATCHES="$REF/opencode/patches"
TAG="v1.15.12"
EXPECTED_COMMIT="58a27b95c155d3f7d9b9f25b30eb1233bfb0eae5"

die() { echo "error: $*" >&2; exit 1; }

[[ -d "$SRC/.git" ]] || die "참조 리포가 없다: $SRC"

# 태그 commit 검증
actual="$(git -C "$SRC" rev-parse "$TAG^{commit}")"
[[ "$actual" == "$EXPECTED_COMMIT" ]] || die "태그 $TAG 커밋이 $actual 이다. 기대값 $EXPECTED_COMMIT"

# 기존 upstream/ 제거 후 태그 트리만 추출(node_modules 제외)
rm -rf upstream
mkdir -p upstream
git -C "$SRC" archive --format=tar "$TAG" | tar -x -C upstream
[[ -f upstream/packages/opencode/src/index.ts ]] || die "추출 실패: src/index.ts 없음"

# upstream/은 git 리포가 아니므로, git apply의 엄격한 --check 의미론을 쓰기 위해
# 임시 리포를 초기화한다. (커밋 후 upstream/.git은 제거한다 — 중첩 리포 금지)
git -C upstream init -q
git -C upstream add -A >/dev/null
git -C upstream -c user.email=a@b -c user.name=c commit -qm "tag base" >/dev/null

# 8개 패치를 순서대로 적용(패치 파일 없이 코어에 직접 반영). 순서 의존(0001..0008) → 반드시 정렬된 순서.
shopt -s nullglob
APPLIED=0
for p in $(ls "$PATCHES"/*.patch | sort); do
  echo "applying $(basename "$p")"
  # 1) 먼저 --check로 적용 가능성 확인 (soft-skip 금지)
  git -C upstream apply --check --whitespace=nowarn "$p" >/dev/null 2>&1 \
    || die "패치 적용 불가(check 실패): $p"
  # 2) 실제 적용. 실패하면 즉시 중단(마스킹 금지)
  git -C upstream apply --whitespace=nowarn "$p" \
    || die "패치 실패: $p"
  APPLIED=$((APPLIED + 1))
done
[[ "$APPLIED" -eq 8 ]] || die "패치 개수 불일치: $APPLIED (기대 8)"

# 패치가 추가한 핵심 파일 존재 확인 (구조적 검증, 하드코딩 총계 대신)
for f in \
  packages/opencode/src/cli/permission-mode.ts \
  packages/opencode/test/provider/stream-timeout.test.ts \
  packages/opencode/test/cli/resume.test.ts ; do
  [[ -f "upstream/$f" ]] || die "패치 결과 누락: $f"
done

# 임시 리포 제거 — upstream/은 태그 트리만 남기고 중첩 .git이 없어야 한다.
rm -rf upstream/.git
[[ ! -e upstream/.git ]] || die "임시 리포 제거 실패: upstream/.git"

# 태그 트리에는 있으나 upstream 자체 .gitignore(script/build-*.ts, bun.lock 등)로
# croakcode 리포가 무시하는 파일이 있다. 이들을 강제로 무시 해제해 커밋되게 한다.
git add -f upstream 2>/dev/null || true

echo "absorbed tag v1.15.12 tree + $APPLIED patches"
