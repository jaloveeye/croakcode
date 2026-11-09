# Phase 3 동등성 증거 매트릭스 (§6.3 C + §6.4)

> 상태 기준: PASS / FAIL / NOT TESTED / ACCEPTED DEVIATION (spec §6.6). **실행 증거로만 채운다.**
> 각 행의 상태는 아래에 기록된 실제 명령·출력으로만 확정한다. 추정 PASS 금지.

## local-stability reconciliation (§4.9)

- local-stability의 `experimental.session.compacting` 훅은 `output.prompt`만 설정하고 `system`/`context`를 건드리지 않는다.
- **정정(실측)**: `session/compaction.ts:404`는 `compacting.prompt ?? buildPrompt(...)`로 처리되어 plugin prompt가 코어 기본 prompt를 **대체**한다. 따라서 코어 기본 경로와 plugin prompt 사이에 append 충돌이 없다.
- `CROAKCODE_STREAM_IDLE_TIMEOUT_MS`/`CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS`는 변경되지 않으므로 §4.9 내장 idle guard는 독립적으로 유지된다.
- 근거: `tests/local-stability.test.mjs` 4 pass, `tests/phase2-stream-guard-contract.test.mjs` 4 pass.

## stall-recovery 폐기 결정 (§6.6 ACCEPTED DEVIATION)

- 타깃 내장 스트림 유휴 가드는 `StreamIdleTimeoutError`(`errorCode: "STREAM_IDLE_TIMEOUT"`)로 오류를 방출한다(`upstream/packages/opencode/src/session/message-v2.ts:55-60`, `:1116-1124`; `contracts/src/stream-guard.mjs:5`).
- 기존 stall-recovery는 `"SSE read timed out after response data was received"` **문자열 매치**로 탐지했다. 이 문자열은 타깃에서 더 이상 발생하지 않는다 → 기존 탐지 로직 무효.
- 재프롬프트는 `experimental.compaction.autocontinue`/재시도 규칙과 의미가 중복된다.
- **결정**: 폐기(ACCEPTED DEVIATION). 동일 기능이 아니며(“탐지 후 안전 중단” vs “스톨 후 재프롬프트”) 정책 변경임을 명시한다. 결함 아님. Phase 4에서 `metadata.code` 기반 재도입 검토.

## C. 커스텀 플러그인 동작

| 기능 | 증거 (실행 증거) | 상태 |
|---|---|---|
| croak-auth 세션/토큰 | `node --test tests/croak-auth-session.test.mjs` → **9 pass** | PASS |
| croak-auth 서버 토큰 주입 (3중 조건) | `node --test tests/croak-auth-server.test.mjs` → **6 pass** (로그인전/정상/미설정provider/URL불일치/direct/id) | PASS |
| gate-identity (x-croak-agent/session) | `node --test tests/gate-identity.test.mjs` → **2 pass** | PASS |
| local-stability (반복차단/qwen/compaction) | `node --test tests/local-stability.test.mjs` → **4 pass** | PASS |
| secret-paths | `node --test tests/secret-paths.test.mjs` → **5 pass** | PASS |
| tool-policy (`/net-off` `/net-on` `/tool-status`, deny) | `node --test tests/tool-policy.test.mjs` → **8 pass** | PASS |
| usage-meter (JSONL) | `node --test tests/usage-meter.test.mjs` → **4 pass** | PASS |
| usage-panel (슬롯 3종·order 90) | `bun test test/usage-panel` → **55 pass**; `test/plugins/usage-panel.test.ts` → **1 pass** | PASS |
| hwp-read / hwp_cli / hwp_memo | `node --test tests/hwp-read.test.mjs` → **12 pass**(래퍼 규칙). 2026-11-09 rhwp v0.8.7로 `node --test tests/hwp-read.rhwp.test.mjs` → **6 pass**(실제 실행). 이 검증에서 1쪽 문서의 쪽 읽기 결함을 찾아 고쳤다. `hwp_memo`는 같은 날 추가했다 | PASS |
| croak-auth TUI (/login /logout /whoami /agent-perm) | `bun test test/plugins/croak-auth-tui.test.ts` → **2 pass** (슬래시 4개+슬롯 2개); `node --test tests/croak-auth-tui-registration.test.mjs` → **2 pass** | PASS |
| stall-recovery | 폐기 결정 기록 | ACCEPTED DEVIATION |
| vendor/opencode-cache-hit | 폐기 결정 기록 (아래) | ACCEPTED DEVIATION |
| dev-safe + commands | `node --test tests/dev-safe-agent.test.mjs` → **2 pass** | PASS |
| 플러그인 자동 스캔/등록 | `node --test tests/plugin-registration.test.mjs` → **2 pass**; 실 로더 스모크 `--print-logs models` → `loading plugin` **7건**, 실패 로그 0건, exit 0 | PASS |

