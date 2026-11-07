# croakcode Phase 0 — Baseline 동결 및 계약 확정 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 `codefrog-opencode` 동작을 기준선으로 고정하고, Phase 1 구현 전에 필요한 제어 경계 계약(실행 전 검사 순서, Gate 신뢰 경계, 도구 복구 2-phase commit)을 코드와 계약 테스트로 확정한다.

**Architecture:** Phase 0는 "구현 없는 계약 단계"다. opencode 코어를 흡수·수정하지 않는다. 새 리포 `codefrog/croakcode`에 (a) contracts 타입 모듈, (b) 제어 경계 순수 로직, (c) 계약 테스트, (d) 문서 산출물을 둔다. 계약 테스트는 **`node:test` + `node:assert`** 로 작성해 `bun test`와 `node --test` **둘 다** 통과해야 한다(참조 리포 플러그인 테스트와 동일 방식). 소스는 `.mjs`로 두어 두 러너에서 직접 로드한다.

**Tech Stack:** JavaScript ESM (`.mjs`), Node 22 / Bun. DB는 Phase 0에서 스키마 정의·마이그레이션 계획 문서만(구현은 Phase 1).

**Spec:** `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md`

**Reference repo (read-only):** `/Users/herace/workspace/ideas/codefrog-opencode`

**Worktree:** 이 계획은 `croakcode` 리포에서 실행한다. 현재 리포 루트는 `/Users/herace/workspace/ideas/codefrog/croakcode`다.

**Spec §8.1 계약 항목 매핑:** 항목 **3**=실행 전 검사 순서(Chunk 4), 항목 **4**=Gate 신뢰 경계(Chunk 5), 항목 **7**=복구 2-phase commit(Chunk 6). 이 계획의 각 Chunk 제목에 해당 항목 번호를 표기한다.

**Phase 0 범위 명시:** 이 계획은 **코드 계약 + 계약 테스트**를 다룬다. `package-extraction.md` / `sqlite-plan.md` / `equivalence-matrix.md`(필수 기능 목록 포함)는 **후속 계획 Phase 0b**에서 처리한다. **이 계획만으로 Phase 0 결정 게이트를 "완료"로 표시하지 않는다.**

---

## File Structure (Phase 0a)

```
croakcode/
├── .gitignore                   ← node_modules, bun.lock, dist, .DS_Store
├── package.json                 ← 워크스페이스/스크립트(test, test:node)
├── contracts/src/  (index, hooks, connection — JSDoc typedef)
├── control/src/    (index, permission-order, security-context, server-auth-stub, recovery, admin-policy)
├── tests/  (smoke, contracts.conformance, permission-order, security-context, recovery, admin-policy — 모두 *.test.mjs)
├── scripts/baseline-inventory.mjs
├── docs/superpowers/{specs,plans,phase0/baseline-inventory.md}
└── NOTICE
```

**책임 경계**: `contracts/`는 JSDoc typedef(타입 계약)만. `control/`는 순수 로직(입력→판정). `tests/`는 계약대로 검증. `scripts/`는 참조 리포 읽기 전용. **DB/네트워크/opencode import 없음.**

---

## Chunk 1: 리포 골격 + workspace + 테스트 실행 환경

### Task 1: `.gitignore` + 워크스페이스 초기화

**Files:**
- Create: `croakcode/.gitignore`
- Create: `croakcode/package.json`
- Create: `croakcode/contracts/package.json`
- Create: `croakcode/control/package.json`

- [ ] **Step 1: `.gitignore` 작성 (커밋 전 필수)**

```gitignore
node_modules/
bun.lock
dist/
.DS_Store
```

- [ ] **Step 2: 세 개의 `package.json` 작성**

루트:
```json
{ "name": "croakcode", "private": true, "type": "module",
  "workspaces": ["contracts", "control"],
  "scripts": { "test": "node --test tests", "test:bun": "bun test tests" } }
```
`contracts/package.json`:
```json
{ "name": "@croakcode/contracts", "version": "0.0.0", "private": true,
  "type": "module", "exports": { ".": "./src/index.mjs" } }
```
`control/package.json`:
```json
{ "name": "@croakcode/control", "version": "0.0.0", "private": true,
  "type": "module", "exports": { ".": "./src/index.mjs" },
  "dependencies": { "@croakcode/contracts": "workspace:*" } }
```

- [ ] **Step 3: 설치 (workspace 링크)**

Run: `cd croakcode && bun install`
Expected: 성공, `node_modules/@croakcode/*` 심볼릭 링크 생성. `node_modules`/`bun.lock`은 `.gitignore`로 무시됨.

