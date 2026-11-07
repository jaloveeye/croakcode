# croakcode Phase 1 — Upstream 기반 Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** opencode v1.15.12 실행 경로를 **재사용**해 `cc` CLI/TUI와 헤드리스 코어를 구동한다(재구현 금지). 세션 생성→스트리밍→도구→권한→저장→재개 + §4.5 unknown 복구 테스트 + 헤드리스 구동 검증.

**Architecture:** upstream 소스를 `upstream/`에 **새 이력**으로 흡수하고 8개 패치를 코어 코드에 직접 반영한다. 리브랜딩은 설정 지점(global app 상수, package name/bin, CLI scriptName, env 접두어)에 한정한다. 실행 코어는 Bun/Effect/TS 그대로 유지하고, croakcode의 계약/제어 레이어(`contracts/`, `control/`, node:test)는 불변으로 둔다. Phase 1 훅은 스텁(인터페이스만, no-op)이며 권한(ask/deny/allow)은 실제 동작.

**Tech Stack:** Bun 1.3.14, TypeScript, Effect, Drizzle SQLite(upstream), `node:test`+`node:assert/strict`(croakcode 계약 테스트).

**Spec:** `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md` §8.2 (Phase 1 완료 조건), §2(리포 레이아웃), §7.2(마이그레이션), §4.5(복구), §3.4(실행 순서).

**Reference repo (read-only):** `/Users/herace/workspace/ideas/codefrog-opencode`
- upstream 소스: `opencode/work/` (tag `v1.15.12`, commit `58a27b95c155d3f7d9b9f25b30eb1233bfb0eae5`)
- fork 패치: `opencode/patches/0001..0008`

**Prerequisite:** Phase 0 완료(master에 머지됨). `docs/superpowers/phase0/phase0-gate.md` 모든 항목 체크됨.

**Worktree:** `.worktrees/phase1-upstream-skeleton` (branch `phase1-upstream-skeleton`).

**Scope note (검증된 사실 — 리뷰 후 정정):**
- **중요:** 참조 리포의 `opencode/work` **HEAD = v1.15.12 태그 + 8개 패치 적용본**이다. 따라서 HEAD에서 보이는 파일은 패치가 추가한 것이다.
- `v1.15.12` **태그 원본**에는 `src/cli/cmd/resume.ts`, `src/cli/permission-mode.ts`, `test/cli/permission-mode.test.ts`, `test/provider/stream-timeout.test.ts`, `test/cli/resume.test.ts`, `test/util/locale.test.ts` 등이 **없다**. 이 파일들은 **패치 0001~0008이 추가**한다(`git cat-file -e v1.15.12:<path>` → not in tag 확인됨).
- 흡수 스크립트는 반드시 **태그 트리**(`git archive v1.15.12`)에서 시작해야 하며, 패치가 이미 적용된 `work/` 작업트리를 복사하면 안 된다(이미 존재하는 파일과 충돌).
- 따라서 Phase 1 = 태그 흡수 + 패치 순차 반영 + 리브랜딩 + 구동 검증. 패치가 추가하는 기능(permission-mode TUI, stream-timeout 구분, resume 명령/테스트, WSL 경로, footer 슬롯, plugin permission.mode 노출, CJK 타이틀 절단)은 패치로 흡수된다.
- **DB 파일명:** upstream `storage/db.ts` `getChannelPath()`는 기본적으로 **채널 DB**(`opencode-${safe}.db`)를 쓰고, `disableChannelDb` 또는 채널이 latest/beta/prod일 때만 `opencode.db`를 쓴다. Phase 1은 **환경변수 `CROAKCODE_DB="croakcode.db"`** 를 명시해 경로를 고정한다(`getPath()`가 `Flag.OPENCODE_DB`→`CROAKCODE_DB`를 우선 사용). 그리고 채널 템플릿도 `croakcode-${safe}.db`로 리브랜딩한다.
- **PRAGMA 검증 한계:** `journal_mode`는 파일에 영속된다. 그러나 `busy_timeout`·`foreign_keys`는 **연결별(per-connection)** 설정이라 새 `sqlite3` 프로세스에서는 0으로 보인다. 따라서 파일 검사로는 `journal_mode`만 검증하고, `busy_timeout`/`foreign_keys`는 **소스(`db.ts:104-109`) 검사**로 확인한다.

