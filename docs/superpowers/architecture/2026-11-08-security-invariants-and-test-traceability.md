# Security Invariants & Test Traceability (Agent Principal & Delegation)

- **상태**: Proposed (설계 승인 대기 — 런타임 구현 없음)
- **날짜**: 2026-11-08
- **관련 문서**:
  - ADR: `docs/superpowers/adr/0001-agent-principal-and-delegation.md`
  - 위임 아키텍처: `docs/superpowers/architecture/2026-11-08-agent-principal-delegation.md`
  - Phase 3 계획: `docs/superpowers/plans/2026-11-08-phase3-plugin-port.md`
  - 설계 명세 §6.6 상태 기준: `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md`

> 이 문서는 위임 모델의 **보안 불변식**과 이를 검증하는 **테스트 추적표**를 고정한다. **가짜 PASS 금지** — 각 행은 **정확히 하나의 상태**만 가진다.

## 상태 정의 (§6.6 정본 + 확장)

설계 명세 §6.6의 정본 상태는 **PASS / FAIL / NOT TESTED / ACCEPTED DEVIATION** 4종이다(`specs/…-design.md:542-546`). 이 문서는 위임 모델 특성상 **`FUTURE CONTRACT`를 추가 확장**한다(§6.6에는 없는 상태임을 명시 — "정합"이라 주장하지 않는다).

| 상태 | 의미 | 출처 |
|---|---|---|
| **PASS** | 테스트/검증이 실제로 통과함을 **이 문서 작성 시 실행**해 확인(명령 + 결과 필수). | §6.6 정본 |
| **FAIL** | 검증이 존재하고 실행했으나 실패. | §6.6 정본 |
| **NOT TESTED** | 검증이 아직 **없거나**, 존재하나 **이 작업에서 실행/기록하지 않음**. | §6.6 정본 |
| **ACCEPTED DEVIATION** | 의도적 차이(사유·영향 기록, 사용자 승인). | §6.6 정본 |
| **FUTURE CONTRACT** | Phase 4에서 구현될 계약. 현재 런타임에 개념 자체가 없음. (§6.6에 없는 **확장** 상태) | 본 문서 확장 |

- **금지**: 근거 없는 **PASS**. 코드 확인만으로 PASS라 쓰지 않는다 — **테스트 실행 명령과 결과**가 있어야 PASS.
- **코드 확인**(확인된 사실)은 PASS의 근거가 아니다 — 상태는 테스트 기준이다. 코드 근거는 비고란에만 적는다.
- **복합 상태 금지**: `FAIL / NOT TESTED` 같은 표기는 쓰지 않는다. 하나만 고르고, 나머지는 비고로.

---

## A. Agent Principal (AG)

### 불변식
- **AG-INV-1**: 신원(`principalId`, `role`)은 런타임이 발급한다. 모델 출력/프롬프트에서 신원을 신뢰하지 않는다.
- **AG-INV-2**: Definition ≠ Principal. Principal은 레지스트리에서 발급된 인스턴스만 존재한다.
- **AG-INV-3**: 모든 Run은 하나의 Principal을 참조한다(`runId → principalId`).
- **AG-INV-4**: Principal 철회 시 참조하는 Run은 중단된다.

### 테스트 추적표
| ID | 검증 내용 | 상태 | 근거/비고 |
|---|---|---|---|
| AG-01 | 세션에 agent 이름이 저장되고 실행 시 메시지 단위 agent(`lastUser.agent`)가 사용된다(현재 동작 고정) | **NOT TESTED** | 코드 근거만 존재(`session.ts:209-221`, `prompt.ts:1334`). `test/agent/agent.test.ts`는 **Definition/config**를 검증할 뿐 세션 agent 저장·`lastUser.agent` 사용을 검증하지 않음 → 이 작업에서 해당 동작 테스트를 **실행/확인하지 않음**. "신원"이 아니라 "이름"임을 명시 |
| AG-02 | Principal 레지스트리가 런타임 발급 신원을 제공하고, 프롬프트/모델 출력에서 신원을 추출하지 않는다 | **FUTURE CONTRACT** | Phase 4. 현재 코드에 레지스트리 없음(확인된 사실) |
| AG-03 | Definition과 Principal이 분리되어 동일 Definition에서 복수 Principal 생성 가능 | **FUTURE CONTRACT** | Phase 4 |
| AG-04 | Run → Principal 참조가 정확히 1개(무결성) | **FUTURE CONTRACT** | Phase 4 |
| AG-05 | Principal 철회 시 참조 Run 중단 | **FUTURE CONTRACT** | Phase 4 |