- [ ] **Step 4: 무시 확인**

Run: `cd croakcode && git status --short`
Expected: `node_modules`, `bun.lock`이 목록에 없음.

- [ ] **Step 5: Commit**

```bash
git add .gitignore package.json contracts/package.json control/package.json
git commit -m "chore: scaffold croakcode workspace for phase 0a"
```

### Task 2: 테스트 스모크 (node:test + bun 둘 다)

**Files:**
- Create: `croakcode/tests/smoke.test.mjs`

- [ ] **Step 1: 스모크 테스트 작성 (`node:test` 기준 — 참조 리포와 동일 스타일)**

```js
import test from "node:test";
import assert from "node:assert/strict";

test("workspace is wired", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 2: node 러너 실행**

Run: `cd croakcode && node --test tests/smoke.test.mjs`
Expected: PASS (1 test). `node:test` API라 `.mjs`에서 정상 동작.

- [ ] **Step 3: bun 러너 실행 (동일 파일)**

Run: `cd croakcode && bun test tests/smoke.test.mjs`
Expected: PASS. Bun은 `node:test`를 지원하므로 통과해야 한다.

- [ ] **Step 4: Commit**

```bash
git add tests/smoke.test.mjs
git commit -m "test: add workspace smoke test (node:test compatible)"
```

> **Runner policy:** 모든 테스트는 `node:test`/`node:assert`만 사용한다(`bun:test` 금지). 이유: portability 보장 + 참조 리포 테스트와 동일 스타일.

---

## Chunk 2: Baseline 테스트 인벤토리 (§8.1 항목 1)

### Task 3: 인벤토리 생성 스크립트

**Files:**
- Create: `croakcode/scripts/baseline-inventory.mjs`
- Create: `croakcode/docs/superpowers/phase0/baseline-inventory.md` (출력)

- [ ] **Step 1: 인벤토리 스크립트 작성 (플러그인 테스트 + 패치-added 테스트 분리 집계)**

```js
#!/usr/bin/env node
// Read-only scan of the reference repo for test files and patch-added tests.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const REF = process.env.CROAKCODE_REF || "/Users/herace/workspace/ideas/codefrog-opencode";
const OUT = "docs/superpowers/phase0/baseline-inventory.md";

async function walk(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "work") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else if (/\.test\.(mjs|ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const pluginTests = (await walk(path.join(REF, "plugins"))).sort();
const patchDir = path.join(REF, "opencode", "patches");
const patchAdded = [];
for (const file of (await readdir(patchDir)).sort()) {
  if (!file.endsWith(".patch")) continue;
  const body = await readFile(path.join(patchDir, file), "utf8");
  const hits = [...body.matchAll(/^\+\+\+ b\/(.*\.test\.(?:ts|tsx|mjs))$/gm)].map((m) => m[1]);
  patchAdded.push({ file, tests: [...new Set(hits)] });
}

const lines = [
  "# Baseline Test Inventory (Phase 0a)",
  "",
  `Reference repo: \`${REF}\``,
  `Plugin/invariant test files: ${pluginTests.length}`,
  "",
  "## Plugin & invariant tests (run with node --test / bun test)",
  "",
  ...pluginTests.map((p) => `- \`${path.relative(REF, p)}\``),
  "",
  "## Patch-added tests (per patch file)",
  "",
  ...patchAdded.map((p) =>
    p.tests.length
      ? `- \`${p.file}\`: ${p.tests.map((t) => `\`${t}\``).join(", ")}`
      : `- \`${p.file}\`: (adds NO tests — must be covered by a new Phase 2/3 test)`,
  ),
  "",
];
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, lines.join("\n"), "utf8");
console.log(`wrote ${OUT}: ${pluginTests.length} plugin tests, ${patchAdded.length} patches scanned`);
```

- [ ] **Step 2: 실행**

Run: `cd croakcode && node scripts/baseline-inventory.mjs`
Expected: `wrote ...: 12 plugin test files, 8 patches scanned`. 12개 = node-호환 `.mjs` 7개(최상위 6 + croak-auth 1) + **bun 전용 `.ts` 5개**(usage-panel). 문서에서 이 두 그룹을 분리 표기한다(다르면 출력값 기준).

- [ ] **Step 3: 검증 (개수 + no-test 패치 명시)**

Run: `cd croakcode && grep -c '^\- `' docs/superpowers/phase0/baseline-inventory.md`
Expected: 12 + (테스트 있는 패치 수) 이상. 그리고 grep으로 `adds NO tests` 라인이 최소 2개(0006·0007) 존재 확인:

Run: `cd croakcode && grep -c 'adds NO tests' docs/superpowers/phase0/baseline-inventory.md`
Expected: `2` (0006, 0007). 값이 다르면 실제 패치 내용 기준으로 문서에 기록.

- [ ] **Step 4: Commit**

```bash
git add scripts/baseline-inventory.mjs docs/superpowers/phase0/baseline-inventory.md
git commit -m "docs: capture baseline test inventory with patch gap notes"
```

### Task 4: 기존 테스트 통과 상태 기록 (서브디렉토리 포함)

**Files:**
- Modify: `croakcode/docs/superpowers/phase0/baseline-inventory.md`

- [ ] **Step 1: 플러그인 최상위 테스트 실행 (읽기 전용)**

Run: `cd /Users/herace/workspace/ideas/codefrog-opencode/plugins && node --test *.test.mjs 2>&1 | tail -15`
Expected: 통과/실패 요약 캡처.

- [ ] **Step 2: croak-auth 서브디렉토리 테스트 실행 (누락 방지)**

Run: `cd /Users/herace/workspace/ideas/codefrog-opencode/plugins/croak-auth && node --test session.test.mjs 2>&1 | tail -15`
Expected: 통과/실패 요약 캡처.

- [ ] **Step 3: usage-panel 테스트 실행**

Run: `cd /Users/herace/workspace/ideas/codefrog-opencode/plugins/usage-panel && bun test 2>&1 | tail -15`
Expected: 통과/실패 요약 캡처. `node_modules` symlink 미설정이면 `NOT RUN: needs opencode symlink`로 기록.

- [ ] **Step 4: 결과를 문서에 추가**

문서 끝에 추가하고 실제 출력을 붙여넣는다:

```markdown
## Baseline run status (captured YYYY-MM-DD)

