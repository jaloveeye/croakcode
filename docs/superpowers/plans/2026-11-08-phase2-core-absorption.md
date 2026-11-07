# croakcode Phase 2 — 코어 독립화 및 기존 동작 흡수 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers/subagent-driven-development (if subagents available) or superpowers/executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1이 남긴 4가지 부채(zen/console 물리 제거, 슬롯+permission.mode 계약 승격, 권한 기반 동적 하네스/스킬 할당, TUI TODO 동기화, compaction idle guard)를 완료하고, upstream 자체 테스트 스냅샷을 정상화해 §8.3 완료 조건(§6의 A+B 매트릭스 PASS)을 만족한다.

**Architecture:** upstream 코어를 재구현하지 않는다. 변경은 전부 **기존 실행 경로의 제거/게이트 추가 + contracts 계약 승격**이다. contracts(`contracts/src/*.mjs`)는 Phase 0/1 계약을 깨지 않고 **추가**만 한다. 모든 새 기능은 §3.4 실행 순서(fail-closed)를 위반하지 않아야 한다.

**Tech Stack:** Bun 1.3.14, TypeScript, Effect, Drizzle SQLite(upstream), `node:test`+`node:assert/strict`(croakcode 계약 테스트).

**Spec:** `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md` — §8.3(Phase 2 완료 조건), §4.7(동적 하네스), §4.8(TODO 동기화), §4.9(compaction guard), §3.4(실행 순서), §4.2(이벤트), §4.5(복구).

**Prerequisite:** Phase 1 게이트 완료. `docs/superpowers/phase0/phase1-gate.md` 전 항목 `[x]`. 브랜치 `phase1-upstream-skeleton` HEAD `328f911`, 45/45 node·bun 통과.

**Worktree:** `.worktrees/phase2-core-absorption` (branch `phase2-core-absorption`), `phase1-upstream-skeleton`에서 분기.

**Scope note (검증된 사실 — 서브에이전트 조사 결과 반영):**
- **"zen provider"는 별도 객체가 아니라 provider id `"opencode"` 하나다.** `"opencode-go"`는 provider가 아니라 **tier 문자열**(TUI/retry에만 존재). `"zen"`은 테스트 fixture id로만 등장(실 provider 없음).
- provider id `"opencode"`는 **10곳에 독립 하드코딩**되어 있다: `core/src/provider.ts:10`, `core/src/plugin/provider/index.ts:23,55`, `opencode/src/provider/schema.ts:12`, `opencode/src/provider/provider.ts:183,1799`, `opencode/src/provider/transform.ts:1082,1163`, `opencode/src/tool/registry.ts:60`. **단일 스위치가 없다** → 제거 Task는 이 지점을 모두 순회해야 한다.
- `webSearchEnabled`(`registry.ts:59-61`)는 `ProviderID.opencode`에 **하드 의존**한다. zen을 빼면 이 게이트를 교체해야 한다(현재 exa/parallel도 함께 허용하므로 `opencode`만 빼면 됨).
- **permission mode는 서버에 전송·영속되지 않는다**(client-local signal). spec §4.4의 `sessions.permission_mode TEXT`는 아직 미구현. `api.permission.mode`는 **읽기 전용**(setter 없음).
- **permission mode와 세션 `permission`은 다른 것**: 세션에 저장되는 건 `Permission.Ruleset`(도구별 allow/ask/deny)이고, `PermissionMode`("ask"|"auto")는 승인 다이얼로그 자동응답 여부다. 계획에서 혼동 금지.
- **도구 레벨 permission 필터는 없다.** `ToolRegistry.tools()`는 provider/model 기준 필터만 하고(`registry.ts:316-361`), 실제 차단은 `ctx.ask` 실행 시점뿐. 단, `describeTask`에는 task 서브에이전트 deny 필터가 있고(`registry.ts:304`), **스킬은 이미 deny 필터가 존재**(`skill/index.ts:306-311`, `system.ts:66`) → §4.7은 "도구 레벨 게이트가 없다"가 출발점.
- **TODO는 이미 전용 SQLite 테이블**(`session.sql.ts:93-109` `TodoTable`)에 영속되고 `todo.updated` 이벤트를 발행한다(`session/todo.ts:59`). §4.8의 "SSOT 승격"은 **이미 절반 구현됨**. 없는 것은: `linkedToolCalls` 필드, 턴 종료 정합성 검사, `session.todo.inconsistent` 이벤트, 서브세션 격리 표시.
- **TUI 사이드바에 TODO 패널이 없다** — `sidebar_content` 슬롯을 통한 플러그인 전용(`api.state.session.todo()`). `routes/session/index.tsx:2342-2360`은 도구 파트 렌더만 한다.
- **compaction 경로에 타임아웃이 없다.** `compaction.process`(`compaction.ts:344`)는 `processor.process`를 그대로 호출. `provider.ts:94-96`은 **헤더 수신 전** 타임아웃만, `options.timeout`은 사용자 설정 시에만. → 본문 idle guard는 신규 구현.
- **upstream 도움말 스냅샷이 깨져 있다**: `test/cli/help/__snapshots__/help-snapshots.test.ts.snap`에 리터럴 `opencode`가 남아 `cc` 리브랜딩과 불일치. Phase 2 첫 작업으로 재생성.

---

## File Structure (Phase 2)

```
croakcode/
├── upstream/                      ← Phase 1 흡수본 (변경 대상)
│   └── packages/
│       ├── core/src/              ← provider 카탈로그, 플러그인
│       └── opencode/src/          ← provider 로딩, TUI, 세션, 도구, 스킬
├── contracts/                     ← 계약 추가(기존 export 불변)
│   ├── src/index.mjs
│   ├── src/harness.mjs            ← 신규 (§4.7)
│   ├── src/todo-sync.mjs          ← 신규 (§4.8)
│   ├── src/stream-guard.mjs       ← 신규 (§4.9)
│   └── src/tui-surface.mjs        ← 신규 (0006/0007 승격)
├── control/                       ← Phase 0 불변(필요 시 순수함수 추가만)
├── tests/                         ← Phase 1 45개 + Phase 2 신규
├── scripts/
│   ├── rebrand-check.mjs          ← Phase 1 확장 + Phase 2 잔여 0건 요구
│   └── phase2-gate-replay.sh      ← 전체 회귀 일괄 실행
└── docs/superpowers/
    ├── plans/2026-11-08-phase2-core-absorption.md   ← 이 파일
    └── phase0/phase2-gate.md                        ← 신규
```

**의존 규칙:** `upstream`은 croakcode 루트 `contracts`/`control`을 import하지 않는다(Phase 1과 동일). 신규 contracts는 **타입·상수 descriptor**로, upstream 런타임이 아니라 croakcode 계약 테스트가 소비한다. Phase 2에서 upstream에 실제 연결하는 것은 **compaction idle guard 하나**(런타임 기능)이고, 나머지(하네스/TODO 계약/슬롯 descriptor)는 contracts + upstream 내부 구현으로 둔다.

