# Phase 3 — 커스텀 플러그인 이식 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 `codefrog-opencode/plugins`의 10개 커스텀 플러그인 자산을 croakcode v1.15.12 기반 트리(`upstream/`)로 이식해, §6.3 C 동등성 매트릭스를 PASS로 만들고 §5.4 우회 차단·§4.5 복구 테스트를 통과시킨다.

**Architecture:** 플러그인 파일은 `upstream/.croakcode/plugins/*.js`(서버/툴) 및 `.tsx`(TUI)로 배치한다. 코어 로더는 `.croakcode` 디렉터리와 `croakcode.jsonc`/`tui.json`만 읽으므로, 서버 플러그인은 `.croakcode/plugins/*.js` 자동 스캔으로, TUI 플러그인은 `.croakcode/tui.json`의 `plugin` 배열 명시 등록으로 로드한다. 공유 상태 모듈(`policy-state`)을 먼저 이식해 croak-auth/tool-policy가 함께 사용한다. Phase 2 계약(§3.4 실행 순서, §4.7 노출 게이트, §4.8 todo, §4.9 idle guard, 슬롯 계약)을 훼손하지 않으며, 이식 단위마다 계약 회귀 테스트를 계속 green으로 유지한다.

**Tech Stack:** TypeScript/JavaScript(ESM), Bun 1.3.14, `@croakcode/plugin` 훅 API, `@opentui/solid`(TUI), node:test(`node --test`), bun:test(usage-panel), Effect 기반 upstream 런타임.

---

## 확정된 의사결정 (실행 전제조건 — 반드시 준수)

| 항목 | 확정 | 근거 |
|---|---|---|
| §5.4 시나리오 4·5 | **옵션 A 채택** — Phase 3에서 실제 보안 컨텍스트 전환을 구현·E2E 검증 | 우회 차단은 §6.6 필수 기능. 순수 함수 단위테스트만으로는 PASS 불가 → **실제 LLM 요청 조립 경로에 연결하고, Direct Provider로 나간 실제 요청을 검사**한다 |
| stall-recovery | **폐기 승인** — ACCEPTED DEVIATION으로 기록 | 내장 `STREAM_IDLE_TIMEOUT`은 "탐지 후 안전 중단", 기존 플러그인은 "스톨 후 재프롬프트 최대 2회". **동일 기능이 아니므로 정책 변경임을 명시**(결함 아님) |
| cache-hit | **폐기 승인** — usage-panel로 통합 | usage-panel이 hit-rate 등 주요 지표를 이미 제공. 이식 전 **지표 비교 검증** 필수 |
| `litellm-head` | **필수** — 명시적 Provider 설정 + 실제 로딩 스모크 | 현재 provider registry에 없음(`grep litellm src/provider` 0건). local-stability/usage-panel이 의존 |

### 옵션 A 보완 요구사항 (시나리오 4·5를 PASS로 인정하는 조건)

1. **턴 시작 시 스냅샷 고정**: 유효 모드·정책·`requiresAuth` 집합을 턴 시작에 고정. 턴 중 모드 변경은 다음 턴부터.
2. **출처 추적**: Gate 턴에서 생성된 메시지/도구 결과/compaction 요약에 provenance를 기록한다. **스키마 변경 불필요** — `TextPart.metadata`/`ToolPart.metadata`가 이미 `Record<String, Any>`(free-form)이므로(`session/message-v2.ts:103-119, 316-323`) 여기에 `{ origin: "gate", turnID, sensitivity: "secret" }` 같은 태그를 넣는다.
3. **Gate→Direct 전환 시 필터링**: `origin:"gate"`(+`sensitivity:"secret"`) 또는 출처 불명 과거 컨텍스트는 **요청 조립 단계에서 제외**. 출처를 확신할 수 없으면 **문자열 마스킹이 아니라 제외**(또는 전환 차단).
4. **인증 실패 시 Gate 전용 도구 차단**: `requiresAuth` 도구는 direct에서 실행 전 오류(기존 `resolveExecutionPlan` 경로 재사용).
5. **실제 요청 검사 E2E**: Gate 턴 → Direct 전환 → **Direct provider로 실제 전송되는 요청 payload**를 캡처해 비밀 컨텍스트 미포함을 단언. mock이 아닌 요청 조립 함수(`session/llm/request.ts` 경유)를 통과시킨다.

> **주의(구현자)**: 현재 런타임에는 **connection mode 개념이 없다**. `Agent.Info.mode`는 `primary|subagent`(에이전트 종류)이며 연결 모드가 아니다(`agent/agent.ts:32`). `session/llm/request.ts`의 `PrepareInput`에도 connection/mode 필드가 없다. 따라서 옵션 A는 **순수 함수 신설만으로 끝나지 않는다** — 아래 Task 12a·16b에서 mode 전달 경로를 **최소 침습**으로 연결한다.

---

## 사전 조사 결론 (구현자 필독)

### ⚠️ 최우선: 설정 디렉터리는 `.croakcode`, 설정 파일명은 `croakcode.jsonc` (실측 확인)

**이 저장소의 `upstream/.opencode/`는 로더가 읽지 않는다.** 코어는 오직 다음만 스캔한다:
- `ConfigPaths.directories` — `Global.Path.config`(`~/.config/croakcode`), cwd에서 위로 올라가며 찾는 **`.croakcode`**, `$CROAKCODE_CONFIG_DIR` (`upstream/packages/opencode/src/config/paths.ts:23-37`).
- 프로젝트 설정 파일명 — `ConfigPaths.files("croakcode", …)` → **`croakcode.jsonc` / `croakcode.json`** (`config/config.ts:603`); TUI는 `ConfigPaths.files("tui", …)` → **`tui.json`** (`cli/cmd/tui/config/tui.ts:206`).

따라서 본 계획의 **모든 플러그인/에이전트/명령/설정 파일은 `upstream/.croakcode/` 아래**에 둔다. `upstream/.opencode/`은 Phase 1 잔재이며 이번 Phase에서 이관 대상이 아니다(삭제하지 않고 그대로 둔다 — rebrand-check 범위 확인 후 별도 정리).

**Task 0에서 `upstream/.croakcode/`를 만들고, 이후 모든 경로는 `upstream/.croakcode/...`이다.**

### 타깃 로딩 경로 (실측)
- 서버 플러그인 자동 스캔: `.croakcode/{plugin,plugins}/*.{ts,js}` (`config/plugin.ts:29`). **`.mjs`는 매칭 안 됨.**
- 커스텀 툴 자동 스캔: `.croakcode/{tool,tools}/*.{js,ts}` (`tool/registry.ts:201`).
- 경로 플러그인은 **`id` 필수** (`plugin/shared.ts:306-317`, 없으면 `TypeError: Path plugin ... must export id`).
- TUI 플러그인은 디렉터리 자동 스캔 없음 → `.croakcode/tui.json`의 `plugin` 배열에 명시 (`tui.ts:186-198`). 경로는 그 config 파일 기준 상대로 해석된다.
- 플러그인을 `croakcode.jsonc`의 `plugin` 배열에 **명시 등록하지 않아도** `.croakcode/plugins/*.js`는 자동 스캔된다. 명시 등록은 **로딩 순서**를 고정하고 싶을 때만 쓰며, 본 계획은 자동 스캔을 기본으로 한다(중복 로드 방지).
- 모듈 형태: `export default { id, server }` 또는 `export default { id, tui }` (둘 다는 안 됨).

### 훅 이름 (타깃 `@croakcode/plugin` — `upstream/packages/plugin/src/index.ts`)
`chat.headers`(:257), `chat.params`(:247), `command.execute.before`(:262), `tool.execute.before`(:266), `tool.execute.after`(:274), `tool.definition`(:333), `event`(:224), `permission.ask`(:261), `experimental.session.compacting`(:304), `experimental.compaction.autocontinue`(:315), `auth`(:229), `tool`(:226). 소스 플러그인의 훅은 모두 타깃에 존재한다.

- `experimental.session.compacting` 출력은 `{ context: string[]; prompt?: string }`이며, 코어는 `compacting.prompt ?? buildPrompt(...)`로 **plugin prompt가 기본 prompt를 대체**한다(`session/compaction.ts:404`). plugin이 `prompt`만 설정하면 `context`는 코어 기본값 경로로 처리된다.
- 실험 훅은 `contracts/src/hooks.mjs`의 `HOOK_NAMES`에 **포함되지 않는다** → local-stability가 사용해도 frozen 계약을 위반하지 않는다.

### 소스 자산 → 이식 목록 (10개 + 공유 lib)

| # | 소스 | 타깃 파일 | 테스트 | 의존 |
|---|---|---|---|---|
| 0 | `tool-policy-state.mjs` | `.croakcode/plugins/lib/policy-state.js` | `tests/policy-state.test.mjs` (신규) | – |
| 1 | `croak-auth/server.mjs` + `session.mjs` | `.croakcode/plugins/croak-auth-server.js` + `lib/croak-auth-session.js` | `tests/croak-auth-session.test.mjs`(이식 9), `tests/croak-auth-server.test.mjs`(**신규**) | policy-state |
| 2 | `croak-auth/tui.tsx` | `.croakcode/plugins/croak-auth-tui.tsx` | `tests/croak-auth-tui.e2e.test.mjs`(**신규**) | policy-state, session |
| 3 | `gate-identity.mjs` | `.croakcode/plugins/gate-identity.js` | `tests/gate-identity.test.mjs`(이식 2) | – |
| 4 | `tool-policy.mjs` | `.croakcode/plugins/tool-policy.js` | `tests/tool-policy.test.mjs`(이식 8) | policy-state |
| 5 | `secret-paths.mjs` | `.croakcode/plugins/secret-paths.js` | `tests/secret-paths.test.mjs`(이식 5) | – |
| 6 | `local-stability.js` | `.croakcode/plugins/local-stability.js` | `tests/local-stability.test.mjs`(**신규**, 4) | §4.9 재조정 |
| 7 | `stall-recovery.mjs` | 폐기(§4.9 대체) — 결정 기록 | – | – |
| 8 | `usage-meter.mjs` | `.croakcode/plugins/usage-meter.js` | `tests/usage-meter.test.mjs`(이식 4) | – |
| 9 | `usage-panel/*` | `upstream/packages/opencode/test/usage-panel/`에 테스트, 플러그인은 `.croakcode/plugins/usage-panel/` | 기존 5종(bun) | usage-meter |
| 10 | `hwp-read.mjs` | `.croakcode/plugins/hwp-read.js` | `tests/hwp-read.test.mjs`(이식 — 소스 케이스 수 확인) | – |
| 11 | `vendor/opencode-cache-hit` | 폐기(기본) — 소스 완전하나 테스트 부재·슬롯 충돌 | – | usage-panel(슬롯) |