### plugins/*.test.mjs
<PASTE tail output>

### croak-auth/session.test.mjs
<PASTE tail output>

### usage-panel
<PASTE tail output>
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/phase0/baseline-inventory.md
git commit -m "docs: record baseline test run status (incl. croak-auth)"
```

---

## Chunk 3: contracts — JSDoc typedef (타입 계약)

### Task 5: 훅 typedef

**Files:**
- Create: `croakcode/contracts/src/hooks.mjs`
- Create: `croakcode/contracts/src/index.mjs`
- Create: `croakcode/tests/contracts.conformance.test.mjs`

- [ ] **Step 1: 실패하는 conformance 테스트 작성**

```js
import test from "node:test";
import assert from "node:assert/strict";
import * as contracts from "@croakcode/contracts";

test("contracts exports hooks descriptor", () => {
  assert.ok(contracts.HOOK_NAMES, "HOOK_NAMES export missing");
  assert.deepEqual(contracts.HOOK_NAMES, [
    "chat.headers", "chat.params",
    "tool.execute.before", "tool.execute.after",
    "command.execute.before", "event",
  ]);
});
```

- [ ] **Step 2: 실행 (실패)**

Run: `cd croakcode && node --test tests/contracts.conformance.test.mjs`
Expected: FAIL — `@croakcode/contracts` 해석 불가 또는 export 없음.

- [ ] **Step 3: `hooks.mjs` 작성 (타입은 JSDoc, 런타임 상수는 실제 값)**

```js
/**
 * @typedef {Object} PluginHooks
 * @property {(input: {headers: Record<string,string>}) => Promise<void>} [chat.headers]
 * @property {(input: {params: Record<string,unknown>}) => Promise<void>} [chat.params]
 * @property {(input: ToolBeforeInput) => Promise<"allow"|"deny"|"ask"|void>} [tool.execute.before]
 * @property {(input: ToolAfterInput) => Promise<void>} [tool.execute.after]
 * @property {(input: CommandInput) => Promise<void>} [command.execute.before]
 * @property {(input: {event: unknown}) => Promise<void>} [event]
 *
 * @typedef {{tool: string, args: unknown, sessionID: string}} ToolBeforeInput
 * @typedef {{tool: string, result: unknown, sessionID: string}} ToolAfterInput
 * @typedef {{command: string, sessionID: string, arguments: string[]}} CommandInput
 */