### vendor/opencode-cache-hit 폐기 결정

소스는 완전하나(3,484줄, `src/` 존재): (1) **테스트 부재** → §6.4 골든 테스트 미충족, (2) usage-panel과 `sidebar_content` **중복 렌더**(order 56 vs 90 — 충돌 아님), (3) usage-panel이 `hitRate`를 이미 제공. **폐기(ACCEPTED DEVIATION)**, Phase 4 재검토. 이식 시 peerDeps `@croakcode/*` 갱신·패널 중복 정리 필요.

## §6.4 수용 기준

| # | 기준 | 증거 | 상태 |
|---|---|---|---|
| 1 | 골든 동작 테스트 — 각 테스트 파일 통과 | Phase 0–2 계약 51 pass + 위 C 표 | PASS |
| 2 | UX 스냅샷 (슬롯/푸터/아바타/승인모드/타이틀) | 슬롯 등록 계약 테스트로 등록만 검증; 실제 렌더 UX는 수동 | NOT TESTED(수동) |
| 3 | 통합 E2E (로그인→세션→도구→정책차단→usage→스톨복구) | 부분: 로그인 세션(HTTP fixture)·정책차단(§5.4)·usage(usage-panel/meter)·gate→direct 컨텍스트 E2E 검증. 라이브 LLM 부팅 통합·스톨복구(폐기)는 미실행 | NOT TESTED(부분) |
| 4 | 패치 동작 단위테스트 (Phase 2) | Phase 2 결과 상속 — 51 pass 재실행 확인 | PASS |
| 5 | 수동 체크리스트 | 릴리스 게이트 항목, 본 세션 미수행 | NOT TESTED(수동) |

## 필수 기능 상태 (§6.6)

인증(croak-auth)·정책 차단(tool-policy/secret-paths/§5.4)·사용량 기록(usage-meter/usage-panel) = 위 표 기준 **PASS**. FAIL 없음. NOT TESTED 항목은 UX/E2E 수동 영역으로 명시.

## §5.4 우회 차단 5종

| # | 시나리오 | 증거 | 상태 |
|---|---|---|---|
| 1 | `force:gate` + direct 전환 거부 | `node --test tests/security-context.test.mjs tests/phase3-bypass.test.mjs` → **19 pass** (phase3-bypass 1) | PASS |
| 2 | direct + `requiresAuth` 실행 전 오류 | security-context + phase3-bypass(2, 실행계획 INVALID_INPUT) → 19 pass | PASS |
| 3 | 로컬 설정으로 서버 deny 완화 무시 | phase3-bypass(3/3b/3c: policy>permission, POLICY_DENIED/POLICY_UNAVAILABLE/PLUGIN_DENIED) → 19 pass | PASS |
| 4 | 인증 실패 시 direct 전환의 게이트 전용 토큰 차단 | phase3-bypass(4a) + **phase3-context-e2e(5)**: direct에서 `shouldAttachToken=false`, capture provider 수신 `authorization` 없음 | PASS |
| 5 | 전환 후 비밀 컨텍스트 재주입 없음 | 무-fixture E2E 8건으로 일반 응답, 압축, 하위 에이전트 결과를 검증했다. 상세는 "SEC-03 후속 수정"과 "하위 에이전트 결과 E2E"에 있다 | PASS |

실측 명령: `node --test tests/security-context.test.mjs tests/phase3-bypass.test.mjs tests/phase3-context-e2e.test.mjs` → **tests 19, pass 19, fail 0**
E2E는 변환을 손으로 만들지 않는다: `tests/fixtures/convert-history.ts`가 **프로덕션 `MessageV2.toModelMessages`를 호출**하고(node --test에서 TS import 불가하므로 bun 서브프로세스), 그 출력을 실제 HTTP로 capture provider에 전송한다. 프롬프트가 실제로 동일 필터를 호출하는지도 테스트가 소스에서 확인한다(복제 금지 검증).

## §4.5 복구