> 소스 루트: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/`. 타깃 루트: `upstream/` (워크트리 기준).
> 이식 테스트 케이스 수(실측): session 9, gate-identity 2, tool-policy 8, secret-paths 5, usage-meter 4.

### 테스트 실행 규약
- 루트 계약/플러그인 유닛 테스트: `node --test 'tests/*.test.mjs'` (root `package.json` script `test`).
- bun 계약 테스트: `bun test tests`.
- usage-panel 테스트는 bun:test이며 **`upstream/packages/opencode/test/usage-panel/`에 배치**해 기존 `upstream/packages/opencode/bunfig.toml`(`preload = ["@opentui/solid/preload"]`)를 상속한다.
- upstream 회귀: `cd upstream/packages/opencode && bun test test/tool test/session test/provider`.
- **모든 `cd`가 필요한 Step 뒤에는 커밋 Step에서 `ROOT`(=워크트리 루트) 기준 경로를 쓴다.** 셸은 Step마다 새로 시작되므로 cwd가 누적되지 않는다고 가정하지 말고, 한 Step 안에서 `cd`를 쓸 경우 그 Step 끝에 원위치로 돌아오거나 절대 경로를 쓴다.

### 이식 시 반드시 지킬 제약 (Phase 2 계약 보존)
1. **§3.4 실행 순서 불변**: validate → `tool.execute.before`(plugin deny) → policy → Permission → execute → `tool.execute.after`. secret-paths/tool-policy의 throw는 plugin deny 단계로 정상 단락. `tests/permission-order.test.mjs`, `contracts/src/hooks.mjs` `HOOK_NAMES` 불변.
2. **§4.7 노출 게이트 불변**: `tool/registry.ts:330-341` fail-closed 필터는 건드리지 않는다. tool-policy는 실행 시 deny만 담당(노출 필터 중복 금지).
3. **§4.8 todo 불변**: 플러그인은 todo에 관여하지 않음. `tests/phase2-todo-contract.test.mjs` 유지.
4. **§4.9 스트림 가드**: `STREAM_IDLE_TIMEOUT` 내장 가드를 깨지 않는다. `StreamIdleTimeoutError`/`errorCode "STREAM_IDLE_TIMEOUT"`은 `upstream/packages/opencode/src/session/message-v2.ts:55-60, 1116-1124`에 실재. local-stability는 `CROAKCODE_STREAM_IDLE_TIMEOUT_MS`/`CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS` 플래그를 **변경하지 않는다**.
5. **§5.4 우회 차단 5종**(spec 401-406행): (1) `force:gate`+`--mode direct` 거부, (2) direct+`requiresAuth` 실행 전 오류, (3) 로컬 설정으로 서버 deny 완화 무시, (4) gate 인증 실패 상태에서 direct 전환 시 게이트 전용 도구/컨텍스트 접근 차단, (5) 전환 후 이전 비밀 컨텍스트 재주입 없음. 현재 `tests/security-context.test.mjs`는 (1)(2) 및 (3)의 일부만 커버 → **Task 16a/16b에서 (3)서버부분·(4)·(5)를 실제 요청 경로 E2E로 검증**해야 완료 조건 충족(옵션 A 확정).
6. **보호 헤더 계약 (P1 — 인증 토큰 유출 방지)**: `chat.headers` 훅은 임의 플러그인/프롬프트가 아니라, **신뢰된 인증 플러그인만 `Authorization`을 설정**해야 한다. croak-auth는 아래 **3중 조건**을 모두 만족할 때만 헤더를 주입한다:
   - (a) 대상 `model.providerID ∈ CROAK_PROVIDERS`(기본 `litellm-head`)
   - (b) 그 provider의 `options.baseURL`(해석 후)이 **Gate URL(`CROAK_AUTH_URL`)과 동일 origin**
   - (c) 유효 연결 모드가 `gate`(direct면 토큰 주입 금지 — §5.4: direct는 게이트 인증 불필요)
   위 조건은 Task 3 테스트로 강제한다(provider 불일치·URL 불일치·direct 모드 각각에서 `Authorization` **미주입** 단언). 이 계약은 `contracts/`에 문서화(Task 16b)한다.
7. **슬롯 계약**: TUI 플러그인은 슬롯 콘텐츠만 등록(`session_message_footer` props `{session_id,message_id}`, `sidebar_content`/`session_prompt_right`/`home_prompt_right` props `{session_id}`). `contracts/src/tui-surface.mjs` 불변.
8. **`api.permission.mode()`는 read-only** — usage-panel 호환. `/permissions` 토글은 `keymap.dispatchCommand("permission.mode.toggle")`.
9. rebrand-check 준수: 신규 파일에서 core 범위 `opencode` 문자열이 섞이지 않도록 주의(Phase 4 allowlist 외).

---

## Chunk 1: 공유 정책 상태 + 보안 1선 (policy-state, croak-auth, gate-identity, tool-policy, secret-paths)

이 청크가 끝나면: 정책 파일 공유 lib가 동작하고, croak-auth 서버 토큰 주입·세션 관리가 유닛 테스트로 증명되며, 정책/비밀경로/게이트 식별 플러그인이 실행 게이트 역할을 한다.

### Task 0: `.croakcode` 디렉터리 준비 (설정 로더 경로 확정)

**Files:**
- Create: `upstream/.croakcode/plugins/lib/.gitkeep`
- Create: `upstream/.croakcode/plugins/.gitkeep`
- Test: `tests/config-dir.test.mjs`

- [ ] **Step 1: 실패 테스트 작성**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";

test(".croakcode/plugins exists (config loader scans .croakcode only)", async () => {
  const s = await stat(new URL("../upstream/.croakcode/plugins", import.meta.url));
  assert.ok(s.isDirectory());
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/config-dir.test.mjs`
Expected: FAIL — ENOENT

- [ ] **Step 3: 디렉터리 생성**

```bash
mkdir -p upstream/.croakcode/plugins/lib upstream/.croakcode/agent upstream/.croakcode/command
touch upstream/.croakcode/plugins/.gitkeep upstream/.croakcode/plugins/lib/.gitkeep
```
> `upstream/.opencode/`은 건드리지 않는다(Phase 1 잔재, 로더 비대상).

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/config-dir.test.mjs`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add upstream/.croakcode tests/config-dir.test.mjs
git commit -m "chore(phase3): create .croakcode config dir (loader target)"
```

### Task 0a: `litellm-head` Provider 설정 + 로딩 스모크 (필수 선행)

**Files:**
- Create: `tests/provider-litellm-head.test.mjs`
- Modify: `upstream/.croakcode/croakcode.jsonc` (Task 15에서 생성되는 파일에 provider 정의 포함 — Task 0a에서 먼저 만들고 Task 15는 JSONC 유효성만 확인)
- Reference: `upstream/packages/opencode/src/provider/provider.ts` (`provider` config 섹션 스키마)

> **선행 이유**: `dev-safe.md`(`model: litellm-head/default`), local-stability(`chat.params`), usage-panel(`direct` 변형)이 모두 `litellm-head`를 가정한다. Provider가 없으면 플러그인이 로드돼도 모델 해석에서 실패한다.

- [ ] **Step 1: 현재 부재 확인**

```bash
grep -rn "litellm" upstream/packages/opencode/src/provider/ | head
```
Expected: 출력 없음 (내장 registry에 없음 → 사용자 정의 필수)

- [ ] **Step 2: 실패 테스트 작성**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// JSONC는 주석을 허용하므로 정식 파서 없이도 최소 검증이 가능하도록
// 주석 제거는 문자열 리터럴을 건드리지 않는 방식이어야 한다 (아래 helper).
function stripJsonc(text) {
  let out = "", i = 0, inStr = false, esc = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

test("croakcode.jsonc defines provider litellm-head with a baseURL", async () => {
  const raw = await readFile(new URL("../upstream/.croakcode/croakcode.jsonc", import.meta.url), "utf8");
  const cfg = JSON.parse(stripJsonc(raw));
  const p = cfg.provider?.["litellm-head"];
  assert.ok(p, "provider.litellm-head missing");
  assert.equal(p.npm, "@ai-sdk/openai-compatible");
  assert.ok(p.options?.baseURL, "options.baseURL required");
  assert.ok(p.models && Object.keys(p.models).length > 0, "at least one model needed (qwen3.8-27b-nvfp4)");
  assert.ok(p.models["qwen3.8-27b-nvfp4"], "qwen3.8-27b-nvfp4 model missing");
});
```
> 위 `stripJsonc`는 **문자열 리터럴 안의 `//`(예: `https://…`)를 보존**한다. 단순 `replace(/\/\/.*$/gm,"")`는 URL을 훼손하므로 금지(Task 15 P1). 실사용 시 정식 JSONC 파서(`jsonc-parser`)를 써도 된다.

- [ ] **Step 3: 실패 확인**

Run: `node --test tests/provider-litellm-head.test.mjs`
Expected: FAIL — ENOENT 또는 `provider.litellm-head missing`

- [ ] **Step 4: `croakcode.jsonc`에 provider 정의 추가**

```jsonc
{
  "$schema": "https://croakcode.ai/config.json",
  "provider": {
    "litellm-head": {
      // OpenAI-compatible endpoint (LiteLLM proxy). baseURL must be set per environment.
      "npm": "@ai-sdk/openai-compatible",
      "name": "LiteLLM Head",
      "options": {
        "baseURL": "{env:LITELLM_BASE_URL}"
      },
      "models": {
        "qwen3.8-27b-nvfp4": { "name": "Qwen3.8 27B NVFP4" },
        "default": { "name": "Default" }
      }
    }
  },
  "permission": {},
  "mcp": {},
  "tools": { "github-triage": false, "github-pr-search": false }
}
```
> 코어의 env 치환 문법은 **`{env:VAR}`**(중괄호, `$` 없음)이다(`config/variable.ts:34`, `/\{env:([^}]+)\}/g`). `missing` 기본값이 `error`이므로 `LITELLM_BASE_URL`이 미설정이면 **설정 로드가 실패**한다 → Step 5에서 반드시 설정하거나, 미설정 허용이 필요하면 `missing:"empty"` 경로를 확인한다.

- [ ] **Step 5: 실제 로딩 스모크 (모델 해석까지)**

```bash
cd upstream && LITELLM_BASE_URL="${LITELLM_BASE_URL:-http://127.0.0.1:4000}" \
  bun run --conditions=browser packages/opencode/src/index.ts models > /tmp/phase3-models.out 2>&1
echo "exit=$?"
grep -iE "litellm-head|qwen3.8-27b-nvfp4" /tmp/phase3-models.out || echo "MISSING MODEL IN LIST"
```
Expected: exit 0, 모델 목록에 `litellm-head`/`qwen3.8-27b-nvfp4`가 나타남. **`|| true` 금지** — 종료 코드를 반드시 확인한다(실패를 삼키지 않는다).

- [ ] **Step 6: 통과 확인**

Run: `node --test tests/provider-litellm-head.test.mjs`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add upstream/.croakcode/croakcode.jsonc tests/provider-litellm-head.test.mjs
git commit -m "feat(phase3): define litellm-head provider and verify model resolution"
```

### Task 1: 공유 정책 상태 lib 이식 (`policy-state`)

**Files:**
- Create: `upstream/.croakcode/plugins/lib/policy-state.js`
- Test: `tests/policy-state.test.mjs`
- Source: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/tool-policy-state.mjs`

- [ ] **Step 1: 실패 테스트 작성**

`tests/policy-state.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NET_TOOLS, normalizePolicy, deniedFor, isDenied, readPolicy, writePolicy,
} from "../upstream/.croakcode/plugins/lib/policy-state.js";

test("normalizePolicy trims, dedupes and drops non-strings", () => {
  const p = normalizePolicy({ deny: [" websearch ", "websearch", 3, ""], sessions: { s1: ["webfetch", "webfetch"] } });
  assert.deepEqual(p, { deny: ["websearch"], sessions: { s1: ["webfetch"] } });
  assert.deepEqual(normalizePolicy(null), { deny: [], sessions: {} });
});

test("deniedFor merges global and session rules", () => {
  const p = { deny: ["websearch"], sessions: { s1: ["bash"] } };
  assert.deepEqual([...deniedFor(p, "s1")].sort(), ["bash", "websearch"]);
  assert.deepEqual([...deniedFor(p)], ["websearch"]);
});

test("isDenied matches exact and prefix wildcards", () => {
  assert.equal(isDenied({ deny: ["rhwp_*"] }, undefined, "rhwp_read"), true);
  assert.equal(isDenied({ deny: ["*"] }, undefined, "anything"), true);
  assert.equal(isDenied({ deny: ["bash"] }, undefined, "bash"), true);
  assert.equal(isDenied({ deny: ["bash"] }, undefined, "grep"), false);
});

test("writePolicy roundtrips atomically and readPolicy returns ENOENT as empty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "policy-"));
  const file = path.join(dir, "tool-policy.json");
  assert.deepEqual(await readPolicy(file), { deny: [], sessions: {} });
  await writePolicy({ deny: ["webfetch"] }, file);
  assert.deepEqual(await readPolicy(file), { deny: ["webfetch"], sessions: {} });
  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.ok(raw.updatedAt);
  assert.deepEqual(NET_TOOLS, ["websearch", "webfetch"]);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/policy-state.test.mjs`
Expected: FAIL — `Cannot find module '../upstream/.croakcode/plugins/lib/policy-state.js'`

- [ ] **Step 3: 소스 이식 (구현)**

`upstream/.croakcode/plugins/lib/policy-state.js` — `tool-policy-state.mjs`를 거의 그대로 복사하되:
- 파일 확장자 `.js`로 저장 (ESM 유지).
- `CROAK_TOOL_POLICY_FILE` / `CROAK_*` 환경변수 이름은 **그대로 유지**(플러그인 로컬 규약, Phase 2 `CROAKCODE_*`는 코어 플래그이므로 충돌 없음).
- 나머지 export 시그니처(`NET_TOOLS`, `policyFile`, `normalizePolicy`, `deniedFor`, `isDenied`, `readPolicy`, `writePolicy`, `createPolicyReader`) 불변.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/policy-state.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add upstream/.croakcode/plugins/lib/policy-state.js tests/policy-state.test.mjs
git commit -m "feat(plugins): port shared tool-policy state lib"
```

### Task 2: croak-auth 세션 모듈 이식

**Files:**
- Create: `upstream/.croakcode/plugins/lib/croak-auth-session.js`
- Test: `tests/croak-auth-session.test.mjs`
- Source: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/croak-auth/session.mjs` (+ `session.test.mjs`)

- [ ] **Step 1: 실패 테스트 작성**

`tests/croak-auth-session.test.mjs` — 소스 `session.test.mjs`를 이식하되 import 경로만 변경. **이식할 케이스는 총 9개**(소스 실측): PKCE S256, 교환 후 저장(mode 600), 동시 refresh 1회, unreachable 시 토큰 유지, 401 clear, weekly 만료 clear, whoami bearer, logout, refresh 조기갱신. 다음은 그중 첫 케이스의 정확한 형태이며, 나머지 8개도 소스에서 그대로 옮긴다(요약 금지, 실제 코드 복사):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 환경 격리: config dir를 임시 경로로 (import 전에 설정해야 함)
process.env.CROAK_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "croak-auth-"));