export const HOOK_NAMES = Object.freeze([
  "chat.headers",
  "chat.params",
  "tool.execute.before",
  "tool.execute.after",
  "command.execute.before",
  "event",
]);
```

- [ ] **Step 4: `index.mjs` 작성**

```js
export * from "./hooks.mjs";
```

- [ ] **Step 5: 실행 (통과)**

Run: `cd croakcode && node --test tests/contracts.conformance.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add contracts/src tests/contracts.conformance.test.mjs
git commit -m "feat(contracts): add hook typedefs and HOOK_NAMES"
```

### Task 6: Connection/Delta/ToolSpec typedef

**Files:**
- Create: `croakcode/contracts/src/connection.mjs`
- Modify: `croakcode/contracts/src/index.mjs`
- Modify: `croakcode/tests/contracts.conformance.test.mjs`

- [ ] **Step 1: 실패하는 테스트 추가**

```js
test("Delta kinds separate tool_call phases", () => {
  assert.deepEqual(contracts.DELTA_KINDS, ["text","tool_call.start","tool_call.delta","tool_call.completed","usage","reasoning","stop","error"]);
});
test("ToolSpec requires side-effect and reexecution flags", () => {
  assert.deepEqual(contracts.TOOL_SPEC_REQUIRED, ["name", "hasSideEffects", "reexecutionSafe"]);
});
```

- [ ] **Step 2: 실행 (실패)**

Run: `cd croakcode && node --test tests/contracts.conformance.test.mjs`
Expected: FAIL — `DELTA_KINDS`/`TOOL_SPEC_REQUIRED` 미정의.

- [ ] **Step 3: `connection.mjs` 작성**

```js
/**
 * @typedef {Object} ChatRequest
 * @property {string} model
 * @property {unknown[]} messages
 * @property {ToolSpec[]} [tools]
 * @property {Record<string, unknown>} params
 * @property {Record<string, string>} headers
 *
 * @typedef {Object} ToolSpec
 * @property {string} name
 * @property {string} [description]
 * @property {unknown} [schema]
 * @property {boolean} hasSideEffects       // external state change
 * @property {boolean} reexecutionSafe      // deterministic regardless of env
 * @property {boolean} [requiresAuth]
 *
 * @typedef {Object} Delta
 * Delta is one of: text | tool_call.start | tool_call.delta | tool_call.completed | usage | reasoning | stop | error
 *
 * @typedef {Object} ConnectionAdapter
 * @property {"gate"|"direct"} id
 * @property {(req: ChatRequest) => Promise<ChatRequest>} prepare
 * @property {(req: ChatRequest, signal: AbortSignal) => AsyncIterable<Delta>} stream
 * @property {() => boolean} requiresAuthorization
 * @property {() => (null | ((tool: string, sessionID: string) => Promise<"allow"|"deny">))} policyHook
 */

export const DELTA_KINDS = Object.freeze([
  "text",
  "tool_call.start",
  "tool_call.delta",
  "tool_call.completed",
  "usage",
  "reasoning",
  "stop",
  "error",
]);

export const TOOL_SPEC_REQUIRED = Object.freeze(["name", "hasSideEffects", "reexecutionSafe"]);
```

- [ ] **Step 4: `index.mjs` 갱신**

```js
export * from "./hooks.mjs";
export * from "./connection.mjs";
```

- [ ] **Step 5: 실행 (통과)**

Run: `cd croakcode && node --test tests/contracts.conformance.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add contracts/src tests/contracts.conformance.test.mjs
git commit -m "feat(contracts): add Connection/Delta/ToolSpec contract"
```

---

## Chunk 4: control — 실행 전 검사 순서 (§8.1 항목 3, deny-first)

### Task 7: resolveExecutionPlan (ask는 policy deny 통과 후에만 표면화)

**Spec:** §3.4 정본 — 호출 검증 → `tool.execute.before` → `policyHook` → Permission 승인 → 실행. **deny 최우선**. `ask`는 **모든 deny 판정이 통과한 뒤에만** 사용자에게 제시.

**Files:**
- Create: `croakcode/control/src/permission-order.mjs`
- Create: `croakcode/control/src/index.mjs`
- Create: `croakcode/tests/permission-order.test.mjs`

- [ ] **Step 1: 실패하는 테스트 작성**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveExecutionPlan } from "@croakcode/control";

const base = { tool: "bash", sessionID: "s1", args: {} };

test("plugin deny short-circuits before policy/permission", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "deny", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "plugin");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false);
});

test("policy deny beats permission allow", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "allow", policy: "deny", permission: "allow" });
  assert.equal(p.stage, "policy");
  assert.equal(p.execute, false);
});

test("plugin ask + policy deny => deny wins, never asks", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "ask", policy: "deny", permission: "allow" });
  assert.equal(p.stage, "policy");
  assert.equal(p.execute, false);
  assert.equal(p.askUser, false); // ask must NOT surface before policy deny cleared
});

test("policy checked before permission ask", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "allow", policy: "allow", permission: "ask" });
  assert.equal(p.stage, "permission");
  assert.equal(p.askUser, true);
  assert.equal(p.execute, false);
});

test("plugin ask with all denies cleared surfaces at permission stage for approval", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "ask", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "permission");
  assert.equal(p.askUser, true);
  assert.equal(p.execute, false);
});

test("all allow executes", () => {
  const p = resolveExecutionPlan({ ...base, plugin: "allow", policy: "allow", permission: "allow" });
  assert.equal(p.stage, "execute");
  assert.equal(p.execute, true);
});
```