| 항목 | 증거 | 상태 |
|---|---|---|
| recovery 계약 | `node --test tests/recovery.test.mjs` (3) | PASS |
| Phase 1 복구 E2E | `node --test tests/phase1-recovery.e2e.test.mjs` (3) | PASS |

## 증거 정정 (2026-11-08, SEC-03 검토 후)

§5.4-5의 **"운영 경로 보호 완료" 주장을 철회**한다. 다음이 확인됨:

- `grep -rn "origin.*gate" upstream/packages/opencode/src` (테스트 제외) → **0건**. 런타임은 gate 턴의 text/reasoning/tool 파트에 `metadata.origin="gate"`를 **부여하지 않는다**.
- `SessionProcessor`의 text part metadata는 `value.providerMetadata`에서만 온다(`processor.ts:660,697`). Provider 응답이 출처를 정하지 않는다.
- 따라서 `filterMessagesForModeParts`는 실제 Gate 세션의 assistant 텍스트(태그 없음)를 **direct 모드에서 삭제하지 않고 통과**시킨다. 즉 **운영 경로에서 gate→direct 컨텍스트 차단은 현재 동작하지 않는다.**
- 기존 E2E는 **수동 태그 fixture**로만 증명했으므로 보호 범위를 과대평가했다. 수정 전 증거·테스트 이력은 이 문서와 `docs/superpowers/phase0/evidence/phase3-gate/`에 그대로 보존한다.
- 상태(정정 시점): §5.4-5 = **PASS(fixture 한정) / 운영 경로 NOT TESTED**. SEC-03 완료 전 Phase 3 제품 수용 HOLD였음. **후속 SEC-03 수정으로 런타임 스탬핑은 구현됨** — 아래 "SEC-03 수정" 참조. 단, 운영 경로 재전송 E2E는 여전히 fixture 한계가 남아 Phase 3 수용은 HOLD 유지.

## SEC-03 수정 (2026-11-08, 런타임 provenance 스탬핑)

위 정정에서 확인한 "런타임에 `origin:"gate"` 부여 경로가 없다"는 공백을 다음과 같이 닫았다(커밋 `2836e2c`, `ff94249`, `e1778f5`, `b4ed592`).

- **런타임이 턴 출처를 결정**: `SessionProcessor.create`는 필수 `origin: "gate" | "user"`를 받고, `prompt.ts` 루프가 `connectionFor(config).mode`에서 턴 출처를 계산한다. 모델/Provider 응답은 출처를 선택할 수 없다.
- **스탬핑 범위**: text-start(및 모든 delta/end 재스탬프), reasoning-start/delta/end, tool part metadata(`withOrigin`), compaction summary, background sub-agent 결과를 주입하는 synthetic user 메시지(`task.ts`).
- **Provider 덮어쓰기 불가**: 스탬핑은 provider metadata보다 항상 우선하며, delta/end에서 provider metadata를 재병합해도 `origin`을 재적용한다.
- **fail-closed 필터**: `isProtectedAssistantPart`는 `origin:"gate"` 또는 출처 불명(미스탬프/비신뢰 값) assistant 파트를 direct 모드에서 제거한다. 정상 사용자 입력은 과도 제거하지 않는다.
- **synthetic user 주입**: direct 모드에서 `origin:"gate"`로 스탬프된 user 파트(background sub-agent 결과)는 재전송에서 제외한다.
- **provider 본문 비유출**: `providerMeta`가 `origin`을 제거하며, text/reasoning 변환도 `providerMeta`를 경유한다(`b4ed592`).

검증:
- `node --test tests/sec03-origin.test.mjs tests/connection-context.test.mjs` → **16 pass**
- `node --test 'tests/*.test.mjs'` → **153 pass / 0 fail**
- `bun test test/session/processor-effect.test.ts` → **13 pass**
- typecheck(`tsgo`)는 SEC-01/02/03이 건드린 모든 파일에서 clean.

**남은 한계(정직한 표기)**: 런타임 스탬핑 경로 자체는 구현·검증됐으나, "실제 Gate 턴을 생성해 파트를 영속화한 뒤 direct로 재전송"하는 완전한 실경로 E2E는 아직 수동 태그 fixture(`convert-history.ts`)를 사용한다. 저장소 수준 실경로는 단위/소스 검사로, provider 차단은 fixture로 증명된 상태다.

## SEC-03 후속 수정 (2026-11-09, 압축 경로와 하위 에이전트 결과)