---

## File Structure (Phase 1)

```
croakcode/
├── upstream/                      ← opencode v1.15.12 흡수(새 이력)
│   ├── packages/...               ← 기존 모노레포 구조 그대로 (patches 반영)
│   ├── NOTICE                     ← opencode MIT (필수)
│   └── ...                        ← 루트 파일들
├── contracts/                     ← Phase 0 불변
├── control/                       ← Phase 0 불변
├── plugins/                       ← Phase 3에서 이식; Phase 1엔 없음
├── cli/resources/                 ← dev-safe 에이전트 + commands 3종 (Phase 2/3 이식; Phase 1은 placeholder만)
├── docs/superpowers/...
├── NOTICE                         ← upstream + cache-hit 고지 통합
└── README.md
scripts/
├── absorb-upstream.sh             ← 태그 트리 흡수 + 패치 적용
└── rebrand-check.mjs              ← 리브랜딩 누락 검출(잔여 "opencode" 상표)
```

**의존 규칙:** `upstream`은 croakcode 루트의 `contracts`/`control`을 import하지 않는다(역방향 금지). Phase 1의 연결은 스텁 어댑터 파일로만.

---

## Chunk 1: upstream 흡수 + 패치 반영 (§2, §7.2)

### Task 1: 흡수 스크립트 작성 + 실행

**Files:**
- Create: `scripts/absorb-upstream.sh`
- Create: `upstream/` (스크립트로 생성)

- [x] **Step 1: 흡수 스크립트 작성**

`scripts/absorb-upstream.sh`:

```bash
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

echo "absorbed tag v1.15.12 tree + $APPLIED patches"
```

- [x] **Step 2: 실행**

Run: `cd croakcode/.worktrees/phase1-upstream-skeleton && bash scripts/absorb-upstream.sh`
Expected: `applying 0001..0008` 로그, `absorbed tag v1.15.12 tree + 8 patches`. 실패 시 어느 패치가 왜 실패했는지 명시하고 중단.

- [x] **Step 3: 패치 반영 검증 (패치가 추가한 파일 존재 확인)**

Run: `test -f upstream/packages/opencode/src/cli/permission-mode.ts && echo ok-permission-mode; test -f upstream/packages/opencode/test/provider/stream-timeout.test.ts && echo ok-stream-timeout; test -f upstream/packages/opencode/test/cli/resume.test.ts && echo ok-resume-test`
Expected: 세 줄 모두 `ok-...`.

- [x] **Step 4: 커밋 (흡수 자체를 새 이력으로)**

```bash
git add upstream scripts/absorb-upstream.sh
git commit -m "feat(upstream): absorb opencode v1.15.12 tree with 8 fork patches"
```

> 주의: `upstream/`에는 자체 `.git`이 없다(태그 트리만). 새 이력 = croakcode 리포 커밋.

### Task 2: 리브랜딩 지점 적용

**Files:**
- Modify: `upstream/packages/core/src/global.ts` (app 상수)
- Modify: `upstream/packages/opencode/package.json` (name, bin)
- Modify: `upstream/packages/opencode/bin/opencode` (바이너리명/env 접두어)
- Modify: `upstream/packages/opencode/src/index.ts` (scriptName, env 접두어)
- Modify: `upstream/packages/opencode/src/storage/db.ts` (DB 파일명/channel 템플릿)
- Modify: `upstream/package.json` (name)
- Create: `upstream/NOTICE`

- [x] **Step 1: global app 상수 변경**

`upstream/packages/core/src/global.ts`의 `const app = "opencode"` (라인 9):
```ts
const app = "croakcode"
```
(이 한 줄이 `~/.local/share/croakcode`, `~/.config/croakcode`, `~/.cache/croakcode`, `~/.local/state/croakcode` 경로를 만든다.)

