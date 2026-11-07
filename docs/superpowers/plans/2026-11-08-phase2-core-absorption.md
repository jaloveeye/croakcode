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
- **TODO는 이미 전용 SQLite 테이블**(`session.sql.ts:93-109` `TodoTable`)에 영속되고 `todo.updated` 이벤트를 발행한다(`session/todo.ts:59`). §4.8의 "SSOT 승격"은 **이미 절반 구현됨**. 없는 것은: `linkedToolCalls` 필드, `evidence` 정책, 턴 종료 정합성 검사, `todo.inconsistent` 이벤트(upstream 명명 규칙), 서브세션 격리 표시. **이벤트 명명은 spec §4.2/§4.8 정본을 따른다: `todo.updated` / `todo.inconsistent`** (prefix 없는 upstream BusEvent 규칙).
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

- [ ] **Step 2: console/web 처리 방침 확정 + 삭제 사전 점검**

Phase 4에서 게이트/관리웹은 croakcode가 새로 만든다. upstream `packages/console`(SaaS 백엔드)·`packages/web`(마케팅/랜딩)은 croakcode 제품에 불필요하므로 **upstream 트리에서 제거**한다. 제거 시 workspace `package.json`에서도 뺀다.

> **삭제 사전 점검(pre-flight) — 검토 지적 반영:** 삭제는 되돌리기 비싸므로, 삭제 전에 의존성·빌드 영향도를 먼저 측정하고 증거를 남긴다.

1) 삭제 전 기준선(build/typecheck)을 기록한다:
   Run: `cd upstream && bun run typecheck 2>&1 | tail -2`
   Expected: 현재 성공 태스크 수를 기록(삭제 후 비교 기준).

2) `console`/`web`을 import하는 다른 패키지가 있는지 확인한다:
   Run: `grep -rn 'packages/console\|packages/web\|"@opencode/console"\|"@opencode/web"' upstream/package.json upstream/packages/*/package.json upstream/packages/*/src 2>/dev/null | grep -v node_modules`
   Expected: workspace 정의 외에 런타임 import가 있으면 목록에 기록한다(있으면 Step 3 전에 정리).

3) 자원(asset)·라우트가 `app`/`desktop`에서 참조되는지 확인:
   Run: `grep -rn '/changelog\|/desktop-feedback\|/brand\|/favicon' upstream/packages/app upstream/packages/desktop 2>/dev/null | grep -v node_modules || true`
   Expected: 참조는 Step 3의 비소유 엔드포인트 분류표에 기록.

사전 점검 결과를 gate 문서(Phase 2 Gate)의 "삭제 영향도" 항목에 첨부한다. 그 다음 삭제를 수행한다:

```bash
git rm -r upstream/packages/console upstream/packages/web
```

그리고 `upstream/package.json`의 `workspaces`에서 두 항목을 제거한다. `upstream/packages/app`이 `packages/web`을 참조하는지 확인하고, 참조가 있으면 함께 정리한다(Step 3).

Run: `grep -rn '"web"\|packages/web' upstream/package.json upstream/packages/*/package.json | grep -v node_modules`
Expected: 남은 참조 0건. 있으면 해당 참조를 제거한다.

- [ ] **Step 3: 잔여분 인벤토리 — croakcode 소유 URL과 upstream 비소유 URL을 분리**

> **검토 지적 반영 (P1 Task 2):** "일괄 URL 치환"은 croakcode가 소유하지 않은 엔드포인트(`/desktop-feedback`, `/changelog*`, `/favicon*`, `/brand`, `/discord`, `/zen`, `/legal/*`)까지 `croakcode.ai`로 다시 써서 **존재하지 않는 URL**을 만든다. 따라서 먼저 잔여 히트를 **소유/비소유**로 분류한 뒤, 소유분만 치환한다.

Step 2의 console/web 제거 후 실제 잔여는 `packages/{app,enterprise,stats}` 등 **30여 개 파일**에 남는다. 다음을 실행해 파일·URL 단위로 목록을 만든다:

Run: `node scripts/rebrand-check.mjs upstream 2>&1 | grep '^ - upstream/'`

분류 규칙(검증된 잔여 엔드포인트):
- **croakcode 소유(=치환 대상):** `https://opencode.ai/docs/*`, `.opencode/` 경로, `opencode.json(c)` 파일명, 텔레메트리 key `opencode.*`, config 엔드포인트 `/config.json`·`/tui.json`·`/theme.json`·`/desktop-theme.json`(croakcode 서버가 제공).
- **upstream 비소유(=치환 금지):** `/desktop-feedback`(3곳), `/changelog.json`, `/changelog`, `/favicon.svg`, `/favicon-96x96-v3.png`, `/brand`, `/discord`, `/zen`, `/legal/terms-of-service`, `/legal/privacy-policy`, `/docs/themes/`, `/docs/providers/#custom-provider`. 이들은 croakcode 서버에 존재하지 않으므로 **rewrite 금지**. 처리 방침: 해당 UI/링크가 Phase 2 제품 범위 밖이면 **제거**(dead link 방지), 아니면 링크를 **croakcode 실제 경로로 대체**하거나 **비활성(defer)** 으로 남기고 gate 문서에 근거 기록.

치환은 자동 스크립트로 하되 **반드시 수동 검수**한다:
- `https://opencode.ai/*` → `https://croakcode.ai/*` (소유분만)
- `.opencode/` → `.croakcode/`, `opencode.json(c)` → `croakcode.json(c)`
- 텔레메트리 key `opencode.*` → `croakcode.*`
- `.opencode/` fixture 디렉터리: `git mv upstream/.opencode upstream/.croakcode`

Run: `grep -rn 'croakcode.ai/desktop-feedback\|croakcode.ai/changelog\|croakcode.ai/favicon\|croakcode.ai/brand\|croakcode.ai/discord\|croakcode.ai/zen\|croakcode.ai/legal' upstream/packages --include='*.*' | grep -v node_modules`
Expected: 0건 — 비소유 엔드포인트를 croakcode URL로 잘못 바꾼 흔적이 없어야 한다.

- [ ] **Step 4: rebrand-check를 전체 blocking으로 변경**

`scripts/rebrand-check.mjs`에서 `CORE_PREFIXES` 기반 분기를 제거하고 모든 파일을 `bad`로 모은다. 단 `packages/opencode/package.json`·`packages/core/package.json`의 `"name": "opencode"`는 `ALLOW_PKG_NAMES`로 계속 허용한다(workspace:* 의존).

Run: `node scripts/rebrand-check.mjs upstream`
Expected: `PASS: no disallowed upstream branding outside NOTICE/attribution` (DEFERRED 출력 없음). FAIL이면 남은 파일을 치환한다. **NOTICE/LICENSE의 upstream 고지는 예외로 유지**(MIT 의무).

- [ ] **Step 5: typecheck + 회귀 동등성 증거 + 커밋**

Run: `cd upstream && bun install --ignore-scripts && bun run typecheck 2>&1 | tail -4`
Expected: `Tasks: N successful, N total`, 실패 0. **삭제 사전 점검(Step 2)의 기준선 태스크 수와 비교**해, 제거된 `console`/`web` 프로젝트 수만큼만 줄고 **나머지 프로젝트는 모두 성공**함을 기록한다.

Run: `cd upstream/packages/opencode && bun test test/cli/help 2>&1 | tail -4`
Expected: 통과 — `console`/`web` 제거가 코어 CLI 동작에 회귀를 주지 않음(동등성 증거).

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

- [ ] **Step 6: provider 아이콘·테스트 정리 (일반 커버리지 보존)**

`ui/src/components/provider-icons/types.ts`의 `"opencode"`(37행), `"opencode-go"`(38행) 제거.

`test/session/retry.test.ts`에서는 **Go upsell 전용 테스트 3개만** 제거한다(검증된 위치):
- `maps free limits to Go upsell action` (L258)
- `maps Go subscription limits to workspace PAYG upsell` (L284)
- `maps Go subscription limits without limit metadata` (L322)

