# Security Invariants & Test Traceability (Agent Principal & Delegation)

- **상태**: Phase 4 구현 진행 중. 이 문서의 FUTURE CONTRACT 행은 Phase 4 계획의 Task에서 구현한다(§J)
- **날짜**: 2026-11-08 작성, 2026-11-09 갱신(Phase 4 Task 0)
- **관련 문서**:
  - ADR: `docs/superpowers/adr/0001-agent-principal-and-delegation.md`
  - 위임 아키텍처: `docs/superpowers/architecture/2026-11-08-agent-principal-delegation.md`
  - Phase 3 계획: `docs/superpowers/plans/2026-11-08-phase3-plugin-port.md`
  - Phase 4 계획: `docs/superpowers/plans/2026-11-09-phase4-delegation-runtime.md`
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
| AG-01 | 세션에 agent 이름이 저장되고 실행 시 메시지 단위 agent(`lastUser.agent`)가 사용된다(현재 동작 고정) | **NOT TESTED** | 코드 근거만 존재(`session.ts:607` 생성 시 저장, `session.ts:126` 읽기, `prompt.ts:1350` 실행 시 선택). `test/agent/agent.test.ts`는 **Definition/config**를 검증할 뿐 세션 agent 저장·`lastUser.agent` 사용을 검증하지 않음 → 이 작업에서 해당 동작 테스트를 **실행/확인하지 않음**. "신원"이 아니라 "이름"임을 명시 |
| AG-02 | Principal 레지스트리가 런타임 발급 신원을 제공하고, 프롬프트/모델 출력에서 신원을 추출하지 않는다 | **PASS** | Phase 4 Task 2. `bun test test/delegation/registry.test.ts` 8 pass / 0 fail(2026-11-09). ID는 `issuePrincipal` 안에서만 만든다. 발급 입력에는 ID 필드가 없다. owner는 `human:local`과 활성 Principal ID만 받는다. 형식이 틀린 owner(예: `agent: trust me`)는 거부한다 |
| AG-03 | Definition과 Principal이 분리되어 동일 Definition에서 복수 Principal 생성 가능 | **PASS** | Phase 4 Task 2. `bun test test/delegation/registry.test.ts` 8 pass / 0 fail(2026-11-09) |
| AG-04 | Run → Principal 참조가 정확히 1개(무결성) | **PASS** | Phase 4 Task 2. `bun test test/delegation/registry.test.ts` 8 pass / 0 fail(2026-11-09). 없는 Principal과 철회된 Principal로는 Run을 만들 수 없다. 부모 Run도 존재해야 한다 |
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
| DG-02 | `child.capabilities ⊆ parent.capabilities` | **PASS** | Phase 4 Task 3. `bun test test/delegation/grants.test.ts` 13 pass / 0 fail(2026-11-09). 두 규칙 목록에 나오는 모든 (권한, 패턴) 지점에서 자식이 위임자와 부모 Grant보다 느슨하면 발급을 거부한다. 이 검사는 모든 와일드카드 겹침을 열거하지 않는다. 실행 시점 교집합(DG-05, Task 4)이 최종 강제다 |
| DG-03 | `child.scope ⊆ parent.scope` 및 constraints 단조 강화 | **PASS** | Phase 4 Task 3. `bun test test/delegation/grants.test.ts` 13 pass / 0 fail(2026-11-09). 범위는 절대 경로만 받고, 부모 범위 밖의 경로와 형제 경로는 거부한다. 루트 Grant는 런타임이 준 범위 상한이 있어야 한다. 부모 제약이 빠지면 거부한다 |
| DG-04 | `expiresAt`/`policyRevision` 단조성 및 순환 그래프 거부 | **PASS** | Phase 4 Task 3. `bun test test/delegation/grants.test.ts` 13 pass / 0 fail(2026-11-09). 만료 연장, 지난 만료 시각, revision 역행을 거부한다. 체인에 같은 Principal이 두 번 나오면 거부한다. 깊이 4 발급을 거부한다 |
| DG-05 | 효과 권한 교집합(min) 계산; 서브 에이전트 부모 권한 초과 불가 | **NOT TESTED** | 교집합 검사 테스트가 **존재하지 않음** → FAIL이 아니라 NOT TESTED. 코드 근거: 현재 런타임은 교집합이 아니라 `merge`(평탄)+`findLast`(마지막 우선) — `upstream/packages/core/src/permission.ts:21-35`(확인된 사실). 교집합 검사 없음(INV-8 미구현). Phase 4 Task 4에서 검증한다 |
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
| CX-01 | `task` 도구가 자식에 `params.prompt`만 전달(부모 대화 전체 미주입) | **NOT TESTED** | 코드 근거(`task.ts:277`: `resolvePromptParts(params.prompt)`만 전달). `test/tool/task.test.ts`에는 `resolvePromptParts`의 가짜 구현만 있고, 자식에 전달된 내용을 검사하는 테스트가 없다(2026-11-09 확인) |
| CX-02 | gate context(`origin:"gate"`)가 direct 요청 조립 시 제외 | **PASS** | 2026-11-09 실행: `bun test test/session/sec03-gate-direct-e2e.test.ts` → 8 pass / 0 fail. 근거 테스트 "direct request after a real gate turn omits gate output and keeps direct history"(1 pass)는 gate 턴의 응답이 이후 direct 요청 본문에 없음을 확인한다. 요청 조립 지점 `prompt.ts:1465-1471` |
| CX-03 | 다중 위임 경로 간 교차 컨텍스트 누수 없음 | **FUTURE CONTRACT** | Phase 4 Task 6a |
| CX-04 | Grant scope 밖 컨텍스트 접근 deny | **FUTURE CONTRACT** | Phase 4 Task 6a |
| CX-05 | 모델이 쓴 위임 프롬프트의 파일 참조가 권한 확인 없이 읽히지 않는다 | **PASS** | 2026-11-09 재현 뒤 수정했다. 수정 전에는 read와 `external_directory`를 deny한 세션에서 위임 프롬프트의 `@/절대경로` 파일 내용이 자식의 LLM 요청 본문에 실렸다. `task.ts`의 `delegatedPromptParts`가 위임 프롬프트의 파일 part를 텍스트 안내로 바꾼다. 자식은 read 도구로 읽어야 하고, read 도구는 권한 확인과 before 훅을 거친다. 실행 증거: `prompt.test.ts -t CX-05` 수정 전 0 pass / 1 fail, 수정 후 1 pass / 0 fail. `task.test.ts -t CX-05` 1 pass |

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
| AU-01 | 실행 기록이 parentSessionId/sessionId metadata로 연결된다(현재 동작) | **NOT TESTED** | 코드 근거만 존재(`task.ts:243-253`) + `x-parent-session-id` 헤더(`session/llm/request.ts:169`). 이 작업에서 실행 기록 연결을 검증하는 테스트를 **실행하지 않음** → NOT TESTED. **free-form이며 typed 아님** — AU-02로 보강 필요 |
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
| SC-01 | plan 부모 → general/explore/custom 자식 edit 상승 경로(아키텍처 문서 §5.6) 통합 재현; deny 유지 여부 확인 | **PASS** | **수정 완료(2026-11-08)**. 수정: `PromptInput.inheritedPermission`을 추가하고 `prompt()`가 tools 규칙 **뒤에** inherited 규칙을 append(`findLast`로 inherited deny 우선). `task.ts`가 `deriveSubagentSessionPermission(...)`를 `inheritedPermission`으로 전달. 실행 증거: `test/session/prompt.test.ts` 7 pass / 0 fail (plan→general edit deny, custom subagent, `tools:{edit:true}` 우회 불가, parent session deny 유지, read/grep 허용, real `Permission.ask`→`PermissionDeniedError`), `test/tool/task.test.ts` 17 pass (task.ts가 inheritedPermission 전달 확인). 수정 전 5 fail → 수정 후 0 fail. 기존 `plan-mode-subagent-bypass.test.ts`도 5 pass 유지. **후속 하드닝(2026-11-08)**: `inheritedPermission`은 내부 상한값이므로 공개 API `PromptPayload`에서 `sessionID`와 함께 `Struct.omit`으로 제외 — 클라이언트가 요청 payload로 상한을 주입할 수 없음. 근거 테스트 "SC-01: public prompt payload omits inheritedPermission" 추가 → `test/session/prompt.test.ts -t SC-0` **8 pass / 0 fail**. resume(`task_id`) 경로는 `sessions.create`를 건너뛰되 `inheritedPermission`을 매 실행마다 재계산해 `ops.prompt`에 전달함(코드 확인). **P0-A/B/C 후속 수정(2026-11-08)**: (A) `session.setPermission`는 `current` 뒤에 클라이언트 규칙을 merge하고 `findLast`로 allow가 deny를 이길 수 있었음 → 상속 상한을 **수정 불가 저장소**(`Session.setInheritedPermission`, 신뢰 런타임만 기록)로 분리하고 `fromRow`에서 매 읽기마다 저장 규칙을 걸러낸 뒤 끝에 append → 어떤 permission/tools 쓰기도 상한을 완화 불가. (B) 공개 Prompt API가 자식 세션에 `tools:{edit:true}`로 `prompt()`를 호출하면 tools 맵만으로 `session.permission`을 전체 교체했음 → 이제 상한이 매 읽기 재적용되어 deny 유지. (C) `task_id` 재개 시 `parentID`/`agent` 일치 검사 추가 — 다른 부모/타입의 세션 hijack 차단(`agent` 미기록 레거시 세션은 상한을 부모에서 재계산하므로 허용). 증거: `prompt.test.ts -t SC-0` **12 pass / 0 fail**(A·B·restart·fail-closed 포함), `task.test.ts` **19 pass / 0 fail**(C 2 pass 포함), Phase 0–2 계약 45 pass, typecheck clean. **P0-restart 영속+fail-closed 수정(2026-11-08)**: 상한을 프로세스 메모리 `Map`이 아니라 **영속 컬럼 `session.inherited_permission`**(마이그레이션 `20261108091000_session_inherited_permission`)에 저장 → 재시작/다중 프로세스에서도 유지(모든 프로세스가 같은 SQLite 파일 공유). 쓰기는 `createNext`(생성 시 원자적) 와 `setInheritedPermission`(재개 시) 의 **직접 컬럼 UPDATE**로만 수행하고 공개 `Event.Updated`/`Patch`에는 포함하지 않음 → 클라이언트 주입 불가. **fail-closed**: `parent_id`가 있는 위임 세션이 `inherited_permission`이 `null`(미기록)이면 `fromRow`가 `*:deny`를 append 하여 실행을 차단(빈 배열 `[]`은 "제한 없음"으로 명시 허용). 삭제 순서 P1: 별도 레지스트리가 없어져 row 삭제와 상한 삭제가 원자적으로 함께 일어남. 증거: restart/fail-closed 테스트 `test/session/prompt.test.ts`, 마이그레이션 업그레이드 테스트 `test/storage/session-inherited-permission-migration.test.ts` 1 pass. |
| SC-02 | `session.permission` 덮어쓰기(`prompt.ts:1226-1233`)가 턴 스냅샷(§5.4)을 깨지 않음 | **PASS** | **검증 완료**: 일반(비-서브에이전트) 세션에서 `tools:{edit:false, bash:true}`가 정상 반영(edit=deny, bash=allow) — `test/session/prompt.test.ts` "SC-02: normal (non-subagent) session honours tools map enable/disable" PASS. inherited가 없으면 덮어쓰기 동작이 기존과 동일함을 확인. 잔여: 턴 중 `/mode` 변경 스냅샷은 §5.4 Task 16b에서 별도 검증. |
| SC-03 | 손자 생성 제한(task 규칙 없는 subagent는 task 비활성) | **PASS** | **검증 완료**: `test/tool/task.test.ts` "SC-03: general subagent has task denied" PASS — `general`(task 규칙 없음) 자식 세션에 `{task:deny}` 주입됨, 실행 ruleset `Permission.evaluate("task","*")` = deny. 노출 게이트는 allow지만 세션 deny + `ctx.ask`로 실행 차단됨을 확인. |
| SC-04 | 부모 취소 → 자식 abort 전파(포그라운드 abort chain + 백그라운드 metadata 매칭) | **PASS** | **실행 결과**: `bun test test/tool/task.test.ts` → **15 pass / 0 fail** (2026-11-08). 근거 테스트: `task.test.ts:290` "execute cancels child session when abort signal fires"(포그라운드), `task.test.ts:705` "cancelling a parent run recursively cancels descendant background tasks"(백그라운드 metadata 매칭, `expect(...status).toBe("cancelled")`). |
| SC-05 | 위임 불변식이 §3.4 불변식을 약화시키지 않음(monotonic tightening) — 계약 교차 검증 | **FUTURE CONTRACT** | Phase 4 계약 테스트 |
| SC-06 | Phase 3에서 위임 안전성을 PASS로 주장하지 않음(정직성 검증) | **NOT TESTED** | 메타 주장은 테스트가 아니다. 이 문서는 미구현 항목을 FUTURE CONTRACT/NOT TESTED로 표기하나, SC-INV-4 준수 여부는 **게이트 리뷰에서 확인할 항목**이므로 NOT TESTED로 둔다 |