---

## B. Delegation Grant (DG)

### 불변식
- **DG-INV-1**: 위임은 명시적 Grant 없이 성립하지 않는다(fail-closed).
- **DG-INV-2**: `childGrant.capabilities ⊆ parentGrant.capabilities`.
- **DG-INV-3**: `childGrant.scope ⊆ parentGrant.scope`.
- **DG-INV-4**: `childGrant.constraints`는 부모 제약을 약화할 수 없다.
- **DG-INV-5**: `childGrant.expiresAt ≤ parentGrant.expiresAt`.
- **DG-INV-6**: `childGrant.policyRevision ≥ parentGrant.policyRevision`.
- **DG-INV-7**: 위임 그래프는 순환 불가.
- **DG-INV-8**: 효과 권한 = `min(org, delegator, parentRun, ownPolicy, taskScope)` 교집합; 다중 경로는 교집합(union 금지).

### 테스트 추적표
| ID | 검증 내용 | 상태 | 근거/비고 |
|---|---|---|---|
| DG-01 | Grant 없이 위임(spawn) 시도 시 deny | **FUTURE CONTRACT** | Phase 4. 현재 task 도구는 Grant 개념 없음(확인된 사실) |
| DG-02 | `child.capabilities ⊆ parent.capabilities` | **FUTURE CONTRACT** | Phase 4 |
| DG-03 | `child.scope ⊆ parent.scope` 및 constraints 단조 강화 | **FUTURE CONTRACT** | Phase 4 |
| DG-04 | `expiresAt`/`policyRevision` 단조성 및 순환 그래프 거부 | **FUTURE CONTRACT** | Phase 4 |
| DG-05 | 효과 권한 교집합(min) 계산; 서브 에이전트 부모 권한 초과 불가 | **NOT TESTED** | 교집합 검사 테스트가 **존재하지 않음** → FAIL이 아니라 NOT TESTED. 코드 근거: 현재 런타임은 교집합이 아니라 `merge`(평탄)+`findLast`(마지막 우선) — `upstream/packages/core/src/permission.ts:21-35`(확인된 사실). 교집합 검사 없음(INV-8 미구현). Phase 3에서 통합 재현 테스트로 고정 필요 |
| DG-06 | 다중 위임 경로 union 증폭 금지(교집합) | **FUTURE CONTRACT** | Phase 4 |

---

## C. Revocation (RV)

### 불변식
- **RV-INV-1**: Grant/Principal 철회는 하위로 재귀 캐스케이드된다(누락 없음).
- **RV-INV-2**: 철회된 Grant/Principal은 실행 직전 검사에서 fail-closed.
- **RV-INV-3**: 철회는 감사 로그에 남는다.
- **RV-INV-4**: 오프라인 철회 지연 시 fail policy(권장: deny).

### 테스트 추적표
| ID | 검증 내용 | 상태 | 근거/비고 |
|---|---|---|---|
| RV-01 | Grant 철회 시 하위 Grant 전체 `revoked` 전파 | **FUTURE CONTRACT** | Phase 4. 현재 revocation 개념 없음(확인된 사실) |
| RV-02 | Principal 철회 시 발급 Grant 전체 + 참조 Run 철회 | **FUTURE CONTRACT** | Phase 4 |
| RV-03 | 철회된 Grant로 도구 실행 직전 deny(fail-closed) | **FUTURE CONTRACT** | Phase 4. 현재 실행 직전 검사는 `ctx.ask`뿐(`session/tools.ts:64-72`) |
| RV-04 | 오프라인 철회 지연 시 fail policy 준수 | **FUTURE CONTRACT** | Fail policy 미정의(ADR Decision Required). 상태는 FUTURE CONTRACT 단일 |
| RV-05 | `expiresAt` 도달 시 자동 expired 처리 + 실행 deny | **FUTURE CONTRACT** | Phase 4 |