- [ ] **Step 2: 실행 (실패)**

Run: `cd croakcode && node --test tests/permission-order.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: `permission-order.mjs` 작성**

```js
/**
 * @typedef {"allow"|"deny"|"ask"} Decision
 * @typedef {Object} ExecutionInput
 * @property {string} tool
 * @property {string} sessionID
 * @property {unknown} args
 * @property {Decision} plugin      // tool.execute.before
 * @property {Decision} policy      // policyHook (direct mode => allow)
 * @property {Decision} permission  // Permission Engine
 * @typedef {Object} ExecutionPlan
 * @property {"plugin"|"policy"|"permission"|"execute"} stage
 * @property {boolean} execute
 * @property {boolean} askUser
 * @property {string} [denyReason]
 */

export function resolveExecutionPlan(input) {
  // Order (spec §3.4): validate -> plugin -> policy -> permission -> execute.
  // deny-first: ANY deny stops immediately.
  if (input.plugin === "deny") {
    return { stage: "plugin", execute: false, askUser: false, denyReason: "plugin policy deny" };
  }
  if (input.policy === "deny") {
    return { stage: "policy", execute: false, askUser: false, denyReason: "gate policy deny" };
  }
  if (input.permission === "deny") {
    return { stage: "permission", execute: false, askUser: false, denyReason: "permission deny" };
  }
  // Only after ALL deny checks pass do we consider "ask".
  if (input.permission === "ask" || input.plugin === "ask") {
    return { stage: "permission", execute: false, askUser: true };
  }
  return { stage: "execute", execute: true, askUser: false };
}
```

- [ ] **Step 4: `control/src/index.mjs` 작성**

```js
export * from "./permission-order.mjs";
```

- [ ] **Step 5: 실행 (통과)**

Run: `cd croakcode && node --test tests/permission-order.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add control/src tests/permission-order.test.mjs
git commit -m "feat(control): deny-first execution order with ask-after-policy-deny"
```

---

## Chunk 5: control — 모드 우선순위 (§8.1 항목 4, Gate 신뢰 경계)

### Task 8: resolveEffectiveMode (전체 우선순위표 + bypass 행)

**Spec:** §5.3 모드 결정 표. 특히 `session=direct + global=gate + requiresAuth` 행과 `force:gate` 행.

**Files:**
- Create: `croakcode/control/src/security-context.mjs`
- Modify: `croakcode/control/src/index.mjs`
- Create: `croakcode/tests/security-context.test.mjs`

- [ ] **Step 1: 실패하는 테스트 작성 (spec §5.3 표의 핵심 행 포함)**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveMode } from "@croakcode/control";

test("agent.force gate beats session direct (with warning)", () => {
  const r = resolveEffectiveMode({ agentForce: "gate", sessionOverride: "direct", global: "direct", requiresAuth: false });
  assert.equal(r.mode, "gate");
  assert.equal(r.ok, true);
  assert.ok(r.warning);
});

test("session direct overrides global gate", () => {
  const r = resolveEffectiveMode({ agentForce: undefined, sessionOverride: "direct", global: "gate", requiresAuth: false });
  assert.equal(r.mode, "direct");
  assert.equal(r.ok, true);
});

test("requiresAuth + direct (global) => error", () => {
  const r = resolveEffectiveMode({ agentForce: undefined, sessionOverride: undefined, global: "direct", requiresAuth: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /gate/);
});

test("requiresAuth + session direct + global gate => error", () => {
  const r = resolveEffectiveMode({ agentForce: undefined, sessionOverride: "direct", global: "gate", requiresAuth: true });
  assert.equal(r.mode, "direct");
  assert.equal(r.ok, false);
  assert.match(r.error, /gate/);
});

test("requiresAuth + global gate => ok", () => {
  const r = resolveEffectiveMode({ agentForce: undefined, sessionOverride: undefined, global: "gate", requiresAuth: true });
  assert.equal(r.mode, "gate");
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: 실행 (실패)**

Run: `cd croakcode && node --test tests/security-context.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: `security-context.mjs` 작성**