---

## G. 코드 확인 사실 vs 테스트 상태 (혼동 방지)

| 코드 확인 사실(레이블) | 테스트 상태 |
|---|---|
| `task` 자식 세션 `parentID` 설정(`task.ts:208-225`) | (세션생성 코드 확인 — **대응 테스트 행 없음**, AG-01과 무관) |
| `merge` = 평탄 + `findLast`(`packages/core/src/permission.ts:21-35`) | DG-05 **NOT TESTED**(교집합 미구현, Phase 4 Task 4) |
| `deriveSubagentSessionPermission` deny 전달(`subagent-permissions.ts:20-37`) | SC-01 **PASS**. 수정 전에는 `prompt()` 덮어쓰기 뒤 deny가 사라졌다. 2026-11-08 수정 뒤 영속 상한으로 유지된다 |
| `prompt()` session.permission 덮어쓰기(`prompt.ts:1236-1249`) | SC-02 **PASS** |
| plan 부모 → general 자식 edit 상승(실제 `prompt()` 경로) | SC-01 **PASS**(수정 완료 2026-11-08) |
| `task`/`todowrite` 주입 deny로 손자 제한(세션 deny + `ctx.ask`) | SC-03 **PASS** |
| abort 전파(포그라운드 `task.test.ts:290`, 백그라운드 `task.test.ts:705`) | SC-04 **PASS**(15 pass / 0 fail 실행) |
| revocation 부재 | RV-01~05 **FUTURE CONTRACT**(Phase 4 Task 5, 7) |
| Principal 레지스트리(`src/delegation/registry.ts`) | AG-02~04 **PASS**(Task 2), AG-05 **FUTURE CONTRACT**(Task 7) |

