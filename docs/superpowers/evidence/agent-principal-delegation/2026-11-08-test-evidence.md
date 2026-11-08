# Evidence — Agent Principal & Delegation (2026-11-08)

> 이 디렉터리는 위임 설계 검증의 **실행 증거**를 보존한다. 상태 PASS는 여기 기록된 **실행 결과**가 있어야만 매트릭스에서 인정한다(가짜 PASS 금지).

## 실행 환경
- 날짜: 2026-11-08
- 런타임: bun 1.3.14 (0d9b296a)
- 위치: `upstream/packages/opencode`

## 실행 결과

### E1. `test/agent/plan-mode-subagent-bypass.test.ts`
```
bun test test/agent/plan-mode-subagent-bypass.test.ts
→ 5 pass / 0 fail (17 expect() calls)
```
- **의미**: `deriveSubagentSessionPermission` + merge를 **격리 환경**에서 검증. plan 부모에서 general/explore/custom 자식의 edit deny가 유지되는지 helper 단위 확인.
- **한계(중요)**: 이 테스트는 **`prompt()`의 `session.permission` 덮어쓰기 경로를 거치지 않는다**(stub/격리). 따라서 **SC-01(통합 상승 경로)은 여전히 NOT TESTED**.

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