> **검토 지적 반영 (P1 Task 4):** 일반 재시도 커버리지는 삭제하지 않는다. 다음 테스트는 **반드시 유지**한다:
> - `maps too_many_requests json messages` (L122)
> - `maps overloaded provider codes` (L127, `resource_exhausted`)
> - `does not retry unknown json messages` (L132)
> - `does not throw on numeric error codes` (L137, `code: 123` → undefined) — **Go 전용이 아니라 일반 방어 테스트**이므로 유지한다(검토에서 "Go assertion이 섞였다"고 본 부분은 재확인 결과 오판이었음).

Run: `cd upstream/packages/opencode && bun test test/session/retry.test.ts 2>&1 | tail -5`
Expected: Go upsell 3케이스가 빠져 총계가 3만큼 줄고 **0 fail**. 위 유지 목록 4개가 여전히 존재하는지 함께 확인:
Run: `grep -c 'too_many_requests\|resource_exhausted\|unknown json messages\|numeric error codes' upstream/packages/opencode/test/session/retry.test.ts`
Expected: ≥ 4.

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

- [ ] **Step 1: 검사 스크립트 (baseten 마스킹 방지)**

> **검토 지적 반영 (P1 Task 5):** 기존 `grep -rn ... | grep -qv 'baseten'`은 히트 중 한 줄이라도 `baseten`이면 **전체를 통과시켜** 위반을 가린다. 검증된 사실: `transform.ts:1081-1082`에서 `baseten`과 `"opencode"`가 **한 `if` 블록의 인접 줄**로 함께 있다. 따라서 `baseten` 예외는 **줄 단위가 아니라 매치 단위**로 처리하고, `opencode` 히트는 `baseten` 줄에 있더라도 별도로 잡아야 한다.

`scripts/phase2-zen-check.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0

# pat 매치를 찾되, "예외 라인" 필터는 매치 자체가 예외일 때만 통과시킨다.
# baseten 이 같은 줄에 있어도 'opencode' 토큰이 그 줄에 있으면 위반으로 센다.
check_absent() {
  local pat="$1" desc="$2"
  local hits
  hits=$(grep -rn -E "$pat" upstream/packages \
           --include='*.ts' --include='*.tsx' 2>/dev/null \
         | grep -v node_modules \
         | grep -E "$pat" || true)
  if [[ -n "$hits" ]]; then
    echo "FAIL: $desc still present"
    echo "$hits" | head -5
    fail=1
  fi
}

# ProviderID.opencode / ProviderV2.ID.opencode: baseten 은 이 패턴에 등장하지 않으므로 그대로 검사.
# (baseten 예외는 transform 의 'startsWith("opencode")' 류에만 필요했고,
#  아래 check_absent 는 baseten 줄이라도 'opencode' 토큰이 있으면 실패로 잡는다.)
check_absent 'ProviderID\.opencode' 'ProviderID.opencode'
check_absent 'ProviderV2\.ID\.opencode' 'ProviderV2.ID.opencode'
check_absent 'GO_UPSELL' 'GO upsell'
check_absent '\bopencode-go\b' 'opencode-go tier string'

[[ -f upstream/packages/core/src/plugin/provider/opencode.ts ]] && { echo "FAIL: zen plugin file still exists"; fail=1; }
[[ -f upstream/packages/core/test/plugin/provider-opencode.test.ts ]] && { echo "FAIL: zen plugin test still exists"; fail=1; }

[[ "$fail" -eq 0 ]] && echo "PASS: zen/console provider fully removed"
exit "$fail"
```

> `baseten` 조건 자체는 **삭제 대상이 아니다**(Task 3 Step 4: `baseten` 분기 보존). 이 스크립트는 `baseten`을 *허용*하는 대신, `opencode` 토큰이 같은 줄에 있어도 **놓치지 않는다**. 또한 회귀 방지를 위해 `baseten` 분기가 남아 있는지 별도 확인한다(Step 3).

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

- [ ] **Step 3: 실행 (baseten 보존 교차 검증 포함)**

Run: `bash scripts/phase2-zen-check.sh && node --test tests/phase2-zen-removal.test.mjs`
Expected: `PASS: zen/console provider fully removed` + 1 pass.

추가로 `baseten` 분기가 실수로 함께 지워지지 않았는지 확인한다(회귀 방지):
Run: `grep -c 'providerID === "baseten"' upstream/packages/opencode/src/provider/transform.ts`
Expected: ≥ 1. 0이면 Task 3 Step 4에서 `baseten` 조건을 잘못 제거한 것이므로 복원한다.

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

- [ ] **Step 4: `HARNESS_REFRESH_TRIGGERS` 런타임 연결 범위 확정 (검토 지적 반영)**

> **검토 지적 반영 (P1 Task 7):** `HARNESS_REFRESH_TRIGGERS`가 선언만 되고 실제 재산정 경로가 없다는 지적. Phase 2의 실제 재산정 구현(Task 10)이 어느 트리거에 연결되는지 **명시**한다.

Phase 2에서 **런타임 연결하는 트리거(필수):**
- `turn_start` → Task 10의 registry 권한 게이트가 매 턴 도구 목록을 재산정(이미 턴마다 `tools()` 호출됨).
- `permission_reply` / `permission_profile_change` → 권한 응답/프로필 변경 시 `harness.updated` 재발행(§4.7).
- `subagent_spawn` → 세션 파생 시 동일 게이트 적용(§3.4 실행 순서 보존).

Phase 2에서 **연결 보류(Phase 3 이관, 명시적 defer):**
- `session_start`·`connection_mode_switch` → 연결 모드 전환은 Phase 4(gate 어댑터)에서 실제 의미를 갖는다. Phase 2는 트리거 상수만 정의하고 **gate 문서에 defer 근거 기록**.

계약 테스트에 연결 범위를 고정한다(`tests/phase2-harness-contract.test.mjs`에 추가):
```js
test("runtime-wired triggers are a declared subset of all triggers", () => {
  const RUNTIME_WIRED = ["turn_start", "permission_reply", "permission_profile_change", "subagent_spawn"];
  const DEFERRED = ["session_start", "connection_mode_switch"];
  for (const t of [...RUNTIME_WIRED, ...DEFERRED]) assert.ok(HARNESS_REFRESH_TRIGGERS.includes(t));
  assert.equal(RUNTIME_WIRED.length + DEFERRED.length, HARNESS_REFRESH_TRIGGERS.length);
});
```

Run: `node --test tests/phase2-harness-contract.test.mjs`
Expected: 4 pass.

### Task 8: TODO 동기화 계약 (§4.8)

**Files:**
- Create: `contracts/src/todo-sync.mjs`
- Modify: `contracts/src/index.mjs`
- Create: `tests/phase2-todo-contract.test.mjs`

> §4.8: TODO는 이미 SQLite 테이블 + `todo.updated`로 영속된다. 계약이 정의할 **없는 것**: `linkedToolCalls`, `evidence` 정책, `todo.inconsistent`.

- [ ] **Step 1: descriptor + 순수 함수 작성**