외부 리뷰가 SEC-03의 추가 경로 두 개를 지적했다. 압축 요청에 direct 필터가 없었고, 백그라운드 결과의 출처를 주입 시점의 모드로 정했다. 두 경로를 확인하려고 무-fixture E2E를 먼저 작성했다. 이 테스트는 `TestLLMServer`로 실제 HTTP 요청 본문을 받는다. 메시지는 실제 prompt 루프가 만들고, processor가 출처를 찍고, SQLite에 저장된다. 테스트가 바꾸는 값은 `connection.mode` 하나다.

수정 전에는 리뷰의 두 지적이 모두 재현됐고, 결함 하나가 더 나왔다(표 1). `step-start`, `step-finish`, `patch` part에는 스키마상 `metadata` 필드가 없어서 출처를 찍을 수 없다. 필터는 이런 part를 출처 불명으로 보고 assistant 메시지 전체를 버렸다. 이 때문에 direct 모드는 자기가 만든 응답까지 잃었다. 수동 태그 fixture는 text part만 담아서 이 결함을 드러내지 못했다.

| 시나리오 | 수정 전 | 수정 후 |
|---|---|---|
| direct 요청에서 gate 응답 제외 | 제외됨 | 제외됨 |
| direct 요청에서 direct 응답 유지 | 빠짐 (FAIL) | 유지 |
| direct 압축 요청에서 gate 원문 제외 | 포함됨 (FAIL) | 제외됨 |
| direct 압축에서 gate 이전 요약 제외 | 포함됨 (FAIL) | 제외됨 |
| gate 시작 백그라운드 결과를 direct 전환 뒤 주입 | `origin:"user"` (FAIL) | `origin:"gate"` |
| 하위 세션에 gate 내용이 있는 백그라운드 결과 | `origin:"user"` (FAIL) | `origin:"gate"` |
| 하위 세션에 gate 내용이 있는 동기 task 결과 | 출처 표시 없음 (FAIL) | 도구 part를 gate로 올림 |

표 1. SEC-03 후속 시나리오별 수정 전후 결과

조치는 다섯 가지다.

- 필터: `connection.js`에 `STRUCTURAL_PART_TYPES`를 두었다. 내용이 없는 네 종류(`step-start`, `step-finish`, `snapshot`, `patch`)만 출처 검사에서 뺐다. 나머지 종류는 출처가 없으면 계속 차단한다.
- 압축: `compaction.ts`가 연결 모드를 한 번 읽는다. 그 값으로 기록을 걸러낸 뒤에 이전 요약과 압축 대상을 고른다. 요약의 출처와 요청의 연결 모드도 같은 값을 쓴다.
- 하위 에이전트: `task.ts`가 시작 시점의 연결 모드를 보관한다. 결과의 출처는 이 값과 하위 세션 기록으로 정한다. 하위 세션에 gate 내용이나 출처 불명 내용이 있으면 결과도 gate로 본다. 하위 세션을 읽지 못하면 gate로 본다.
- 도구 결과: 도구가 `origin:"gate"`를 보고하면 processor가 도구 part의 출처를 gate로 올린다. 도구는 gate 턴의 출처를 `user`로 낮출 수 없다.
- 턴 스냅샷: `prompt.ts`는 단계마다 연결 모드를 한 번 읽는다. 출처 스탬프와 필터, 요청이 이 값을 함께 쓴다. 제목 생성 요청에도 같은 필터를 걸었다.

각 테스트는 수정 전후로 실행했고, 전체 스위트는 master와 비교했다.

- `bun test test/session/sec03-gate-direct-e2e.test.ts` → **5 pass** (수정 전 3 fail)
- `bun test test/tool/task.test.ts -t SEC-03` → **4 pass** (수정 전 3 fail)
- `bun test test/session/processor-effect.test.ts -t SEC-03` → **2 pass** (수정 전 1 fail)
- `node --test tests/sec03-origin.test.mjs` → **9 pass**
- 패키지 전체 `bun test`: 브랜치 3220 pass / 22 fail, master 3209 pass / 22 fail이다. 실패 목록이 같아서 신규 회귀는 0건이다.
- 루트 `node --test 'tests/*.test.mjs'`: 브랜치 153 pass / 2 fail, master 151 pass / 2 fail이다. 실패 2건은 두 쪽 모두 `phase1-sqlite.e2e`다.
- `tsgo --noEmit`: 브랜치와 master 모두 73건이다. 전부 `usage-panel`과 `croak-auth-tui`의 기존 JSX 오류다.