---

## H. 상태 확정 진행 상황

- **SC-01**: **PASS(수정 완료 + API 하드닝 + 영속 상한 + fail-closed)** — plan 부모의 edit-deny가 tools 맵 덮어쓰기, 공개 permission 수정, 공개 prompt, **프로세스 재시작**에 의해서도 유지됨. `prompt.test.ts -t SC-0` 12 pass(A·B·restart·fail-closed 포함), `task.test.ts` 19 pass(C 포함), 마이그레이션 테스트 1 pass.
- **SC-02**: **PASS** — 일반 세션 tools 맵 enable/disable 정상 유지.
- **SC-03**: **PASS** — general 서브에이전트 task deny 주입 + 실행 시 차단.
- **SC-04**: **완료(PASS)** — `test/tool/task.test.ts` → 15 pass / 0 fail (포그라운드 abort + 백그라운드 재귀 취소).

- **CX-02**: **PASS(2026-11-09)** — `sec03-gate-direct-e2e.test.ts` 8 pass / 0 fail.

다음 항목은 검증 테스트가 없어 NOT TESTED로 둔다.

- **CX-01**: 자식에 전달된 프롬프트를 검사하는 테스트가 없다.
- **AG-01**: 세션 agent 저장과 실행 시 선택을 검사하는 테스트가 없다.
- **AU-01**: 자유 형식 metadata 연결을 검사하는 테스트가 없다. Phase 4 Task 8의 typed 연결(AU-02)이 이 기능을 대신한다.