`contracts/src/todo-sync.mjs`:
```js
/**
 * TODO 표시 ↔ 실제 작업 동기화 계약. Spec §4.8.
 * upstream 은 TodoTable(session.sql.ts) + todo.updated 로 이미 영속한다.
 * 이 계약은 부족한 부분(evidence 정책, linkedToolCalls, 정합성 경고)을 정의한다.
 */
export const TODO_STATUSES = Object.freeze(["pending", "in_progress", "completed", "cancelled"]);

export const TODO_EVIDENCE = Object.freeze(["tool", "none"]);

/** upstream BusEvent 규칙(prefix 없음)과 일치. Spec §4.8 이벤트 명명(정본). */
export const TODO_EVENTS = Object.freeze({
  updated: "todo.updated",
  inconsistent: "todo.inconsistent",
});

export const TODO_WARNINGS = Object.freeze([
  "completed_without_evidence",
  "in_progress_without_evidence",
  "invalid_todo",
  "invalid_status",
]);

/**
 * 턴 종료 정합성 판정. evidence:"none" 은 도구 증거를 요구하지 않는다(오탐 방지).
 * in_progress 는 턴 단위 판정 금지 — 진입 턴에만 확인한다.
 */
export function checkTodoConsistency(todo, turnCalls, entryTurnCalls) {
  if (!todo || typeof todo !== "object") return ["invalid_todo"];
  const warnings = [];
  if (!TODO_STATUSES.includes(todo.status)) warnings.push("invalid_status");
  const evidence = todo.evidence ?? "tool";
  const linked = Array.isArray(todo.linkedToolCalls) ? todo.linkedToolCalls : [];
  if (evidence === "tool" && todo.status === "completed" && linked.length === 0) {
    warnings.push("completed_without_evidence");
  }
  if (evidence === "tool" && todo.status === "in_progress") {
    const entry = Array.isArray(entryTurnCalls) ? entryTurnCalls : [];
    const calledInEntryTurn = entry.some((id) => linked.includes(id));
    if (entry.length > 0 && !calledInEntryTurn && linked.length === 0) {
      warnings.push("in_progress_without_evidence");
    }
  }
  return warnings;
}
```

- [ ] **Step 2: 계약 테스트**

`tests/phase2-todo-contract.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { checkTodoConsistency, TODO_STATUSES, TODO_EVIDENCE, TODO_EVENTS } from "@croakcode/contracts";

test("evidence:tool completed without linked calls warns", () => {
  assert.deepEqual(checkTodoConsistency({ status: "completed", evidence: "tool", linkedToolCalls: [] }, [], []), [
    "completed_without_evidence",
  ]);
});

test("evidence:none completed without linked calls does NOT warn", () => {
  assert.deepEqual(checkTodoConsistency({ status: "completed", evidence: "none", linkedToolCalls: [] }, [], []), []);
});

test("completed with linked call is consistent", () => {
  assert.deepEqual(
    checkTodoConsistency({ status: "completed", evidence: "tool", linkedToolCalls: ["call_1"] }, ["call_1"], []),
    [],
  );
});

test("missing evidence defaults to tool", () => {
  assert.deepEqual(checkTodoConsistency({ status: "completed", linkedToolCalls: [] }, [], []), [
    "completed_without_evidence",
  ]);
});

test("in_progress spanning turns is not a false positive", () => {
  // 진입 턴에 호출이 있었으면 이후 턴에 호출이 없어도 경고 없음
  assert.deepEqual(
    checkTodoConsistency({ status: "in_progress", linkedToolCalls: ["call_1"] }, ["call_1"], ["call_1"]),
    [],
  );
});

test("in_progress entered with no tool calls warns", () => {
  assert.deepEqual(checkTodoConsistency({ status: "in_progress", linkedToolCalls: [] }, [], ["call_x"]), [
    "in_progress_without_evidence",
  ]);
});

test("invalid status and malformed input fail detectably", () => {
  assert.deepEqual(checkTodoConsistency({ status: "done" }, [], []), ["invalid_status"]);
  assert.deepEqual(checkTodoConsistency(null, [], []), ["invalid_todo"]);
});

test("todo contract declares statuses, evidence, and upstream event names", () => {
  assert.deepEqual(TODO_STATUSES, ["pending", "in_progress", "completed", "cancelled"]);
  assert.deepEqual(TODO_EVIDENCE, ["tool", "none"]);
  assert.equal(TODO_EVENTS.updated, "todo.updated");
  assert.equal(TODO_EVENTS.inconsistent, "todo.inconsistent");
});
```

- [ ] **Step 3: 실행 + 커밋**

Run: `node --test tests/phase2-todo-contract.test.mjs`
Expected: 8 pass.

```bash
git add contracts/src/todo-sync.mjs contracts/src/index.mjs tests/phase2-todo-contract.test.mjs
git commit -m "feat(contracts): evidence-aware todo sync contract with upstream event names (§4.8)"
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
- Modify: `contracts/src/harness.mjs`
- Create: `upstream/packages/opencode/test/tool/registry-permission.test.ts`
- Create: `tests/phase2-harness-runtime.test.mjs`

> **정정(P0-2):** 이전 초안의 `decision !== "deny"`는 **fail-open**이다(알 수 없는 판정도 노출). §3.4 불변식(`Execute = ValidInput ∧ PluginAllow ∧ PolicySatisfied ∧ PermissionAllow`)과 맞추려면 **명시적 `allow`/`ask`만 노출**해야 한다.

> **검증된 사실(중요):** `Permission.evaluate`(`core/src/permission.ts:21-34`)는 규칙이 없으면 `{ action: "ask", permission, pattern: "*" }` **폴백을 반환**한다. 즉 `action`은 항상 `"allow" | "deny" | "ask"`이므로 `undefined`는 정상 경로에서 나오지 않는다. 따라서 방어 코드는 **타입 시스템 밖 입력(플러그인/설정/미래 확장)에 대한 방어**이며, 테스트로 고정한다.

- [ ] **Step 1: 계약에 포함 판정 함수 강화**

`contracts/src/harness.mjs`의 `resolveHarnessInclusion`을 이미 `allow`/`ask`만 include로 처리하도록 작성했다(Task 7). 여기에 **레지스트리 판정용 명시 함수**를 추가한다:

```js
/**
 * 도구 목록 노출 판정 — fail-closed. allow/ask 만 노출, 그 외 전부 제외.
 * 런타임의 Permission.evaluate 는 항상 유효한 action 을 반환하지만,
 * 방어적으로 알 수 없는 값도 제외한다.
 */
export function shouldExposeTool(decision) {
  return decision === "allow" || decision === "ask";
}
```

- [ ] **Step 2: 레지스트리 필터를 fail-closed로 변경**

`registry.ts`의 `tools()`에서 기존 `filtered` 체인 뒤에 추가한다(`tools(input)`은 `input.agent`를 받는다 — 73-80행):

```ts
.filter((tool) => {
  const decision = Permission.evaluate(tool.id, "*", input.agent.permission)?.action
  return decision === "allow" || decision === "ask"
})
```

> **주의(목록 ≠ 실행):** 목록 필터 통과는 **노출**일 뿐 실행 허가가 아니다. 실행 시점의 `ctx.ask`(`session/tools.ts:65-71`)와 §3.4 검사 순서는 **반드시 유지**한다.

- [ ] **Step 3: 목록 판정과 실행 판정의 Ruleset 차이 문서화**

> **검증된 사실:** 목록 필터는 `agent.permission`만 쓰지만, 실행 시 `ctx.ask`는 `Permission.merge(agent.permission, session.permission ?? [])`을 쓴다(`session/tools.ts:66-70`). 즉 **세션 레벨 규칙이 목록 필터에 반영되지 않는다**.

두 가지 중 하나를 선택한다(권장: 후자):
- (a) 목록도 세션 규칙을 포함 — `tools()`에 `sessionRuleset` 파라미터 추가. 호출부(`session/tools.ts:75-79`) 수정 필요.
- (b) **목록은 agent 기준(보수적 과노출 허용), 실행은 session 포함(엄격 차단)**. 세션 규칙으로 deny된 도구는 실행 시 차단되므로 **보안은 유지**되고, 목록에 보였다가 실행에서 거부되는 UX 비용만 발생한다.

Phase 2는 **(b)**를 채택한다. 이유: (a)는 `tools()` 시그니처 변경으로 5곳 이상 호출부를 흔들고, 세션 규칙 변경 시 목록 캐시 무효화 문제를 새로 만든다. (b)는 §3.4 불변식을 깨지 않는다. 이 결정을 게이트 문서에 "목록 과노출 허용(실행 차단 보장)"으로 기록한다.

- [ ] **Step 4: 런타임 테스트**

`test/tool/registry-permission.test.ts`:
- agent permission `{read: "deny"}` → `tools()` 결과에 `read` **없음**
- `{write: "ask"}` → `write` **있음**(ask는 노출)
- `{...}` 기본 → 정상 도구 노출
- 규칙 없음(빈 ruleset) → 폴백 `ask`이므로 **노출**(계약과 일치)

- [ ] **Step 5: 계약-런타임 대조 테스트**

`tests/phase2-harness-runtime.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { shouldExposeTool, resolveHarnessInclusion } from "@croakcode/contracts";