- [x] **Step 2: package 메타데이터 변경**

`upstream/packages/opencode/package.json`:
```json
"name": "croakcode",
"bin": { "cc": "./bin/opencode" }
```
`upstream/package.json`: `"name": "croakcode"` (루트).

- [x] **Step 3: bin 스크립트 리브랜딩**

`upstream/packages/opencode/bin/opencode`에서:
- `process.env.OPENCODE_BIN_PATH` → `CROAKCODE_BIN_PATH` (env 접두어는 `CROAKCODE_*`로 통일)
- `let base = "opencode-" + platform + "-" + arch` → `const base = "croakcode-" + platform + "-" + arch` (실제 소스는 `const`; `-arch`는 유지)
- `const binary = platform === "windows" ? "opencode.exe" : "opencode"` → `"cc"`/`"cc.exe"`
- 에러 메시지의 `"the opencode CLI"` → `"the croakcode (cc) CLI"`

> Phase 1은 단일 바이너리 배포를 하지 않으므로 이 스크립트는 `bun run` 경로에서만 참조된다. 정확성은 `rebrand-check.mjs`로 검증한다.

- [x] **Step 4: CLI index 리브랜딩**

`upstream/packages/opencode/src/index.ts`:
- `.scriptName("opencode")` → `.scriptName("cc")`
- `show()`의 `text.startsWith("opencode ")` → `"cc "`
- env 설정: `process.env.OPENCODE = "1"` → `process.env.CROAKCODE = "1"`, `OPENCODE_PID` → `CROAKCODE_PID`
- 로그 `Log.Default.info("opencode", ...)` → `Log.Default.info("croakcode", ...)`
- DB 마커 `path.join(Global.Path.data, "opencode.db")` → `"croakcode.db"` (Task 3 SQLite 경로)

> 환경변수 접두어 일괄 치환은 `packages/core/src/flag/flag.ts` 등에도 적용한다 (Step 5).

- [x] **Step 5: 환경변수 접두어 일괄 치환 + DB 파일명 명시 리브랜딩**

Run: `cd upstream && grep -rl "OPENCODE_" packages --include='*.ts' | xargs perl -pi -e 's/OPENCODE_/CROAKCODE_/g'`

DB 경로는 **명시적으로** 편집한다(글로브로는 `opencode-${safe}.db` 템플릿을 놓친다):

`upstream/packages/opencode/src/storage/db.ts`:
- `path.join(Global.Path.data, "opencode.db")` (getChannelPath의 disable 분기) → `"croakcode.db"`
- `` `opencode-${safe}.db` `` (채널 DB 템플릿) → `` `croakcode-${safe}.db` ``
- `Flag.OPENCODE_DB`는 Step 5의 env 치환으로 `Flag.CROAKCODE_DB`가 된다.
- `upstream/packages/desktop/src/main/index.ts`의 `join(base, "opencode", "opencode.db")`(라인 ~283) → **디렉토리 세그먼트까지** `join(base, "croakcode", "croakcode.db")`로 바꾼다(세그먼트만 바꾸면 `~/.local/share/opencode/croakcode.db`라는 잘못된 경로가 된다).

Run: `cd upstream && grep -rn "opencode\.db\|opencode-\${safe}\|join(base, \"opencode\"" packages --include='*.ts'`
Expected: 매치 0건.

Run: `bash scripts/rebrand-check.mjs upstream` (Task 3에서 스크립트 작성)
Expected: `PASS` (허용 목록 외 잔여 0건).

- [x] **Step 6: NOTICE 작성**

`upstream/NOTICE`:
```
croakcode includes source code from opencode v1.15.12
(https://github.com/anomalyco/opencode, commit 58a27b95c155d3f7d9b9f25b30eb1233bfb0eae5),
licensed under the MIT License. See upstream/LICENSE for the full license text.
The "opencode" and "anomalyco" names/marks are used only in this attribution and
are not used as croakcode branding.
```

- [x] **Step 7: 리브랜딩 검증 + 커밋**

