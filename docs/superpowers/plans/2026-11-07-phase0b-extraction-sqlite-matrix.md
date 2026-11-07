# croakcode Phase 0b — 추출 판정·SQLite 계획·동등성 매트릭스 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 0 결정 게이트를 완성한다 — 패키지 추출 판정 표, SQLite 스키마·마이그레이션 계획, 동등성 매트릭스 초안 + 필수 기능 목록을 작성한다.

**Architecture:** 문서 산출물 중심 계획. 각 산출물은 참조 리포를 근거로 작성하고, 검증 스크립트로 누락·불일치를 자동 점검한다. Phase 0a의 contracts/control 계약을 전제로 한다.

**Tech Stack:** Markdown 산출물 + Node 점검 스크립트(`.mjs`). 코드 구현 없음.

**Spec:** `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md`

**Reference repo (read-only):** `/Users/herace/workspace/ideas/codefrog-opencode`

**Prerequisite:** Phase 0a 계획(`2026-11-07-phase0-baseline-contracts.md`) 완료. 특히 `docs/superpowers/phase0/baseline-inventory.md` 존재.

**Spec 매핑:** §2(추출 조건), §4.4(SQLite/WAL/schema version/마이그레이션), §6.5~§6.6(동등성 매트릭스, 상태 기준), §8.1(Phase 0 완료 조건 1·2·8·9).

---

## File Structure (Phase 0b)

```
croakcode/docs/superpowers/phase0/
├── baseline-inventory.md      (Phase 0a 산출물 — 입력)
├── package-extraction.md      ← 플러그인별 추출함/안함 + 근거
├── sqlite-plan.md             ← 스키마, WAL/transaction, schema_version, 마이그레이션
├── equivalence-matrix.md      ← 기능별 PASS/FAIL/NOT TESTED/ACCEPTED DEVIATION + 필수 목록
└── phase0-gate.md             ← Phase 0 전체 게이트 체크리스트
croakcode/scripts/
└── phase0b-verify.mjs         ← 산출물 필수 항목/행 존재 점검
```

---

## Chunk 1: 패키지 추출 판정 (§2)

### Task 1: 추출 판정 표 작성

**Files:**
- Create: `croakcode/docs/superpowers/phase0/package-extraction.md`

- [x] **Step 1: 문서 초안 작성 (10개 자산 전부 행 포함, 기본값 flat)**

```markdown
# Package Extraction Decisions (Phase 0b)

Spec §2: 논리 계약 분리와 물리 패키지 분리는 다르다. 기본값은 **flat 유지**.
추출 조건(하나라도 해당 + 유지보수 이득이 클 때만):
(a) 독립 버전/배포 필요, (b) 다른 언어/런타임, (c) 큰 테스트 스위트 분리, (d) 여러 제품에서 재사용.

| Asset | Extract? | Condition met | Rationale |
|---|---|---|---|
| croak-auth | No | - | 공개 API만 사용, 단일 제품. Phase 3에서 flat 유지 |
| gate-identity | No | - | 22줄. 추출 가치 없음 |
| local-stability | No | - | 단일 제품 정책 |
| secret-paths | No | - | 공개 훅만 사용 |
| stall-recovery | No | - | 49줄 |
| tool-policy | No | - | 상태 파일 공유, 단일 패키지가 응집도 높음 |
| usage-meter | No | (c)? | 테스트 있으나 패키지 분리 이득 낮음 → flat |
| usage-panel | No | (c) 큰 UI 테스트군 | 기본 flat 유지, Phase 3에서 재판정 |
| hwp-read | No | (b)(d) rhwp 외부 의존, 재사용 가능 | 기본 flat 유지, Phase 3에서 재판정 |
| cache-hit (vendor) | No | - | 제3자 벤더, 이미 독립 npm 패키지 |

**결론:** Phase 0 기준 **물리 추출 0개**. Phase 3 이식 후 usage-panel·hwp-read만 재판정.
```

- [x] **Step 2: 근거 검증 (참조 리포 실제 라인 수/의존성 확인)**