---

## D. Context Isolation (CX)

### 불변식
- **CX-INV-1**: 서브 에이전트 Run은 부모 Session 전체 메시지를 무분별하게 상속하지 않는다.
- **CX-INV-2**: gate 전용 컨텍스트(`origin:"gate"`, `sensitivity:"secret"`)는 direct/위임 경계에서 제외.
- **CX-INV-3**: 서브 에이전트 도구 결과는 부모에게 정제된 형태로만 전달.
- **CX-INV-4**: Grant `scope`는 컨텍스트 접근 범위도 제한.

### 테스트 추적표
| ID | 검증 내용 | 상태 | 근거/비고 |
|---|---|---|---|
| CX-01 | `task` 도구가 자식에 `params.prompt`만 전달(부모 대화 전체 미주입) | **NOT TESTED** | 코드 근거(`task.ts:183-199`: `resolvePromptParts(params.prompt)`만 전달). `test/tool/task.test.ts`는 존재하나 이 작업에서 **실행 결과를 기록하지 않음** → NOT TESTED. Phase 3에서 실행해 PASS 확정 |
| CX-02 | gate context(`origin:"gate"`)가 direct 요청 조립 시 제외 | **NOT TESTED** | Phase 3 Task 16b(§5.4 시나리오 5 E2E)에서 검증 예정. 요청 조립 지점 `prompt.ts:1439-1445`(확인된 사실). 이 작업에서는 **실행하지 않음** |
| CX-03 | 다중 위임 경로 간 교차 컨텍스트 누수 없음 | **FUTURE CONTRACT** | Phase 4 |
| CX-04 | Grant scope 밖 컨텍스트 접근 deny | **FUTURE CONTRACT** | Phase 4 |

---

## E. Execution Audit (AU)

### 불변식
- **AU-INV-1**: Principal/Grant/Run/도구 실행은 감사 로그에 기록(정책 revision 포함).
- **AU-INV-2**: 실행 기록은 parentRunId/childRunId로 **typed** 연결된다.
- **AU-INV-3**: 프롬프트 원문은 감사 로그에 기록하지 않는다(도구/스킬 ID와 판정만).
- **AU-INV-4**: usage 로그와 보안 감사 로그는 분리된다.

### 테스트 추적표
| ID | 검증 내용 | 상태 | 근거/비고 |
|---|---|---|---|
| AU-01 | 실행 기록이 parentSessionId/sessionId metadata로 연결된다(현재 동작) | **NOT TESTED** | 코드 근거만 존재(`task.ts:168-178`) + `x-parent-session-id` 헤더(`session/llm/request.ts:165`). 이 작업에서 실행 기록 연결을 검증하는 테스트를 **실행하지 않음** → NOT TESTED. **free-form이며 typed 아님** — AU-02로 보강 필요 |
| AU-02 | parentRunId/childRunId **typed** 교차 Run 연결 | **FUTURE CONTRACT** | Phase 4. 현재 typed 필드 없음(확인된 사실) |
| AU-03 | 도구 실행 allow/deny/ask + errorCode + policyRevision 감사 기록 | **FUTURE CONTRACT** | Phase 4. 현재 감사 레코드 스키마 없음 |
| AU-04 | 프롬프트 원문 미기록 + usage/보안 감사 분리 | **FUTURE CONTRACT** | §4.4 계약 존재, 구현·검증은 Phase 4 |
| AU-05 | 철회 이벤트 감사 기록 | **FUTURE CONTRACT** | Phase 4 |

---

## F. Security Cross-cutting / Scope (SC)

### 불변식
- **SC-INV-1**: 기존 §3.4 실행 허용 불변식을 약화시키지 않는다(monotonic tightening).
- **SC-INV-2**: 위임 제약은 모드(gate/direct)와 무관하게 동일 적용.
- **SC-INV-3**: 강제 경계는 정직하게 명시한다(Phase 1~3 로컬 강제, Phase 4 서버 강제).
- **SC-INV-4**: Phase 4 구현 없이는 위임 안전성을 PASS로 주장하지 않는다.