Run: `bash scripts/rebrand-check.mjs upstream`
Expected: `PASS: no disallowed upstream branding outside NOTICE/attribution`

```bash
git add upstream scripts/rebrand-check.mjs
git commit -m "feat(upstream): rebrand to croakcode/cc (paths, bin, CLI, env prefix, NOTICE)"
```

### Task 3: rebrand-check 스크립트

**Files:**
- Create: `scripts/rebrand-check.mjs`

> 설계 의도: upstream 코드에는 주석/문자열에 "opencode"가 다수 존재한다. **완전 제거는 목표가 아니다**(상표 미사용 = 제품명/명령/경로/배포물). 이 스크립트는 **식별자/경로/명령/package name**만 엄격 검사한다. 주석 잔여는 허용.

- [x] **Step 1: 스크립트 작성 (금지 패턴 기반)**

```js
#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2] ?? "upstream";
const ALLOW = new Set(["NOTICE", "LICENSE", "README.md", "UPSTREAM"]);

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(ts|tsx|js|mjs|json|jsonc|sh|toml)$/.test(p)) out.push(p);
  }
  return out;
}

const FORBIDDEN = [
  [/OPENCODE_/, "env prefix OPENCODE_"],
  [/~\/\.local\/share\/opencode|---local-share-opencode/, "opencode data path"],
  [/scriptName\("opencode"\)/, 'cli scriptName "opencode"'],
  [/"name":\s*"opencode"/, 'package name "opencode"'],
  [/opencode-\$\{safe\}/, "channel DB template opencode-${safe}.db"],
  [/[\\/"]opencode[\\/"]\s*,\s*["']opencode\.db/, "desktop path segment opencode/opencode.db"],
  [/const base\s*=\s*"opencode-/, "binary base name opencode-"],
];

const bad = [];
for (const file of await walk(root)) {
  if (ALLOW.has(path.basename(file))) continue;
  const body = await readFile(file, "utf8").catch(() => "");
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const [re, label] of FORBIDDEN) {
      if (re.test(lines[i])) bad.push(`${file}:${i + 1} [${label}]`);
    }
  }
}

if (bad.length) {
  console.error("FAIL: disallowed upstream branding");
  for (const b of bad.slice(0, 50)) console.error(" - " + b);
  process.exit(1);
}
console.log("PASS: no disallowed upstream branding outside NOTICE/attribution");
```

- [x] **Step 2: 실행**

Run: `bash scripts/rebrand-check.mjs upstream`
Expected: `PASS: no disallowed upstream branding outside NOTICE/attribution`. (FAIL이면 Task 2 Step 5로 돌아가 잔여 식별자를 수정한다.)

- [x] **Step 3: 커밋**

```bash
git add scripts/rebrand-check.mjs upstream
git commit -m "feat(upstream): rebrand-check script for identifier-level branding"
```

---

## Chunk 2: CLI/TUI 구동 확인 (기존 실행 경로 재사용)

### Task 4: 의존성 설치 + 타입체크

**Files:** 없음(설치/검증만)

- [ ] **Step 1: upstream 의존성 설치**

Run: `cd croakcode/.worktrees/phase1-upstream-skeleton/upstream && bun install`
Expected: 성공. `bunfig.toml`의 `minimumReleaseAge`(3일)에 걸리면 `bun install --ignore-scripts`로 재시도.

- [ ] **Step 2: node-pty 수정 + 타입체크**

Run: `cd upstream/packages/opencode && bun run fix-node-pty && bun run typecheck`
Expected: 타입 에러 0 (패치 반영 후).

### Task 5: CLI 도움말/버전/리브랜딩 구동

**Files:** 없음(실행 검증만)

- [ ] **Step 1: 버전/도움말**

Run: `cd upstream/packages/opencode && bun run --conditions=browser src/index.ts --version`
Expected: 버전 출력(예: `1.15.12`), 오류 없음.

Run: `cd upstream/packages/opencode && bun run --conditions=browser src/index.ts --help`
Expected: `cc` scriptName으로 도움말 출력, `resume` 명령 포함.