---

## Chunk 1: upstream 스냅샷·잔여 브랜딩 정상화

### Task 1: upstream 도움말 스냅샷 재생성

**Files:**
- Modify: `upstream/packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap`

> Phase 1에서 `scriptName("cc")`로 바꿔 스냅샷이 무효화됐다. 이후 모든 Phase 2 회귀에서 upstream 테스트를 돌릴 수 있어야 하므로 가장 먼저 고친다.

- [ ] **Step 1: 현 상태 확인**

Run: `cd upstream/packages/opencode && bun test test/cli/help/help-snapshots.test.ts 2>&1 | tail -20`
Expected: 스냅샷 불일치로 실패(최소 1 fail). 실패가 없으면 이미 정상이므로 이 Task를 건너뛴다.

- [ ] **Step 2: 스냅샷 재생성**

Run: `cd upstream/packages/opencode && bun test test/cli/help/help-snapshots.test.ts -u 2>&1 | tail -10`
Expected: `-u`로 갱신 후 마지막에 0 fail.

- [ ] **Step 3: 잔여 브랜딩 검사**

Run: `grep -c 'opencode' upstream/packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap`
Expected: `0`. 0이 아니면 `cc` 리브랜딩이 help 출력에서 빠진 것이므로 `src/index.ts`의 명령 등록을 재확인한다.

- [ ] **Step 4: 커밋**

```bash
git add upstream/packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap
git commit -m "test(upstream): regenerate help snapshots for cc scriptName"
```

### Task 2: Phase 1 core 밖의 브랜딩 잔여분 정리 (deferred 161건)

**Files:**
- Modify: `scripts/rebrand-check.mjs`
- Modify: `upstream/packages/{app,web,console,desktop,enterprise,stats,docs}/**` (해당분)
- Modify: `upstream/.opencode/**` (fixture)
- Modify: `upstream/github/**`, `upstream/infra/**`

> Phase 1은 core 패키지만 blocking으로 두고 나머지 161건을 DEFERRED로 보고했다. Phase 2에서는 **전체를 blocking**으로 올린다. 단, `packages/console`과 `packages/web`은 **제품 범위 밖(Phase 4)** 이므로 이번에는 **삭제 대상 판단**을 먼저 한다.

- [ ] **Step 1: 잔여 목록 확보**

Run: `node scripts/rebrand-check.mjs upstream 2>&1 | grep 'DEFERRED'`
Expected: `DEFERRED: <n> hits ...` — n을 기록한다(Phase 1 기준 161).

- [ ] **Step 2: console/web 처리 방침 확정**

Phase 4에서 게이트/관리웹은 croakcode가 새로 만든다. upstream `packages/console`(SaaS 백엔드)·`packages/web`(마케팅/랜딩)은 croakcode 제품에 불필요하므로 **upstream 트리에서 제거**한다. 제거 시 workspace `package.json`에서도 뺀다.

```bash
git rm -r upstream/packages/console upstream/packages/web
```

그리고 `upstream/package.json`의 `workspaces`에서 두 항목을 제거한다. `upstream/packages/app`이 `packages/web`을 참조하는지 확인하고, 참조가 있으면 함께 정리한다(Step 3).

Run: `grep -rn '"web"\|packages/web' upstream/package.json upstream/packages/*/package.json | grep -v node_modules`
Expected: 남은 참조 0건. 있으면 해당 참조를 제거한다.

- [ ] **Step 3: 나머지 브랜딩 치환**

Run: `node scripts/rebrand-check.mjs upstream 2>&1 | grep '^ - upstream/' | head -20`
Expected: 실제 파일 목록을 얻는다. 다음 규칙으로 치환한다(자동 스크립트 권장, 수동 검수 필수):
- `https://opencode.ai/*` → `https://croakcode.ai/*`
- `.opencode/` → `.croakcode/`, `opencode.json(c)` → `croakcode.json(c)`
- 텔레메트리 key `opencode.*` → `croakcode.*`
- `.opencode/` fixture 파일은 **디렉터리 이름도** 옮긴다: `git mv upstream/.opencode upstream/.croakcode`

- [ ] **Step 4: rebrand-check를 전체 blocking으로 변경**

`scripts/rebrand-check.mjs`에서 `CORE_PREFIXES` 기반 분기를 제거하고 모든 파일을 `bad`로 모은다. 단 `packages/opencode/package.json`·`packages/core/package.json`의 `"name": "opencode"`는 `ALLOW_PKG_NAMES`로 계속 허용한다(workspace:* 의존).

Run: `node scripts/rebrand-check.mjs upstream`
Expected: `PASS: no disallowed upstream branding outside NOTICE/attribution` (DEFERRED 출력 없음). FAIL이면 남은 파일을 치환한다. **NOTICE/LICENSE의 upstream 고지는 예외로 유지**(MIT 의무).

- [ ] **Step 5: typecheck + 커밋**

Run: `cd upstream && bun install --ignore-scripts && bun run typecheck 2>&1 | tail -4`
Expected: `Tasks: N successful, N total`, 실패 0. console/web 제거로 프로젝트 수가 줄어드는 것이 정상이다.

```bash
git add -A upstream scripts/rebrand-check.mjs
git commit -m "feat(upstream): remove console/web packages and complete rebrand sweep"
```

---

## Chunk 2: zen/console provider 물리 제거 (§4.7의 입력 조건)

### Task 3: provider 카탈로그에서 `"opencode"` 제거

**Files:**
- Delete: `upstream/packages/core/src/plugin/provider/opencode.ts`
- Delete: `upstream/packages/core/test/plugin/provider-opencode.test.ts`
- Modify: `upstream/packages/core/src/plugin/provider/index.ts`
- Modify: `upstream/packages/core/src/provider.ts`
- Modify: `upstream/packages/opencode/src/provider/schema.ts`
- Modify: `upstream/packages/opencode/src/provider/provider.ts`
- Modify: `upstream/packages/opencode/src/provider/transform.ts`
- Modify: `upstream/packages/opencode/src/tool/registry.ts`

> `"opencode"`는 zen 전용 provider다. croakcode는 croak-gate 또는 OpenAI 호환 direct만 쓴다. **한 곳이라도 남으면 기본 모델 정렬(`big-pickle`)이 zen을 고르려 하므로 전 지점을 순회해야 한다.**

- [ ] **Step 1: 플러그인 등록 제거**

`upstream/packages/core/src/plugin/provider/index.ts`에서 `OpencodePlugin` import(23행)와 배열 항목(55행)을 제거한다.