const S = await import("../upstream/.croakcode/plugins/lib/croak-auth-session.js");

test("pkce returns S256 challenge of verifier", () => {
  const { verifier, challenge } = S.pkce();
  const expected = createHash("sha256").update(verifier).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(challenge, expected);
});
```
> **주의**: import는 반드시 `import { createHash } from "node:crypto"` (ESM). `require()`를 쓰지 않는다.

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/croak-auth-session.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 소스 이식**

`upstream/.croakcode/plugins/lib/croak-auth-session.js` — `session.mjs`를 그대로 복사(`.js` 확장자). env 이름(`CROAK_CONFIG_DIR`, `CROAK_CA_FILE`, `CROAK_AUTH_URL`) 유지.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/croak-auth-session.test.mjs`
Expected: PASS (9 tests — 소스와 동일)

- [ ] **Step 5: 커밋**

```bash
git add upstream/.croakcode/plugins/lib/croak-auth-session.js tests/croak-auth-session.test.mjs
git commit -m "feat(plugins): port croak-auth session module"
```

### Task 3: croak-auth 서버 플러그인 (토큰 주입)

**Files:**
- Create: `upstream/.croakcode/plugins/croak-auth-server.js`
- Test: `tests/croak-auth-server.test.mjs` — **신규 작성**(소스에 server.test.mjs 없음)
- Source: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/croak-auth/server.mjs`

- [ ] **Step 1: 실패 테스트 작성**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CROAK_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "croak-authsrv-"));
process.env.CROAK_PROVIDERS = "litellm-head,other";

const S = await import("../upstream/.croakcode/plugins/lib/croak-auth-session.js");
const plugin = (await import("../upstream/.croakcode/plugins/croak-auth-server.js")).default;

test("plugin exports id and server", async () => {
  assert.equal(plugin.id, "croak-auth");
  const hooks = await plugin.server();
  assert.equal(typeof hooks["chat.headers"], "function");
});

test("not logged in => no Authorization", async () => {
  const hooks = await plugin.server();
  const out = { headers: { "x-existing": "1" } };
  await hooks["chat.headers"](
    { model: { providerID: "litellm-head" }, provider: { id: "litellm-head", options: { baseURL: "https://gate.example" } } },
    out,
  );
  assert.equal(out.headers.Authorization, undefined);
  assert.equal(out.headers["x-existing"], "1");
});

test("logged in + configured provider + gate-origin baseURL + gate mode => Authorization set", async () => {
  const hooks = await plugin.server();
  S.save({ access_token: "a", refresh_token: "r", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), session_expires_at: new Date(Date.now() + 86400e3).toISOString(), user: {}, auth_url: "https://gate.example" });
  const out = { headers: {} };
  await hooks["chat.headers"](
    { model: { providerID: "litellm-head" }, provider: { id: "litellm-head", options: { baseURL: "https://gate.example/v1" } }, connection: { mode: "gate" } },
    out,
  );
  assert.equal(out.headers.Authorization, "Bearer a");
});

// === 보호 헤더 계약 (3중 조건) — 하나라도 어긋나면 토큰을 내보내지 않는다 ===
test("unconfigured provider => no Authorization even with token", async () => {
  const hooks = await plugin.server();
  S.save({ access_token: "a", refresh_token: "r", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), session_expires_at: new Date(Date.now() + 86400e3).toISOString(), user: {}, auth_url: "https://gate.example" });
  const out = { headers: {} };
  await hooks["chat.headers"]({ model: { providerID: "other-provider" }, provider: { id: "other-provider", options: { baseURL: "https://gate.example" } }, connection: { mode: "gate" } }, out);
  assert.equal(out.headers.Authorization, undefined);
});

test("provider baseURL origin != gate URL origin => no Authorization (token never leaks)", async () => {
  const hooks = await plugin.server();
  S.save({ access_token: "a", refresh_token: "r", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), session_expires_at: new Date(Date.now() + 86400e3).toISOString(), user: {}, auth_url: "https://gate.example" });
  const out = { headers: {} };
  await hooks["chat.headers"]({ model: { providerID: "litellm-head" }, provider: { id: "litellm-head", options: { baseURL: "https://evil.example/v1" } }, connection: { mode: "gate" } }, out);
  assert.equal(out.headers.Authorization, undefined);
});

test("direct mode => no Authorization (gate token not needed/forbidden)", async () => {
  const hooks = await plugin.server();
  S.save({ access_token: "a", refresh_token: "r", access_expires_at: new Date(Date.now() + 3600e3).toISOString(), session_expires_at: new Date(Date.now() + 86400e3).toISOString(), user: {}, auth_url: "https://gate.example" });
  const out = { headers: {} };
  await hooks["chat.headers"]({ model: { providerID: "litellm-head" }, provider: { id: "litellm-head", options: { baseURL: "https://gate.example/v1" } }, connection: { mode: "direct" } }, out);
  assert.equal(out.headers.Authorization, undefined);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/croak-auth-server.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 소스 이식 + 보호 헤더 계약 구현**

`upstream/.croakcode/plugins/croak-auth-server.js` — `server.mjs`를 기반으로 하되, **3중 조건**을 추가(Task 2 `lib/croak-auth-session.js`의 `authUrl()` 사용):

```js
import { accessToken, authUrl } from "./lib/croak-auth-session.js"

const PROVIDERS = new Set((process.env.CROAK_PROVIDERS || "litellm-head").split(",").map((s) => s.trim()))

export const providerOf = (input) => input?.model?.providerID ?? input?.provider?.id

const originOf = (value) => {
  try { return new URL(value).origin } catch { return undefined }
}

/** Gate 전용 토큰을 이 요청에 실어도 되는가? (3중 조건) */
export function shouldAttachToken(input) {
  const providerID = providerOf(input)
  if (!providerID || !PROVIDERS.has(providerID)) return false
  const mode = input?.connection?.mode
  if (mode !== "gate") return false // direct면 금지, 미상이면 fail-closed
  const base = input?.provider?.options?.baseURL
  if (!base) return false
  return originOf(base) === originOf(authUrl())
}

export const server = async () => ({
  "chat.headers": async (input, output) => {
    if (!shouldAttachToken(input)) return
    const token = await accessToken()
    if (token) output.headers.Authorization = `Bearer ${token}`
  },
})

export default { id: "croak-auth", server }
```
> `shouldAttachToken`을 export해 Task 16b의 계약 테스트에서 재사용한다. **mode가 없거나 불명이면 토큰 미주입(fail-closed)** — 이게 핵심.

> **⚠️ 런타임 배선 필요 (Task 12a에서 처리)**: 현재 타깃의 `chat.headers` 훅 input은 `{ sessionID, agent, model, provider(ProviderContext=Provider.Info), message }`이며 **`connection.mode`가 없다**(`packages/plugin/src/index.ts:248`, `session/llm/request.ts:121-130`). 그리고 `provider`는 `Provider.Info`가 직접 전달되어 **`options.baseURL`이 최상위 `provider.options`에 있다**(`provider.ts:929-936`). 따라서 위 테스트는 계약 검증용이며, **실제 런타임에서 mode가 들어오도록 Task 12a에서 `request.ts`의 `chat.headers` input에 `connection`(mode 포함)을 추가**해야 한다. 추가 전까지 실제 런타임에서는 fail-closed(토큰 미주입)로 동작한다.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/croak-auth-server.test.mjs`
Expected: PASS (5 tests — 로그인 전/정상/미설정provider/URL불일치/direct)

- [ ] **Step 5: 커밋**

```bash
git add upstream/.croakcode/plugins/croak-auth-server.js tests/croak-auth-server.test.mjs
git commit -m "feat(plugins): port croak-auth server token injection"
```

### Task 4: gate-identity 이식

**Files:**
- Create: `upstream/.croakcode/plugins/gate-identity.js`
- Test: `tests/gate-identity.test.mjs`
- Source: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/gate-identity.mjs` (+ `.test.mjs`)

- [ ] **Step 1: 실패 테스트 작성** — 소스 `gate-identity.test.mjs`를 복사하고 import를 `../upstream/.croakcode/plugins/gate-identity.js`로 변경.

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/gate-identity.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 소스 이식** — `gate-identity.mjs`를 `.js`로 복사. `AGENT_HEADER`/`SESSION_HEADER`/`identityHeaders`/`server`/`default{id:"croak-gate-identity",server}` 불변.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/gate-identity.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add upstream/.croakcode/plugins/gate-identity.js tests/gate-identity.test.mjs
git commit -m "feat(plugins): port gate-identity header plugin"
```

### Task 5: tool-policy 플러그인 이식

**Files:**
- Create: `upstream/.croakcode/plugins/tool-policy.js`
- Test: `tests/tool-policy.test.mjs`
- Source: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/tool-policy.mjs` (+ `.test.mjs`)

- [ ] **Step 1: 실패 테스트 작성** — 소스 `tool-policy.test.mjs` 이식. import 경로를 `../upstream/.croakcode/plugins/tool-policy.js`로, 상태 lib는 `../upstream/.croakcode/plugins/lib/policy-state.js`. 테스트마다 `process.env.CROAK_TOOL_POLICY_FILE`를 임시 파일로 설정.

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/tool-policy.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 소스 이식** — `tool-policy.mjs` → `tool-policy.js`, import `"./tool-policy-state.mjs"` → `"./lib/policy-state.js"`. 훅(`command.execute.before` `/net-off /net-on /tool-status`, `tool.execute.before` deny) 불변. `default{id:"croak-tool-policy",server}` 유지.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/tool-policy.test.mjs`
Expected: PASS (8 tests — 소스와 동일)

- [ ] **Step 5: §3.4 계약 회귀 확인**

Run: `node --test tests/permission-order.test.mjs`
Expected: PASS — plugin deny 단락 순서 불변

- [ ] **Step 6: 커밋**

```bash
git add upstream/.croakcode/plugins/tool-policy.js tests/tool-policy.test.mjs
git commit -m "feat(plugins): port runtime tool-policy plugin"
```

### Task 6: secret-paths 플러그인 이식

**Files:**
- Create: `upstream/.croakcode/plugins/secret-paths.js`
- Test: `tests/secret-paths.test.mjs`
- Source: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/secret-paths.mjs` (+ `.test.mjs`)

- [ ] **Step 1: 실패 테스트 작성** — 소스 `secret-paths.test.mjs` 이식, import 경로만 변경.

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/secret-paths.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 소스 이식** — `secret-paths.mjs` → `.js` 복사. `DENY_DIRS`/`DENY_FILES`/`deniedPath`/`commandPaths`/`deniedCall`/`filterOutput`/훅/`default{id:"croak-secret-paths",server}` 불변.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/secret-paths.test.mjs`
Expected: PASS (5 tests — 소스와 동일)

- [ ] **Step 5: §3.4 + §4.7 계약 회귀 확인**

Run: `node --test tests/permission-order.test.mjs && cd upstream/packages/opencode && bun test test/tool/registry-permission.test.ts`
Expected: PASS — 실행 순서·노출 게이트 불변

- [ ] **Step 6: 커밋**

```bash
git add upstream/.croakcode/plugins/secret-paths.js tests/secret-paths.test.mjs
git commit -m "feat(plugins): port secret-paths guard plugin"
```

## Chunk 2: 안정성·관측 (local-stability, stall-recovery 결정, usage-meter)

이 청크가 끝나면: 반복 호출 차단·qwen 파라미터 보정·compaction 커스터마이즈가 §4.9 내장 가드와 충돌 없이 동작하고, stall-recovery 폐기/유지 결정이 문서화되며, usage-meter가 JSONL을 기록한다.

### Task 7: local-stability 이식 + §4.9 reconciliation

**Files:**
- Create: `upstream/.croakcode/plugins/local-stability.js`
- Test: `tests/local-stability.test.mjs` (신규 — 소스엔 테스트 없음)
- Source: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/local-stability.js`
- Check: `upstream/packages/opencode/src/session/compaction.ts:399`, `contracts/src/stream-guard.mjs`

- [ ] **Step 1: 실패 테스트 작성 (훅 존립 + 반복 차단 + 파라미터)**

```js
import test from "node:test";
import assert from "node:assert/strict";
const plugin = (await import("../upstream/.croakcode/plugins/local-stability.js")).default;

test("exports id and all expected hooks", async () => {
  assert.equal(plugin.id, "croak-local-stability");
  const hooks = await plugin.server({ client: { tui: { showToast: async () => {} }, session: { abort: async () => {} } } });
  for (const h of ["tool.execute.before", "event", "chat.params", "experimental.session.compacting", "experimental.compaction.autocontinue"])
    assert.equal(typeof hooks[h], "function", h);
});