> **주의**: 위 테스트를 **실행하지 않고** PASS로 승격하지 말 것. 상태 승격은 `docs/superpowers/plans/2026-11-08-phase3-plugin-port.md`의 Task 16/16a/16b/17 게이트에서만 한다.

---

## I. 근거 링크 요약

| 항목 | 파일:라인 |
|---|---|
| task 자식 세션 생성 + permission | `upstream/packages/opencode/src/tool/task.ts:208-225` |
| task tools 맵 | `upstream/packages/opencode/src/tool/task.ts:276-295` |
| deriveSubagentSessionPermission | `upstream/packages/opencode/src/agent/subagent-permissions.ts:20-37` |
| merge/evaluate | `upstream/packages/core/src/permission.ts:21-35` |
| prompt session.permission 덮어쓰기 | `upstream/packages/opencode/src/session/prompt.ts:1236-1249` |
| setPermission 전체 교체 | `upstream/packages/opencode/src/session/session.ts:820-825` |
| abort 전파 | `upstream/packages/opencode/src/tool/task.ts:360-390`, `run-state.ts:76-85` |
| registry 노출 게이트 | `upstream/packages/opencode/src/tool/registry.ts:330-339` |
| execution gate(ctx.ask) | `upstream/packages/opencode/src/session/tools.ts:64-72` |
| metadata 연결 | `upstream/packages/opencode/src/tool/task.ts:243-253` |
| x-parent-session-id | `upstream/packages/opencode/src/session/llm/request.ts:169` |
| 세션 agent 저장 | `upstream/packages/opencode/src/session/session.ts:607` |
| 실행 시 agent 선택 | `upstream/packages/opencode/src/session/prompt.ts:1350` |
| provenance metadata | `upstream/packages/opencode/src/session/message-v2.ts:103-118`(TextPart), `:316-323`(ToolPart) |
| 요청 조립 필터 | `upstream/packages/opencode/src/session/prompt.ts:1465-1471` |
| 기존 격리 테스트 | `upstream/packages/opencode/test/agent/plan-mode-subagent-bypass.test.ts` |
| 격리 테스트 실행 결과 | 5 pass / 0 fail (2026-11-08 실행) |
| task 테스트 실행 결과 | 15 pass / 0 fail (2026-11-08 실행) — SC-04 근거 |
| 실행 증거 보존 | `docs/superpowers/evidence/agent-principal-delegation/2026-11-08-test-evidence.md` |