```bash
git rm upstream/packages/core/src/plugin/provider/opencode.ts
git rm upstream/packages/core/test/plugin/provider-opencode.test.ts
```

Run: `grep -rn 'OpencodePlugin' upstream/packages --include='*.ts' | grep -v node_modules`
Expected: 0건.

- [ ] **Step 2: ProviderV2.ID / ProviderID static 제거**

- `core/src/provider.ts:10`의 `opencode: schema.make("opencode")` 제거.
- `opencode/src/provider/schema.ts:12`의 동일 항목 제거.

Run: `grep -rn 'ProviderID\.opencode\|ProviderV2\.ID\.opencode' upstream/packages --include='*.ts' | grep -v node_modules`
Expected: 아래 Step 3·4에서 다룰 곳만 남는다(먼저 이 목록을 기록한다).

- [ ] **Step 3: provider.ts에서 커스텀 로더 제거 + small-model 우선순위 정리**

- `provider.ts:183-205`의 `opencode:` 커스텀 로더 항목 삭제.
- `provider.ts:1799`의 `if (providerID.startsWith("opencode"))` 우선순위 블록 삭제 또는 제거.
- `provider.ts:1875` 근처 기본 모델 정렬에서 zen 모델명(`big-pickle`) 의존이 있으면, gate/direct 모델 기준으로 교체한다(없으면 그대로).

Run: `grep -n 'big-pickle\|startsWith("opencode")\|opencode:' upstream/packages/opencode/src/provider/provider.ts`
Expected: 0건(또는 의도적으로 남긴 것만, 주석으로 이유 기재).

- [ ] **Step 4: transform.ts의 zen 전용 분기 제거**

- `transform.ts:1082`의 `input.model.providerID === "opencode"` 분기 제거. **같은 줄에 `baseten`이 함께 있으므로 `baseten` 조건은 반드시 보존**한다.
- `transform.ts:1163`의 `startsWith("opencode")` 분기 제거.

Run: `grep -n '"opencode"' upstream/packages/opencode/src/provider/transform.ts`
Expected: 0건. `baseten` 분기 존재 확인: `grep -c baseten ...` ≥ 1.

- [ ] **Step 5: `registry.ts`의 webSearch 게이트 교체**

`registry.ts:59-61`의 `webSearchEnabled`에서 `providerID === ProviderID.opencode`를 제거하고 `exa`/`parallel`만 남긴다(또는 gate 모드면 항상 허용하도록 §5 정책에 위임 — Phase 2는 후자 금지, 단순 제거).

Run: `grep -n 'ProviderID\.opencode' upstream/packages/opencode/src/tool/registry.ts`
Expected: 0건.

- [ ] **Step 6: typecheck + 관련 테스트 + 커밋**

Run: `cd upstream && bun run typecheck 2>&1 | tail -4`
Expected: 실패 0.

Run: `cd upstream/packages/opencode && bun test test/provider/ test/tool/registry.test.ts 2>&1 | tail -8`
Expected: provider-opencode 관련 테스트가 없으므로 pass. 실패가 있으면 `ProviderID.opencode` 참조 잔여분을 수정한다.

```bash
git add -A upstream
git commit -m "feat(upstream): remove zen provider (id opencode) from catalog, loaders, and transforms"
```

### Task 4: zen tier/upsell UI·retry 경로 제거

**Files:**
- Modify: `upstream/packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx`
- Modify: `upstream/packages/opencode/src/cli/cmd/tui/component/dialog-retry-action.tsx`
- Modify: `upstream/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- Modify: `upstream/packages/opencode/src/cli/cmd/providers.ts`
- Modify: `upstream/packages/opencode/src/session/retry.ts`
- Modify: `upstream/packages/ui/src/components/provider-icons/types.ts`
- Modify: `upstream/packages/opencode/test/session/retry.test.ts`

> `"opencode-go"`는 provider가 아니라 **구독 tier 문자열**이다. provider를 지워도 TUI/retry에 남아 있으면 "Go 구독" 안내가 계속 뜬다.

- [ ] **Step 1: TUI provider 다이얼로그 정리**

`dialog-provider.tsx`에서 다음을 제거:
- `PROVIDER_PRIORITY`의 `opencode: 0`(20행), `"opencode-go": 1`(21행)
- 설명 맵의 `opencode`(58행), `"opencode-go"`(61행)
- `ApiMethod` 설명 블록의 `opencode:`(365행, `.../zen` 링크 포함), `"opencode-go":`(376행)

Run: `grep -n 'opencode-go\|opencode:' upstream/packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx`
Expected: 0건.

- [ ] **Step 2: retry-action의 Go 처리 제거**

`dialog-retry-action.tsx`에서 `GO_URL`(10행), `showGoTreatment`(43행) 및 이에 gated된 `BgPulse` 렌더(72-74, 104…)를 제거한다. 일반 다이얼로그 동작은 유지.

Run: `grep -n 'GO_URL\|showGoTreatment' upstream/packages/opencode/src/cli/cmd/tui/component/dialog-retry-action.tsx`
Expected: 0건.

- [ ] **Step 3: 세션 화면의 upsell 제거**

`routes/session/index.tsx`에서 `GO_UPSELL_PROVIDERS`(104행), `goUpsellKeys`(105-122행), KV key(99-103행), retry 리스너(349-365행)와 `DialogRetryAction` import(90행)를 제거한다. 단 `DialogRetryAction`이 Go와 무관한 재시도에도 쓰이면 **import는 유지**하고 Go 분기만 지운다.

Run: `grep -n 'GO_UPSELL\|goUpsell' upstream/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
Expected: 0건.

- [ ] **Step 4: CLI providers.ts 정리**

`providers.ts`의 `priority` 맵 `opencode: 0`(369행), 힌트 `opencode: "recommended"`(396행), `if (provider === "opencode")` 블록(463-465행)을 제거.

Run: `grep -n 'opencode' upstream/packages/opencode/src/cli/cmd/providers.ts`
Expected: 0건.

- [ ] **Step 5: retry.ts의 Go/free-tier 분기 제거**

`session/retry.ts`에서 `GO_UPSELL_MESSAGE`(9행), `GO_UPSELL_URL`(10행), FreeUsageLimit/GoUsageLimit action 분기(75-120행)를 제거하고 일반 재시도 메시지(121행)만 남긴다.

Run: `grep -n 'GO_UPSELL\|GoUsageLimit\|FreeUsageLimit' upstream/packages/opencode/src/session/retry.ts`
Expected: 0건.

- [ ] **Step 6: provider 아이콘·테스트 정리**

`ui/src/components/provider-icons/types.ts`의 `"opencode"`(37행), `"opencode-go"`(38행) 제거. `test/session/retry.test.ts`의 Go-limit 테스트(300-345행 근처) 제거.

