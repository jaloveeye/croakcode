# Evidence — Agent Principal & Delegation (2026-11-08)

> 이 디렉터리는 위임 설계 검증의 **실행 증거**를 보존한다. 상태 PASS는 여기 기록된 **실행 결과**가 있어야만 매트릭스에서 인정한다(가짜 PASS 금지).

## 실행 환경
- 날짜: 2026-11-08
- 런타임: bun 1.3.14 (0d9b296a)
- 위치: `upstream/packages/opencode`

## 실행 결과

### E0. SC-01 — P0 권한 상승 결함: 재현(FAIL) → **수정 완료(PASS)**

실제 `prompt()` 경로를 통과하는 재현 테스트로 결함을 확정하고, 최소 침습 수정 후 PASS로 전환했다(격리 helper 테스트가 아님).

**재현(수정 전, FAIL):**
```
bun test test/session/prompt.test.ts -t "SC-01"
→ FAIL: Permission.evaluate("edit", "<file>", effective)  Expected "deny", Received "allow"
```
- 자식 세션 **생성 직후**: `edit` = deny(부모 plan deny 전달 정상).
- 실제 `prompt.prompt({ tools: { task: false }, noReply: true })` **통과 후**: `edit` = **allow**.
- 원인: `prompt.ts:1226-1233`이 tools 맵이 비어있지 않으면 `session.permission`을 **전체 교체**(`session.ts:735-739`) → 부모 deny 소실 → general `"*": "allow"`가 edit 허용.

**수정(최소 침습 — Phase 4 런타임 신설 없음):**
1. `PromptInput.inheritedPermission` 추가 (`session/prompt.ts`).
2. `prompt()`: tools 규칙 **뒤에** inherited 규칙 append → `findLast`로 inherited deny 우선( tools `edit:true`도 상속 deny를 완화 불가).
3. `task.ts`: `deriveSubagentSessionPermission(...)`를 변수로 추출해 세션 생성 + `inheritedPermission` 양쪽에 전달.
4. (후속 하드닝) 공개 API `PromptPayload`에서 `inheritedPermission`을 `Struct.omit`으로 제외 — 클라이언트가 payload로 권한 상한을 주입하는 경로를 봉쇄(내부 task 경로만 설정 가능).

**검증(수정 후, PASS):**
```
bun test test/session/prompt.test.ts -t "SC-0"   → 8 pass / 0 fail
  - plan→general edit/write/apply_patch deny (write/apply_patch는 실행 시 permission "edit")
  - plan→custom subagent edit deny 유지
  - tools:{edit:true} 우회 불가
  - 부모 Session deny 유지
  - read/grep 허용 정상
  - normal 세션 tools enable/disable 정상 (SC-02)
  - real Permission.ask → PermissionDeniedError (실행 경로)
  - 공개 PromptPayload가 inheritedPermission/sessionID를 포함하지 않음 (API 주입 차단)
bun test test/tool/task.test.ts                 → 17 pass / 0 fail
  - SC-01: task가 inheritedPermission(edit-deny) 전달
  - SC-03: general 서브에이전트 task deny 주입 + 실행 차단
```
**회귀**: Phase 0–2 계약 테스트 45 pass / 0 fail; task+bypass+permission 42 pass; session/registry/todo-subagent 10 pass; typecheck clean. `prompt.test.ts` 전체는 61 pass(간헐 flake 1건은 재실행 시 0 fail — 기존 flaky 클래스).

### E0-b. SC-01 P0-A/B/C — 상한 우회 잔여 경로 봉쇄: 재현(FAIL) → **수정 완료(PASS)**

코드 검토에서 같은 상한을 우회할 수 있는 3개 경로를 확인하고 각각 실패 테스트 → 최소 수정으로 닫았다.

**(A) 공개 Session Update API** — `handlers/session.ts:188-192`가 `current.permission` 뒤에 클라이언트 규칙을 merge. `findLast`라 클라이언트 `allow`가 상속 `deny`를 이김.
**(B) 공개 Prompt API 직접 전송** — `prompt()`가 `inheritedPermission` 없이 `tools`만으로 `session.permission`을 **전체 교체**(`prompt.ts:1226-1244`).
**(C) `task_id` 소유권** — `task.ts`가 조회한 세션의 `parentID`/`agent` 일치를 검사하지 않음.