- [ ] **Step 2: 헤드리스 단일 프롬프트(모델 설정 없이 도움말 경로만 확인)**

Run: `cd upstream/packages/opencode && bun run --conditions=browser src/index.ts run --help`
Expected: `run` 옵션 출력(모델 호출 없음). 실제 LLM 호출은 Task 8(로컬 vLLM/모델 설정 필요)에서.

- [ ] **Step 3: 커밋 (검증 스크립트 추가)**

CLI 구동을 자동 검증하는 스크립트 `scripts/phase1-cli-check.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../upstream/packages/opencode"
out="$(bun run --conditions=browser src/index.ts --help 2>&1)"
echo "$out" | grep -q "resume" || { echo "FAIL: resume missing"; exit 1; }
bun run --conditions=browser src/index.ts --version >/dev/null 2>&1 || { echo "FAIL: version"; exit 1; }
echo "PASS: cli help+version ok"
```

Run: `bash scripts/phase1-cli-check.sh`
Expected: `PASS: cli help+version ok`

```bash
git add scripts/phase1-cli-check.sh
git commit -m "test(upstream): automated CLI help/version smoke check"
```

---

## Chunk 3: 헤드리스 코어 구동 + 세션 종단 간 (§3.1, §4.1)

### Task 6: 헤드리스 서버 구동 + 세션 생성

**Files:** 없음(실행/스크립트 검증)

- [ ] **Step 1: 서버 시작 스크립트**

`scripts/phase1-headless-check.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/upstream/packages/opencode"
export CROAKCODE_CONFIG_CONTENT='{"model":"stub"}'
# DB 파일명을 고정한다(getPath가 CROAKCODE_DB를 우선 사용) → 채널 DB 대신 croakcode.db
export CROAKCODE_DB="croakcode.db"
# 테스트 홈을 격리해 기존 DB와 섞이지 않게 한다
export HOME="${CROAKCODE_TEST_HOME:-$HOME}"
# 서버를 백그라운드로 띄운다
bun run --conditions=browser src/index.ts serve --port 4319 >/tmp/croakcode-serve.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT

READY=0
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:4319/global/health >/dev/null 2>&1; then READY=1; break; fi
  sleep 0.5
done
[[ "$READY" -eq 1 ]] || { echo "FAIL: server did not become healthy"; cat /tmp/croakcode-serve.log; exit 1; }

# 세션 생성 (HTTP API)
curl -sf http://127.0.0.1:4319/session -X POST -H 'content-type: application/json' \
  -d '{"title":"phase1-smoke"}' >/tmp/croakcode-session.json \
  || { echo "FAIL: session create"; cat /tmp/croakcode-serve.log; exit 1; }

# 반환된 세션 id를 파싱해 비어있지 않은지 확인
SID="$(node -e 'const j=require("/tmp/croakcode-session.json"); if(!j.id) process.exit(2); process.stdout.write(j.id)')" \
  || { echo "FAIL: no session id in response"; exit 1; }
echo "session id: $SID"
echo "PASS: headless server up + session created"
```

> 헬스 경로는 `/global/health`(검증됨). 서버가 뜨지 않으면 `/tmp/croakcode-serve.log`를 확인한다.

- [ ] **Step 2: 실행**

Run: `bash scripts/phase1-headless-check.sh`
Expected: `session id: <id>` + `PASS: headless server up + session created`.

- [ ] **Step 3: 커밋**

```bash
git add scripts/phase1-headless-check.sh
git commit -m "test(upstream): headless server + session creation smoke"
```

### Task 7: 세션 영속(생성→저장) 검증

**Files:**
- Create: `tests/phase1-session.e2e.test.mjs`

> 실제 **세션 행**이 DB에 저장됐는지 검증한다(단순 파일 존재가 아님). headless 스크립트가 만든 세션 id를 `/tmp/croakcode-session.json`에서 읽어 `session` 테이블에 존재하는지 확인한다.

- [ ] **Step 1: 테스트 작성**