Run: `cd upstream/packages/opencode && bun test test/session/retry.test.ts 2>&1 | tail -5`
Expected: 삭제한 케이스 수만큼 총계가 줄고 0 fail.

- [ ] **Step 7: typecheck + 커밋**

Run: `cd upstream && bun run typecheck 2>&1 | tail -4`
Expected: 실패 0.

```bash
git add -A upstream
git commit -m "feat(upstream): remove zen subscription tier from TUI, retry, and provider list"
```

### Task 5: 제거 검증 계약 테스트

**Files:**
- Create: `tests/phase2-zen-removal.test.mjs`
- Create: `scripts/phase2-zen-check.sh`

> "지웠다"를 **소스 검사로 증명**한다. 런타임 테스트는 upstream 모듈 로딩 비용이 크므로 정적 검사가 적절하다.

- [ ] **Step 1: 검사 스크립트**

`scripts/phase2-zen-check.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0
check_absent() {
  local pat="$1" desc="$2"
  if grep -rn "$pat" upstream/packages --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | grep -qv 'baseten'; then
    echo "FAIL: $desc still present"
    grep -rn "$pat" upstream/packages --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | head -5
    fail=1
  fi
}
check_absent 'ProviderID.opencode' 'ProviderID.opencode'
check_absent 'ProviderV2.ID.opencode' 'ProviderV2.ID.opencode'
check_absent 'GO_UPSELL' 'GO upsell'
[[ -f upstream/packages/core/src/plugin/provider/opencode.ts ]] && { echo "FAIL: zen plugin file still exists"; fail=1; }
[[ -f upstream/packages/core/test/plugin/provider-opencode.test.ts ]] && { echo "FAIL: zen plugin test still exists"; fail=1; }
[[ "$fail" -eq 0 ]] && echo "PASS: zen/console provider fully removed"
exit "$fail"
```

- [ ] **Step 2: 계약 테스트**

`tests/phase2-zen-removal.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

test("zen/console provider removal invariants hold", () => {
  const out = execFileSync("bash", [path.join(ROOT, "scripts/phase2-zen-check.sh")], { encoding: "utf8" });
  assert.match(out, /PASS: zen\/console provider fully removed/);
});
```

- [ ] **Step 3: 실행**

Run: `bash scripts/phase2-zen-check.sh && node --test tests/phase2-zen-removal.test.mjs`
Expected: `PASS: zen/console provider fully removed` + 1 pass.

- [ ] **Step 4: 커밋**

```bash
git add scripts/phase2-zen-check.sh tests/phase2-zen-removal.test.mjs
git commit -m "test(phase2): assert zen/console provider is fully removed"
```

---

## Chunk 3: contracts 계약 승격 (0006/0007 + 신규)

### Task 6: 슬롯/permission.mode 계약 승격

**Files:**
- Create: `contracts/src/tui-surface.mjs`
- Modify: `contracts/src/index.mjs`
- Modify: `tests/contracts.conformance.test.mjs`

> spec §3.4(145행)·§8.3(610행): 패치 0006(`session_message_footer`)·0007(`api.permission.mode`)을 contracts 정식 계약으로 승격한다. 현재는 `upstream/packages/plugin/src/tui.ts`에 타입만 있다.

- [ ] **Step 1: descriptor 작성**

`contracts/src/tui-surface.mjs`:
```js
/**
 * TUI 표면 계약 — patch 0006/0007 승격. Spec §3.4, §8.3.
 * upstream plugin/src/tui.ts 의 타입을 croakcode 계약으로 고정한다.
 * Phase 2: 계약 확정만. 슬롯 콘텐츠는 Phase 3.
 */
export const TUI_HOST_SLOTS = Object.freeze([
  "app",
  "app_bottom",
  "home_logo",
  "home_prompt",
  "home_prompt_right",
  "home_bottom",
  "home_footer",
  "session_prompt",
  "session_prompt_right",
  "session_message_footer",
  "sidebar_title",
  "sidebar_content",
  "sidebar_footer",
]);

export const SESSION_MESSAGE_FOOTER_PROPS = Object.freeze(["session_id", "message_id"]);

export const TUI_PERMISSION_MODES = Object.freeze(["ask", "auto"]);

export const TUI_PERMISSION_API = Object.freeze({
  readOnly: true,
  accessor: "mode",
  note: "patch 0007: plugins read the current permission mode; no setter is exposed.",
});
```

- [ ] **Step 2: index export + conformance 테스트**

`contracts/src/index.mjs`에 `export * from "./tui-surface.mjs";` 추가.

`tests/contracts.conformance.test.mjs`에 추가:
```js
test("TUI surface contract promotes patch 0006/0007", () => {
  assert.ok(contracts.TUI_HOST_SLOTS.includes("session_message_footer"));
  assert.deepEqual(contracts.SESSION_MESSAGE_FOOTER_PROPS, ["session_id", "message_id"]);
  assert.deepEqual(contracts.TUI_PERMISSION_MODES, ["ask", "auto"]);
  assert.equal(contracts.TUI_PERMISSION_API.readOnly, true);
});
```

- [ ] **Step 3: 실행**

Run: `node --test tests/contracts.conformance.test.mjs`
Expected: 기존 5 + 신규 1 = 6 pass.

- [ ] **Step 4: 커밋**

```bash
git add contracts/src/tui-surface.mjs contracts/src/index.mjs tests/contracts.conformance.test.mjs
git commit -m "feat(contracts): promote TUI slot and permission.mode contracts (patch 0006/0007)"
```

### Task 7: 하네스 계약 (§4.7)

**Files:**
- Create: `contracts/src/harness.mjs`
- Modify: `contracts/src/index.mjs`
- Create: `tests/phase2-harness-contract.test.mjs`

> §4.7의 `HarnessResolver` 포트를 계약으로 고정한다. 실제 upstream 연결은 Chunk 4.

- [ ] **Step 1: descriptor 작성**

`contracts/src/harness.mjs`:
```js
/**
 * 권한 기반 동적 하네스/스킬 할당 계약. Spec §4.7.
 * Phase 2: 포트 계약만. 실제 재산정은 upstream tool registry / skill discovery 에 연결.
 */
export const HARNESS_DECISIONS = Object.freeze(["allow", "ask", "deny", "not_applicable"]);

export const HARNESS_REFRESH_TRIGGERS = Object.freeze([
  "session_start",
  "turn_start",
  "permission_reply",
  "connection_mode_switch",
  "subagent_spawn",
  "permission_profile_change",
]);

/**
 * 권한 판정 → 하네스 포함 여부.
 * fail-closed: 알 수 없는 decision 은 deny 로 취급한다.
 */
export function resolveHarnessInclusion(decision) {
  if (decision === "allow") return "include";
  if (decision === "ask") return "include_requires_approval";
  return "exclude"; // deny / not_applicable / undefined / unknown
}

export const HARNESS_EVENT = Object.freeze({
  name: "harness.updated",
  direction: "core→client",
  snapshot: true,
});
```