test("shouldExposeTool is fail-closed", () => {
  assert.equal(shouldExposeTool("allow"), true);
  assert.equal(shouldExposeTool("ask"), true);
  assert.equal(shouldExposeTool("deny"), false);
  assert.equal(shouldExposeTool(undefined), false);
  assert.equal(shouldExposeTool(null), false);
  assert.equal(shouldExposeTool("not_applicable"), false);
  assert.equal(shouldExposeTool("typo"), false);
  assert.equal(shouldExposeTool(""), false);
});

test("contract inclusion agrees with exposure for allow/ask/deny", () => {
  assert.equal(resolveHarnessInclusion("allow"), "include");
  assert.equal(resolveHarnessInclusion("ask"), "include_requires_approval");
  assert.equal(resolveHarnessInclusion("deny"), "exclude");
  assert.equal(shouldExposeTool("deny"), false);
});
```

- [ ] **Step 6: 실행 + 커밋**

Run: `cd upstream/packages/opencode && bun test test/tool/registry-permission.test.ts test/tool/registry.test.ts 2>&1 | tail -8`
Expected: 0 fail(기존 테스트는 기본 permission이 ask/allow이므로 영향 없음).

Run: `node --test tests/phase2-harness-runtime.test.mjs tests/phase2-harness-contract.test.mjs`
Expected: 2 + 4 = 6 pass (harness-contract 는 Task 7 Step 4 의 트리거 범위 테스트 포함 4개).

```bash
git add upstream/packages/opencode/src/tool/registry.ts upstream/packages/opencode/test/tool/registry-permission.test.ts contracts/src/harness.mjs tests/phase2-harness-runtime.test.mjs tests/phase2-harness-contract.test.mjs
git commit -m "feat(upstream): fail-closed tool exposure gate and harness contract parity (§4.7)"
```

### Task 11: TODO 정합성 검사 연결 (§4.8 구현)

**Files:**
- Modify: `upstream/packages/opencode/src/session/todo.ts`
- Modify: `upstream/packages/opencode/src/session/prompt.ts`
- Modify: `upstream/packages/opencode/src/session/session.sql.ts`
- Modify: `upstream/packages/opencode/src/tool/todo.ts`
- Modify: `upstream/packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- Create: `upstream/packages/opencode/test/session/todo-consistency.test.ts`
- Create: `upstream/packages/opencode/test/session/todo-subagent-isolation.test.ts`
- Create: `tests/phase2-todo-parity.test.mjs`

> **정정(P1-1):** `completed`인데 도구 호출이 없다고 무조건 경고하면 **정상 작업을 오탐**한다(설계 검토·분석·판단 등 도구 없이 완료되는 일). `evidence` 정책으로 구분한다. **정정(P1-2):** 이벤트는 upstream 규칙대로 **`todo.inconsistent`**(prefix 없음). contracts도 이 이름으로 통일한다.

> **검증된 사실:** TODO는 이미 전용 테이블 `TodoTable`(`session.sql.ts:93-109`)에 영속되고 `todo.updated`(`session/todo.ts:20-26`)를 발행한다. TUI는 `sync.tsx:213-214`에서 `todo.updated`를 구독한다. **없는 것**: `linkedToolCalls`, `evidence`, 정합성 검사, `todo.inconsistent`.

- [ ] **Step 1: 스키마 확장**

`session.sql.ts`의 `TodoTable`에 두 컬럼을 추가한다:
```ts
linkedToolCalls: text("linked_tool_calls").notNull().default("[]"),
evidence: text("evidence").notNull().default("tool"),
```

> **검증된 사실:** upstream은 drizzle `db:generate` 스크립트가 **없다**. 마이그레이션은 `upstream/packages/opencode/migration/<timestamp>_<name>/migration.sql` 디렉터리로 관리되고 `storage/db.ts:72-117`의 `migrations(dir)`가 적용한다. **수동 추가**한다.

새 디렉터리 `migration/<YYYYMMDDHHMMSS>_todo_evidence/migration.sql`:
```sql
ALTER TABLE `todo` ADD COLUMN `linked_tool_calls` text NOT NULL DEFAULT "[]";
ALTER TABLE `todo` ADD COLUMN `evidence` text NOT NULL DEFAULT "tool";
```
Run: `grep -n TodoTable upstream/packages/opencode/src/session/session.sql.ts`
Expected: 테이블 실제 이름 확인(`todo`가 아니면 SQL 수정).

- [ ] **Step 2: Todo.Info 확장 + 이벤트 정의**

`session/todo.ts`:
```ts
export const Info = Schema.Struct({
  content: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
  priority: Schema.optional(Schema.String),
  linkedToolCalls: Schema.optional(Schema.Array(Schema.String)),
  evidence: Schema.optional(Schema.Literals(["tool", "none"])),
})

export const Event = {
  Updated: BusEvent.define("todo.updated", Schema.Struct({ sessionID: SessionID, todos: Schema.Array(Info) })),
  Inconsistent: BusEvent.define(
    "todo.inconsistent",
    Schema.Struct({ sessionID: SessionID, todo: Info, warnings: Schema.Array(Schema.String) }),
  ),
}
```

- [ ] **Step 3: 정합성 판정 (evidence 기반)**

`session/todo.ts`에 upstream 내부 헬퍼를 둔다(contracts import 금지 — 의존 규칙):
```ts
export function consistencyWarnings(todo: Info, turnCalls: string[], turnStartCalls: string[]): string[] {
  const warnings: string[] = []
  const evidence = todo.evidence ?? "tool"
  const linked = todo.linkedToolCalls ?? []
  if (evidence === "tool" && todo.status === "completed" && linked.length === 0) {
    warnings.push("completed_without_evidence")
  }
  // in_progress 는 턴 단위로 판정하지 않는다: 이 TODO 가 in_progress 로 진입한 턴에
  // 도구 호출이 전혀 없었던 경우만 경고(여러 턴 진행 오탐 방지).
  if (evidence === "tool" && todo.status === "in_progress") {
    const calledInEntryTurn = turnStartCalls.some((id) => linked.includes(id))
    if (turnStartCalls.length > 0 && !calledInEntryTurn && linked.length === 0) {
      warnings.push("in_progress_without_evidence")
    }
  }
  return warnings
}
```
> `evidence: "none"` 항목은 **항상 경고 없음**. `turnStartCalls`는 TODO가 `in_progress`로 바뀐 턴의 도구 호출이며, 호출부가 계산해 넘긴다(Step 4).

- [ ] **Step 4: 턴 종료 검사 연결**

> **검증된 사실:** `prompt.ts` layer(100-130행)에 `Todo.Service`가 **주입되어 있지 않다**. 먼저 추가한다.

`prompt.ts` import에 `import { SessionTodo } from "./todo"` 추가, layer에 `const todos = yield* SessionTodo.Service` 추가. 오케스트레이션 루프의 턴 종료 지점(`prompt.ts:1498`의 `compaction.prune` 직전)에:
```ts
const allTodos = yield* todos.get(sessionID)
const turnCalls = msgs
  .flatMap((m) => m.parts.filter((p): p is MessageV2.ToolPart => p.type === "tool"))
  .map((p) => p.callID)
for (const todo of allTodos) {
  const warnings = SessionTodo.consistencyWarnings(todo, turnCalls, turnCalls)
  if (warnings.length) yield* bus.publish(SessionTodo.Event.Inconsistent, { sessionID, todo, warnings })
}
```