direct 모드에서 압축하면 gate 기록은 요약에 들어가지 않는다. 압축 뒤에는 이전 기록이 숨겨지므로, 다시 gate로 전환해도 그 gate 기록은 요약으로 복원되지 않는다. 보안 쪽으로 기우는 동작으로 판단해 그대로 두었다.

## 하위 에이전트 결과 E2E (2026-11-09)

SEC-03 후속 수정 뒤에도 백그라운드 결과는 task 도구 단위에서만 검증한 상태였다. 이 공백을 닫으려고 `sec03-gate-direct-e2e.test.ts`에 prompt 루프 전체를 거치는 시나리오 세 개를 더했다.

부모와 하위 에이전트는 같은 공급자를 쓰고, 백그라운드 하위 에이전트는 부모와 동시에 요청을 보낸다. 그래서 응답 순서 대신 요청 본문으로 응답을 골랐다. 하위 에이전트 응답은 테스트가 모드를 바꿀 때까지 붙잡아 두었다.

| 시나리오 | 확인한 결과 |
|---|---|
| gate에서 시작한 백그라운드 작업을 direct 전환 뒤 주입 | 주입 메시지가 `origin:"gate"`이고, 이후 direct 요청에 하위 결과가 없다 |
| 순수 direct 백그라운드 작업 (대조군) | 주입 메시지가 `origin:"user"`이고, 다음 direct 요청에 하위 결과가 남는다 |
| 동기 task 실행 중 모드를 direct, gate, direct 순으로 전환 | 부모의 도구 part가 gate로 올라가고, direct 요청에 하위 결과가 없다 |

표 2. 하위 에이전트 결과 E2E 시나리오

새 시나리오가 결함을 잡는지 확인하려고 PR #8 이전 소스(`daf3922`)로 같은 파일을 실행했다. gate가 끼는 두 시나리오는 하위 결과가 `origin:"user"`로 분류되어 실패했다. 대조군은 통과했다. 현재 소스에서는 8건이 모두 통과한다.

이로써 리뷰가 제시한 SEC-03 무-fixture E2E 조건을 채웠다. Phase 3 보안 수용은 2026-11-10에 판정했다(아래 "보안 수용 판정").

## 보안 수용 판정 (2026-11-10)

2026-11-10에 사용자가 Phase 3 보안 수용을 판정했다. 판정 근거는 세 가지다.