`tests/phase1-session.e2e.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DB = path.join(process.env.HOME ?? "", ".local/share/croakcode/croakcode.db");
const SESSION_JSON = "/tmp/croakcode-session.json";

function sql(query) {
  return execFileSync("sqlite3", [DB, query], { encoding: "utf8" }).trim();
}

test("created session row is persisted in croakcode.db", () => {
  assert.ok(existsSync(DB), `db missing: ${DB} (run scripts/phase1-headless-check.sh first)`);
  assert.ok(existsSync(SESSION_JSON), "session json missing (run headless script first)");
  const { id } = JSON.parse(readFileSync(SESSION_JSON, "utf8"));
  assert.ok(id, "session id empty");
  const count = sql(`SELECT count(*) FROM session WHERE id = '${id}';`);
  assert.equal(count, "1", `session ${id} not persisted`);
});
```

- [ ] **Step 2: 실행 (headless 스크립트 선행)**

Run: `bash scripts/phase1-headless-check.sh && node --test tests/phase1-session.e2e.test.mjs`
Expected: 1 pass.

- [ ] **Step 3: 커밋**

```bash
git add tests/phase1-session.e2e.test.mjs
git commit -m "test(phase1): created session row persisted in croakcode.db"
```

---

## Chunk 4: SQLite 경로 + 복구(§4.5) unknown 경로

### Task 8: SQLite 경로/프라그마 검증

**Files:**
- Create: `tests/phase1-sqlite.e2e.test.mjs`

> **검증 한계(리뷰 반영):** `journal_mode`는 파일에 영속된다. `busy_timeout`/`foreign_keys`는 **연결별(per-connection)** 이라 새 `sqlite3` 프로세스에서는 기본값(0)으로 보인다 — 파일 검사로 검증할 수 없다. 따라서 이 테스트는 **파일 영속 pragma(`journal_mode`)만** 검증하고, `busy_timeout`/`foreign_keys`는 **소스 검사**로 확인한다(Step 2).

- [ ] **Step 1: 테스트 작성**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const DB = path.join(process.env.HOME ?? "", ".local/share/croakcode/croakcode.db");

function pragma(name) {
  return execFileSync("sqlite3", [DB, `PRAGMA ${name};`], { encoding: "utf8" }).trim();
}

test("croakcode DB is in WAL mode (file-persistent pragma)", () => {
  assert.ok(existsSync(DB), `db missing: ${DB} (run scripts/phase1-headless-check.sh first)`);
  assert.equal(pragma("journal_mode").toLowerCase(), "wal");
});
```

- [ ] **Step 2: 실행 + 소스 검사**

Run: `bash scripts/phase1-headless-check.sh && node --test tests/phase1-sqlite.e2e.test.mjs`
Expected: 1 pass.

Run: `grep -n "PRAGMA busy_timeout = 5000\|PRAGMA foreign_keys = ON\|PRAGMA synchronous = NORMAL\|PRAGMA journal_mode = WAL" upstream/packages/opencode/src/storage/db.ts`
Expected: 네 줄 모두 매치(소스에 계승된 연결별/파일별 pragma가 존재).

- [ ] **Step 3: 커밋**

```bash
git add tests/phase1-sqlite.e2e.test.mjs
git commit -m "test(phase1): sqlite path + file-persistent pragma on croakcode.db"
```

### Task 9: §4.5 unknown 복구 계약 테스트 (croakcode control 재사용)

**Files:**
- Create: `tests/phase1-recovery.e2e.test.mjs`

> `control/src/recovery.mjs`의 2-phase commit 계약은 이미 존재한다(Phase 0a). **검증된 사실:** upstream `part` 테이블은 `data` JSON에 `ToolState`(pending/running/completed/error)를 저장하며 `run_state` 물리 컬럼이 없다. 따라서 Phase 1에서는 **계약 재사용(unknown 해석 + 자동 재실행 금지)** 을 순수 함수 수준으로 검증하고, DB 레벨 상태 매핑(§4.5 unknown ↔ metadata.unknown)은 Phase 2로 미룬다. 이 테스트는 DB를 건드리지 않는다.

- [ ] **Step 1: 테스트 작성**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { recoverOnResume, canAutoReexecute } from "@croakcode/control";

test("lingering running resolves to unknown (spec §4.5)", () => {
  assert.equal(recoverOnResume("running"), "unknown");
  assert.equal(recoverOnResume("succeeded"), "succeeded");
  assert.equal(recoverOnResume("failed"), "failed");
});

test("unknown never auto-reexecutes side-effect tools", () => {
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: true, reexecutionSafe: true }), false);
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: true, reexecutionSafe: false }), false);
});

test("unknown auto-reexecutes only side-effect-free + reexecution-safe tools", () => {
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: false, reexecutionSafe: true }), true);
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: false, reexecutionSafe: false }), false);
});
```