- [ ] **Step 5: 부작용 도구 자동 연결(보수적)**

`tool/todo.ts`의 `update` 호출 시, `linked_tool_calls`를 보존하고 **자동 귀속은 하지 않는다**(추측 금지). 모델이 명시한 경우만 연결한다 — `todowrite` 파라미터에 `linkedToolCalls`(선택)를 추가해 모델이 명시할 수 있게 한다.

> 근거: 자동 귀속은 "in_progress 항목이 2개 이상이거나 턴에 TODO 변경이 없으면 연결 불가"라는 모호성이 있어, **명시 우선 + 미명시 시 경고**가 §3.4의 관측 원칙과 더 잘 맞는다. 자동 귀속이 필요하면 Phase 3에서 턴 컨텍스트 기반으로 재검토한다.

- [ ] **Step 6: TUI 구독 정합**

`sync.tsx`에서 `todo.inconsistent`를 구독해 경고를 표시(토스트 또는 배지)한다. 기존 `todo.updated` 구독(213-214행)은 유지.

- [ ] **Step 7: 테스트 — 오탐 방지 포함**

`test/session/todo-consistency.test.ts`:
- `evidence:"tool"` + `completed` + linked 없음 → `todo.inconsistent` 발행
- `evidence:"none"` + `completed` + linked 없음 → **발행 없음**(오탐 방지, P1-1 핵심)
- `evidence:"tool"` + `completed` + linked 있음 → 발행 없음
- 여러 턴에 걸친 `in_progress`(진입 턴에 도구 호출 있었음) → 발행 없음
- `in_progress` 진입 턴에 도구 호출 전무 → 발행

`test/session/todo-subagent-isolation.test.ts`:
- 부모 세션에서 서브세션을 생성하고 서브세션에 TODO를 넣은 뒤, `todos.get(parentID)`에 서브세션 TODO가 **없음**을 확인(`TodoTable`이 `session_id` FK로 분리되므로 구조적으로 보장 — 테스트로 증명).
- 서브세션에서 `todo.inconsistent`가 발행되면 `sessionID`가 서브세션 id임을 확인.

`tests/phase2-todo-parity.test.mjs` (계약-구현 대조):
- `contracts.checkTodoConsistency`와 upstream `consistencyWarnings`가 **같은 입력에 같은 경고 라벨**을 내는지 비교(`evidence` 포함). upstream 로직을 문자열로 복제하지 않고, **계약 함수를 기준으로 기대값을 고정**한다.

Run: `cd upstream/packages/opencode && bun test test/session/todo-consistency.test.ts test/session/todo-subagent-isolation.test.ts test/session/prompt.test.ts 2>&1 | tail -8`
Expected: 0 fail.

- [ ] **Step 8: 커밋**

```bash
git add -A upstream/packages/opencode contracts/src/todo-sync.mjs tests/phase2-todo-parity.test.mjs
git commit -m "feat(upstream): evidence-aware todo consistency with todo.inconsistent (§4.8)"
```

### Task 12: compaction body-idle guard 구현 (§4.9 구현)

**Files:**
- Modify: `upstream/packages/opencode/src/session/processor.ts`
- Modify: `upstream/packages/opencode/src/session/compaction.ts`
- Modify: `upstream/packages/core/src/flag/flag.ts` (또는 config 스키마)
- Create: `upstream/packages/opencode/test/session/compaction-idle-timeout.test.ts`
- Create: `upstream/packages/opencode/test/session/stream-idle-timeout.test.ts`

> **정정(P0-1):** 이전 초안은 `Effect.timeoutOption`을 idle guard로 썼으나, 그것은 **전체 실행 시간** 제한이다(델타가 계속 와도 120초에서 중단 → 요구사항 위배). **검증된 사실:** `Stream.timeout(duration)`의 Effect 문서 정의는 *"Ends the stream if it does not produce a value within the specified duration"* — 즉 **마지막 델타 이후 idle 간격** 감시다. 적용 지점은 `processor.ts:791-795`의 스트림 파이프라인이다.

- [ ] **Step 1: idle 타임아웃 설정 추가**

`core/src/flag/flag.ts`에 추가:
```ts
get CROAKCODE_STREAM_IDLE_TIMEOUT_MS() {
  const v = Number(process.env["CROAKCODE_STREAM_IDLE_TIMEOUT_MS"])
  return Number.isFinite(v) && v >= 0 ? v : undefined
}
get CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS() {
  const v = Number(process.env["CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS"])
  return Number.isFinite(v) && v > 0 ? v : undefined
}
```
Phase 3에서 config 파일(`compaction.idleTimeoutMs`, `stream.idleTimeoutMs`)로 승격한다. Phase 2는 env로 충분하다.

- [ ] **Step 2: 스트림 파이프라인에 `Stream.timeout` 추가**

`processor.ts:791-795`를 수정한다. `handleEvent`는 **이벤트 도착 시마다** 실행되므로, `Stream.tap` 앞에 `Stream.timeout`을 두면 마지막 이벤트 기준 idle을 잡는다.

```ts
const idleMs = input.idleTimeoutMs   // SessionProcessor.process 입력에 추가(아래 Step 3)
const stream = idleMs && idleMs > 0
  ? llm.stream(streamInput).pipe(Stream.timeout(Duration.millis(idleMs)))
  : llm.stream(streamInput)

yield* stream.pipe(
  Stream.tap((event) => handleEvent(event)),
  Stream.takeUntil(() => ctx.needsCompaction),
  Stream.runDrain,
)
```
> **중요:** `Stream.timeout`은 값을 내지 않으면 스트림을 **정상 종료**한다(에러 아님). 따라서 **정상 종료와 idle 종료를 구분**해야 한다. Step 3에서 `takeUntil`과 결합해 플래그로 판별한다.

- [ ] **Step 3: 정상 종료 vs idle 종료 구분**

`Stream.timeout`은 종료 사유를 노출하지 않으므로, **마지막 이벤트 수신 시각**을 기록해 판별한다:

```ts
let lastEventAt = Date.now()
yield* stream.pipe(
  Stream.tap((event) => {
    lastEventAt = Date.now()
    return handleEvent(event)
  }),
  Stream.takeUntil(() => ctx.needsCompaction),
  Stream.runDrain,
)
// Stream.timeout 이후엔 스트림이 '정상 종료'하므로, 마지막 이벤트로부터 idleMs 경과 여부로 판별한다.
// (구현 시 Stream.timeout 종료와 자연 완료를 구분하는 sentinel 을 쓸 수 있으나, 아래 조건으로도 충분)
const idleTimedOut = idleMs > 0 && Date.now() - lastEventAt >= idleMs && !ctx.needsCompaction
if (idleTimedOut) {
  yield* halt(new StreamIdleTimeoutError({ idleMs }))
  yield* status.set(ctx.sessionID, { type: "idle" })
  ctx.idleTimedOut = true
}
```
> `halt`은 `processor.ts:751`의 기존 헬퍼로, assistant 메시지를 `error`로 마감한다. `ctx.idleTimedOut`을 `Result` 판정에 반영해 `compaction.process`가 재시도하지 않게 한다.

- [ ] **Step 4: compaction 입력에 기본 idle 타임아웃 주입**

`compaction.process`(344행)에서 `processor.process({...})` 호출 시 `idleTimeoutMs`를 넘긴다:
```ts
const idleMs = Flag.CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS ?? 120_000   // compaction 은 기본 항상 on
const result = yield* processor.process({ ...input, idleTimeoutMs: idleMs })
if (ctx.idleTimedOut) return "stop"   // 재시도 금지
```
일반 턴(`prompt.ts`의 `processor.process` 호출)은 `Flag.CROAKCODE_STREAM_IDLE_TIMEOUT_MS ?? 60_000`을 넘긴다(§4.9: 기본 60초, 0이면 off).

- [ ] **Step 5: 테스트 — 정상 장시간 스트림이 중단되지 않음 + idle 중단**