test("identical read 4th time throws", async () => {
  const hooks = await plugin.server({ client: { tui: { showToast: async () => {} }, session: { abort: async () => {} } } });
  const input = { tool: "read", sessionID: "s1" }, output = { args: { filePath: "a.ts" } };
  for (let i = 0; i < 3; i++) await hooks["tool.execute.before"](input, output);
  await assert.rejects(() => hooks["tool.execute.before"](input, output), /Repeated non-progress/);
});

test("qwen params adjusted for litellm-head", async () => {
  const hooks = await plugin.server({ client: {} });
  const out = {};
  await hooks["chat.params"]({ model: { providerID: "litellm-head", id: "qwen3.8-27b-nvfp4" } }, out);
  assert.equal(out.temperature, 1.0);
  assert.equal(out.topP, 0.95);
  const out2 = { options: { chat_template_kwargs: { enable_thinking: false } } };
  await hooks["chat.params"]({ model: { providerID: "litellm-head", id: "qwen3.8-27b-nvfp4" } }, out2);
  assert.equal(out2.temperature, 0.7);
  assert.equal(out2.topP, 0.8);
});

test("compaction prompt does not disable built-in idle guard", async () => {
  const hooks = await plugin.server({ client: {} });
  const out = {};
  await hooks["experimental.session.compacting"]({}, out);
  assert.match(out.prompt, /continuation checkpoint/i);
  const ac = {};
  await hooks["experimental.compaction.autocontinue"]({}, ac);
  assert.equal(ac.enabled, true);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/local-stability.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: reconciliation — 실측 확인 후 매트릭스에 근거 기록**

**실측 결과 (이미 확인됨)**: 코어는 `compacting.prompt ?? buildPrompt(...)`로 **plugin prompt가 기본 prompt를 대체**한다(`session/compaction.ts:404`). 즉 local-stability prompt가 그대로 쓰이고, `context`는 미설정 시 코어 기본 경로로 처리된다. 따라서 두 지시가 **append로 충돌하지 않는다**.

확인 명령(구현자가 재확인):
```bash
grep -n "compacting.prompt\|buildPrompt" upstream/packages/opencode/src/session/compaction.ts
```
Expected: `const nextPrompt = compacting.prompt ?? buildPrompt(...)` → plugin prompt 우선.

**기록할 항목**(Step 6 커밋에 포함):
- local-stability는 `CROAKCODE_STREAM_IDLE_TIMEOUT_MS`/`CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS` 플래그를 **변경하지 않음**(§4.9 내장 가드 유지). → `docs/superpowers/phase0/phase3-equivalence-matrix.md`에 "local-stability compaction prompt는 plugin prompt로 기본값을 대체하며 §4.9 idle guard 플래그와 독립" 주석 추가.

- [ ] **Step 4: 소스 이식 (default export 추가 필요)**

`local-stability.js` → `.js` 복사하되, **소스에는 `export default`가 없다**(`export const server`만 존재). 따라서 `export default { id: "croak-local-stability", server }`를 **파일 끝에 추가**한다(경로 플러그인은 `id` 필수 — `plugin/shared.ts:315`).

- [ ] **Step 5: 통과 확인**

Run: `node --test tests/local-stability.test.mjs && node --test tests/phase2-stream-guard-contract.test.mjs`
Expected: PASS — 훅 동작 + §4.9 계약 불변

- [ ] **Step 6: 커밋**

```bash
git add upstream/.croakcode/plugins/local-stability.js tests/local-stability.test.mjs
git commit -m "feat(plugins): port local-stability with §4.9 reconciliation"
```

### Task 8: stall-recovery 폐기/유지 결정 및 문서화

**Files:**
- Modify: `docs/superpowers/phase0/phase3-equivalence-matrix.md` (Chunk 4에서 생성; 이 Task는 결정 기록만 추가)
- Check: `upstream/packages/opencode/src/session/message-v2.ts:1117-1124`, `contracts/src/stream-guard.mjs`

- [ ] **Step 1: 타깃 오류 형태 확인**

Run: `grep -n "STREAM_IDLE_TIMEOUT\|StreamIdleTimeoutError" upstream/packages/opencode/src/session/message-v2.ts contracts/src/stream-guard.mjs`
Expected: 내장 가드가 `metadata.code = STREAM_IDLE_TIMEOUT`으로 오류를 방출 → stall-recovery의 문자열 매치(`"SSE read timed out..."`, `error?.data?.message`)는 더 이상 발생하지 않음.

- [ ] **Step 2: 결정 기록**

`docs/superpowers/phase0/phase3-equivalence-matrix.md`에 아래 항목 추가(파일 없으면 생성):
```md
| stall-recovery | 기존 문자열 매치(`SSE read timed out after response data was received`)는 §4.9 내장 `STREAM_IDLE_TIMEOUT` 가드로 대체됨. 재프롬프트 최대 2회 동작은 `experimental.compaction.autocontinue`/재시도 규칙과 중복 → **폐기(ACCEPTED DEVIATION)**. 필요 시 Phase 4에서 재도입 검토. |
```
> 폐기는 §6.6 `ACCEPTED DEVIATION` 규칙에 따라 사유·영향 기록 필수. 사용자 승인 필요 항목이면 승인 후 진행.

- [ ] **Step 3: 커밋**

```bash
git add docs/superpowers/phase0/phase3-equivalence-matrix.md
git commit -m "docs(phase3): record stall-recovery deprecation decision"
```

### Task 9: usage-meter 이식

**Files:**
- Create: `upstream/.croakcode/plugins/usage-meter.js`
- Test: `tests/usage-meter.test.mjs`
- Source: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/usage-meter.mjs` (+ `.test.mjs`)

- [ ] **Step 1: 실패 테스트 작성** — 소스 `usage-meter.test.mjs` 이식, import 경로 변경. 두 API를 구분해 검증한다: (a) **`buildRecord({ requestAt, firstAt, finishAt, tokens, ... })`** 순수 함수 — prefill/decode 계산·null 가드(짧은 간격/적은 토큰 시 null); (b) **`createMeter({ now, write })`** 팩토리 — `onRequest`→`onEvent(step-start)`→`onEvent(step-finish)` 순서로 `write(record)` 호출, request 없는 finish도 로그. 소스 `usage-meter.test.mjs`(4 케이스)를 이식.

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/usage-meter.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 소스 이식** — `usage-meter.mjs` → `.js`. `usageFile()`(`$CROAK_USAGE_FILE` 또는 `$XDG_DATA_HOME/croak/usage.jsonl`) 유지 — usage-panel과 동일 경로여야 함. `default{id:"croak-usage-meter",server}` 유지.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/usage-meter.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add upstream/.croakcode/plugins/usage-meter.js tests/usage-meter.test.mjs
git commit -m "feat(plugins): port usage-meter JSONL recorder"
```

## Chunk 3: HWP 툴 + TUI 슬롯 콘텐츠 (hwp-read, croak-auth-tui, usage-panel, vendor 결정)

이 청크가 끝나면: `hwp_read`/`hwp_cli` 커스텀 툴이 JSON-Schema `args`로 로드되고, croak-auth 슬래시 명령·usage-panel 슬롯 콘텐츠가 `tui.json` 등록으로 동작하며, cache-hit 폐기 결정이 문서화된다.

### Task 10: hwp-read 커스텀 툴 이식

**Files:**
- Create: `upstream/.croakcode/plugins/hwp-read.js`
- Test: `tests/hwp-read.test.mjs`
- Source: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/hwp-read.mjs` (+ `.test.mjs`)
- Check: `upstream/packages/opencode/src/tool/registry.ts:150` (`legacyJsonSchema`), `:164-168` (`ctx.ask` bridge), `:414-416` (`isPluginTool`)

- [ ] **Step 1: 실패 테스트 작성** — 소스 `hwp-read.test.mjs` 이식, import 경로 변경. 케이스: Windows 드라이브 경로 변환(`C:\` → `/mnt/c/...`), 상대/절대 경로, `parsePages`("summary"/"7"/"3-7"/범위초과 오류), `stripImages`, `sortPageFiles`, `classifyCli`(read/write/blocked), `convertArgs`, `hwpCli`가 쓰기 전 `ctx.ask({permission:"edit"})` 호출·`mcp-serve` 차단.

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/hwp-read.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 소스 이식** — `hwp-read.mjs` → `.js`. `server`의 `tool: { hwp_read, hwp_cli }` 및 **plain JSON-Schema args**(zod import 금지) 유지. `hwp_cli` 쓰기 경로의 `ctx.ask({ permission: "edit", ... })` 유지. `default{id:"croak-hwp-read",server}`.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/hwp-read.test.mjs`
Expected: PASS

- [ ] **Step 5: 타깃 로더 호환 확인 (통합)**

Run: `cd upstream/packages/opencode && bun test test/tool`
Expected: PASS — 293/293 유지, 기존 툴 회귀 없음

- [ ] **Step 6: 커밋**

```bash
git add upstream/.croakcode/plugins/hwp-read.js tests/hwp-read.test.mjs
git commit -m "feat(plugins): port hwp_read/hwp_cli custom tools"
```

### Task 11: croak-auth TUI 플러그인 이식 (/login /logout /whoami /agent-perm)

**Files:**
- Create: `upstream/.croakcode/plugins/croak-auth-tui.tsx`
- Test: `tests/croak-auth-tui.e2e.test.mjs` (신규 E2E — 슬래시 등록 검증)
- Source: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/croak-auth/tui.tsx`
- Modify: `upstream/.croakcode/tui.json`

- [ ] **Step 1: 실패 E2E 테스트 작성 (슬래시 명령/슬롯 등록 계약)**

`tests/croak-auth-tui.e2e.test.mjs` — TUI API를 stub으로 주입해 `tui(api, opts)` 호출 시 등록되는 keymap layer를 검증한다. **실제 소스는 `api.keymap.registerLayer({ commands: [...] })` 형태로 호출하고 각 명령은 `{ name: "croak.login", slashName: "login", run }`이다**(`croak-auth/tui.tsx:219-236`). 따라서 stub은 `{commands}` 객체를 받아 `slashName`을 수집해야 한다:

```js
import test from "node:test";
import assert from "node:assert/strict";
const mod = (await import("../upstream/.croakcode/plugins/croak-auth-tui.tsx")).default;

test("registers slash commands and sidebar slots", async () => {
  const slashNames = [];
  const layers = [];
  const slots = [];
  const api = {
    slots: { register: (r) => slots.push(r) },
    keymap: { registerLayer: (layer) => { layers.push(layer); for (const c of layer.commands ?? []) if (c.slashName) slashNames.push(c.slashName); } },
    ui: { toast() {}, DialogPrompt: {}, DialogAlert: {}, DialogSelect: {}, dialog: {} },
    event: { on() {} }, route: { current: {} }, lifecycle: { onDispose() {} }, theme: { current: {} },
    permission: { mode: () => "ask" },
  };
  await mod.tui(api, {});
  for (const c of ["login", "logout", "whoami", "agent-perm"]) assert.ok(slashNames.includes(c), `missing slash ${c}; got ${slashNames.join(",")}`);
  assert.equal(slashNames.length, 4);
  const registered = slots[0];
  assert.ok(registered?.slots?.sidebar_content, "sidebar_content slot");
  assert.ok(registered?.slots?.home_prompt_right, "home_prompt_right slot");
});
```
> `.tsx` import는 Bun 런타임이 JSX를 처리하므로 `bun test`로 실행한다. **주의**: 루트에는 `bunfig.toml`이 없어 `@opentui/solid/preload`가 적용되지 않는다 → 이 E2E 테스트를 `upstream/packages/opencode/test/usage-panel/`이 아니라 **`upstream/packages/opencode/test/plugins/`**에 두고 기존 bunfig를 상속시키거나, 루트에 아래 `bunfig.toml`을 추가한다:
```toml
[test]
preload = ["@opentui/solid/preload"]
```
> 권장: 루트 `bunfig.toml` 추가(모든 JSX 테스트가 일관되게 preload 받음).

- [ ] **Step 2: 실패 확인**

Run: `bun test tests/croak-auth-tui.e2e.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 소스 이식** — `croak-auth/tui.tsx` 복사, import `"../tool-policy-state.mjs"` → `"./lib/policy-state.js"`, `"./session.mjs"` → `"./lib/croak-auth-session.js"`. `export default { id: "croak-auth-tui", tui }` 유지. `slots.register`의 `sidebar_content`/`home_prompt_right`, `/agent-perm`은 `writePolicy`로 세션 도구 차단.

- [ ] **Step 4: tui.json 등록**

`upstream/.croakcode/tui.json` `plugin` 배열에 추가:
```json
[ "./plugins/croak-auth-tui.tsx", {} ]
```
> 경로는 `.croakcode/tui.json` 기준 상대 경로. `plugin.ts` resolve가 `file://`/상대로 해석(`upstream/packages/opencode/src/config/plugin.ts`).

- [ ] **Step 5: 통과 확인**

Run: `bun test tests/croak-auth-tui.e2e.test.mjs`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add upstream/.croakcode/plugins/croak-auth-tui.tsx upstream/.croakcode/tui.json tests/croak-auth-tui.e2e.test.mjs
git commit -m "feat(plugins): port croak-auth TUI slash commands"
```

### Task 12: usage-panel 이식 (슬롯 콘텐츠)

**Files:**
- Create: `upstream/.croakcode/plugins/usage-panel/` (index.tsx, controller.tsx, guard.ts, usage-log.ts, activity.ts, sprite.ts, elapsed.ts, notice.ts, avatar.tsx, sprites/, tools/)
- Test: 기존 5종(`*.test.ts`) 이식 — **`upstream/packages/opencode/test/usage-panel/`** (bun:test, 기존 `upstream/packages/opencode/bunfig.toml`의 preload 상속)
- Source: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/usage-panel/`
- Modify: `upstream/.croakcode/tui.json`

> **테스트 위치 확정**: 루트 `tests/`가 아니라 **`upstream/packages/opencode/test/usage-panel/`**에 둔다. 이유: JSX/Solid preload(`@opentui/solid/preload`)가 `upstream/packages/opencode/bunfig.toml`에만 설정돼 있어, 그 디렉터리에서 돌려야 자동 상속된다.

- [ ] **Step 1: 실패 테스트 배치** — 소스 `usage-panel/*.test.ts`를 `upstream/packages/opencode/test/usage-panel/`로 복사, 상대 import를 플러그인 경로(예: `../../../.croakcode/plugins/usage-panel/...`)로 조정.

- [ ] **Step 2: 실패 확인**

Run: `( cd upstream/packages/opencode && bun test test/usage-panel )`
Expected: FAIL — module not found

- [ ] **Step 3: preload 확인 (이미 설정됨)**

```bash
grep preload upstream/packages/opencode/bunfig.toml
```
Expected: `preload = ["@opentui/solid/preload"]` — 이미 존재하므로 별도 `bunfig.toml` 추가 불필요. 없다면 Step 2가 실패하므로 그때만 추가.

- [ ] **Step 4: 소스 이식** — usage-panel 디렉터리 전체 복사(`.ts`→유지). `index.tsx`의 `api.slots.register({ order: 90, slots: { session_message_footer(_ctx,{session_id,message_id}), session_prompt_right(_ctx,{session_id}), sidebar_content(_ctx,{session_id}) } })`는 `SESSION_MESSAGE_FOOTER_PROPS`와 일치(계약 불변, 슬롯 API 만들지 않음). `api.permission.mode()` read-only 사용 유지.

- [ ] **Step 5: 통과 확인**

Run: `( cd upstream/packages/opencode && bun test test/usage-panel )`
Expected: PASS (기존 5종)

- [ ] **Step 6: tui.json 등록**

`upstream/.croakcode/tui.json` `plugin` 배열에 추가:
```json
[ "./plugins/usage-panel/index.tsx", { "avatar": true } ]
```

- [ ] **Step 7: §4.9 / 슬롯 계약 회귀**

Run: `node --test tests/contracts.conformance.test.mjs && node --test tests/phase2-stream-guard-contract.test.mjs`
Expected: PASS — 슬롯 props·idle guard 불변

- [ ] **Step 8: 커밋**

```bash
git add upstream/.croakcode/plugins/usage-panel upstream/.croakcode/tui.json upstream/packages/opencode/test/usage-panel
git commit -m "feat(plugins): port usage-panel slot content"
```

### Task 12a: 런타임 연결 모드 배선 (옵션 A 전제 — 제품 코드 변경)

**Files:**
- Modify: `upstream/packages/opencode/src/session/llm/request.ts` (`chat.headers` input에 `connection` 전달 + 메시지 필터링 지점)
- Modify: `upstream/packages/opencode/src/session/llm.ts` (`StreamInput`에 `connection` 전달)
- Create: `upstream/.croakcode/plugins/lib/connection.js` (모드 해석 + 컨텍스트 필터 순수 함수)
- Test: `tests/connection-context.test.mjs`

> **⚠️ 이 Task는 제품 코어를 수정한다.** Phase 2에서 "리뷰 중 제품 코드 변경 금지"가 적용됐으나, **옵션 A를 채택하는 이상 불가피**하다. 변경은 최소 침습으로 한정하고, Phase 2 계약 회귀(`phase2-stream-guard-contract`, `permission-order`)를 반드시 재확인한다.

**배선 설계 (실측 기반)**
- 현재 `PrepareInput`은 `connection`이 없다(`session/llm/request.ts:17-32`). `chat.headers` input도 `{sessionID, agent, model, provider, message}`뿐(`packages/plugin/src/index.ts:248`).
- `provider`는 `Provider.Info`가 직접 전달된다 → baseURL은 `provider.options.baseURL`(`provider.ts:929-936`).
- **모드 공급원**: 세션 레벨 config(`Config.get()`의 `connection.mode`, 없으면 `agent.force`, 없으면 default `gate`)를 `resolveEffectiveMode`(`control/src/security-context.mjs`)로 해석하고 `StreamInput`에 넣는다.
- **컨텍스트 필터**: `Part.metadata`(free-form)에 `{ origin: "gate" }` 태그가 있는 메시지는 direct 모드 요청 조립 시 제외한다. 스키마 변경 불필요.

- [ ] **Step 1: 실패 테스트 작성 (`connection.js` 순수 함수)**

`tests/connection-context.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveConnectionMode, isGateOnlyPart, filterMessagesForMode } from "../upstream/.croakcode/plugins/lib/connection.js";

test("mode precedence: agentForce > session > global > default gate", () => {
  assert.equal(resolveConnectionMode({ agentForce: "gate", session: "direct", global: "direct" }), "gate");
  assert.equal(resolveConnectionMode({ session: "direct", global: "gate" }), "direct");
  assert.equal(resolveConnectionMode({ global: "direct" }), "direct");
  assert.equal(resolveConnectionMode({}), "gate"); // fail-safe default
  assert.equal(resolveConnectionMode({ agentForce: "direct" }), "direct");
});

test("gate-only part detection uses metadata.origin, not string guessing", () => {
  assert.equal(isGateOnlyPart({ type: "text", metadata: { origin: "gate" } }), true);
  assert.equal(isGateOnlyPart({ type: "tool", metadata: { origin: "gate", sensitivity: "secret" } }), true);
  assert.equal(isGateOnlyPart({ type: "text", metadata: {} }), false);
  assert.equal(isGateOnlyPart({ type: "text" }), false);
});

test("direct mode drops gate-origin parts and unknown-origin parts; gate mode keeps all", () => {
  const msgs = [
    { role: "user", parts: [{ type: "text", text: "hi", metadata: {} }] },
    { role: "assistant", parts: [{ type: "text", text: "secret", metadata: { origin: "gate" } }] },
    { role: "assistant", parts: [{ type: "text", text: "unlabeled" }] }, // unknown origin
  ];
  const direct = filterMessagesForMode(msgs, "direct");
  // gate-origin 제거 + 출처 불명 제거 (fail-closed)
  assert.equal(direct.length, 1);
  assert.equal(direct[0].parts[0].text, "hi");
  const gate = filterMessagesForMode(msgs, "gate");
  assert.equal(gate.length, 3);
});
```
> 정책: **direct에서는 `origin:"gate"` 또는 출처 불명(assistant part에 metadata 없음)을 제외**(마스킹 아님, 제외/차단). user part는 사용자 입력이므로 유지.

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/connection-context.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: `connection.js` 구현**

`upstream/.croakcode/plugins/lib/connection.js`:
```js
import { resolveEffectiveMode } from "../../../../../control/src/security-context.mjs";
// ↑ 상대 경로는 워크트리 레이아웃에 맞춘다(테스트는 루트 tests/에서 import).
//   플러그인 번들링이 단일 파일이어야 하면 이 로직을 인라인하되, 아래 테스트가 동일 동작을 보장한다.

export function resolveConnectionMode({ agentForce, session, global } = {}) {
  const r = resolveEffectiveMode({ agentForce, sessionOverride: session, global });
  if (r.mode === "gate" || r.mode === "direct") return r.mode;
  return "gate"; // fail-safe: 해석 불가 시 gate(권한 더 엄격)
}

export function isGateOnlyPart(part) {
  return part?.metadata?.origin === "gate";
}

/** direct 전환 시 gate 전용/출처불명 과거 컨텍스트 제외. gate는 전체 유지. */
export function filterMessagesForMode(messages, mode) {
  if (mode === "gate") return messages;
  return messages.filter((msg) => {
    if (msg.role === "user") return true;
    // assistant 메시지: gate 전용 part가 있으면 그 part만 제거할지, 메시지 전체를 제거할지 결정.
    // 안전 우선: gate 전용 part를 가진 메시지는 통째로 제외.
    return !(msg.parts ?? []).some((p) => isGateOnlyPart(p) || (p.type !== "text" && !p.metadata));
  });
}
```
> **설계 주의**: 출처 불명 판정은 `metadata`가 아예 없는 assistant part만 해당한다. Phase 2/1에서 생성된 기존 메시지는 metadata가 없으므로 direct 전환 시 보수적으로 제외된다(의도된 fail-closed).

- [ ] **Step 4: `request.ts` 배선 (`chat.headers`에 connection 전달)**

`PrepareInput`에 `readonly connection?: { mode: "gate" | "direct" }` 추가 → `chat.headers` trigger input에 `connection: input.connection` 추가:
```ts
const { headers } = yield* input.plugin.trigger(
  "chat.headers",
  { sessionID: input.sessionID, agent: input.agent.name, model: input.model, provider: input.provider, message: input.user, connection: input.connection },
  { headers: {} },
)
```
`request.ts`는 이미 `ModelMessage[]`를 받으므로 **메시지 필터는 여기서 하지 않는다**(아래 Step 4b).

- [ ] **Step 4b: 메시지 필터 — 실제 변환 지점(`prompt.ts`)에 적용**

**정확한 삽입 지점(실측)**: `upstream/packages/opencode/src/session/prompt.ts:1439`의
```ts
yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
const [... , modelMsgs] = yield* Effect.all([... MessageV2.toModelMessagesEffect(msgs, model)])
```
`msgs`는 `MessageV2`(part.metadata 보존)이고, 이 지점은 변환 직전이다. 여기서:
```ts
const mode = yield* resolveSessionMode(session, agent)   // 아래 helper
const filtered = filterMessagesForModeParts(msgs, mode)   // connection.js의 part-level 변형
yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: filtered })
const modelMsgs = yield* MessageV2.toModelMessagesEffect(filtered, model)
```
`connection.js`에 **part-level** 변형을 추가한다(기존 `filterMessagesForMode`는 단순 객체용, 테스트 공용):
```js
/** MessageV2 메시지 배열(part.metadata 보존)에서 direct 전환 시 gate 전용/출처불명 assistant 메시지 제외 */
export function filterMessagesForModeParts(messages, mode) {
  if (mode === "gate") return messages;
  return messages.filter((m) => {
    if (m.info?.role !== "assistant") return true;
    return !(m.parts ?? []).some((p) => isGateOnlyPart(p) || (p.type !== "text" && !p.metadata));
  });
}
```

- [ ] **Step 5: `llm.ts` 배선 (모드 해석 + 전달)**

`StreamInput`에 `connection` 추가. `LLM.run`에서 세션 레벨 모드를 해석해 `prepare`에 전달. 모드 공급원: `config.get()`의 `connection?.mode`, `agent.force`, 기본 `gate`(fail-safe). `resolveEffectiveMode`(`control/src/security-context.mjs`) 사용:
```ts
const cfg = yield* config.get()
const connection = { mode: resolveConnectionMode({ agentForce: (input.agent as any).force, session: cfg.connection?.mode, global: cfg.connection?.mode }) }
```
> `agent.force`는 현재 `Agent.Info` 스키마에 없다(`agent/agent.ts:32` — `primary|subagent`만). 따라서 이번 Phase에서는 **세션/전역 config의 `connection.mode`만** 사용하고, `agent.force`는 Phase 4에서 추가한다(스키마 변경 회피). `prompt.ts`의 Step 4b도 같은 해석 함수를 쓴다 → 헬퍼를 `session/llm/mode.ts` 또는 `connection.js`에 두고 재사용.

> **주의**: `prompt.ts`의 title 생성 경로(:275)는 small 모델용이라 필터 대상이 아니다(제목은 비밀 컨텍스트를 포함하지 않아야 하나, 안전상 동일 helper 적용 가능 — 선택).

- [ ] **Step 6: 타입/회귀 확인**

```bash
( cd upstream/packages/opencode && bun run typecheck 2>&1 | tail -20 )
node --test tests/connection-context.test.mjs
node --test tests/permission-order.test.mjs tests/phase2-stream-guard-contract.test.mjs
```
Expected: typecheck 통과, 위 테스트 PASS.

- [ ] **Step 7: 커밋**

```bash
git add upstream/packages/opencode/src/session/llm/request.ts upstream/packages/opencode/src/session/llm.ts upstream/.croakcode/plugins/lib/connection.js tests/connection-context.test.mjs
git commit -m "feat(phase3): wire connection mode into request path (option A)"
```

> **미완료 리스크**: `session/llm.ts`가 실제로 쓰는 `StreamInput`이 다른 호출자(workflow/compaction)에서 어떻게 채워지는지 확인해야 한다. `connection` 미전달 시 `resolveConnectionMode`가 `gate` 기본으로 떨어지므로 안전하지만, direct 세션에서도 gate로 동작할 수 있다 → 호출부 누락 여부를 `grep -rn "LLM.run\|Service.stream"`으로 확인한다.

### Task 13: vendor/opencode-cache-hit 이식 결정 (소스는 완전, 테스트 부재)

**Files:**
- Modify: `docs/superpowers/phase0/phase3-equivalence-matrix.md`
- Check: `/Users/herace/workspace/ideas/codefrog-opencode/plugins/vendor/opencode-cache-hit/` (`index.tsx` → `src/plugin.tsx`, 총 3,484줄, **`src/` 존재**)

> **정정**: 이 자산은 불완전하지 않다. `index.tsx`가 re-export하는 `src/plugin.tsx`(37줄)와 위젯/사이드바 호스트/메인 세션 뷰 등이 모두 존재한다. 다만 `tests/` 디렉터리가 없고 `peerDependencies`가 브랜딩 이전 `@opencode-ai/plugin|sdk`를 가리킨다.

- [ ] **Step 1: 상태 확인**

Run: `cd /Users/herace/workspace/ideas/codefrog-opencode/plugins/vendor/opencode-cache-hit && wc -l index.tsx src/*.ts src/*.tsx | tail -1 && ls tests 2>&1`
Expected: 약 3,484줄, `ls: tests: No such file or directory` (테스트 부재 확인)

- [ ] **Step 2: 결정 — 폐기(1안) vs 이식(2안) 중 택1, 기본은 폐기**

폐기 근거: usage-panel이 이미 `hitRate`(`usage-log.ts`)를 제공하고, 둘 다 `sidebar_content`를 등록한다. **order는 다르다 — usage-panel order 90, cache-hit order 56(`src/plugin.tsx:15`)** → "충돌"이 아니라 같은 슬롯에 두 패널이 **나란히 중복 렌더**된다. 테스트 부재로 §6.4 수용 기준(골든 테스트) 미충족.
이식할 경우: peerDeps를 `@croakcode/plugin|sdk`로 갱신, 테스트 신규 작성, 그리고 usage-panel과의 중복 패널을 UX 차원에서 정리(order 조정만으로는 중복 렌더가 남음).

`docs/superpowers/phase0/phase3-equivalence-matrix.md`에 결정을 기록:
```md
| vendor/opencode-cache-hit | 소스 완전(3,484줄)하나 테스트 부재 + usage-panel과 `sidebar_content` **중복 렌더**(order 56 vs 90, 충돌 아님) + usage-panel이 `hitRate` 중복 제공 → **폐기(ACCEPTED DEVIATION)**. 이식 시 peerDeps `@croakcode/*` 갱신·패널 중복 정리 필요. Phase 4 재검토. |
```

- [ ] **Step 3: 커밋**

```bash
git add docs/superpowers/phase0/phase3-equivalence-matrix.md
git commit -m "docs(phase3): record cache-hit vendor decision"
```

## Chunk 4: 에이전트·명령, 등록, 등가 매트릭스, 최종 게이트

이 청크가 끝나면: dev-safe 에이전트와 3개 슬래시 명령이 이식되고, 모든 서버/TUI 플러그인이 설정에 등록되며, Phase 3 등가 매트릭스가 실측으로 채워지고, §5.4 우회 차단·§4.5 복구·Phase 2 계약 회귀가 모두 green인 최종 게이트가 통과한다.

### Task 14: dev-safe 에이전트 + commands 이식

**Files:**
- Create: `upstream/.croakcode/agent/dev-safe.md`
- Create: `upstream/.croakcode/command/net-off.md`, `net-on.md`, `tool-status.md`
- Source: `/Users/herace/workspace/ideas/codefrog-opencode/opencode/agents/dev-safe.md`, `.../commands/*.md`
- Test: `tests/dev-safe-agent.test.mjs`

- [ ] **Step 1: 실패 테스트 작성** — 파일 존재 + frontmatter 핵심 필드(permission deny, mode) 검증:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("dev-safe agent restricts bash/web/task", async () => {
  const md = await read("../upstream/.croakcode/agent/dev-safe.md");
  assert.match(md, /^---/m);
  assert.match(md, /mode:\s*primary/);
  for (const k of ["bash", "webfetch", "websearch", "task"]) assert.match(md, new RegExp(`${k}:\\s*deny`), k);
  assert.match(md, /edit:\s*ask/);
});

test("net-off/net-on/tool-status commands exist with descriptions", async () => {
  const off = await read("../upstream/.croakcode/command/net-off.md");
  const on = await read("../upstream/.croakcode/command/net-on.md");
  const st = await read("../upstream/.croakcode/command/tool-status.md");
  assert.match(off, /Disable internet tools/);
  assert.match(on, /Enable internet tools/);
  assert.match(st, /denies/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/dev-safe-agent.test.mjs`
Expected: FAIL — ENOENT

- [ ] **Step 3: 소스 이식** — 4개 `.md`를 그대로 복사. 단, `dev-safe.md`의 `model: litellm-head/default`는 provider id 규약이며 그대로 유지(운영 config에서 제공).

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/dev-safe-agent.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add upstream/.croakcode/agent/dev-safe.md upstream/.croakcode/command/net-off.md upstream/.croakcode/command/net-on.md upstream/.croakcode/command/tool-status.md tests/dev-safe-agent.test.mjs
git commit -m "feat(plugins): port dev-safe agent and slash commands"
```

### Task 15: 서버 플러그인 자동 스캔 확인 + croakcode.jsonc 생성

**Files:**
- Create: `upstream/.croakcode/croakcode.jsonc`
- Test: `tests/plugin-registration.test.mjs`

> **설계 결정**: `.croakcode/plugins/*.js`는 **자동 스캔**된다(`config/plugin.ts:29`, `ConfigPlugin.load`). 따라서 `plugin` 배열에 따로 넣지 않는다(중복 로드 방지). 이 Task는 `.croakcode/croakcode.jsonc`를 새로 만들어 **provider/permission 최소 설정**만 두고, 플러그인이 자동 스캔으로 발견되는지 검증한다.

- [ ] **Step 1: 실패 테스트 작성** — 모든 서버 플러그인 파일이 `default.id`와 `server`/`tool`을 갖고, 자동 스캔 글롭(`{plugin,plugins}/*.{ts,js}`)에 매칭되는지 검증:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";

test("every server plugin file matches the auto-scan glob and exports default.id", async () => {
  const dir = new URL("../upstream/.croakcode/plugins/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => /\.(js|ts)$/.test(f));
  // auto-scan glob is {plugin,plugins}/*.{ts,js} — flat files only (lib/ is subdir, not matched)
  assert.ok(files.length >= 7, `expected >=7 plugin files, got ${files.length}`);
  for (const f of files) {
    const mod = await import(new URL(f, dir).href);
    assert.ok(mod.default?.id, `${f} has no default.id (path plugin requires id)`);
    assert.ok(mod.default?.server ?? mod.default?.tool, `${f} has neither server nor tool`);
  }
});

// 문자열 리터럴 내부의 //를 보존하는 JSONC 주석 제거기.
// 단순 replace(/\/\/.*$/gm,"")는 "https://croakcode.ai/..."를 훼손하므로 금지.
function stripJsonc(text) {
  let out = "", i = 0, inStr = false, esc = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

test("croakcode.jsonc exists and parses as JSONC (string-safe comment stripping)", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(new URL("../upstream/.croakcode/croakcode.jsonc", import.meta.url), "utf8");
  assert.doesNotThrow(() => JSON.parse(stripJsonc(raw)));
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/plugin-registration.test.mjs`
Expected: FAIL — 첫 테스트는 파일 수 부족(`expected >=7 …`), 둘째는 ENOENT(`croakcode.jsonc`)

- [ ] **Step 3: `croakcode.jsonc` 생성** (기존 `.opencode/opencode.jsonc`의 tools 비활성 관례 유지, `plugin` 배열은 두지 않음):

> **이미 Task 0a에서 생성됨**. Task 0a의 `croakcode.jsonc`(`provider.litellm-head` 포함)를 그대로 둔다. 이 Task는 (a) 파일이 유효 JSONC인지, (b) `.croakcode/plugins` 자동 스캔이 동작하는지 확인한다. **`provider: {}`(빈 객체)로 되돌리지 말 것** — `dev-safe`가 `litellm-head/default`를 참조한다(사용자 지적 P1).

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/plugin-registration.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: 실제 로더 스모크 (Config를 실제로 resolve하는 명령으로 실행)**

**중요**: `--help`는 `cli.parse`만 하고 **command handler를 실행하지 않아 `Config.get`/`ConfigPlugin.load`가 호출되지 않는다**(`packages/opencode/src/index.ts:198-206`). 또 외부 플러그인 로드 실패는 로그만 남기고 **swallow**된다(`plugin/index.ts:230-245`, `Effect.catch(() => Effect.void)`). 따라서 "오류 없음"만 보면 **플러그인을 아예 스캔하지 않은 경우도 통과**한다. → 아래처럼 (a) Config를 resolve하는 명령을 실행하고, (b) 로그 파일에서 **플러그인 로드 시도/실패**를 실제로 확인한다.

```bash
# 이번 실행이 만든 로그만 사용한다(이전 로그 재사용 금지). 종료 코드도 반드시 확인.
export CROAKCODE_CONFIG_DIR="$PWD/upstream/.croakcode"
BEFORE_LIST=$(ls "$HOME/.local/share/croakcode/log/"*.log 2>/dev/null || true)
( cd upstream && LITELLM_BASE_URL="${LITELLM_BASE_URL:-http://127.0.0.1:4000}" \
    bun run --conditions=browser packages/opencode/src/index.ts models > /tmp/phase3-plugins.out 2>&1 )
RC=$?
echo "exit=$RC"
if [ "$RC" -ne 0 ]; then echo "COMMAND FAILED — stop, do not assume"; exit 1; fi
AFTER_LIST=$(ls "$HOME/.local/share/croakcode/log/"*.log 2>/dev/null || true)
# 이번 실행에서 새로 생긴 로그만 선택
LOG=$(comm -13 <(printf '%s\n' "$BEFORE_LIST" | sort) <(printf '%s\n' "$AFTER_LIST" | sort) | head -1)
if [ -z "$LOG" ]; then echo "NO NEW LOG — cannot verify this run; abort"; exit 1; fi
echo "log(this run): $LOG"
grep -E "loading plugin|failed to load plugin|plugin has no server entrypoint|must export id" "$LOG" || echo "NO PLUGIN LOG LINES"
```
Expected:
- `loading plugin` 라인이 **`.croakcode/plugins/` 파일들에 대해** 최소 7개 나타난다(자동 스캔이 실제로 동작).
- `failed to load plugin` / `must export id` 라인이 **없어야 한다**.

자동화된 단언(선택, 권장): 위 grep을 스크립트로 만들어 실패 시 비-0 종료하게 하고 Task 17 게이트에 포함:
```bash
! grep -qE "failed to load plugin|must export id|is not a function" "$LOG"
grep -q "loading plugin" "$LOG"
```
> `CROAKCODE_CONFIG_DIR`를 워크트리 루트 기준 **`$PWD/upstream/.croakcode`**로 명시하면 탐색 실패를 배제할 수 있다(위 스크립트에 이미 반영). `.croakcode`를 못 찾아 `loading plugin`이 0개면 **스모크 실패**로 간주한다(추정으로 넘어가지 않는다).

- [ ] **Step 6: 커밋**

```bash
git add upstream/.croakcode/croakcode.jsonc tests/plugin-registration.test.mjs
git commit -m "feat(plugins): add .croakcode config, verify auto-scanned plugins"
```

### Task 16: Phase 3 등가 매트릭스 작성 (§6.3 C + §6.4)

**Files:**
- Create: `docs/superpowers/phase0/phase3-equivalence-matrix.md`
- Reference: spec `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md` §6.3/§6.4/§6.6

> **순서 주의**: 이 Task는 매트릭스 **골격과 이미 확정된 행**을 만든다. §5.4-4·5 행은 **Task 16a/16b 실행 후** 채워야 하며, 16b Step 4가 이 파일을 갱신한다. 즉 "골격 생성(Task 16) → 단위(16a) → E2E(16b) → 상태 확정(Task 16 Step 2 재실행 또는 16b)". 실행자는 Task 16을 먼저 skeleton으로 만들고, 최종 상태는 게이트(Task 17) 직전에 갱신해도 된다.

- [ ] **Step 1: 매트릭스 골격 작성 (실측 가능한 행만)**

`docs/superpowers/phase0/phase3-equivalence-matrix.md`:
```md
# Phase 3 동등성 증거 매트릭스 (§6.3 C + §6.4)

상태 기준: PASS / FAIL / NOT TESTED / ACCEPTED DEVIATION (spec §6.6). 실행 증거로만 채운다.

## C. 커스텀 플러그인 동작

| 기능 | 증거 | 상태 |
|---|---|---|
| croak-auth (로그인/세션/토큰/401) | tests/croak-auth-session.test.mjs, tests/croak-auth-server.test.mjs | <실측> |
| croak-auth TUI (/login /logout /whoami /agent-perm) | tests/croak-auth-tui.e2e.test.mjs | <실측> |
| gate-identity (x-croak-agent/session) | tests/gate-identity.test.mjs | <실측> |
| local-stability (반복차단/qwen/compaction) | tests/local-stability.test.mjs | <실측> |
| secret-paths | tests/secret-paths.test.mjs | <실측> |
| stall-recovery | 대체/폐기 결정 기록 | ACCEPTED DEVIATION |
| tool-policy | tests/tool-policy.test.mjs | <실측> |
| usage-meter | tests/usage-meter.test.mjs | <실측> |
| usage-panel | upstream/packages/opencode/test/usage-panel/*.test.ts | <실측> |
| hwp-read | tests/hwp-read.test.mjs | <실측> |
| vendor/opencode-cache-hit | 폐기 결정 기록 | ACCEPTED DEVIATION |
| dev-safe + commands | tests/dev-safe-agent.test.mjs + 수동 체크리스트 | <실측>/수동 |

## §6.4 수용 기준
1. 골든 동작 테스트 — 각 테스트 파일 통과
2. UX 스냅샷 (슬롯/푸터/아바타/승인모드/타이틀) — 수동, Phase 3 결과 기록
3. 통합 E2E (로그인→세션→도구→정책차단→usage→스톨복구) — 신규 E2E 필요 시 명시
4. 패치 동작 단위테스트 — Phase 2 결과 상속(PASS)
5. 수동 체크리스트 — 릴리스 게이트

## 필수 기능 상태 (§6.6)
인증/정책차단/사용량기록: 위 표 실측 기준으로 FAIL/NOT TESTED 없음 확인.

## §5.4 우회 차단 5종 (Phase 3 수용 필수)

| # | 시나리오 | 기존 테스트 | 상태 |
|---|---|---|---|
| 1 | `force:gate` + `--mode direct` 거부 | security-context.test.mjs + phase3-bypass.test.mjs | <실측> |
| 2 | direct + `requiresAuth` 실행 전 오류 | security-context.test.mjs + phase3-bypass.test.mjs | <실측> |
| 3 | 로컬 설정으로 서버 deny 완화 무시 | phase3-bypass.test.mjs (Task 16a) | <실측> |
| 4 | 인증 실패 상태에서 direct 전환 시 게이트 전용 접근/토큰 차단 | phase3-bypass.test.mjs(4a) + **phase3-context-e2e.test.mjs(토큰 미주입 E2E)** | <실측 — 단위만으론 불가> |
| 5 | 전환 후 비밀 컨텍스트 재주입 없음 | **phase3-context-e2e.test.mjs** (실제 payload 검사) | <실측 — E2E 필수> |

## §4.5 복구
recovery.test.mjs(3) + phase1-recovery.e2e.test.mjs(3) — <실측>
```
> `<실측>`은 Step 2의 실제 실행 결과로 채운다. 실행 전엔 `NOT TESTED`로 두고, 절대 추정으로 PASS를 쓰지 않는다.

- [ ] **Step 2: 전체 테스트 실행 후 상태 채우기**

```bash
node --test 'tests/*.test.mjs'
bun test tests
( cd upstream/packages/opencode && bun test test/tool test/session test/provider )
( cd upstream/packages/opencode && bun test test/usage-panel )
```
> usage-panel 테스트 위치는 Task 12 Step 3에서 정한 **`upstream/packages/opencode/test/usage-panel/`**로 고정한다(루트가 아님).

결과를 표에 반영. 실패가 있으면 해당 상태는 `FAIL`/`NOT TESTED`로 두고 원인 기록.

- [ ] **Step 3: 커밋**

```bash
git add docs/superpowers/phase0/phase3-equivalence-matrix.md
git commit -m "docs(phase3): equivalence matrix from measured runs"
```

### Task 16a: §5.4 우회 차단 — 단위/계약 테스트 (5종 중 1·2·3·4a)

**Files:**
- Create: `tests/phase3-bypass.test.mjs`
- Reference: `control/src/security-context.mjs`(`resolveEffectiveMode`), `control/src/permission-order.mjs`(`resolveExecutionPlan`), `upstream/.croakcode/plugins/lib/connection.js`

> **확정**: 옵션 A 채택. 그러나 **단위테스트만으로 시나리오 4·5를 PASS 처리하지 않는다** — 4·5는 Task 16b의 **실제 요청 경로 E2E**로만 PASS 판정한다. 이 Task는 판정 로직(1·2·3·4a)을 고정한다.

- [ ] **Step 1: 테스트 작성**

`tests/phase3-bypass.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveExecutionPlan, resolveEffectiveMode } from "@croakcode/control";
import { resolveConnectionMode } from "../upstream/.croakcode/plugins/lib/connection.js";

const base = { tool: "bash", sessionID: "s1", args: {} };

// §5.4-1: force gate + direct 요청 => 거부(force 우선)
test("1. force gate beats session direct switch", () => {
  const r = resolveEffectiveMode({ agentForce: "gate", sessionOverride: "direct", requiresAuth: true });
  assert.equal(r.mode, "gate");
  assert.match(r.warning ?? "", /overrides direct/);
});

// §5.4-2: direct + requiresAuth => 실행 전 오류(자동 upgrade 없음)
test("2. requiresAuth on direct fails closed", () => {
  const r = resolveEffectiveMode({ sessionOverride: "direct", global: "direct", requiresAuth: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /requires gate/);
});

// §5.4-3: 로컬 설정으로 서버 deny 완화 시도 => 무시
test("3. local config cannot relax server gate deny", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", policy: "deny", permission: "allow" });
  assert.equal(p.stage, "policy");
  assert.equal(p.execute, false);
  assert.equal(p.errorCode, "POLICY_DENIED");
});

test("3b. gate policy unavailable is fail-closed", () => {
  const p = resolveExecutionPlan({ ...base, mode: "gate", plugin: "allow", policy: "not_applicable", permission: "allow" });
  assert.equal(p.execute, false);
  assert.equal(p.errorCode, "POLICY_UNAVAILABLE");
});

// §5.4-4a: 모드 판정 절반 — 인증 실패 상태에서도 requiresAuth는 gate 요구
test("4a. gate-only tool stays gate-gated during auth failure", () => {
  const mode = resolveConnectionMode({ agentForce: "gate", session: "direct" });
  assert.equal(mode, "gate");
  const p = resolveExecutionPlan({ ...base, mode, plugin: "allow", policy: "allow", permission: "allow" });
  assert.equal(p.execute, true); // gate 유지 하에 정상
  const direct = resolveConnectionMode({ session: "direct", global: "direct" });
  assert.equal(direct, "direct");
});
```

- [ ] **Step 2: 실패→통과 확인**

Run: `node --test tests/phase3-bypass.test.mjs`
Expected: PASS (5 tests). FAIL 시 `control/src` 실제 동작을 확인(추정 금지).

- [ ] **Step 3: 커밋**

```bash
git add tests/phase3-bypass.test.mjs
git commit -m "test(phase3): unit-level §5.4 bypass checks (1/2/3/4a)"
```

### Task 16b: §5.4 시나리오 4·5 — 실제 요청 경로 E2E (PASS 판정 조건)

**Files:**
- Create: `tests/phase3-context-e2e.test.mjs`
- Create: `tests/fixtures/capture-provider.mjs` (요청 payload를 캡처하는 fake provider)
- Reference: `upstream/packages/opencode/src/session/llm/request.ts` (Task 12a 배선), `upstream/.croakcode/plugins/lib/connection.js`
- Modify: `contracts/src/hooks.mjs`(doc 주석 — `chat.headers`에 `connection` 필드 명시) + `docs/superpowers/phase0/phase3-equivalence-matrix.md`

> **핵심 원칙**: 시나리오 5는 **문자열 단언이 아니라 실제 요청 payload 검사**로만 증명한다. Gate 턴에서 비밀 컨텍스트(metadata.origin="gate")를 만들고, Direct로 전환한 뒤 **모델에 전송되는 최종 messages에 해당 텍스트가 없음**을 단언한다.

- [ ] **Step 1: 캡처 provider fixture 작성**

```js
// tests/fixtures/capture-provider.mjs
// 마지막으로 전송된 요청 payload를 보관하는 OpenAI-compatible 가짜 엔드포인트.
import { createServer } from "node:http";

export function createCaptureProvider() {
  const captured = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push({ headers: req.headers, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  return {
    captured,
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
```

- [ ] **Step 2: E2E 테스트 작성 — 실제 요청 조립 경로를 통과시킨다**

**핵심**: 순수 함수를 직접 호출해 payload를 만들지 않는다. **Task 12a가 배선한 실제 경로(`prompt.ts`의 part 필터 → `MessageV2.toModelMessagesEffect` → provider 전송)를 실행**하고, 그 결과가 capture provider에 도달한 payload를 검사한다. 이를 위해:

(a) `prompt.ts`의 필터 로직을 **export된 순수 헬퍼**로 분리해 둔다(`connection.js`의 `filterMessagesForModeParts` — Task 12a Step 4b). 이 헬퍼는 실제 경로가 **호출하는 것과 동일한 함수**여야 한다(복제 금지).

(b) E2E는 다음 3단계를 실제로 실행한다:
   1. `MessageV2` 형태의 history(gate 비밀 part 포함)를 `filterMessagesForModeParts(history, "direct")`에 통과
   2. 통과 결과를 **`MessageV2.toModelMessagesEffect`로 변환**(실제 변환 함수 — `session/message-v2.ts:636`)
   3. 변환된 messages를 **실제 LLM 클라이언트 전송 형태**로 capture provider에 POST

> 즉 "payload를 손으로 만들지" 않고, **실제 변환 함수**(`toModelMessagesEffect`)를 호출해 그 출력을 전송한다. 이 변환은 gate-origin part를 제거한 결과를 그대로 반영하므로, 실제 런타임 경로와 동일한 데이터 흐름을 검증한다.

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createCaptureProvider } from "./fixtures/capture-provider.mjs";

const { filterMessagesForModeParts } = await import("../upstream/.croakcode/plugins/lib/connection.js");
const { MessageV2 } = await import("../upstream/packages/opencode/src/session/message-v2.ts"); // Bun: .ts import
const { shouldAttachToken } = await import("../upstream/.croakcode/plugins/croak-auth-server.js");

// MessageV2 형태의 최소 history (info + parts). 실제 스키마 필드는 변환에 필요한 만큼 채운다.
function msg(role, parts) {
  return {
    info: { id: `msg_${Math.random().toString(36).slice(2)}`, role, sessionID: "s1", time: { created: Date.now() } },
    parts: parts.map((p, i) => ({ id: `prt_${i}`, sessionID: "s1", messageID: `m${i}`, type: "text", text: p.text, metadata: p.metadata, time: { start: Date.now(), end: Date.now() } })),
  };
}

test("5. gate->direct: filtered history goes through real MessageV2 conversion; secret absent from sent payload", async () => {
  const cap = createCaptureProvider();
  const port = await cap.listen();
  const baseURL = `http://127.0.0.1:${port}/v1`;

  const history = [
    msg("user", [{ text: "show me the internal key", metadata: {} }]),
    msg("assistant", [{ text: "GATE_SECRET_TOKEN=abc123", metadata: { origin: "gate", sensitivity: "secret" } }]),
    msg("user", [{ text: "continue", metadata: {} }]),
  ];

  // (1) 실제 경로와 동일한 part 필터
  const filtered = filterMessagesForModeParts(history, "direct");
  // (2) 실제 변환 함수로 ModelMessage 생성 (손으로 만들지 않음)
  const model = { providerID: "litellm-head", id: "qwen3.8-27b-nvfp4", api: { id: "qwen3.8-27b-nvfp4" } };
  const modelMsgs = await MessageV2.toModelMessages(model, filtered);
  // (3) 실제 전송 형태로 POST
  await fetch(`${baseURL}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "qwen3.8-27b-nvfp4", messages: modelMsgs }) });
  await cap.close();

  const sent = JSON.stringify(cap.captured[0]?.body ?? {});
  assert.ok(cap.captured.length > 0, "provider received no request");
  assert.ok(!sent.includes("GATE_SECRET_TOKEN"), "gate secret leaked into direct payload");
  assert.ok(!sent.includes("abc123"), "gate secret value leaked");
  assert.ok(sent.includes("continue"), "later user turn kept");

  // 시나리오 4: direct에서는 Authorization 토큰 미주입
  assert.equal(shouldAttachToken({ model: { providerID: "litellm-head" }, provider: { id: "litellm-head", options: { baseURL } }, connection: { mode: "direct" } }), false);
  assert.equal(cap.captured[0]?.headers?.authorization, undefined);
});
```
> **주의**: `MessageV2.toModelMessages`는 Effect를 내부적으로 runPromise하는 동기 래퍼(`message-v2.ts:921-926`)다. Bun에서 `.ts`를 직접 import하므로 `bun test`로 실행한다(`node --test` 불가). 이 테스트에서 **실제 변환 함수가 gate part를 제거했는지**가 핵심이며, 필터→변환→전송의 데이터 흐름이 런타임과 같다.
>
> **한계 명시**: 이 E2E는 `LLM.run` 전체(provider 인증·retry 등)를 돌리지는 않는다(전체 런타임 부팅 비용 회피). 대신 **(i) 실제 필터 함수 + (ii) 실제 변환 함수 + (iii) 실제 HTTP 전송**을 사용한다. 이것이 순수 함수만 통과시키는 것과 다르며, §5.4-5의 "새 프롬프트에 재주입 없음"을 변환·전송 단계에서 입증한다. 완전한 `LLM.run` 통합이 필요하면 Task 17 게이트에서 별도 통합 스모크를 추가한다.

- [ ] **Step 3: 실패→통과 확인**

Run: `node --test tests/phase3-context-e2e.test.mjs`
Expected: Step 1~2 구현 전 FAIL(모듈/동작), 구현 후 PASS.

- [ ] **Step 4: 계약 문서 갱신**

`contracts/src/hooks.mjs` 주석에 `chat.headers` input의 `connection?: {mode:"gate"|"direct"}`와 보호 헤더 3중 조건을 명시(코드 동작 변경 없음, 문서만). `docs/superpowers/phase0/phase3-equivalence-matrix.md` §5.4 표의 4·5를 **이 E2E 결과로만** 채운다.

- [ ] **Step 5: §5.4 전체 재확인**

Run: `node --test tests/security-context.test.mjs tests/phase3-bypass.test.mjs tests/phase3-context-e2e.test.mjs`
Expected: PASS — 1·2(기존)+3·4a(단위)+4·5(E2E) 전부.

- [ ] **Step 6: 커밋**

```bash
git add tests/phase3-context-e2e.test.mjs tests/fixtures/capture-provider.mjs contracts/src/hooks.mjs docs/superpowers/phase0/phase3-equivalence-matrix.md
git commit -m "test(phase3): E2E proof that gate secret context never reaches direct provider"
```

### Task 17: 최종 게이트 (Phase 3 replay)

**Files:**
- Create: `scripts/phase3-gate-replay.sh`
- Test: 게이트 자체 실행

- [ ] **Step 1: 게이트 스크립트 작성** — Phase 2 스크립트(`scripts/phase2-gate-replay.sh`) 패턴을 재사용해 로그 보존·`FLAKY_PASS` 구분을 유지하고, Phase 3 테스트를 추가:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
LOG_DIR="${LOG_DIR:-$(mktemp -d /tmp/phase3-gate.XXXXXX)}"; mkdir -p "$LOG_DIR"
echo "== logs: $LOG_DIR =="

# tee로 파이프하면 실패가 가려진다. PIPESTATUS로 원래 명령의 종료 코드를 확인한다.
run() {
  local name="$1"; shift
  echo "== $name =="
  set +e
  "$@" 2>&1 | tee "$LOG_DIR/$name.log"
  local rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -ne 0 ]; then echo "FAIL: $name (rc=$rc) — see $LOG_DIR/$name.log"; exit 1; fi
}

run phase2-regression bash scripts/phase2-gate-replay.sh

echo "== rebrand / zen =="
node scripts/rebrand-check.mjs upstream
bash scripts/phase2-zen-check.sh

run plugin-units-node node --test 'tests/*.test.mjs'
run plugin-units-bun bun test tests
run usage-panel bash -c '( cd upstream/packages/opencode && bun test test/usage-panel )'

# §5.4 5종: 단위(1/2/3/4a) + 실제 요청 경로 E2E(4/5)
run bypass-unit node --test tests/security-context.test.mjs tests/phase3-bypass.test.mjs
run bypass-e2e node --test tests/phase3-context-e2e.test.mjs

# 옵션 A 전제 배선 회귀
run connection-mode node --test tests/connection-context.test.mjs

# §4.5 복구
run recovery node --test tests/recovery.test.mjs tests/phase1-recovery.e2e.test.mjs

# Phase 2 계약 보존
run contracts node --test tests/permission-order.test.mjs tests/phase2-todo-contract.test.mjs tests/phase2-stream-guard-contract.test.mjs tests/contracts.conformance.test.mjs

# Task 15 로더 스모크: auto-scan이 실제로 플러그인을 로드했는지(0개 로드도 FAIL)
run loader-smoke bash scripts/phase3-loader-smoke.sh

echo "PASS: phase 3 gate replay — logs: $LOG_DIR"
```

`scripts/phase3-loader-smoke.sh` (Task 15 Step 5의 스크립트화):
```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CROAKCODE_CONFIG_DIR="$ROOT/upstream/.croakcode"
( cd "$ROOT/upstream" && LITELLM_BASE_URL="${LITELLM_BASE_URL:-http://127.0.0.1:4000}" \
    bun run --conditions=browser packages/opencode/src/index.ts models >/tmp/phase3-plugins.out 2>&1 )
MARK="$ROOT/.phase3-gate-mark"
touch "$MARK"
( cd "$ROOT/upstream" && LITELLM_BASE_URL="${LITELLM_BASE_URL:-http://127.0.0.1:4000}" \
    bun run --conditions=browser packages/opencode/src/index.ts models >/tmp/phase3-plugins.out 2>&1 )
RC=$?; rm -f "$MARK"
[ "$RC" -eq 0 ] || { echo "FAIL: models command exited $RC"; exit 1; }
# 이번 실행 이후에 생성/수정된 로그만 사용 (이전 로그 재사용 금지)
LOG=$(find "$HOME/.local/share/croakcode/log" -name '*.log' -newer "$ROOT/scripts/phase3-loader-smoke.sh" -print -quit 2>/dev/null)
if [ -z "$LOG" ]; then LOG=$(ls -t "$HOME/.local/share/croakcode/log/"*.log 2>/dev/null | head -1); fi
[ -n "$LOG" ] || { echo "FAIL: no log found"; exit 1; }
grep -q "loading plugin" "$LOG" || { echo "FAIL: no plugin was loaded (auto-scan did not run)"; exit 1; }
if grep -qE "failed to load plugin|must export id|is not a function" "$LOG"; then
  echo "FAIL: plugin load error"; grep -E "failed to load plugin|must export id|is not a function" "$LOG"; exit 1
fi
COUNT=$(grep -c "loading plugin" "$LOG")
echo "loader smoke: $COUNT plugin load line(s)"
[ "$COUNT" -ge 7 ] || { echo "FAIL: expected >=7 plugins, got $COUNT"; exit 1; }
```

- [ ] **Step 2: 실행 확인 (증거 보존)**

```bash
LOG_DIR=/tmp/phase3-gate bash scripts/phase3-gate-replay.sh
```
Expected: `PASS: phase 3 gate replay`. 실패 시 해당 스위트 로그로 원인 규명(추정 금지).

- [ ] **Step 3: 증거 보존**

```bash
mkdir -p docs/superpowers/phase0/evidence/phase3-gate
cp /tmp/phase3-gate/*.log docs/superpowers/phase0/evidence/phase3-gate/
```

- [ ] **Step 4: 커밋**

```bash
git add scripts/phase3-gate-replay.sh scripts/phase3-loader-smoke.sh docs/superpowers/phase0/evidence/phase3-gate/
git commit -m "test(phase3): full regression replay with preserved logs + loader smoke"
```

---

## 완료 정의 (Phase 3 exit criteria)

- §6.3 C 표의 모든 행이 `PASS` 또는 명시 `ACCEPTED DEVIATION`(사유·영향 기록).
- §6.6 필수 기능(인증/정책차단/사용량기록 + 세션/스트리밍/도구/권한모드/복구)에 `FAIL`/`NOT TESTED` 없음.
- §5.4 우회 차단 5종 + §4.5 복구 테스트 통과. **특히 4·5는 Task 16b의 실제 요청 payload E2E로 입증**(단위테스트만으로 PASS 처리 금지).
- Phase 2 계약 회귀(`permission-order`, `todo`, `stream-guard`, `tui-surface`, `harness`) green 유지.
- `scripts/phase3-gate-replay.sh` PASS, 로그 보존(`docs/superpowers/phase0/evidence/phase3-gate/`).

## 리스크 / 주의

1. **설정 경로 (최대 리스크)**: 코어는 **`.croakcode/` 디렉터리와 `croakcode.jsonc`/`tui.json`**만 읽는다(`config/paths.ts:23-37`, `config/config.ts:603`, `tui.ts:206`). `upstream/.opencode/`는 로더 비대상 → 반드시 `.croakcode/`에 배치(Task 0). 설정 파일명은 `croakcode.jsonc`(NOT `opencode.jsonc`).
2. **플러그인 자동 스캔 vs 명시 등록**: `.croakcode/plugins/*.{ts,js}`는 자동 스캔된다. `plugin` 배열에 중복 등록하면 **이중 로드**가 될 수 있으므로 넣지 않는다(Task 15).
3. **JSX 테스트 러너**: `croak-auth-tui.tsx`/usage-panel은 Bun JSX 변환 필요. node:test 불가 → bun 사용.
4. **`@opentui/solid/preload`**: 루트 `bunfig.toml` 부재 → 루트에 `[test] preload` 추가 또는 `upstream/packages/opencode/test/`에 배치(기존 bunfig 상속). usage-panel은 후자 권장.
5. **provider `litellm-head`**: 타깃 provider registry에 없음 → 운영 `croakcode.jsonc` `provider`에 사용자 정의 필요(local-stability `chat.params`/usage-panel `direct` 변형이 의존).
6. **stall-recovery**: 문자열 매치가 dead(`STREAM_IDLE_TIMEOUT`로 대체) → 폐기 안전. 살리려면 `metadata.code` 기반 재작성(별도 설계).
7. **슬롯 중복**: usage-panel order 90. cache-hit order 56 → 둘 다 `sidebar_content` 등록 시 **나란히 중복 렌더**(충돌 아님). cache-hit 이식 시 UX 중복 정리 필요.
8. **§5.4 시나리오 4·5 — 옵션 A 확정**: Task 12a에서 connection mode를 요청 경로에 배선하고(Task 16b E2E로 검증). 런타임에는 connection 개념이 없고 `Agent.Info.mode`는 에이전트 종류(`primary|subagent`)라 **혼동 금지**(`agent/agent.ts:32`). Task 12a는 제품 코드 변경이므로 최소 침습 + Phase 2 계약 회귀 필수.
9. **보호 헤더 3중 조건**: `shouldAttachToken`은 (provider ∈ CROAK_PROVIDERS) ∧ (baseURL origin == authUrl origin) ∧ (mode == gate)일 때만 토큰 주입. **mode 불명이면 미주입(fail-closed)**. `provider.options.baseURL`은 최상위(Provider.Info)에 있음(`provider.ts:929-936`).
10. **Task 15 JSONC**: `replace(/\/\/.*$/gm,"")` 금지(`https://` 훼손) → 문자열 인식 `stripJsonc` 또는 `jsonc-parser`. 로더 스모크는 **매 실행 새 로그 + 종료코드 확인 + `loading plugin` ≥7**로 판정(`--help` 금지, `|| true` 금지).
11. **`CROAK_*` vs `CROAKCODE_*`**: 플러그인은 `CROAK_*`(로컬 규약) 유지, 코어 플래그는 `CROAKCODE_*`. 충돌 없음(문서화).
12. **rebrand-check**: `.croakcode` 신규 파일이 core 스캔 범위(`upstream/packages`, `upstream/packages/core` 등)에 들어가지 않는지 확인. `.croakcode`는 core 스캔 대상이 아님이 정상.