- [ ] **Step 2: 계약 테스트**

`tests/phase2-harness-contract.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveHarnessInclusion, HARNESS_DECISIONS, HARNESS_REFRESH_TRIGGERS, HARNESS_EVENT } from "@croakcode/contracts";

test("allow/ask include, deny excludes", () => {
  assert.equal(resolveHarnessInclusion("allow"), "include");
  assert.equal(resolveHarnessInclusion("ask"), "include_requires_approval");
  assert.equal(resolveHarnessInclusion("deny"), "exclude");
  assert.equal(resolveHarnessInclusion("not_applicable"), "exclude");
});

test("unknown decision fails closed to exclude", () => {
  assert.equal(resolveHarnessInclusion(undefined), "exclude");
  assert.equal(resolveHarnessInclusion("typo"), "exclude");
  assert.equal(resolveHarnessInclusion(null), "exclude");
});

test("harness contract declares decisions, triggers, and event", () => {
  assert.deepEqual(HARNESS_DECISIONS, ["allow", "ask", "deny", "not_applicable"]);
  assert.ok(HARNESS_REFRESH_TRIGGERS.includes("connection_mode_switch"));
  assert.ok(HARNESS_REFRESH_TRIGGERS.includes("subagent_spawn"));
  assert.equal(HARNESS_EVENT.name, "harness.updated");
  assert.equal(HARNESS_EVENT.snapshot, true);
});
```

- [ ] **Step 3: 실행 + 커밋**

Run: `node --test tests/phase2-harness-contract.test.mjs`
Expected: 3 pass.

```bash
git add contracts/src/harness.mjs contracts/src/index.mjs tests/phase2-harness-contract.test.mjs
git commit -m "feat(contracts): permission-based harness allocation contract (§4.7)"
```

### Task 8: TODO 동기화 계약 (§4.8)

**Files:**
- Create: `contracts/src/todo-sync.mjs`
- Modify: `contracts/src/index.mjs`
- Create: `tests/phase2-todo-contract.test.mjs`

> §4.8 검증: TODO는 이미 SQLite 테이블 + `todo.updated` 이벤트로 영속된다. **없는 것은** `linkedToolCalls`, 턴 종료 정합성 검사, `session.todo.inconsistent` 이벤트.

- [ ] **Step 1: descriptor + 순수 함수 작성**

`contracts/src/todo-sync.mjs`:
```js
/**
 * TODO 표시 ↔ 실제 작업 동기화 계약. Spec §4.8.
 * upstream 은 TodoTable(session.sql.ts) + todo.updated 이벤트로 이미 영속한다.
 * 이 계약은 부족한 부분(linkedToolCalls, 정합성 경고)을 정의한다.
 */
export const TODO_STATUSES = Object.freeze(["pending", "in_progress", "completed", "cancelled"]);

export const TODO_SYNC_EVENTS = Object.freeze({
  snapshot: "session.todo",
  inconsistency: "session.todo.inconsistent",
});

/**
 * 턴 종료 시 정합성 판정. 표시와 실행이 어긋나면 경고 대상.
 * 반환: [] = 정상, ["completed_without_tool_call"] 등 = 경고.
 */
export function checkTodoConsistency(todo, turnToolCalls) {
  const warnings = [];
  if (!todo || typeof todo !== "object") return ["invalid_todo"];
  const status = todo.status;
  if (!TODO_STATUSES.includes(status)) warnings.push("invalid_status");
  const linked = Array.isArray(todo.linkedToolCalls) ? todo.linkedToolCalls : [];
  if (status === "completed" && linked.length === 0) warnings.push("completed_without_tool_call");
  if (status === "in_progress") {
    const hasCallThisTurn = linked.some((id) => turnToolCalls.includes(id));
    if (!hasCallThisTurn && turnToolCalls.length === 0) warnings.push("in_progress_without_tool_call");
  }
  return warnings;
}
```

- [ ] **Step 2: 계약 테스트**

`tests/phase2-todo-contract.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { checkTodoConsistency, TODO_STATUSES, TODO_SYNC_EVENTS } from "@croakcode/contracts";

test("completed todo without linked tool calls warns", () => {
  assert.deepEqual(checkTodoConsistency({ status: "completed", linkedToolCalls: [] }, []), [
    "completed_without_tool_call",
  ]);
});

test("completed todo with linked call is consistent", () => {
  assert.deepEqual(checkTodoConsistency({ status: "completed", linkedToolCalls: ["call_1"] }, ["call_1"]), []);
});

test("in_progress with no tool calls this turn warns", () => {
  assert.deepEqual(checkTodoConsistency({ status: "in_progress", linkedToolCalls: [] }, []), [
    "in_progress_without_tool_call",
  ]);
});

test("invalid status and malformed input fail detectably", () => {
  assert.deepEqual(checkTodoConsistency({ status: "done" }, []), ["invalid_status"]);
  assert.deepEqual(checkTodoConsistency(null, []), ["invalid_todo"]);
});

test("todo sync contract declares statuses and events", () => {
  assert.deepEqual(TODO_STATUSES, ["pending", "in_progress", "completed", "cancelled"]);
  assert.equal(TODO_SYNC_EVENTS.snapshot, "session.todo");
  assert.equal(TODO_SYNC_EVENTS.inconsistency, "session.todo.inconsistent");
});
```

- [ ] **Step 3: 실행 + 커밋**

Run: `node --test tests/phase2-todo-contract.test.mjs`
Expected: 5 pass.

```bash
git add contracts/src/todo-sync.mjs contracts/src/index.mjs tests/phase2-todo-contract.test.mjs
git commit -m "feat(contracts): TUI todo sync contract with turn-end consistency checks (§4.8)"
```

### Task 9: 스트림 guard 계약 (§4.9)

**Files:**
- Create: `contracts/src/stream-guard.mjs`
- Modify: `contracts/src/index.mjs`
- Create: `tests/phase2-stream-guard-contract.test.mjs`

> §4.9: 헤더 타임아웃(`provider.ts:94-96`)만 있고 본문 idle guard가 없다. 계약으로 두 단계 타임아웃과 compaction 기본값을 고정한다.

- [ ] **Step 1: descriptor + 순수 함수 작성**