### 테스트 추적표
| ID | 검증 내용 | 상태 | 근거/비고 |
|---|---|---|---|
| SC-01 | plan 부모 → general/explore/custom 자식 edit 상승 경로(아키텍처 문서 §5.6) 통합 재현; deny 유지 여부 확인 | **PASS** | **수정 완료(2026-11-08)**. 수정: `PromptInput.inheritedPermission`을 추가하고 `prompt()`가 tools 규칙 **뒤에** inherited 규칙을 append(`findLast`로 inherited deny 우선). `task.ts`가 `deriveSubagentSessionPermission(...)`를 `inheritedPermission`으로 전달. 실행 증거: `test/session/prompt.test.ts` 7 pass / 0 fail (plan→general edit deny, custom subagent, `tools:{edit:true}` 우회 불가, parent session deny 유지, read/grep 허용, real `Permission.ask`→`PermissionDeniedError`), `test/tool/task.test.ts` 17 pass (task.ts가 inheritedPermission 전달 확인). 수정 전 5 fail → 수정 후 0 fail. 기존 `plan-mode-subagent-bypass.test.ts`도 5 pass 유지. |
| SC-02 | `session.permission` 덮어쓰기(`prompt.ts:1226-1233`)가 턴 스냅샷(§5.4)을 깨지 않음 | **PASS** | **검증 완료**: 일반(비-서브에이전트) 세션에서 `tools:{edit:false, bash:true}`가 정상 반영(edit=deny, bash=allow) — `test/session/prompt.test.ts` "SC-02: normal (non-subagent) session honours tools map enable/disable" PASS. inherited가 없으면 덮어쓰기 동작이 기존과 동일함을 확인. 잔여: 턴 중 `/mode` 변경 스냅샷은 §5.4 Task 16b에서 별도 검증. |
| SC-03 | 손자 생성 제한(task 규칙 없는 subagent는 task 비활성) | **PASS** | **검증 완료**: `test/tool/task.test.ts` "SC-03: general subagent has task denied" PASS — `general`(task 규칙 없음) 자식 세션에 `{task:deny}` 주입됨, 실행 ruleset `Permission.evaluate("task","*")` = deny. 노출 게이트는 allow지만 세션 deny + `ctx.ask`로 실행 차단됨을 확인. |
| SC-04 | 부모 취소 → 자식 abort 전파(포그라운드 abort chain + 백그라운드 metadata 매칭) | **PASS** | **실행 결과**: `bun test test/tool/task.test.ts` → **15 pass / 0 fail** (2026-11-08). 근거 테스트: `task.test.ts:290` "execute cancels child session when abort signal fires"(포그라운드), `task.test.ts:705` "cancelling a parent run recursively cancels descendant background tasks"(백그라운드 metadata 매칭, `expect(...status).toBe("cancelled")`). |
| SC-05 | 위임 불변식이 §3.4 불변식을 약화시키지 않음(monotonic tightening) — 계약 교차 검증 | **FUTURE CONTRACT** | Phase 4 계약 테스트 |
| SC-06 | Phase 3에서 위임 안전성을 PASS로 주장하지 않음(정직성 검증) | **NOT TESTED** | 메타 주장은 테스트가 아니다. 이 문서는 미구현 항목을 FUTURE CONTRACT/NOT TESTED로 표기하나, SC-INV-4 준수 여부는 **게이트 리뷰에서 확인할 항목**이므로 NOT TESTED로 둔다 |

---

## G. 코드 확인 사실 vs 테스트 상태 (혼동 방지)