**재현(수정 전, RED):**
```
bun test test/session/prompt.test.ts -t "cannot relax inherited"  → 2 fail
  - SC-01(A): Expected "deny", Received "allow"
  - SC-01(B): ProviderNoProvidersError (permission 교체 경로 진입 확인)
bun test test/tool/task.test.ts -t "task_id owned|agent differs"  → 2 fail (재개가 성공해버림)
```

**수정(초기, 프로세스 Map):**
1. `session.ts`: 프로세스 스코프 `inheritedCeilings` Map. 신뢰 런타임만 `setInheritedPermission`으로 기록.
2. `fromRow`: 매 읽기마다 상한이 덮는 규칙 제거 후 끝에 append.
3. `task.ts`: `agent: next.name` 설정, 생성·재개마다 상한 등록.
4. `task.ts`: `task_id` 재개 시 `parentID`/`agent` 불일치 거부.
5. `session.remove`: Map 정리.

> ⚠️ 이 초기 Map 구현은 **프로세스 재시작 시 상한이 소실**되는 구조적 한계가 있었다(아래 E0-c에서 영속화로 대체).

**검증(수정 후, PASS):**
```
bun test test/session/prompt.test.ts -t "cannot relax inherited"  → 2 pass / 0 fail
bun test test/tool/task.test.ts                                   → 19 pass / 0 fail (A/B/C 포함)
bun test test/session/prompt.test.ts -t "SC-0"                    → 12 pass / 0 fail (A·B·restart·fail-closed)
Phase 0–2 계약(node --test)                                        → 45 pass / 0 fail
bun run typecheck                                                  → clean
```
**비고**: 기존 "execute shapes child permissions" 단언은 순서 의존이었으므로 규칙 **집합** 비교로 완화(상한을 끝에 append하는 보안 속성에 따른 정당한 순서 변화). `cancel finalizes interrupted bash tool output`은 **baseline `434c79d`에서도 실패**함을 확인 — 기존 환경/flaky 실패이지 회귀 아님.

### E0-c. SC-01 P0-restart — 상한의 영속화 + fail-closed: **수정 완료(PASS)**

**문제(코드 확인)**: 상한이 `Map`(프로세스 메모리)에만 있어 재시작/다중 프로세스에서 소실. DB `permission` 컬럼에 약화된 규칙만 남으면 재시작 후 상승 가능. 또한 `remove`가 Map을 row 삭제 전에 지워 삭제 실패 시 상한-세션 불일치(P1).

**수정:**
1. `session.sql.ts`: `inherited_permission` JSON 컬럼 추가 + 마이그레이션 `20261108091000_session_inherited_permission`(`ALTER TABLE session ADD inherited_permission text`).
2. `fromRow`: 상한을 **DB 컬럼에서** 읽어 적용 → 재시작/다중 프로세스에서 유지(SQLite 파일 공유).
3. `createNext`/`setInheritedPermission`: **직접 컬럼 UPDATE**로만 기록(공개 `Event.Updated`/`Patch`에 미포함 → 클라이언트 주입 불가). 생성 시 원자적으로 기록해 "상한 없는 위임 세션" 창을 제거.
4. **fail-closed**: `parent_id`가 있는 세션에 상한이 `null`이면 `fromRow`가 `*:deny`를 append → 실행 차단. 명시적 `[]`은 "제한 없음"으로 허용(빈 배열을 `[]`로 저장해 `null`과 구분).
5. `remove`: 별도 레지스트리 제거 → 상한이 row와 함께 원자적으로 삭제(P1 소멸).