```js
/**
 * @typedef {"gate"|"direct"} Mode
 * @typedef {Object} ModeInput
 * @property {Mode} [agentForce]      // admin signed policy; highest priority
 * @property {Mode} [sessionOverride] // user --mode
 * @property {Mode} global            // connection.mode
 * @property {boolean} requiresAuth   // task/tool requires gate
 * @typedef {Object} ModeResult
 * @property {Mode} mode
 * @property {boolean} ok
 * @property {string} [warning]
 * @property {string} [error]
 */

export function resolveEffectiveMode(i) {
  // Priority (spec §5.3): agent.force > session override > global.
  const mode = i.agentForce ?? i.sessionOverride ?? i.global;
  const warning =
    i.agentForce === "gate" && (i.sessionOverride === "direct" || i.global === "direct")
      ? "agent.force=gate ignored session/global direct"
      : undefined;

  if (i.requiresAuth && mode !== "gate") {
    return { mode, ok: false, error: "this action requires gate mode; no auto-upgrade" };
  }
  return { mode, ok: true, warning };
}
```

- [ ] **Step 4: `index.mjs` 갱신**

```js
export * from "./permission-order.mjs";
export * from "./security-context.mjs";
```

- [ ] **Step 5: 실행 (통과)**

Run: `cd croakcode && node --test tests/security-context.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add control/src tests/security-context.test.mjs
git commit -m "feat(control): mode precedence incl. session-direct requiresAuth bypass row"
```

### Task 9: 서버 실행 허가 — 인터페이스 typedef만 (Phase 4 구현 금지)

**Spec:** §5.4 — Phase 0은 **인터페이스 초안만**. 구현·강제 로직은 Phase 4.

**Files:**
- Create: `croakcode/control/src/server-auth-stub.mjs`
- Modify: `croakcode/control/src/index.mjs`
- Modify: `croakcode/tests/contracts.conformance.test.mjs`

- [ ] **Step 1: 실패하는 conformance 테스트 (타입 서술만 검증, 동작 금지)**

```js
test("server auth stub exposes interface descriptor but no enforcement", () => {
  assert.equal(typeof contracts.SERVER_AUTH_DESCRIPTOR, "object");
  assert.equal(contracts.SERVER_AUTH_DESCRIPTOR.phase, 4);
  assert.equal(contracts.SERVER_AUTH_DESCRIPTOR.implemented, false);
});
```

- [ ] **Step 2: 실행 (실패)**

Run: `cd croakcode && node --test tests/contracts.conformance.test.mjs`
Expected: FAIL — `SERVER_AUTH_DESCRIPTOR` 미정의.

- [ ] **Step 3: `server-auth-stub.mjs` 작성 (로직 없음, 문서화된 인터페이스만)**

```js
/**
 * Phase 4 server execution authorization — INTERFACE DRAFT ONLY.
 * Phase 1-3 rely on local policy enforcement (spec §5.4). Do not implement
 * enforcement here; this module exists so contracts/tests reference a stable
 * shape when Phase 4 lands.
 *
 * @typedef {Object} ServerVerdict
 * @property {boolean} allowed
 * @property {string} [reason]
 *
 * @typedef {(req: {tool: string, sessionID: string, mode: "gate"|"direct"}) => Promise<ServerVerdict>} ServerVerifier
 */
export const SERVER_AUTH_DESCRIPTOR = Object.freeze({
  phase: 4,
  implemented: false,
  enforcedBy: "local-in-phases-1-3",
});
```

- [ ] **Step 4: `index.mjs` 갱신**

```js
export * from "./permission-order.mjs";
export * from "./security-context.mjs";
export * from "./server-auth-stub.mjs";
```

- [ ] **Step 5: 실행 (통과)**

Run: `cd croakcode && node --test tests/contracts.conformance.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add control/src tests/contracts.conformance.test.mjs
git commit -m "feat(control): server authorization interface stub (phase 4, no logic)"
```

---

## Chunk 6: control — 복구 2-phase commit (§8.1 항목 7)

### Task 10: 상태머신 + T1/T2 커밋 포트 계약

**Spec:** §4.5 — (T1)`running` 커밋 → 실행(트랜잭션 밖) → (T2)결과 커밋. 중간 종료 시 `unknown`. `hasSideEffects`/`reexecutionSafe` 분리.