`test/session/stream-idle-timeout.test.ts`:
- 델타를 `idleMs`보다 짧은 간격으로 계속 내는 스트림 → **중단되지 않음**(회귀 방지, P0-1 핵심).
- `idleMs` 이상 델타가 없는 스트림 → `STREAM_IDLE_TIMEOUT`으로 종료.

`test/session/compaction-idle-timeout.test.ts`:
- compaction 무응답 → `finish: "error"`, 세션 `idle` 복귀, **재시도 없음**(`processor.process` 호출 1회).
- compaction이 계속 델타를 내는 경우 → 정상 완료(오탐 없음).
- abort 시 `running` 도구가 있으면 §4.5대로 `unknown` 복구되는지 확인.

Run: `cd upstream/packages/opencode && bun test test/session/stream-idle-timeout.test.ts test/session/compaction-idle-timeout.test.ts test/session/compaction.test.ts 2>&1 | tail -8`
Expected: 0 fail.

- [ ] **Step 6: 커밋**

```bash
git add upstream/packages/opencode/src/session/processor.ts upstream/packages/opencode/src/session/compaction.ts upstream/packages/core/src/flag/flag.ts upstream/packages/opencode/test/session/stream-idle-timeout.test.ts upstream/packages/opencode/test/session/compaction-idle-timeout.test.ts
git commit -m "feat(upstream): body-idle guard via Stream.timeout with STREAM_IDLE_TIMEOUT (§4.9)"
```

---

## Chunk 5: 회귀 + Phase 2 게이트

### Task 13: 전체 회귀 스크립트 + 동등성 증거 매트릭스

**Files:**
- Create: `scripts/phase2-gate-replay.sh`
- Create: `docs/superpowers/phase0/phase2-equivalence-matrix.md`

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

- [ ] **Step 2: 동등성 증거 매트릭스 작성 (검토 지적 반영)**

> **검토 지적 반영 (P1 Task 13):** "회귀 스크립트 실행"은 §6 A+B 동등성 *증명*이 아니다. 실행 결과가 §6.1(A)/§6.2(B)의 어느 행을 증명하는지 1:1로 매핑해야 한다. Phase 2가 실제로 관측 가능한 **증거**를 남긴다.

`docs/superpowers/phase0/phase2-equivalence-matrix.md`에 다음 표를 작성한다(상태 기준은 spec §6.6: PASS/FAIL/NOT TESTED/ACCEPTED DEVIATION):

```md
# Phase 2 동등성 증거 매트릭스 (§6.1 A + §6.2 B)

Spec 기준: §6.1, §6.2, §6.5, §6.6. 상태는 **실행 증거**로만 채운다.

## A. opencode 코어 동작 (§6.1)

| 동작 | Phase 2 증거(테스트/스크립트) | 상태 |
|---|---|---|
| 세션 생성/재개/중단 | `tests/phase1-session.e2e.test.mjs`, `scripts/phase1-headless-check.sh` | (실행 후 기록) |
| 스트리밍 | `scripts/phase2-gate-replay.sh`의 `bun test test/session`, Task 12 `stream-idle-timeout.test.ts` | (실행 후 기록) |
| 멀티턴 | `tests/phase1-session.e2e.test.mjs` | (실행 후 기록) |
| compaction/autocontinue | Task 12 `compaction-idle-timeout.test.ts` + `bun test test/session` | (실행 후 기록) |
| 도구 전체(read/write/edit/grep/glob/bash/task/webfetch/websearch) | `bun test test/tool`, Task 10 `registry-permission.test.ts` | (실행 후 기록) |
| 권한 모드(auto/ask) | Task 6 `tests/contracts.conformance.test.mjs`(permission.mode), Task 10 | (실행 후 기록) |
| provider/모델 설정 | `bun test test/provider`, Task 3/4 zen 제거 후 회귀 | (실행 후 기록) |
| agents/subagents | `bun test test/skill` | (실행 후 기록) |
| 슬래시 명령 | `bun test test/cli/help` | (실행 후 기록) |
| TUI 슬롯/키맵 | Task 6 `tui-surface` 계약 테스트 | (실행 후 기록) |

## B. 패치 8개 동작 (§6.2)

| 패치 | Phase 2 증거 | 상태 |
|---|---|---|
| 0001 permission mode/auto-follow/run footer | Task 6(contracts) + §6.5 신규 스냅샷(NOT TESTED→Phase 3 수동) | (기록) |
| 0002 queued→steering 명칭 | §6.5 신규 단위(Phase 3 이관 명시) | (기록) |
| 0003 `cc resume` | `scripts/phase1-cli-check.sh` | (실행 후 기록) |
| 0004 SSE 타임아웃 전/후 | Task 12 idle guard + `bun test test/session` | (실행 후 기록) |
| 0005 WSL/CJK | Phase 3 이관(명시) | ACCEPTED DEVIATION(Phase 3) 또는 NOT TESTED |
| 0006 footer 슬롯 | Task 6 `tui-surface` 계약 | (실행 후 기록) |
| 0007 permission.mode 노출 | Task 6 계약 + 기존 TUI | (실행 후 기록) |
| 0008 CJK 타이틀 절단 | Phase 3 수동 스냅샷(명시) | NOT TESTED(Phase 3) |

> Phase 2에서 아직 **NOT TESTED**로 남기고 Phase 3으로 **명시 이관**하는 행은 gate 문서(Phase 2 Gate)의 defer 목록과 일치해야 한다. 필수 기능(spec §6.6)이 `FAIL`/`NOT TESTED`면 Phase 3 게이트에서 차단된다.
```

- [ ] **Step 3: 실행**

Run: `bash scripts/phase2-gate-replay.sh`
Expected: 마지막 줄 `PASS: phase 2 gate replay`. 중간 실패가 있으면 해당 Chunk로 돌아간다. 실행 후 **위 매트릭스의 상태 칸을 실행 결과로 갱신**한다.

> 주의: `tests/phase1-session.e2e.test.mjs`·`phase1-sqlite.e2e.test.mjs`는 headless 선행이 필요하므로 스크립트에서 headless를 먼저 돈다(위 순서 유지).

- [ ] **Step 4: 커밋**

```bash
git add scripts/phase2-gate-replay.sh docs/superpowers/phase0/phase2-equivalence-matrix.md
git commit -m "test(phase2): full regression replay + §6 A/B equivalence evidence matrix"
```

### Task 14: Phase 2 게이트 문서

**Files:**
- Create: `docs/superpowers/phase0/phase2-gate.md`

- [ ] **Step 1: 문서 작성**