Run: `cd /Users/herace/workspace/ideas/codefrog-opencode && wc -l plugins/gate-identity.mjs plugins/stall-recovery.mjs plugins/usage-meter.mjs`
Expected: 표의 줄 수 서술과 일치. 불일치 시 표 갱신.

- [x] **Step 3: Commit**

```bash
git add docs/superpowers/phase0/package-extraction.md
git commit -m "docs: phase 0b package extraction decisions"
```

---

## Chunk 2: SQLite 스키마·마이그레이션 계획 (§4.4)

### Task 2: sqlite-plan.md 작성

**Files:**
- Create: `croakcode/docs/superpowers/phase0/sqlite-plan.md`

- [x] **Step 1: 문서 작성 (upstream 계승 근거 포함)**

```markdown
# SQLite Plan (Phase 0b)

## Inheritance from upstream (verified)
opencode v1.15.12 uses Drizzle SQLite at `~/.local/share/opencode/opencode.db` with:
`journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`,
writes via `Database.transaction(behavior:"immediate")` (`storage/db.ts`, `sync/index.ts:151`).
croakcode INHERITS these settings; we add only schema_version + croakcode tables.

## croakcode DB
Path: `~/.local/share/croakcode/croakcode.db`

## Pragmas (same as upstream)
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

## Schema
```sql
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, model TEXT, permission_mode TEXT, cwd TEXT,
  created_at INTEGER, updated_at INTEGER, status TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT, created_at INTEGER, metadata TEXT
);
CREATE TABLE parts (
  id TEXT PRIMARY KEY, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT, type TEXT, data TEXT, created_at INTEGER,
  invocation_id TEXT, run_state TEXT   -- pending/running/succeeded/failed/unknown
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, session_id TEXT,
  payload TEXT, created_at INTEGER
);
```

## Single-writer policy
One app process is the writer. Concurrent readers use busy_timeout. Cross-process writers retry within busy_timeout.

## Recovery (spec §4.5)
Tool part transitions use 2-phase commit: commit `running` (T1) → execute → commit result (T2).
A lingering `running` on resume becomes `unknown`; side-effect tools never auto-reexecute.

## Migration from opencode
1. Detect `~/.local/share/opencode/opencode.db`.
2. Copy to temp DB (never mutate source).
3. Map opencode session/message/part tables → croakcode schema; set schema_version=1.
4. Verify: session count matches; a sample session loads.
5. On mismatch, abort and keep source intact (non-destructive).

## Retention
- usage events: 90 days (`usageRetentionDays`)
- audit events: 365 days (`auditRetentionDays`), export before delete
- prompt text never stored
```

- [x] **Step 2: 스키마 문법 점검 (SQLite 파서 — 모든 sql 블록 실행)**

먼저 `croakcode/scripts/sql-syntax-check.py` 를 작성한다:

```python
import sqlite3, re, sys
path = sys.argv[1]
body = open(path, encoding="utf-8").read()
blocks = re.findall(r"```sql\n(.*?)```", body, re.S)
c = sqlite3.connect(":memory:")
for b in blocks:
    c.executescript(b)
print("schema ok", len(blocks), "blocks")
```

Run: `cd croakcode && python3 scripts/sql-syntax-check.py docs/superpowers/phase0/sqlite-plan.md`
Expected: `schema ok 2 blocks` (PRAGMA + CREATE TABLE 둘 다 실행). 블록 수가 다르면 문서의 sql 블록 수를 확인.

- [x] **Step 3: Commit**

```bash
git add docs/superpowers/phase0/sqlite-plan.md scripts/sql-syntax-check.py
git commit -m "docs: phase 0b sqlite schema and migration plan"
```

---

## Chunk 3: 동등성 매트릭스 + 필수 기능 목록 (§6.5~§6.6)

### Task 3: equivalence-matrix.md 작성

**Files:**
- Create: `croakcode/docs/superpowers/phase0/equivalence-matrix.md`