- SEC-01, SEC-02, SEC-03과 SEC-03 후속 수정이 `master`에 병합되었다.
- 리뷰가 요구한 SEC-03 무-fixture E2E 8건이 통과했다.
- 회귀 시험 `scripts/phase2-gate-replay.sh`가 1176건 통과했고 실패는 0건이다(PR #31 시점).

이 판정으로 Phase 3 제품 수용 HOLD를 해제한다. §6.4의 2, 3, 5번 기준은 수동 확인 영역이라 NOT TESTED 상태를 그대로 둔다.

## SEC-01 수정 (2026-11-08, 현재 ruleset 우선)

`Permission.ask`가 ruleset 뒤에 과거 `always` 승인을 붙여 `findLast`로 판정해, 과거 승인이 현재 명시적 `deny`를 덮을 수 있었다(커밋 `790de4f`).

- 현재 ruleset 판정 우선: `deny`면 거부, `allow`면 허용.
- 저장된 `always` 승인은 현재 판정이 `ask`일 때만 적용.
- ruleset 내부 `findLast` 의미 유지.
- 정상 `always` 사용성 유지(ask + 저장 allow → 해소).
- `plan → general` 부모 deny 우회 불가.

검증: `bun test test/permission/next.test.ts` → **83 pass** (SEC-01 4건 수정 전 RED, 수정 후 GREEN).

## SEC-02 수정 (2026-11-08, 실행 Agent 기준 fail-closed)

`TaskTool`이 `session.agent`만으로 부모 agent를 도출해, 실제 실행 agent(`ctx.agent`)와 불일치하면 plan edit-deny가 누락됐다(커밋 `481d91d`).

- `mergeParentAgents`로 session 기록 agent와 실행 agent의 deny 규칙을 **합집합**으로 취한다(fail-closed).
- 부모 agent의 edit-class deny(Plan Mode)는 전달한다. 비-edit controller 자기 제한은 executor 권한을 지우지 않는다(#26700 유지).

검증: SEC-02 4건(session=build/ctx=plan, session 미기록/ctx=plan, session=plan/ctx=build, resume/ctx=plan) 수정 전 3건 RED, 수정 후 GREEN; `task + agent` 합계 **28 pass**.

## 잔여 리스크 / 명시적 미검증

- **Gate→Direct 실경로 재전송 E2E**: 일반 응답, 압축, 하위 에이전트 결과를 무-fixture E2E로 검증했다. 실제 Gate 서버 대신 `TestLLMServer`를 썼으므로 Gate 쪽 헤더와 인증은 이 E2E 범위 밖이다. direct 모드의 토큰 차단은 `phase3-context-e2e(5)`가 따로 검증한다.
- **rhwp 바이너리 검증(해소, 2026-11-09)**: rhwp v0.8.7(`~/.local/bin/rhwp`)로 검증했다. 대상은 `hwp_cli`의 `exit 0` 경로와 `hwp_read`의 요약, 쪽 읽기, 캐시다. 테스트는 `tests/hwp-read.rhwp.test.mjs`이고, 바이너리가 없으면 건너뛴다. 검증 중에 결함 하나를 찾았다. rhwp는 1쪽 문서를 쪽 번호 없이 `<이름>.md`로 내보낸다. 그런데 `sortPageFiles`는 `_001.md` 형식만 쪽 파일로 보았다. 그래서 1쪽 문서를 쪽 단위로 읽으면 "문서는 0쪽이다" 오류가 났다. 번호 없는 파일이 하나뿐이면 1쪽으로 읽도록 고쳤다.
- **플러그인 로더 경로 해석**: `src/session/llm/mode.ts`·`prompt.ts`가 `.croakcode/plugins/lib/connection.js`를 상대 경로로 import한다. Bun 런타임은 `upstream/.croakcode`(레벨 5)로 해석하고 `tsgo`는 `upstream/packages/.croakcode`(레벨 3)로 해석한다. `src/connection.d.ts` 모듈 선언으로 typecheck는 통과하나, 번들링 시 이 경로가 보존되는지는 패키지 빌드에서 확인 필요(Phase 4).
- **`cancel finalizes interrupted bash tool output`**: baseline(`2f9a1d8` 이전)에서도 실패하는 환경성 flake. 회귀 아님.
- **plugin.xai / parsePluginSpecifier 테스트**: `@opencode`→`@croakcode` 브랜딩 패치 관련 기존 실패(baseline 동일). 회귀 아님.
- **usage-panel typecheck 범위**: tsconfig `include`에 `usage-panel/**/*.ts`를 추가하지 않았다(원본 tsconfig 유지). `croak-auth-tui.tsx`는 `readPolicy` 결과 타입을 명시해 tsgo를 통과시킨다.

## Phase 3 gate replay 실측 (scripts/phase3-gate-replay.sh)

로그 보존: `docs/superpowers/phase0/evidence/phase3-gate/*.log`

| 스위트 | 결과 |
|---|---|
| phase2-regression (scripts/phase2-gate-replay.sh) | PASS — 1055 tests, 2 failures 모두 BASELINE_FAIL(rebrand stale). **359 pass** 1차 core + 재시도 없이 baseline 판정 |
| rebrand / zen removal | PASS |
| plugin-units-node (`node --test 'tests/*.test.mjs'`) | **145 pass / 0 fail** |
| plugin-units-bun (`bun test tests`) | **145 pass / 0 fail** |
| usage-panel (`bun test test/usage-panel`) | **55 pass / 0 fail** |
| plugin-registration-tests (`bun test test/plugins`) | **3 pass / 0 fail** |
| bypass-unit (security-context + phase3-bypass) | **15 pass / 0 fail** |
| bypass-e2e (phase3-context-e2e) | **4 pass / 0 fail** |
| connection-mode | **8 pass / 0 fail** |
| recovery (recovery + phase1-recovery.e2e) | **6 pass / 0 fail** |
| contracts (§3.4/§4.8/§4.9/§4.7 등) | **46 pass / 0 fail** |
| typecheck (`tsgo --noEmit`) | PASS (출력 없음) |
| loader-smoke (`scripts/phase3-loader-smoke.sh`) | PASS — 7개 서버 플러그인 자동 스캔·로드, 실패 로그 0 |

> gate 스크립트는 각 단계를 `tee`로 로그 보존하며 `PIPESTATUS[0]`로 원래 종료 코드를 검사한다.
> `load plugin` 0건이면 FAIL, `failed to load plugin|must export id|...` 라인 존재 시 FAIL.