코드 위치는 2026-11-09 `master` 기준으로 갱신했다.

---

## J. Phase 4 작업 대응표

Phase 4 계획(`docs/superpowers/plans/2026-11-09-phase4-delegation-runtime.md`)의 Task와 이 문서의 ID를 잇는다. 상태는 각 Task가 끝날 때 테스트 실행 결과로 바꾼다.

| Task | 대상 ID |
|---|---|
| Task 2. Agent Registry와 Run 저장소 | AG-02, AG-03, AG-04 |
| Task 3. Delegation Store | DG-02, DG-03, DG-04 |
| Task 4. 효과 권한 계산기 | DG-05, DG-06 |
| Task 5. 실행 직전 재인가 | RV-03, RV-04, RV-05, SC-05 |
| Task 6. task 도구 연결 | DG-01. SC-01부터 SC-04까지 회귀 확인 |
| Task 6a. 컨텍스트 격리 | CX-03, CX-04, CX-05 |
| Task 7. 철회 | AG-05, RV-01, RV-02 |
| Task 8. 실행 감사 | AU-02, AU-03, AU-04, AU-05 |
| Task 9. 실행 허가 토큰 | PT-01부터 PT-07까지(§K) |

RV-04는 사용자 결정에 따라 "상태를 확인할 수 없으면 deny"로 검증한다.

CX-03과 CX-04는 처음 계획에 없었다. 2026-11-09 사용자 결정으로 Task 6a에 넣었다. Task 6a를 준비하면서 CX-05의 권한 우회를 재현했다.

SC-06은 테스트로 확인할 항목이 아니다. 게이트 리뷰에서 확인한다.

## K. 실행 허가 토큰 (PT)

### 불변식
- **PT-INV-1**: 허가 토큰 검증을 켜면 유효한 토큰 없이 도구를 실행하지 않는다.
- **PT-INV-2**: 토큰은 세션, Principal, Run, 도구, 인자 해시에 묶인다. 다른 호출에 재사용할 수 없다.
- **PT-INV-3**: 검증할 수 없으면 실행을 거부한다.

### 테스트 추적표
| ID | 검증 내용 | 상태 | 근거/비고 |
|---|---|---|---|
| PT-01 | 가짜 Gate가 서명한 유효 토큰으로 실행이 허용된다 | **FUTURE CONTRACT** | Phase 4 Task 9 |
| PT-02 | 서명이 위조된 토큰은 deny | **FUTURE CONTRACT** | Phase 4 Task 9 |
| PT-03 | 세션, Principal, Run, 도구, 인자 해시 중 하나라도 다르면 deny | **FUTURE CONTRACT** | Phase 4 Task 9 |
| PT-04 | 만료된 토큰은 deny. 시계 오차 30초까지 허용 | **FUTURE CONTRACT** | Phase 4 Task 9 |
| PT-05 | 같은 nonce를 두 번 쓰면 deny | **FUTURE CONTRACT** | Phase 4 Task 9 |
| PT-06 | 검증을 켰는데 Gate 공개키가 없으면 모든 도구 deny | **FUTURE CONTRACT** | Phase 4 Task 9 |
| PT-07 | 실제 croak-gate가 발급한 토큰으로 연동 | **FUTURE CONTRACT** | croak-gate 발급 구현 뒤에 검증한다. Phase 4 수용 시점에도 이 상태로 남을 수 있다 |