**검증(수정 후, PASS):**
```
bun test test/session/prompt.test.ts -t "persisted in the DB"         → 1 pass (재시작: raw DB row에 상한 존재 + fromRow가 deny 도출)
bun test test/session/prompt.test.ts -t "fail-closed"                 → 1 pass (상한 미기록 위임 세션 → edit/bash deny)
bun test test/storage/session-inherited-permission-migration.test.ts  → 1 pass (기존 DB 업그레이드: 컬럼 추가·기존 row 보존·기존 위임 세션 null → 런타임 fail-closed)
bun test test/session/prompt.test.ts -t "SC-0"                        → 12 pass / 0 fail
bun test test/tool/task.test.ts                                       → 19 pass / 0 fail
Phase 0–2 계약 + typecheck                                            → 45 pass / 0 fail, clean
```
**재시작 근거**: 상한은 `inherited_permission` 컬럼(=SQLite 파일)에 물리적으로 존재하며, 테스트는 in-memory Map을 우회해 **raw row**에서 직접 읽어 `fromRow`로 재구성한다 — 이는 새 프로세스가 같은 파일을 여는 것과 동일한 읽기 경로다. 기존 `2f9a1d8`(Map)에서는 이 컬럼 자체가 없어 테스트가 성립하지 않는다(회귀 대비).

### E1. `test/agent/plan-mode-subagent-bypass.test.ts`
```
bun test test/agent/plan-mode-subagent-bypass.test.ts
→ 5 pass / 0 fail (17 expect() calls)
```
- **의미**: `deriveSubagentSessionPermission` + merge를 **격리 환경**에서 검증. plan 부모에서 general/explore/custom 자식의 edit deny가 유지되는지 helper 단위 확인.
- **한계(중요)**: 이 테스트는 **`prompt()`의 `session.permission` 덮어쓰기 경로를 거치지 않는다**(stub/격리). 따라서 실제 런타임 상승 경로는 **E0로 별도 재현**했다.

### E2. `test/tool/task.test.ts`
```
bun test test/tool/task.test.ts
→ 15 pass / 0 fail (41 expect() calls)
```
- **의미**:
  - `task.test.ts:290` "execute cancels child session when abort signal fires" → 포그라운드 abort 전파 검증.
  - `task.test.ts:705` "cancelling a parent run recursively cancels descendant background tasks" → 백그라운드 metadata 매칭 재귀 취소 검증(`child`/`grandchild` 모두 `cancelled`).
  - `task.test.ts:377` "execute shapes child permissions for task, todowrite, and primary tools" → **task: allow를 가진 reviewer 에이전트**의 permission shaping 검증(**no-task-rule 케이스는 아님** → SC-03 미커버).
- **SC-04 근거**: E2 통과로 포그라운드+백그라운드 취소 전파는 PASS(매트릭스 SC-04).

## 매트릭스 상태 반영

| ID | 상태 | 근거 |
|---|---|---|
| SC-04 | **PASS** | E2 — `task.test.ts:290` + `:705` (포그라운드+백그라운드 abort) |
| SC-01 | **PASS** | E0 (FAIL→PASS) + E0-b(A/B/C) + E0-c(restart/fail-closed) — `prompt.test.ts -t SC-0` 12 pass, `task.test.ts` 19 pass, 마이그레이션 테스트 1 pass |
| SC-02 | **PASS** | `prompt.test.ts` "SC-02: normal (non-subagent) session honours tools map enable/disable" |
| SC-03 | **PASS** | `task.test.ts` "SC-03: general subagent has task denied" + E0-b |
| CX-01 | **NOT TESTED** | 실행 기록 없음(E2는 parts 단언이 주목적 아님) |

## 후속(Phase 3에서 실행할 항목)

- SC-01 통합 재현 테스트 신규 작성 + 실행(실제 `prompt()` 경로 통과).
- SC-02 덮어쓰기 vs 턴 스냅샷 테스트 신규 작성 + 실행.
- SC-03 no-task-rule(general/explore) 자식의 task deny 검증 테스트 실행.
- CX-01 `task.test.ts`에서 parts 전달 단언 확인.

> **주의**: 위 후속 항목을 실행하기 전에는 매트릭스에서 PASS로 승격하지 않는다.