`contracts/src/stream-guard.mjs`:
```js
/**
 * 스트림 타임아웃 2단계 + compaction idle guard 계약. Spec §4.9.
 * 검증된 사실: upstream 은 헤더 수신 전 타임아웃만 있고, 본문 idle guard 는 없다.
 */
export const STREAM_IDLE_ERROR_CODE = "STREAM_IDLE_TIMEOUT";

export const STREAM_TIMEOUT_PHASES = Object.freeze(["head", "body_idle"]);

export const STREAM_GUARD_DEFAULTS = Object.freeze({
  stream: Object.freeze({ headTimeoutMs: 60_000, bodyIdleTimeoutMs: 60_000 }),
  compaction: Object.freeze({ headTimeoutMs: 120_000, bodyIdleTimeoutMs: 120_000, alwaysOn: true }),
});

/**
 * compaction 경로는 기본으로 guard 가 켜져 있어야 한다(관측된 무한대기 재발 방지).
 * 0/undefined 를 명시하면 일반 스트림은 끌 수 있으나 compaction 은 항상 켠다.
 */
export function resolveIdleTimeout(kind, config) {
  const defaults = STREAM_GUARD_DEFAULTS[kind];
  if (!defaults) throw new Error(`unknown stream kind: ${kind}`);
  const idle = config?.bodyIdleTimeoutMs;
  if (kind === "compaction") {
    return typeof idle === "number" && idle > 0 ? idle : defaults.bodyIdleTimeoutMs;
  }
  if (idle === 0) return 0; // 명시적 비활성
  return typeof idle === "number" && idle > 0 ? idle : defaults.bodyIdleTimeoutMs;
}

/** compaction 중 idle 타임아웃은 재시도 금지(세션을 idle 로 되돌리고 중단). */
export function shouldRetryAfterIdle(kind) {
  return kind !== "compaction";
}
```

- [ ] **Step 2: 계약 테스트**

`tests/phase2-stream-guard-contract.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveIdleTimeout,
  shouldRetryAfterIdle,
  STREAM_GUARD_DEFAULTS,
  STREAM_IDLE_ERROR_CODE,
  STREAM_TIMEOUT_PHASES,
} from "@croakcode/contracts";

test("compaction idle guard is always on with a default", () => {
  assert.equal(resolveIdleTimeout("compaction", {}), 120_000);
  assert.equal(resolveIdleTimeout("compaction", { bodyIdleTimeoutMs: 0 }), 120_000);
  assert.equal(resolveIdleTimeout("compaction", { bodyIdleTimeoutMs: 30_000 }), 30_000);
});

test("normal stream can be explicitly disabled but defaults on", () => {
  assert.equal(resolveIdleTimeout("stream", {}), 60_000);
  assert.equal(resolveIdleTimeout("stream", { bodyIdleTimeoutMs: 0 }), 0);
  assert.equal(resolveIdleTimeout("stream", { bodyIdleTimeoutMs: 15_000 }), 15_000);
});

test("compaction never auto-retries after idle", () => {
  assert.equal(shouldRetryAfterIdle("compaction"), false);
  assert.equal(shouldRetryAfterIdle("stream"), true);
});

test("stream guard declares phases, defaults, and error code", () => {
  assert.deepEqual(STREAM_TIMEOUT_PHASES, ["head", "body_idle"]);
  assert.equal(STREAM_IDLE_ERROR_CODE, "STREAM_IDLE_TIMEOUT");
  assert.equal(STREAM_GUARD_DEFAULTS.compaction.alwaysOn, true);
});
```

- [ ] **Step 3: 실행 + 커밋**

Run: `node --test tests/phase2-stream-guard-contract.test.mjs`
Expected: 4 pass.

```bash
git add contracts/src/stream-guard.mjs contracts/src/index.mjs tests/phase2-stream-guard-contract.test.mjs
git commit -m "feat(contracts): two-phase stream timeout and compaction idle guard contract (§4.9)"
```

---

## Chunk 4: upstream 런타임 연결 (하네스 / TODO / idle guard)

### Task 10: 도구 레지스트리에 권한 게이트 추가 (§4.7 구현)

**Files:**
- Modify: `upstream/packages/opencode/src/tool/registry.ts`
- Modify: `upstream/packages/opencode/src/session/tools.ts`
- Create: `upstream/packages/opencode/test/tool/registry-permission.test.ts`

> 현재 `tools()`는 provider/model 필터만 한다(`registry.ts:316-361`). §4.7: **deny 도구는 모델에 노출하지 않는다**. `ctx.ask`(실행 시 승인)는 그대로 두고, **목록 단계 필터**를 추가한다.

- [ ] **Step 1: 필터 함수 추가**

> **검증된 사실:** `Permission.evaluate(permission, pattern, ...rulesets)`(`permission/index.ts:138`)이고, `tools(input)`은 `const filtered = (yield* all()).filter(...)`(316행)로 시작한다. `describeTask`(304행)가 정확히 같은 패턴을 쓴다.

`registry.ts`의 `tools()` 안, **기존 `filtered` 체인 끝(`return true` 뒤)에 권한 조건을 추가**한다:

```ts
const filtered = (yield* all()).filter((tool) => {
  // ...기존 provider/model 필터 유지...
  return true
}).filter((tool) => Permission.evaluate(tool.id, "*", input.agent.permission).action !== "deny")
```

`input.agent`는 `tools({ providerID, modelID, agent })`(73-80행)로 이미 전달된다. **`ask`는 포함**(실행 시 승인), `deny`만 제외 — §4.7 "deny는 노출하지 않음"과 일치.

- [ ] **Step 2: 테스트 작성**

`test/tool/registry-permission.test.ts` — agent permission에 `read: "deny"`를 주고 `tools()` 결과에 `read`가 **없는지**, 그리고 `ask`인 `write`는 **있는지** 확인한다.

- [ ] **Step 3: 실행**

Run: `cd upstream/packages/opencode && bun test test/tool/registry-permission.test.ts test/tool/registry.test.ts 2>&1 | tail -8`
Expected: 0 fail. 기존 테스트가 깨지면 agent fixture의 permission을 확인한다(기본 permission은 `ask`/`allow`이므로 대부분 영향 없음).

- [ ] **Step 4: 커밋**

```bash
git add upstream/packages/opencode/src/tool/registry.ts upstream/packages/opencode/test/tool/registry-permission.test.ts
git commit -m "feat(upstream): hide deny-permissioned tools from the model tool list (§4.7)"
```

### Task 11: TODO 정합성 검사 연결 (§4.8 구현)

**Files:**
- Modify: `upstream/packages/opencode/src/session/todo.ts`
- Modify: `upstream/packages/opencode/src/session/prompt.ts`
- Modify: `upstream/packages/opencode/src/session/session.sql.ts`
- Create: `upstream/packages/opencode/test/session/todo-consistency.test.ts`

> `TodoTable`에 `linked_tool_calls` JSON 컬럼을 추가하고, 턴 종료 시 정합성 경고 이벤트를 발행한다. **TODO를 임의로 되돌리지 않는다**(관측만).

- [ ] **Step 1: 스키마 확장**

`session.sql.ts`의 `TodoTable`(93-109행)에 `linked_tool_calls TEXT NOT NULL DEFAULT '[]'` 컬럼을 추가한다.