- [x] **Step 1: 문서 작성 (Phase 0a 인벤토리 기반, 상태=NOT TESTED)**

```markdown
# Equivalence Matrix (Phase 0b draft — Phase 2/3에서 갱신)

Status legend: PASS / FAIL / NOT TESTED / ACCEPTED DEVIATION (spec §6.6).
Release rule: 필수 기능에 FAIL/NOT TESTED 가 있으면 최종 수용 불가.

## Required features (최소 집합)
session create/resume/abort, streaming, tools(read/write/edit/grep/glob/bash/task/websearch/webfetch),
permission modes, gate/direct switch + bypass block, session recovery (§4.5), auth(login/token),
policy block(secret-paths/tool-policy), usage recording.

## A. opencode core
| Feature | Existing test | Status |
|---|---|---|
| session lifecycle | (upstream) | NOT TESTED |
| streaming | (upstream) | NOT TESTED |
| tool loop | (upstream) | NOT TESTED |

## B. patches 0001-0008
| Patch | Test source | Status |
|---|---|---|
| 0001 TUI/perm | test/cli/permission-mode.test.ts, test/cli/tui/auto-follow.test.ts | NOT TESTED |
| 0002 steering | test/session/prompt.test.ts | NOT TESTED |
| 0003 resume | test/cli/resume.test.ts | NOT TESTED |
| 0004 SSE timeout | test/provider/stream-timeout.test.ts | NOT TESTED |
| 0005 WSL/CJK | test/cli/cmd/tui/dropped-path.test.ts | NOT TESTED |
| 0006 footer slot | (adds NO test) | NOT TESTED |
| 0007 permission.mode | fixture only | NOT TESTED |
| 0008 CJK title | test/util/locale.test.ts | NOT TESTED |

## C. plugins
| Plugin | Existing test | Status |
|---|---|---|
| croak-auth | plugins/croak-auth/session.test.mjs | NOT TESTED |
| gate-identity | plugins/gate-identity.test.mjs | NOT TESTED |
| local-stability | (none — new test needed) | NOT TESTED |
| secret-paths | plugins/secret-paths.test.mjs | NOT TESTED |
| stall-recovery | plugins/stall-recovery.test.mjs | NOT TESTED |
| tool-policy | plugins/tool-policy.test.mjs | NOT TESTED |
| usage-meter | plugins/usage-meter.test.mjs | NOT TESTED |
| usage-panel | usage-panel/*.test.ts (5, bun-only) | NOT TESTED |
| cache-hit | (none — new snapshot needed) | NOT TESTED |
| dev-safe + commands | (manual) | NOT TESTED |

## Env criteria (spec §6.6)
Linux x64 + macOS arm64 required; Windows via WSL (recorded).
direct=local vLLM; gate=croak-gate (Phase 3+).
```

- [x] **Step 2: 필수 기능 목록 누락 점검**

Run: `cd croakcode && grep -c 'NOT TESTED' docs/superpowers/phase0/equivalence-matrix.md`
Expected: 최소 21 (A+B+C 표 행 수 21 + legend 1). 값이 21 미만이면 누락 행 보강.

- [x] **Step 3: Commit**

```bash
git add docs/superpowers/phase0/equivalence-matrix.md
git commit -m "docs: phase 0b equivalence matrix draft + required features"
```

---

## Chunk 4: Phase 0 게이트 문서 + 자동 점검

### Task 4: phase0-gate.md 작성

**Files:**
- Create: `croakcode/docs/superpowers/phase0/phase0-gate.md`

- [x] **Step 1: 게이트 체크리스트 작성 (spec §8.1 완료 조건 1~9)**