| 코드 확인 사실(레이블) | 테스트 상태 |
|---|---|
| `task` 자식 세션 `parentID` 설정(`task.ts:142-159`) | (세션생성 코드 확인 — **대응 테스트 행 없음**, AG-01과 무관) |
| `merge` = 평탄 + `findLast`(`packages/core/src/permission.ts:21-35`) | DG-05 **NOT TESTED**(교집합 미구현) |
| `deriveSubagentSessionPermission` deny 전달(`subagent-permissions.ts:17-34`) | 생성 직후에는 deny 유지, `prompt()` 덮어쓰기 후 **SC-01 FAIL** (재현 완료) |
| `prompt()` session.permission 덮어쓰기(`prompt.ts:1226-1233`) | SC-02 **NOT TESTED** |
| plan 부모 → general 자식 edit 상승(실제 `prompt()` 경로) | SC-01 **PASS**(수정 완료 2026-11-08) |
| `task`/`todowrite` 주입 deny로 손자 제한(세션 deny + `ctx.ask`) | SC-03 **NOT TESTED** |
| abort 전파(포그라운드 `task.test.ts:290`, 백그라운드 `task.test.ts:705`) | SC-04 **PASS**(15 pass / 0 fail 실행) |
| revocation 부재 | RV-01~05 **FUTURE CONTRACT** |
| Principal 부재 | AG-02~05 **FUTURE CONTRACT** |

---

## H. 상태 확정 진행 상황

- **SC-01**: **PASS(수정 완료)** — `inheritedPermission` 도입으로 plan 부모의 edit-deny가 tools 맵 덮어쓰기 후에도 유지됨. `prompt.test.ts` 7 pass, `task.test.ts` 17 pass.
- **SC-02**: **PASS** — 일반 세션 tools 맵 enable/disable 정상 유지.
- **SC-03**: **PASS** — general 서브에이전트 task deny 주입 + 실행 시 차단.
- **SC-04**: **완료(PASS)** — `test/tool/task.test.ts` → 15 pass / 0 fail (포그라운드 abort + 백그라운드 재귀 취소).

다음 항목은 **아직 실행/기록하지 않았으므로 NOT TESTED**로 둔다(Phase 3에서 실행해 PASS/FAIL 확정):

- **CX-01**: `test/tool/task.test.ts` 실행 → 자식 프롬프트 전달 확인.
- **CX-02**: Phase 3 Task 16b E2E 실행.

> **주의**: 위 테스트를 **실행하지 않고** PASS로 승격하지 말 것. 상태 승격은 `docs/superpowers/plans/2026-11-08-phase3-plugin-port.md`의 Task 16/16a/16b/17 게이트에서만 한다.

---

## I. 근거 링크 요약

| 항목 | 파일:라인 |
|---|---|
| task 자식 세션 생성 + permission | `upstream/packages/opencode/src/tool/task.ts:142-159` |
| task tools 맵 | `upstream/packages/opencode/src/tool/task.ts:193-197` |
| deriveSubagentSessionPermission | `upstream/packages/opencode/src/agent/subagent-permissions.ts:17-34` |
| merge/evaluate | `upstream/packages/core/src/permission.ts:21-35` |
| prompt session.permission 덮어쓰기 | `upstream/packages/opencode/src/session/prompt.ts:1226-1233` |
| setPermission 전체 교체 | `upstream/packages/opencode/src/session/session.ts:735-739` |
| abort 전파 | `upstream/packages/opencode/src/tool/task.ts:260-269`, `run-state.ts:122-128` |
| registry 노출 게이트 | `upstream/packages/opencode/src/tool/registry.ts:330-341` |
| execution gate(ctx.ask) | `upstream/packages/opencode/src/session/tools.ts:64-72` |
| metadata 연결 | `upstream/packages/opencode/src/tool/task.ts:168-178` |
| x-parent-session-id | `upstream/packages/opencode/src/session/llm/request.ts:165` |
| 세션 agent 저장 | `upstream/packages/opencode/src/session/session.ts:209-221` |
| 실행 시 agent 선택 | `upstream/packages/opencode/src/session/prompt.ts:1334` |
| provenance metadata | `upstream/packages/opencode/src/session/message-v2.ts:103-119, 316-323` |
| 요청 조립 필터 | `upstream/packages/opencode/src/session/prompt.ts:1439-1445` |
| 기존 격리 테스트 | `upstream/packages/opencode/test/agent/plan-mode-subagent-bypass.test.ts` |
| 격리 테스트 실행 결과 | 5 pass / 0 fail (2026-11-08 실행) |
| task 테스트 실행 결과 | 15 pass / 0 fail (2026-11-08 실행) — SC-04 근거 |
| 실행 증거 보존 | `docs/superpowers/evidence/agent-principal-delegation/2026-11-08-test-evidence.md` |