> **검증된 사실:** upstream은 drizzle `db:generate` 스크립트가 **없다**. 마이그레이션은 `upstream/packages/opencode/migration/<timestamp>_<name>/migration.sql` 디렉터리로 관리되고 `storage/db.ts:72-117`의 `migrations(dir)`가 journal 순서로 적용한다. 따라서 마이그레이션 파일을 **수동으로** 추가한다.

새 디렉터리 `upstream/packages/opencode/migration/<YYYYMMDDHHMMSS>_todo_linked_tool_calls/migration.sql`:
```sql
ALTER TABLE `todo` ADD COLUMN `linked_tool_calls` text NOT NULL DEFAULT '[]';
```
(테이블명은 `session.sql.ts`의 `TodoTable` 실제 이름을 확인해 맞춘다 — `todo`가 아니면 수정.)

Run: `grep -n 'TodoTable' upstream/packages/opencode/src/session/session.sql.ts`
Expected: 테이블 이름 확인. `drizzle.config.ts`의 스키마 경로와 일치하는지도 확인한다.

- [ ] **Step 2: 이벤트 정의**

`session/todo.ts`의 `Event`에 추가:
```ts
export const Event = {
  Updated: BusEvent.define("todo.updated", Schema.Struct({ sessionID: SessionID, todos: Schema.Array(Info) })),
  Inconsistent: BusEvent.define(
    "todo.inconsistent",
    Schema.Struct({ sessionID: SessionID, todo: Info, warnings: Schema.Array(Schema.String) }),
  ),
}
```

- [ ] **Step 3: 턴 종료 검사 연결**

> **검증된 사실:** `prompt.ts`의 layer(`Layer.effect` 블록, 100-130행)에는 **`Todo.Service`가 주입되어 있지 않다**(`SessionTodo` import도 없음). 먼저 주입을 추가해야 한다.

`prompt.ts` 상단 import에 `import { SessionTodo } from "./todo"` 추가, layer에 `const todos = yield* SessionTodo.Service` 추가. 그리고 오케스트레이션 루프의 **턴 종료 지점**(`prompt.ts:1498`의 `compaction.prune` 바로 앞, `return yield* lastAssistant(sessionID)` 직전)에 추가:

```ts
const allTodos = yield* todos.get(sessionID)
const turnCalls = msgs.flatMap((m) =>
  m.parts.filter((p): p is MessageV2.ToolPart => p.type === "tool").map((p) => p.callID),
)
for (const todo of allTodos) {
  const warnings = todoConsistencyWarnings(todo, turnCalls)   // upstream 내부 헬퍼
  if (warnings.length) yield* bus.publish(SessionTodo.Event.Inconsistent, { sessionID, todo, warnings })
}
```
> upstream은 contracts를 import하지 않으므로(의존 규칙) `todoConsistencyWarnings` 로직을 **upstream 내부(`session/todo.ts`)에 둔다**. contracts는 계약/테스트 기준으로만 쓴다. 두 구현이 어긋나지 않도록 Step 5의 테스트로 고정한다.

- [ ] **Step 4: 부작용 도구 자동 연결(보수적)**

`tool/todo.ts`의 `execute`에서 `todo.update` 호출 시, 현재 턴에 실행된 부작용 도구의 `callID`를 `linked_tool_calls`에 넣는다. 애매하면 연결하지 않는다(경고만 발생하도록).

- [ ] **Step 5: 테스트**

`test/session/todo-consistency.test.ts` — `completed`+빈 linked → `todo.inconsistent` 이벤트 발행 확인, linked 있으면 미발행 확인.

Run: `cd upstream/packages/opencode && bun test test/session/todo-consistency.test.ts test/session/prompt.test.ts test/server/httpapi-session.test.ts 2>&1 | tail -8`
Expected: 0 fail.

- [ ] **Step 6: 커밋**

```bash
git add -A upstream/packages/opencode
git commit -m "feat(upstream): todo consistency warnings at turn end with linked tool calls (§4.8)"
```

### Task 12: compaction idle guard 구현 (§4.9 구현)

**Files:**
- Modify: `upstream/packages/opencode/src/session/compaction.ts`
- Modify: `upstream/packages/opencode/src/provider/provider.ts`
- Create: `upstream/packages/opencode/test/session/compaction-idle-timeout.test.ts`

> 가장 중요한 런타임 변경. **본문 idle** 시간을 감시한다. upstream 기존 헤더 타임아웃은 건드리지 않는다.

- [ ] **Step 1: idle 감시 helper 추가**

> **검증된 사실:** `SessionProcessor.process`는 `Effect.Effect<Result>`를 반환하고(`processor.ts:52`), upstream은 타임아웃에 `Effect.timeoutOption`(`background/job.ts:177`)·`Effect.timeoutOrElse`(`tool/webfetch.ts:92`)를 쓴다. `Stream.timeout`은 이 코드베이스에서 쓰인 적이 없다. 아래 helper는 **실제 사용 패턴**에 맞춘다.

`compaction.ts`에 추가:
```ts
export class StreamIdleTimeoutError extends Schema.TaggedErrorClass<StreamIdleTimeoutError>()(
  "StreamIdleTimeoutError",
  { idleMs: Schema.Number },
) {}

const DEFAULT_COMPACTION_IDLE_MS = 120_000

// compaction 전체(요약 생성)를 idle 타임아웃으로 감싼다.
// Effect.timeoutOption 은 None 으로 반환하므로 호출부에서 None = idle 초과로 판정한다.
const withIdleGuard = <A, E, R>(effect: Effect.Effect<A, E, R>, idleMs: number) =>
  effect.pipe(Effect.timeoutOption(Duration.millis(idleMs)))
```
> 진짜 **본문 idle**(델타 간 간격) 감시는 스트림 레벨이 더 정확하다. `processor.process`가 내부에서 스트림을 소비하므로, Phase 2는 **요청 전체 타임아웃**(`timeoutOption`)을 1차 구현으로 두고, 델타 단위 idle은 Phase 3에서 `Stream` 파이프라인에 추가한다. 이 한계를 게이트 문서에 명시한다.

- [ ] **Step 2: compaction.process에 적용**

`compaction.process`(344행)의 `yield* processor.process({...})` 호출을 guard로 감싼다. `processor.process`는 `Effect.Effect<Result>`이고 `Result = "compact" | "stop" | "continue"`(`processor.ts:35`)이므로 `Effect.timeoutOption`이 `Option<Result>`를 돌려준다:

