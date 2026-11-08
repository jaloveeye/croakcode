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

**검증(수정 후, PASS):**
```
bun test test/session/prompt.test.ts -t "SC-0"   → 7 pass / 0 fail
  - plan→general edit/write/apply_patch deny (write/apply_patch는 실행 시 permission "edit")
  - plan→custom subagent edit deny 유지
  - tools:{edit:true} 우회 불가
  - 부모 Session deny 유지
  - read/grep 허용 정상
  - normal 세션 tools enable/disable 정상 (SC-02)
  - real Permission.ask → PermissionDeniedError (실행 경로)
bun test test/tool/task.test.ts                 → 17 pass / 0 fail
  - SC-01: task가 inheritedPermission(edit-deny) 전달
  - SC-03: general 서브에이전트 task deny 주입 + 실행 차단
```
**회귀**: Phase 0–2 계약 테스트 45 pass / 0 fail; task+bypass+permission 42 pass; session/registry/todo-subagent 10 pass; typecheck clean. `prompt.test.ts` 전체는 61 pass(간헐 flake 1건은 재실행 시 0 fail — 기존 flaky 클래스).

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
| SC-04 | **PASS** | E2 (15 pass) — `task.test.ts:290` + `:705` |
| SC-01 | **NOT TESTED** | E1은 격리 helper만; 덮어쓰기 경로 미검증 |
| SC-02 | **NOT TESTED** | 덮어쓰기 경로 테스트 없음 |
| SC-03 | **NOT TESTED** | no-task-rule 케이스 테스트 없음(E2의 shapes 테스트는 task:allow 케이스) |
| CX-01 | **NOT TESTED** | 실행 기록 없음(E2는 parts 단언이 주목적 아님) |

## 후속(Phase 3에서 실행할 항목)

- SC-01 통합 재현 테스트 신규 작성 + 실행(실제 `prompt()` 경로 통과).
- SC-02 덮어쓰기 vs 턴 스냅샷 테스트 신규 작성 + 실행.
- SC-03 no-task-rule(general/explore) 자식의 task deny 검증 테스트 실행.
- CX-01 `task.test.ts`에서 parts 전달 단언 확인.

> **주의**: 위 후속 항목을 실행하기 전에는 매트릭스에서 PASS로 승격하지 않는다.