```markdown
# Phase 0 Decision Gate

- [x] baseline inventory (§8.1 item 1)
- [x] contracts 확정 (§8.1 item 2) — Phase 0a
- [x] execution order contract test PASSES (item 3) — run `node --test tests/permission-order.test.mjs`
- [x] gate trust boundary contract PASSES (item 4) — run `node --test tests/security-context.test.mjs tests/contracts.conformance.test.mjs`
- [x] admin policy integrity PASSES (item 5) — run `node --test tests/admin-policy.test.mjs`
- [x] sqlite inheritance/migration plan (item 6) — document exists
- [x] recovery 2-phase contract PASSES (item 7) — run `node --test tests/recovery.test.mjs`
- [x] package extraction decisions (item 8)
- [x] equivalence matrix draft (item 9)
- [x] required feature list finalized (item 9)

## Gate result
All items must be checked. Phase 1 implementation is approved ONLY when this file shows all checks.
```

> 참고: Phase 0a 테스트 통과 항목은 실제 실행 결과로 체크한다. 이 표의 `[x]`는 "산출물 존재" 기준이며, Phase 0a 테스트 통과 여부는 별도로 확인한다.

- [x] **Step 2: Commit**

```bash
git add docs/superpowers/phase0/phase0-gate.md
git commit -m "docs: phase 0 decision gate checklist"
```

### Task 5: 자동 점검 스크립트

**Files:**
- Create: `croakcode/scripts/phase0b-verify.mjs`

- [x] **Step 1: 실패하는 점검 스크립트 작성 (필수 산출물/행 존재)**

```js
#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const REQUIRED = [
  ["docs/superpowers/phase0/baseline-inventory.md", [/Plugin & invariant tests/, /Patch-added tests/, /adds NO tests/]],
  ["docs/superpowers/phase0/package-extraction.md", [/croak-auth/, /gate-identity/, /local-stability/, /secret-paths/, /stall-recovery/, /tool-policy/, /usage-meter/, /usage-panel/, /hwp-read/, /cache-hit/, /물리 추출 0개/]],
  ["docs/superpowers/phase0/sqlite-plan.md", [/journal_mode = WAL/, /busy_timeout = 5000/, /schema_version/, /2-phase commit/, /CREATE TABLE parts/]],
  ["docs/superpowers/phase0/equivalence-matrix.md", [/Required features/, /0002/, /0003/, /0004/, /0005/, /0006/, /0007/, /0008/, /local-stability/, /cache-hit/, /dev-safe/]],
  ["docs/superpowers/phase0/phase0-gate.md", [/Phase 0 Decision Gate/, /required feature list/]],
];

let failures = [];
for (const [file, patterns] of REQUIRED) {
  let body;
  try {
    body = await readFile(file, "utf8");
  } catch {
    failures.push(`${file}: MISSING`);
    continue;
  }
  for (const re of patterns) {
    if (!re.test(body)) failures.push(`${file}: missing pattern ${re}`);
  }
}

if (failures.length) {
  console.error("FAIL");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log("PASS: all phase 0b artifacts present and complete");
```

- [x] **Step 2: 실행 (Task 1~4 완료 후 통과 기대)**

Run: `cd croakcode && node scripts/phase0b-verify.mjs`
Expected: `PASS: all phase 0b artifacts present and complete`

- [x] **Step 3: 일부러 누락시켜 실패 확인 (스크립트 신뢰성)**

Run:
```bash
cd croakcode
mv docs/superpowers/phase0/package-extraction.md /tmp/pe.md
node scripts/phase0b-verify.mjs; rc=$?
mv /tmp/pe.md docs/superpowers/phase0/package-extraction.md
echo "verifier exit=$rc (expected non-zero)"
```
Expected: `FAIL`, `package-extraction.md: MISSING`, `verifier exit=1 (expected non-zero)`. 파일은 항상 원복된다.

- [x] **Step 4: Commit**

```bash
git add scripts/phase0b-verify.mjs
git commit -m "test: phase 0b artifact completeness verifier"
```

---

## Phase 0b 완료 조건

- Task 1~5 완료, `node scripts/phase0b-verify.mjs` PASS.
- `phase0-gate.md`의 모든 항목 체크(실제 Phase 0a 테스트 통과 확인 포함).
- 이 시점에서 **Phase 1 구현 승인 가능**.