`docs/superpowers/phase0/phase2-gate.md`:
```md
# Phase 2 Decision Gate — 코어 독립화 및 기존 동작 흡수

Spec: `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md` §8.3
Evidence: `docs/superpowers/phase0/phase2-equivalence-matrix.md` (§6.1 A + §6.2 B)

- [ ] upstream help snapshots regenerated for `cc` (`bun test ... -u`, 잔여 opencode 0)
- [ ] console/web packages removed; rebrand-check 전체 blocking PASS (삭제 영향도 사전 점검 증거 첨부)
- [ ] zen provider (id `opencode`) removed from catalog/loaders/transforms (`scripts/phase2-zen-check.sh` PASS, baseten 보존 교차검증)
- [ ] zen tier/upsell removed from TUI, retry, provider list (일반 재시도 테스트 4개 유지 확인)
- [ ] TUI slot + permission.mode promoted to contracts (patch 0006/0007)
- [ ] harness contract + deny-tools-hidden registry gate (§4.7) — fail-closed, 목록=`agent.permission`·실행=병합 ruleset
- [ ] harness refresh triggers: 런타임 연결 4종 / Phase 3 이관 2종 근거 기록 (§4.7)
- [ ] todo consistency (§4.8) — ① 서버 이벤트만 렌더 ② evidence:"tool"만 경고("none" 미경고) ③ 턴 경계 오탐 없음 ④ resume 복원 ⑤ 서브세션 격리 테스트 증명
- [ ] compaction body-idle guard via `Stream.timeout` (§4.9) — delta-gap idle, 기본 60s(stream)/120s(compaction always-on), 무재시도
- [ ] full regression replay PASS (`scripts/phase2-gate-replay.sh`)
- [ ] equivalence matrix: §6.1 A + §6.2 B 필수 기능 전부 PASS 또는 ACCEPTED DEVIATION (NOT TESTED 는 Phase 3 이관 명시분만 허용)

## Defer 목록 (Phase 3 이관, 명시)
- harness 트리거 `session_start`·`connection_mode_switch` 런타임 연결
- 패치 0005(WSL/CJK)·0008(CJK 타이틀 절단) 및 §6.5 미작성 신규 테스트 수동 검증
- DB-level §4.5 `run_state` 컬럼 (플러그인 이식과 함께)

## Gate result
Phase 3 approved only when every item is checked against real runs, and the equivalence matrix has no unresolved NOT TESTED on required features (§6.6).
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
- §4.8 TODO 동기화: (i) TUI는 서버 이벤트(`todo.updated`)만으로 렌더(낙관적 로컬 갱신 없음), (ii) `todo.inconsistent`가 `evidence:"tool"` 불일치에서 발생하고 `evidence:"none"`에서는 **발생하지 않음**, (iii) 턴 경계를 넘는 `in_progress`에 대해 오탐 없음, (iv) 재개 시 TODO 복원, (v) 서브세션 TODO 격리를 **테스트로 증명**.
- §4.9 Compaction idle guard: 본문 무응답이 `STREAM_IDLE_TIMEOUT`으로 abort, compaction은 기본 항상 켜짐, 무한 재시도 없음.
- Phase 0/1 계약 레이어 회귀 없음.

> **슬롯 콘텐츠는 Phase 3**: Phase 2는 계약 확정까지. 플러그인이 슬롯에 내용을 등록하는 것은 Phase 3.
> **DB-level §4.5 매핑은 계속 deferred**: upstream `part`가 ToolState를 `data` JSON에 저장하므로 `run_state` 컬럼 추가는 Phase 3의 플러그인 이식과 함께 판단한다.

## Scope note

Phase 2는 **upstream 코어 정리 + 런타임 게이트 3종 + 계약 승격**이다. gate/admin 어댑터 실구현·croak-auth 연동·HWP 도구·사용량 패널은 Phase 3/4. 실제 LLM 호출 검증은 Phase 1과 동일하게 로컬 vLLM 또는 croak-gate 설정이 필요하며, Phase 2 게이트의 자동 항목에는 포함하지 않는다.

---

## 부록 1 — 리뷰 지적별 판정 결과 (확인 / 부분 확인 / 반박)

> 아래 판정은 **실제 upstream 코드 경로 확인**에 근거한다. "반박"은 검토 주장이 코드 사실과 어긋날 때만 사용한다.

| ID | 검토 지적 | 판정 | 근거(코드 경로/증거) | 계획 반영 |
|---|---|---|---|---|
| P0-1 | Task 12가 `Effect.timeoutOption`을 idle guard로 씀(= 전체 실행시간 상한) | **확인** | `effect@4.0.0-beta.66` `Stream.d.ts`의 `Stream.timeout`: "stream이 주어진 기간 내에 값을 산출하지 않으면 종료" = **delta-gap idle**. `Effect.timeoutOption`은 총 실행시간 상한. `session/processor.ts:791-795`(Stream 파이프라인), `compaction.ts:344`(타임아웃 없음) | Task 12 전면 재작성 — `Stream.timeout`을 `Stream.tap(handleEvent)` **앞**에 삽입, `lastEventAt`/`ctx.idleTimedOut`로 정상 종료와 idle 종료 구분, "빈번한 delta가 있는 긴 스트림은 abort 금지" 회귀 테스트 |
| P0-2 | Task 10 `decision !== "deny"`는 fail-open | **확인(뉘앙스)** | `upstream/packages/core/src/permission.ts:21-34` `evaluate()`는 항상 유효한 `Rule` 반환(폴백 `{action:"ask"}`)이므로 보통 `undefined`는 안 나오나, 명시 allow/ask만 노출하는 fail-closed가 안전 | Task 10 `shouldExposeTool()` 추가(allow/ask만; undefined/null/오타/"" 제외) |
| P0-2b | 목록 필터 ruleset과 실행 ruleset 불일치(신규) | **확인** | `opencode/src/session/tools.ts:66-70`은 `Permission.merge(agent.permission, session.permission ?? [])`로 실행 권한 판정; `registry.tools()`(`registry.ts:316-361`)는 `agent.permission`만 사용 | Task 10 Step 3 — 목록=`agent.permission`(과노출 허용), 실행=병합 ruleset(차단 보장), §3.4 불변 유지. gate 문서에 "목록 과노출 허용(실행 차단 보장)" 결정 기록 |
| P1-1 | `completed` + 도구 호출 없음이 반드시 불일치는 아님 | **확인(spec 자체 수정)** | 분석/설계/판단 작업은 도구 없이 완결 가능. §4.8이 무조건 경고하면 오탐 | spec §4.8: `evidence:"tool"｜"none"` 추가, 경고 라벨 `completed_without_evidence`, `evidence:"none"`은 경고 안 함 |
| P1-2 | 이벤트명 불일치(`session.todo.inconsistent` vs upstream) | **확인** | `opencode/src/session/todo.ts:20-26`은 `todo.updated`(prefix 없음); TUI 구독 `sync.tsx:213-214` | spec §4.2 이벤트 표: `todo.updated`/`todo.inconsistent`로 정본화. 계약/런타임/TUI/테스트 모두 동일 명명 |
| P1-2b | 서브세션 TODO 격리 미검증 | **확인** | `session.sql.ts:93-109` `TodoTable`은 `session_id` FK로 세션별 분리 | Task 11 테스트에 서브세션 격리 케이스 추가 |
| P1 Task2 | 일괄 URL 치환이 비존재 엔드포인트 생성 | **확인** | 잔여 30여 파일(`packages/{app,enterprise,stats}`). 비소유 엔드포인트: `/desktop-feedback`(3), `/changelog*`, `/favicon*`, `/brand`, `/discord`, `/zen`, `/legal/*` | Task 2 Step 2(삭제 사전 점검) + Step 3(소유/비소유 분리, rewrite 금지) + Step 5(동등성 증거) |
| P1 Task4 | Go 테스트 삭제가 일반 회귀 커버리지 축소 | **부분 반박** | 일반 커버리지는 `retry.test.ts` L122(`too_many_requests`), L127(`resource_exhausted`), L132(unknown), L137(`code:123`→undefined)에 이미 존재. Go 전용은 L258/284/322 **3개뿐**. 검토가 "numeric error codes"를 Go 혼합으로 본 것은 오판(실제 일반 방어 테스트) | Task 4 Step 6 — Go upsell 3개만 제거, 일반 4개 **유지 명시** |
| P1 Task5 | `grep -qv 'baseten'`가 금지 히트를 가림 | **확인** | `transform.ts:1081-1082`: `baseten`/`"opencode"`가 같은 `if` 블록 인접 줄 | Task 5 Step 1 — 매치 단위 검사로 교체, baseten 줄이라도 `opencode` 토큰 있으면 실패. Step 3에 `baseten` 보존 교차검증 |
| P1 Task7 | `HARNESS_REFRESH_TRIGGERS` 선언만, 런타임 재산정 미연결 | **확인** | 계획에 재산정 경로 미기술 | Task 7 Step 4 — 런타임 연결 트리거(4) vs Phase 3 이관(2) 명시 + 계약 테스트 |
| P1 Task8/11 | contracts와 upstream TODO 로직 중복 | **확인(의존 규칙상 불가피)** | 의존 규칙: upstream은 contracts import 금지 | Task 8/11 — contracts는 descriptor+순수함수(테스트 소비), upstream은 내부 구현. `tests/phase2-todo-parity.test.mjs`로 **패리티** 보증 |
| P1 Task13 | 회귀 실행 ≠ §6 A+B 동등성 증명 | **확인** | 회귀 통과만으로 어느 §6 행을 증명했는지 불명 | Task 13 Step 2 — `phase2-equivalence-matrix.md`(§6.1/§6.2 행↔테스트 1:1, §6.6 상태) |
| P2 Task9/12 | spec §4.9 기본값(stream 60s on, compaction 120s always-on)과 계획 불일치 | **확인** | spec §4.9: `compaction.idleTimeoutMs` 120000 always-on, `stream.idleTimeoutMs` 60000 | Task 9 `STREAM_GUARD_DEFAULTS` 이미 일치(60s/120s/always-on, 0=명시 off), Task 12 Step 4와 동일 의미 |

---

## 부록 2 — 수정된 테스트 시나리오 (요약)

| 시나리오 | 파일/위치 | 핵심 단언 |
|---|---|---|
| harness 권한 게이트(fail-closed) | `tests/phase2-harness-contract.test.mjs`, `tests/phase2-harness-runtime.test.mjs`, `upstream/.../test/tool/registry-permission.test.ts` | `deny`/`undefined`/오타/`""` 도구는 모델 목록에 없음; `allow`/`ask`만 노출. 실행은 병합 ruleset으로 차단 |
| harness 트리거 연결 범위 | `tests/phase2-harness-contract.test.mjs`(Step 4 추가) | 런타임 연결 4 + Phase 3 이관 2 = 전체 트리거 |
| TODO 정합성(`evidence:"tool"`) | `tests/phase2-todo-contract.test.mjs`, `tests/phase2-todo-parity.test.mjs`, upstream todo 테스트 | 도구 증거 없는 `completed` → `todo.inconsistent` 발생 |
| TODO 정합성(`evidence:"none"`) | 동일 | `evidence:"none"`은 **경고 없음**(오탐 방지) |
| TODO 턴 경계 in_progress | 동일 | 이전 턴에서 시작된 `in_progress`는 그 턴에서 오탐 없음 |
| 서브세션 TODO 격리 | 동일(upstream) | 서브세션 TODO가 부모 세션 이벤트/상태에 누출되지 않음(§4.8) |
| TUI는 서버 이벤트만 렌더 | Task 11 TUI `sync.tsx` 구독 테스트 | `todo.updated` 수신 시 렌더, 낙관적 로컬 갱신 없음 |
| 스트림 idle(정상 vs abort) | `upstream/.../test/session/stream-idle-timeout.test.ts` | 빈번한 delta의 긴 스트림은 **abort 안 됨**(P0-1 회귀); 무응답은 `STREAM_IDLE_TIMEOUT` |
| compaction idle(always-on, no-retry) | `upstream/.../test/session/compaction-idle-timeout.test.ts` | 기본 120s로 abort, 재시도 없음, 세션 idle 복귀, `running` 도구 → `unknown`(§4.5) |
| zen 제거(baseten 보존) | `scripts/phase2-zen-check.sh`, `tests/phase2-zen-removal.test.mjs` | `opencode` 토큰 잔여 0, `baseten` 분기 보존 ≥ 1 |
| 일반 재시도 커버리지 보존 | `upstream/.../test/session/retry.test.ts` | `too_many_requests`/`resource_exhausted`/unknown/numeric 4개 유지 |
| §6 A+B 동등성 | `docs/superpowers/phase0/phase2-equivalence-matrix.md` | 각 행 상태를 실행 증거로 채움(PASS/FAIL/NOT TESTED/ACCEPTED DEVIATION) |

---

## 부록 3 — Phase 2 완료 조건 ↔ 테스트 증거 대응표

| 완료 조건 (§8.3) | 증거(테스트/스크립트) | 비고 |
|---|---|---|
| §6 A+B 동등성 PASS/ACCEPTED DEVIATION | `scripts/phase2-gate-replay.sh` + `phase2-equivalence-matrix.md` | 상태는 실행 후 기록 |
| zen/console 물리 제거 증명 | `scripts/phase2-zen-check.sh`, `tests/phase2-zen-removal.test.mjs` | `baseten` 보존 교차검증 포함 |
| 슬롯/`api.permission.mode` contracts 승격 | `tests/contracts.conformance.test.mjs`(Task 6) | 기존 export 불변, 추가만 |
| §4.7 deny 미노출 + fail-closed | `registry-permission.test.ts`, `phase2-harness-runtime.test.mjs`, `phase2-harness-contract.test.mjs` | 목록=`agent.permission`, 실행=병합 |
| §4.8 (i) 서버 이벤트 렌더 | Task 11 TUI 구독 테스트 | 낙관적 갱신 없음 |
| §4.8 (ii) evidence:"tool"만 경고 | `phase2-todo-contract.test.mjs`, `phase2-todo-parity.test.mjs` | "none" 미경고 |
| §4.8 (iii) 턴 경계 오탐 없음 | 동일 | |
| §4.8 (iv) 재개 시 복원 | TODO 재개 테스트 | |
| §4.8 (v) 서브세션 격리 증명 | upstream todo 격리 테스트 | `session_id` FK 기반 |
| §4.9 idle abort + always-on + 무재시도 | `stream-idle-timeout.test.ts`, `compaction-idle-timeout.test.ts` | `Stream.timeout` = delta-gap idle |
| Phase 0/1 계약 회귀 없음 | `node --test 'tests/*.test.mjs'`(≥45), Phase 1 CLI/headless | 기존 45건 불변 |

---

## 부록 4 — 구현 착수 가능 여부 최종 판정

**판정: 조건부 승인(Conditional Approval) → P0 항목 반영 완료 후 즉시 착수 가능.**

근거:
1. **P0-1(핵심 오류) 해소.** Task 12가 `Effect.timeoutOption`(총 실행시간)에서 `Stream.timeout`(delta-gap idle)로 교체되었고, "빈번한 delta가 있는 긴 스트림은 abort 금지" 회귀 테스트가 명시됨.
2. **P0-2/P0-2b 해소.** fail-closed `shouldExposeTool` + 목록/실행 ruleset 불일치에 대한 결정(b: 목록 과노출 허용·실행 차단 보장)을 문서화.
3. **P1 항목 전부 반영.** 이벤트 명명(`todo.inconsistent`), `evidence:"none"` 오탐 방지, 서브세션 격리 테스트, URL 소유/비소유 분리, baseten 마스킹 방지, 트리거 연결 범위, parity 테스트, 동등성 증거 매트릭스.
4. **Task 9는 이미 spec §4.9와 일치**(60s 기본 on, 120s always-on, 0=명시 off) — 변경 불필요 확인.
5. **Phase 0/1 영향 분석:** 계약 `contracts/src/*`는 **추가만** 되고 기존 export는 불변. 기존 45개 테스트(및 Phase 1 CLI/headless)는 그대로 통과 예상. spec §4.8/§4.9 변경은 완료 조건(§8.3)과 이벤트 명명에만 영향하며, 구현 착수 전 게이트 문서 기준이 갱신됨.

**남은 전제조건(착수 전 확인):**
- Phase 1 게이트 전 항목 `[x]` 상태 유지(이 작업은 docs 전용, Phase 2 코드 미착수).
- Task 12 착수 시 `lastEventAt`/`ctx.idleTimedOut`가 `processor.ts`의 세션 컨텍스트에 배치 가능한지 실제 타입 확인 후 구현.
- Task 10 Step 3의 ruleset 병합 위치(`session/tools.ts`)가 `registry.tools()` 호출과 실행 시점을 공유하는지 착수 시 1회 재확인.

**결론: 계획 개정은 완료되었고, P0 지적이 모두 코드 근거로 수정되었으므로 Phase 2 구현 착수 가능. 구현은 별도 세션/워크트리(`phase2-core-absorption`)에서 실행한다.**