```ts
const guarded = yield* withIdleGuard(processor.process({ ... }), idleMs)
const result = Option.getOrElse(guarded, () => "stop" as const)   // None = idle 초과
if (Option.isNone(guarded)) {
  processor.message.error = { name: "StreamIdleTimeoutError", data: { idleMs } }   // MessageV2 에러 형식에 맞춰 조정
  processor.message.finish = "error"
  yield* session.updateMessage(processor.message)
  yield* bus.publish(Session.Event.Error, {
    sessionID: input.sessionID,
    error: { name: "STREAM_IDLE_TIMEOUT", data: { idleMs, compaction: true } },
  })
  yield* status.set(input.sessionID, { type: "idle" })
  return "stop"   // 재시도 금지
}
```
> `status.set`·`bus.publish`의 정확한 시그니처는 `processor.ts:777`(idle 설정)·`prompt.ts`의 기존 발행 패턴을 그대로 따를 것. 에러 객체 형태는 `NamedError`/`MessageV2` 기존 형식과 일치시킨다(임의 shape 금지).

- [ ] **Step 3: 일반 스트림에도 동일 guard 적용(선택적, 설정 기반)**

`provider.ts`의 stream 경로에 `options.idleTimeoutMs`가 있으면 적용. 기본은 **off**(일반 스트림은 기존 동작 유지), compaction만 on. 이는 §4.9 "compaction은 기본 항상 켬"과 일치.

- [ ] **Step 4: 테스트**

`test/session/compaction-idle-timeout.test.ts` — 응답 없는 stream stub을 주고, idle 타임아웃 후 `finish: "error"` + 세션 idle 복귀 + 재시도 없음을 확인한다.

Run: `cd upstream/packages/opencode && bun test test/session/compaction-idle-timeout.test.ts test/session/compaction.test.ts 2>&1 | tail -8`
Expected: 0 fail.

- [ ] **Step 5: 커밋**

```bash
git add upstream/packages/opencode/src/session/compaction.ts upstream/packages/opencode/src/provider/provider.ts upstream/packages/opencode/test/session/compaction-idle-timeout.test.ts
git commit -m "feat(upstream): add body-idle guard to compaction with STREAM_IDLE_TIMEOUT (§4.9)"
```

---

## Chunk 5: 회귀 + Phase 2 게이트

### Task 13: 전체 회귀 스크립트

**Files:**
- Create: `scripts/phase2-gate-replay.sh`

- [ ] **Step 1: 스크립트 작성**

`scripts/phase2-gate-replay.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "== rebrand =="
node scripts/rebrand-check.mjs upstream
echo "== zen removal =="
bash scripts/phase2-zen-check.sh
echo "== phase1 regressions =="
bash scripts/phase1-cli-check.sh
bash scripts/phase1-headless-check.sh
node --test 'tests/*.test.mjs'
bun test tests
echo "== upstream core packages =="
(cd upstream/packages/core && bun test)
(cd upstream/packages/opencode && bun test test/provider test/tool test/session test/cli/help test/skill)
echo "PASS: phase 2 gate replay"
```

> upstream 전체 `bun test`는 느리고 flaky(`node_modules/.bun` 중첩 등)이므로 **핵심 디렉터리만** 돈다. 전체 스위트는 Phase 3에서 안정화한다.

- [ ] **Step 2: 실행**

Run: `bash scripts/phase2-gate-replay.sh`
Expected: 마지막 줄 `PASS: phase 2 gate replay`. 중간 실패가 있으면 해당 Chunk로 돌아간다.

> 주의: `tests/phase1-session.e2e.test.mjs`·`phase1-sqlite.e2e.test.mjs`는 headless 선행이 필요하므로 스크립트에서 headless를 먼저 돈다(위 순서 유지).

- [ ] **Step 3: 커밋**

```bash
git add scripts/phase2-gate-replay.sh
git commit -m "test(phase2): one-shot full regression replay script"
```

### Task 14: Phase 2 게이트 문서

**Files:**
- Create: `docs/superpowers/phase0/phase2-gate.md`

- [ ] **Step 1: 문서 작성**

`docs/superpowers/phase0/phase2-gate.md`:
```md
# Phase 2 Decision Gate — 코어 독립화 및 기존 동작 흡수

Spec: `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md` §8.3

- [ ] upstream help snapshots regenerated for `cc` (`bun test ... -u`, 잔여 opencode 0)
- [ ] console/web packages removed; rebrand-check 전체 blocking PASS
- [ ] zen provider (id `opencode`) removed from catalog/loaders/transforms (`scripts/phase2-zen-check.sh` PASS)
- [ ] zen tier/upsell removed from TUI, retry, provider list
- [ ] TUI slot + permission.mode promoted to contracts (patch 0006/0007)
- [ ] harness contract + deny-tools-hidden registry gate (§4.7)
- [ ] todo consistency warnings + linked tool calls (§4.8)
- [ ] compaction body-idle guard with STREAM_IDLE_TIMEOUT (§4.9)
- [ ] full regression replay PASS (`scripts/phase2-gate-replay.sh`)

## Gate result
Phase 3 approved only when every item is checked against real runs.
```

> 체크박스는 실제 실행 결과로만 체크한다.

- [ ] **Step 2: 커밋**

```bash
git add docs/superpowers/phase0/phase2-gate.md
git commit -m "docs: phase 2 decision gate checklist"
```

---

## Phase 2 완료 조건 (§8.3)

- §6의 **A(upstream 코어 동작) + B(패치 8개 동작)** 가 동등성 매트릭스에서 PASS(또는 승인된 ACCEPTED DEVIATION).
- zen/console provider 물리 제거 완료(소스 검사로 증명).
- 슬롯 API·`api.permission.mode`가 croakcode contracts로 승격.
- §4.7 권한 기반 하네스: `deny` 도구가 모델에 노출되지 않음을 테스트로 증명, 판정 누락 시 fail-closed.
- §4.8 TODO 동기화: 실제 불일치 케이스에서 `session.todo.inconsistent` 발생, 서브세션 TODO 격리.
- §4.9 Compaction idle guard: 본문 무응답이 `STREAM_IDLE_TIMEOUT`으로 abort, compaction은 기본 항상 켜짐, 무한 재시도 없음.
- Phase 0/1 계약 레이어 회귀 없음.

> **슬롯 콘텐츠는 Phase 3**: Phase 2는 계약 확정까지. 플러그인이 슬롯에 내용을 등록하는 것은 Phase 3.
> **DB-level §4.5 매핑은 계속 deferred**: upstream `part`가 ToolState를 `data` JSON에 저장하므로 `run_state` 컬럼 추가는 Phase 3의 플러그인 이식과 함께 판단한다.

## Scope note

Phase 2는 **upstream 코어 정리 + 런타임 게이트 3종 + 계약 승격**이다. gate/admin 어댑터 실구현·croak-auth 연동·HWP 도구·사용량 패널은 Phase 3/4. 실제 LLM 호출 검증은 Phase 1과 동일하게 로컬 vLLM 또는 croak-gate 설정이 필요하며, Phase 2 게이트의 자동 항목에는 포함하지 않는다.