- [ ] **Step 2: 실행**

Run: `node --test tests/phase1-recovery.e2e.test.mjs`
Expected: 3 pass. (upstream `part.data` JSON 상태 매핑은 Phase 2 범위.)

- [ ] **Step 3: 커밋**

```bash
git add tests/phase1-recovery.e2e.test.mjs
git commit -m "test(phase1): §4.5 unknown recovery contract (pure functions; DB mapping deferred to Phase 2)"
```

---

## Chunk 5: 훅 스텁 연결 + 회귀 게이트 (§8.2)

### Task 10: 훅 스텁 연결(인터페이스만, no-op)

**Files:**
- Create: `contracts/src/phase1-hooks.mjs` (Phase 1 스텁 descriptor)
- Modify: `contracts/src/index.mjs`
- Modify: `tests/contracts.conformance.test.mjs`

> §8.2: Phase 1 훅은 스텁(chat.headers/chat.params/tool.execute.before/command.execute.before/event = 인터페이스만, 기본 no-op). 실제 훅 연결은 upstream 플러그인 시스템이 이미 제공 → croakcode는 **descriptor**만 두고, Phase 2에서 실제 어댑터를 구현한다.

- [ ] **Step 1: 스텁 descriptor**

```js
// contracts/src/phase1-hooks.mjs
/**
 * Phase 1 hook stubs — interface only, no-op. Spec §8.2.
 * Upstream already provides the plugin hook machinery; croakcode wires real
 * adapters in Phase 2. This descriptor documents the no-op contract.
 */
export const PHASE1_HOOK_STUBS = Object.freeze({
  phase: 1,
  implemented: false,
  noop: true,
  hooks: Object.freeze([
    "chat.headers",
    "chat.params",
    "tool.execute.before",
    "command.execute.before",
    "event",
  ]),
});
```

- [ ] **Step 2: index + conformance 테스트**

`contracts/src/index.mjs`에 `export * from "./phase1-hooks.mjs";` 추가.
`tests/contracts.conformance.test.mjs`에 추가 (기존 파일은 이미 `import * as contracts from "@croakcode/contracts";` 형태이므로 그 바인딩을 그대로 사용):
```js
test("phase 1 hook stubs are declared no-op", () => {
  assert.equal(contracts.PHASE1_HOOK_STUBS.phase, 1);
  assert.equal(contracts.PHASE1_HOOK_STUBS.implemented, false);
  assert.equal(contracts.PHASE1_HOOK_STUBS.noop, true);
  assert.ok(contracts.PHASE1_HOOK_STUBS.hooks.includes("tool.execute.before"));
});
```

- [ ] **Step 3: 실행 + 커밋**

Run: `node --test tests/contracts.conformance.test.mjs`
Expected: 5 pass (기존 4 + 1).

```bash
git add contracts/src/phase1-hooks.mjs contracts/src/index.mjs tests/contracts.conformance.test.mjs
git commit -m "feat(contracts): phase 1 hook stubs (interface only, no-op)"
```

### Task 11: 전체 회귀 + Phase 1 게이트

**Files:**
- Create: `docs/superpowers/phase0/phase1-gate.md`

- [ ] **Step 1: upstream 구동 회귀 (DB 생성 선행 — session/sqlite 테스트가 의존)**