**Files:**
- Create: `croakcode/control/src/recovery.mjs`
- Modify: `croakcode/control/src/index.mjs`
- Create: `croakcode/tests/recovery.test.mjs`

- [ ] **Step 1: 실패하는 테스트 작성 (커밋 순서 포함)**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runWithRecovery, recoverOnResume, canAutoReexecute } from "@croakcode/control";

function makeStore() {
  const commits = [];
  return {
    commits,
    commitRunning: async (id) => { commits.push({ kind: "running", id }); },
    commitResult: async (id, state) => { commits.push({ kind: "result", id, state }); },
  };
}

test("T1 running is committed BEFORE execute, T2 result AFTER", async () => {
  const store = makeStore();
  const order = [];
  const out = await runWithRecovery(
    { id: "inv1", traits: { hasSideEffects: true, reexecutionSafe: false } },
    store,
    async () => { order.push("execute"); return { ok: true }; },
  );
  assert.deepEqual(order, ["execute"]);
  assert.equal(store.commits[0].kind, "running");
  assert.equal(store.commits[1].kind, "result");
  assert.equal(store.commits[1].state, "succeeded");
  assert.equal(out, "succeeded");
});

test("process dies between T1 and T2 => running survives => resume yields unknown", async () => {
  const store = makeStore();
  await runWithRecovery(
    { id: "inv2", traits: { hasSideEffects: true, reexecutionSafe: false } },
    store,
    async () => { throw new Error("simulated crash"); },
  ).catch(() => {});
  // T1 committed, T2 not attempted on crash path => DB has running only.
  assert.equal(store.commits.filter((c) => c.kind === "result").length, 0);
  assert.equal(recoverOnResume("running"), "unknown");
});

test("side-effect tool never auto-reexecutes, even if marked reexecutionSafe", () => {
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: true, reexecutionSafe: true }), false);
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: true, reexecutionSafe: false }), false);
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: false, reexecutionSafe: true }), true);
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: false, reexecutionSafe: false }), false);
});
```

- [ ] **Step 2: 실행 (실패)**

Run: `cd croakcode && node --test tests/recovery.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: `recovery.mjs` 작성**

```js
/**
 * @typedef {"pending"|"running"|"succeeded"|"failed"|"unknown"} RunState
 * @typedef {Object} ToolTraits
 * @property {boolean} hasSideEffects
 * @property {boolean} reexecutionSafe
 * @typedef {Object} RecoveryStore
 * @property {(id: string) => Promise<void>} commitRunning   // T1 (separate txn)
 * @property {(id: string, state: RunState) => Promise<void>} commitResult // T2 (separate txn)
 */

/**
 * Runs a tool with the 2-phase commit contract (spec §4.5):
 *  - commit "running" (T1)
 *  - execute OUTSIDE any transaction
 *  - commit result "succeeded"/"failed" (T2)
 * If execution throws/crashes, T2 is not written; the lingering "running" is
 * recovered as "unknown" on next resume.
 */
export async function runWithRecovery({ id, traits }, store, execute) {
  await store.commitRunning(id); // T1 — separate transaction
  let outcome;
  try {
    outcome = await execute(); // outside transaction
  } catch (err) {
    await store.commitResult(id, "failed").catch(() => {});
    throw err;
  }
  const state = outcome.ok ? "succeeded" : "failed";
  await store.commitResult(id, state); // T2 — separate transaction
  return state;
}

export function recoverOnResume(state) {
  return state === "running" ? "unknown" : state;
}

export function canAutoReexecute(state, traits) {
  // Side-effect tools NEVER auto-reexecute (spec §4.5), regardless of reexecutionSafe.
  return state === "unknown" && traits.hasSideEffects === false && traits.reexecutionSafe === true;
}
```

- [ ] **Step 4: `index.mjs` 갱신**

```js
export * from "./permission-order.mjs";
export * from "./security-context.mjs";
export * from "./server-auth-stub.mjs";
export * from "./recovery.mjs";
```

- [ ] **Step 5: 실행 (통과)**

Run: `cd croakcode && node --test tests/recovery.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add control/src tests/recovery.test.mjs
git commit -m "feat(control): recovery 2-phase commit contract (T1 before execute, T2 after)"
```

---

## Chunk 7: control — 관리자 정책 서명(HMAC, 변조 저항)

### Task 11: HMAC 기반 무결성 검증