Run: `bash scripts/phase1-cli-check.sh && bash scripts/phase1-headless-check.sh`
Expected: 둘 다 PASS. 이 단계가 `croakcode.db`와 `/tmp/croakcode-session.json`을 만든다.

- [ ] **Step 2: croakcode 회귀 (headless 선행 후)**

Run: `cd croakcode/.worktrees/phase1-upstream-skeleton && node --test && bun test tests`
Expected: 기존 38 + 신규 session(1) + sqlite(1) + recovery(3) + hook(1) = 44 PASS (node 및 bun 동일).
> 주의: `tests/phase1-session.e2e.test.mjs`와 `tests/phase1-sqlite.e2e.test.mjs`는 headless 스크립트가 만든 DB에 의존한다. Step 1을 먼저 실행해야 한다. 반복 실행 시 headless 스크립트를 다시 돌려 DB를 재생성한다.

- [ ] **Step 3: 게이트 문서**

`docs/superpowers/phase0/phase1-gate.md`:
```md
# Phase 1 Decision Gate

- [x] upstream v1.15.12 absorbed (new history) + 8 patches
- [x] rebrand applied: paths (~/.config/croakcode, ~/.local/share/croakcode), bin `cc`, env `CROAKCODE_*`, NOTICE
- [x] CLI help/version ok (`scripts/phase1-cli-check.sh`)
- [x] headless server + session creation ok (`scripts/phase1-headless-check.sh`)
- [x] session row persisted in croakcode.db (node --test tests/phase1-session.e2e.test.mjs)
- [x] sqlite WAL (file-persistent; busy_timeout/foreign_keys verified by source inspection of db.ts)
- [x] §4.5 unknown recovery contract (pure functions; DB state mapping deferred to Phase 2)
- [x] phase 1 hook stubs declared no-op (contracts conformance)
- [x] full croakcode regression PASS (node + bun)

## Gate result
Phase 2 approved only when all checks are verified against real runs.
```

- [ ] **Step 4: 커밋**

```bash
git add docs/superpowers/phase0/phase1-gate.md
git commit -m "docs: phase 1 decision gate checklist"
```

---

## Phase 1 완료 조건 (§8.2)

- 기본 에이전트 종단 간 실행(세션 생성→스트리밍→도구→권한→저장→재개).
- 장애 복구 테스트(§4.5 unknown 경로) 통과.
- 헤드리스 구동 검증.
- Phase 0 계약 레이어 회귀 없음.

> **실제 LLM 호출**: Task 6~9는 stub/영속/DB 경로 검증이다. 실제 모델 호출(스트리밍→도구 루프)은 **로컬 vLLM 또는 croak-gate** 설정이 필요하므로, Phase 1 게이트는 다음 중 하나로 검증한다:
> - direct: 로컬 vLLM 엔드포인트 설정 후 `cc run "hi"` → 스트리밍 수신 확인
> - gate: croak-gate 미가동 시 Phase 1은 direct 경로만 요구(§8.2 훅 스텁 허용).
> 이 수동 항목은 `phase1-gate.md`에 "manual: direct-model streaming"으로 기록하고, 자동화는 Phase 2/3에서.

## Scope note

Phase 1은 **upstream 재사용 + 리브랜딩 + 구동 검증**이다. 플러그인 이식(plugins/), 슬롯 콘텐츠, gate/admin 어댑터 실구현은 Phase 2/3/4다. Phase 1의 gate/admin은 no-op(descriptor만).

**upstream 자체 테스트 스냅샷(주의, advisory):**
`upstream/packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap`에는 리터럴 `opencode ...` 도움말이 들어 있다. `.scriptName("cc")` 리브랜딩은 이 스냅샷을 무효화한다. Phase 1은 **upstream `bun test` 전체를 게이트로 돌리지 않는다**(패치·리브랜딩 후 스냅샷 갱신은 Phase 2 범위). 대신 `scripts/phase1-cli-check.sh`로 `--help`에 `resume`이 있는지만 확인한다. Phase 2 진입 시 스냅샷 재생성(`bun test ... -u`)을 첫 작업으로 둔다.