**Spec:** §5.4 — 관리자 정책 `agent.force`/`requiresAuth`는 서명으로 변조 방지. **무키 해시는 불가**(재계산 가능). Phase 0은 HMAC(대칭키)으로 계약만 확정. 운영 시 ed25519로 교체 가능하도록 `publicKey`/`signature` 형태 확보.

**Files:**
- Create: `croakcode/control/src/admin-policy.mjs`
- Modify: `croakcode/control/src/index.mjs`
- Create: `croakcode/tests/admin-policy.test.mjs`

- [ ] **Step 1: 실패하는 테스트 작성 (변조+재계산 거부 포함)**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyAdminPolicy, signAdminPolicy } from "@croakcode/control";

const KEY = Buffer.from("test-hmac-key");
const body = JSON.stringify({ agents: { "dev-safe": { force: "gate", requiresAuth: true } } });

test("valid signature verifies", () => {
  const sig = signAdminPolicy(body, KEY);
  assert.equal(verifyAdminPolicy(body, sig, { key: KEY }), true);
});

test("tampered body with stale signature fails", () => {
  const sig = signAdminPolicy(body, KEY);
  assert.equal(verifyAdminPolicy(body + " ", sig, { key: KEY }), false);
});

test("tampered body WITH recomputed HMAC using wrong key fails", () => {
  const tampered = body.replace("gate", "direct");
  const forged = signAdminPolicy(tampered, Buffer.from("attacker-key")); // attacker has no real key
  assert.equal(verifyAdminPolicy(tampered, forged, { key: KEY }), false);
});

test("malformed policy fails even with valid signature", () => {
  const bad = "not json";
  const sig = signAdminPolicy(bad, KEY);
  assert.equal(verifyAdminPolicy(bad, sig, { key: KEY }), false);
});
```

- [ ] **Step 2: 실행 (실패)**

Run: `cd croakcode && node --test tests/admin-policy.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: `admin-policy.mjs` 작성**

```js
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Phase 0 admin policy integrity (spec §5.4). Uses HMAC (symmetric) so a
 * tampered body cannot be re-hashed without the key. Production may swap to
 * ed25519 while keeping {signature, key} shaped inputs (key => publicKey).
 *
 * @typedef {{ key: Buffer|string }} VerifyOptions
 */
export function signAdminPolicy(body, key) {
  return createHmac("sha256", key).update(body).digest("hex");
}

export function verifyAdminPolicy(body, signature, opts) {
  try {
    JSON.parse(body);
  } catch {
    return false;
  }
  const expected = createHmac("sha256", opts.key).update(body).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: `index.mjs` 갱신**

```js
export * from "./permission-order.mjs";
export * from "./security-context.mjs";
export * from "./server-auth-stub.mjs";
export * from "./recovery.mjs";
export * from "./admin-policy.mjs";
```

- [ ] **Step 5: 실행 (통과)**

Run: `cd croakcode && node --test tests/admin-policy.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add control/src tests/admin-policy.test.mjs
git commit -m "feat(control): HMAC admin policy integrity (tamper-resistant)"
```

---

## Chunk 8: 전체 회귀 + Phase 0a 게이트 표시

### Task 12: 전 계약 테스트 회귀 (node + bun)

**Files:** 없음 (실행만)

- [ ] **Step 1: node 러너 전체 실행**

Run: `cd croakcode && node --test tests`
Expected: PASS. 테스트 수: smoke 1 + contracts.conformance 4 + permission-order 6 + security-context 5 + recovery 3 + admin-policy 4 = **23**.

- [ ] **Step 2: bun 러너 전체 실행**

Run: `cd croakcode && bun test tests`
Expected: PASS. `node:test` 기반이라 Bun에서도 통과해야 한다.

- [ ] **Step 3: Commit (무시 파일 미포함 확인 후)**

Run: `cd croakcode && git status --short` → `node_modules`/`bun.lock` 미표시 확인.

```bash
git add tests control contracts docs
git commit -m "test: full phase 0a contract regression (node + bun)"
```

---

## Phase 0a 범위 명시

이 계획은 **코드 계약 + 계약 테스트 + baseline 인벤토리**만 다룬다. Phase 0 전체 완료(결정 게이트)는 후속 **Phase 0b 계획**의 산출물이 있어야 성립한다:
- `docs/superpowers/phase0/package-extraction.md`
- `docs/superpowers/phase0/sqlite-plan.md`
- `docs/superpowers/phase0/equivalence-matrix.md` (필수 기능 목록 포함) + `phase0a-status.md`

Phase 1 구현 승인 조건 = Phase 0a + Phase 0b 완료.
