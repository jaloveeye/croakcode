# Phase 4 구현 계획 — 위임 런타임과 실행 허가 토큰 검증

- **날짜**: 2026-11-09
- **상태**: 계획 확정 전 검토 대기
- **기준 문서**:
  - 청사진: `docs/superpowers/architecture/2026-11-08-phase4-blueprint.md`
  - 위임 아키텍처: `docs/superpowers/architecture/2026-11-08-agent-principal-delegation.md`
  - 보안 불변식 추적표: `docs/superpowers/architecture/2026-11-08-security-invariants-and-test-traceability.md`
  - ADR(아키텍처 결정 기록): `docs/superpowers/adr/0001-agent-principal-and-delegation.md`

## 0. 결정 사항

청사진 §10의 미해결 항목 7개 가운데 다섯 개는 사용자가 정했다. 저장 방식 두 개는 청사진 권장안을 따랐다.

| # | 항목 | 결정 | 결정 주체 |
|---|---|---|---|
| 1 | Principal 저장 | 새 테이블 `agent_principals` | 청사진 권장안 채택 |
| 2 | Grant 저장 | 새 테이블 `delegation_grants` | 청사진 권장안 채택 |
| 3 | 철회 방식 | 도구 실행 직전에 상태를 DB에서 다시 읽는다 | 사용자 |
| 4 | 상태 확인 실패 시 | 실행을 거부한다 | 사용자 |
| 5 | 강제 범위 | 로컬 서브시스템 5개와 클라이언트 쪽 허가 토큰 검증 | 사용자 |
| 6 | `session.permission` 덮어쓰기 | SC-01과 SC-02 수정으로 해소했다. 추가 작업은 없다 | 기존 수정 |
| 7 | 위임 깊이 | 최대 3단계 | 사용자 |

정책이 바뀐 뒤의 Grant 처리도 사용자가 정했다. Grant는 그대로 두고, 실행 직전에 현재 정책과 교집합을 다시 구한다. 정책이 좁아지면 실행 권한도 바로 좁아진다. 정책이 넓어져도 Grant 범위를 넘지 않는다.

Phase 3 제품 수용은 아직 HOLD 상태다. 이 계획은 HOLD와 별개로 진행한다. HOLD 해제는 리뷰어의 보안 수용 판정으로 정한다.

## 1. 현재 코드의 연결 지점

계획에 영향을 주는 사실만 적는다. 줄 번호는 2026-11-09 `master`(`ebe2aaa`) 기준이다.

### 1.1 도구 실행 경로

모델 스트림의 도구 호출은 AI SDK가 직접 실행한다. 실행 함수는 `session/tools.ts`의 래퍼가 만든다.

| 경로 | 위치 | 순서 |
|---|---|---|
| native와 플러그인 도구 | `session/tools.ts:84-113` | before 훅 → `execute` → after 훅 |
| MCP 도구 | `session/tools.ts:125-201` | before 훅 → `ctx.ask` → `execute` → after 훅 |
| 사용자 실행 서브태스크 | `session/prompt.ts:362-445` | before 훅 → `taskTool.execute` → after 훅 |

native 도구는 권한 확인을 각자 `execute` 안에서 한다. `read.ts`, `edit.ts`, `shell.ts`, `task.ts`가 모두 `ctx.ask`를 따로 부른다. 그래서 모든 도구가 지나는 공통 지점은 래퍼의 before 훅 직후다. 재인가 단계는 이 자리에 넣는다. 세 경로 모두에 넣어야 우회 경로가 생기지 않는다.

`ctx.ask`는 `session/tools.ts:64-72`에서 만든다. 이 함수는 `Permission.merge(agent.permission, session.permission)`으로 `permission.ask`를 부른다. 패턴 단위 판정은 이 지점에서만 알 수 있다. 그래서 효과 권한의 패턴 판정은 `ctx.ask` 앞에 둔다.

`control/src/permission-order.mjs`의 `resolveExecutionPlan`은 테스트에서만 쓰인다. 런타임에는 Gate 정책 단계가 따로 없다. 로컬 플러그인 `tool-policy.js`와 `secret-paths.js`가 before 훅에서 예외를 던져 실행을 막는다.

### 1.2 하위 에이전트 생성

`tool/task.ts`가 하위 에이전트를 만든다.

- 권한 확인은 141-151행에서 한다. 사용자 실행 서브태스크는 `bypassAgentCheck`로 이 확인을 건너뛴다.
- 부모 권한 상한은 203-207행의 `deriveSubagentSessionPermission`이 만든다.
- 자식 세션은 208-225행에서 만든다. 상한은 `inherited_permission` 열에 저장한다.
- `session.ts:71-100`의 `applyInheritedCeiling`이 행을 읽을 때마다 상한을 다시 적용한다.
- 백그라운드 작업은 메모리에서만 관리한다(`background/job.ts:129`).

위임 단위의 Run 식별자는 없다. `CROAKCODE_RUN_ID`는 프로세스마다 하나다. 부모와 자식은 `session.parent_id`와 도구 metadata의 자유 형식 필드로만 이어진다.

### 1.3 권한 엔진

`core/src/permission.ts`의 `merge`는 규칙을 이어 붙인다. `evaluate`는 마지막으로 일치한 규칙을 쓰고, 일치가 없으면 `ask`를 돌려준다. 두 함수 모두 교집합을 계산하지 않는다. 규칙 형식은 `{permission, pattern, action}`이고 action은 `allow`, `deny`, `ask` 셋이다.

### 1.4 저장소

Drizzle ORM과 SQLite를 쓴다. 마이그레이션은 `opencode/migration/<YYYYMMDDHHMMSS>_<이름>/migration.sql` 폴더로 둔다. `storage/db.ts`가 폴더 이름의 시각 순서로 적용한다. 별도의 `schema_version`은 없다. 최근 두 마이그레이션은 SQL 파일만 직접 작성했다.

### 1.5 정책과 Gate 인증

- 관리자 정책 서명 검증 `verifyAdminPolicy`는 HMAC 방식이고 테스트에서만 쓰인다.
- 로컬 도구 정책 파일(`policy-state.js`)은 서명이 없고 revision 필드도 없다.
- 코드 어디에도 정책 revision 개념이 없다.
- Gate 인증 상태는 `croak-auth-session.js`가 `~/.config/croak/session.json`에 둔다.

### 1.6 서명 도구

Ed25519 서명 검증 코드가 없다. JSON 표준 형식 변환 함수도 없다. `node:crypto`는 Ed25519 검증을 지원하므로 외부 패키지 없이 만든다.

## 2. 설계

### 2.1 데이터 모델

지금 코드에는 Run 식별자가 없어서 parentRunId를 기록할 곳이 없다. 그래서 청사진의 세 테이블에 Run 테이블을 더해 네 개를 만든다.

| 테이블 | 핵심 열 | 용도 |
|---|---|---|
| `agent_principals` | `principal_id`, `owner_id`, `definition`, `role`, `status`, `capabilities` | 권한을 가진 에이전트 주체 |
| `agent_runs` | `run_id`, `principal_id`, `session_id`, `parent_run_id`, `grant_id`, `policy_revision`, `status` | Principal의 실행 한 번 |
| `delegation_grants` | `grant_id`, `delegator`, `delegatee`, `parent_grant_id`, `parent_run_id`, `capabilities`, `scope`, `expires_at`, `status`, `depth`, `policy_revision` | 위임 기록 |
| `execution_audit` | `audit_id`, `event_type`, `principal_id`, `run_id`, `parent_run_id`, `grant_id`, `decision`, `error_code`, `policy_revision` | 감사 기록 |

별도의 capability 어휘를 만들면 기존 권한 규칙과의 대응표를 따로 관리해야 한다. 그래서 `capabilities`는 기존 권한 규칙 형식(`Ruleset`)으로 저장한다. `agent.spawn`과 `agent.delegate`는 permission 이름으로 표현한다.

세션을 지워도 감사 기록은 남아야 한다. 그래서 새 테이블은 기존 테이블과 외래 키로 엮지 않는다. 감사 기록에는 프롬프트 원문과 도구 인자 원문을 넣지 않는다.

### 2.2 신원 발급

신원은 런타임만 발급한다(INV-5.3). 모델 출력과 프롬프트에서 신원을 읽지 않는다.

- 최상위 세션의 첫 실행에서 루트 Principal을 만든다. owner는 `human:local`이다. 능력은 조직 상한과 에이전트 정의의 권한이다.
- `task` 도구가 자식을 만들 때 자식 Principal과 Grant와 Run을 함께 만든다.
- Grant 없이 만든 자식은 위임이 성립하지 않는다. 이 자식의 효과 권한은 모두 deny다(INV-5.4).

### 2.3 효과 권한 계산

효과 권한은 다섯 층의 판정 중 가장 엄격한 값이다. 엄격한 순서는 deny, ask, allow 순이다.

| 층 | 출처 |
|---|---|
| 조직 상한 | 서명된 관리자 정책. 정책이 없으면 제한하지 않는다 |
| 위임 체인 | 루트까지 이어진 각 Grant의 `capabilities` |
| 부모 Run | 부모 Run의 효과 권한 |
| 자기 정책 | 에이전트 정의와 세션의 권한 규칙 |
| 작업 범위 | Grant의 `scope` |

같은 delegatee가 여러 Grant를 받으면 각 경로의 결과 중 가장 엄격한 값을 쓴다. 합집합은 쓰지 않는다(INV-3, F5). 층마다 기존 `evaluate`로 판정하고, 그 결과를 모아 가장 엄격한 값을 고른다. 기존 `merge`는 바꾸지 않는다.

지금은 관리자 정책을 배포하는 경로가 없다. 이 상태에서 상한 없음을 deny로 처리하면 모든 도구가 막힌다. 그래서 조직 상한이 없으면 제한하지 않는다. 관리자 정책 파일이 설정됐는데 서명을 확인할 수 없으면 deny한다.

### 2.4 정책 revision

관리자 정책 파일에 정수 `revision` 필드를 둔다. 정책이 없으면 revision은 0이다. Grant와 Run은 발급 시점의 revision을 기록한다. Grant 발급 시 부모 Grant보다 낮은 revision은 거부한다(INV-3.5). 실행 시점에는 현재 정책으로 교집합을 다시 구하므로 revision 차이로 deny하지 않는다.

### 2.5 실행 직전 재인가

재인가 단계는 before 훅 직후에 들어간다. 세 실행 경로 모두에 넣는다.

1. 현재 Run과 Principal, 그리고 Grant 체인을 DB에서 읽는다.
2. Principal이 `active`가 아니면 deny한다.
3. 체인의 Grant 중 하나라도 `active`가 아니면 deny한다. 만료 시각이 지난 Grant는 이 자리에서 `expired`로 바꾸고 deny한다.
4. 도구 이름으로 효과 권한을 판정한다. deny이면 실행하지 않는다.
5. DB를 읽지 못하면 deny한다.
6. 판정 결과를 감사 기록에 남긴다.

패턴 단위 판정은 `ctx.ask` 앞에서 한다. 효과 권한이 deny이면 `DeniedError`를 낸다. allow와 ask이면 기존 `permission.ask`로 넘긴다. 이 단계는 deny만 더하므로 기존 판정을 약화하지 않는다(SC-INV-1).

Run이 없는 경로가 남으면 이 경로는 deny한다. 테스트와 내부 호출을 위한 예외는 두지 않는다. 이 원칙 때문에 기존 테스트 일부가 Run을 만들도록 바뀐다.

### 2.6 철회

- Grant를 철회하면 `parent_grant_id`를 따라 하위 Grant를 모두 철회한다(INV-6.1).
- Principal을 철회하면 그 Principal이 발급한 Grant를 모두 철회한다. 그 Principal의 활성 Run에는 중단 신호를 보낸다.
- 철회와 만료는 감사 기록에 남긴다(INV-6.3).
- 실행 중인 도구는 다음 도구 호출의 재인가에서 막힌다. 진행 중인 단일 도구 호출은 중단 신호로 끝낸다.

철회 API는 서버 HTTP 경로로 연다. 관리자 인증이 걸린 경로에만 둔다. TUI 명령은 이번 범위에서 만들지 않는다.

### 2.7 위임 깊이

루트 Principal의 Grant 깊이를 1로 센다. 깊이가 3을 넘는 Grant 발급은 거부한다. 이 값은 관리자 정책의 `maxDelegationDepth`로 낮출 수 있다. 3보다 높게는 올릴 수 없다.

### 2.8 실행 허가 토큰 검증

Gate가 도구 실행마다 허가 토큰을 발급하고, croakcode가 실행 직전에 검증한다. HMAC은 검증하는 쪽도 같은 키로 서명할 수 있다. 클라이언트가 토큰을 위조하지 못하도록 서명은 Ed25519로 한다. Gate는 개인키로 서명하고 croakcode는 공개키로 검증만 한다.

토큰은 `base64url(payload).base64url(signature)` 형식이다. payload는 호출 대상과 유효 기간을 담는다.

| 필드 | 뜻 |
|---|---|
| `aud` | `croakcode` 고정 |
| `sid`, `pid`, `rid` | 세션, Principal, Run 식별자 |
| `tool` | 도구 이름 |
| `args` | 도구 인자를 표준 형식 JSON으로 바꾼 뒤의 SHA-256 |
| `rev` | 정책 revision |
| `iat`, `exp` | 발급 시각과 만료 시각. 유효 기간은 최대 60초 |
| `nonce` | 재사용 방지 값 |

검증은 서명, 필드 일치, 만료, 재사용을 차례로 확인한다.

- 서명이 맞지 않으면 deny한다.
- `aud`, `sid`, `pid`, `rid`, `tool`, `args`가 현재 호출과 다르면 deny한다.
- 만료됐으면 deny한다. 시계 오차는 30초까지 허용한다.
- 같은 `nonce`를 두 번 쓰면 deny한다. 사용한 nonce는 만료 시각까지 메모리에 둔다.

이 검증은 `CROAKCODE_EXECUTION_PERMIT=required`이고 gate 모드일 때만 켠다. 이때 Gate 공개키 `CROAKCODE_GATE_PERMIT_PUBLIC_KEY`가 없으면 모든 도구를 deny한다. croak-gate는 아직 토큰을 발급하지 않는다. 그래서 기본값은 `off`로 둔다.

토큰 발급 요청 형식도 이 계획에서 정한다. croakcode는 `POST {gate}/v1/execution-permits`로 payload의 `aud`, `nonce`, 시각을 뺀 필드를 보낸다. Gate는 토큰을 돌려준다. Gate 쪽 구현은 croak-gate 저장소의 몫이다. 이 저장소에는 요청 형식 문서와 클라이언트, 그리고 테스트용 가짜 Gate를 둔다.

이 검증의 보장 범위를 문서에 적는다. 변조된 클라이언트는 검증 자체를 건너뛸 수 있다. 이 검증은 정상 클라이언트가 Gate의 허가 없이 도구를 실행하지 않게 한다. 변조 클라이언트까지 막으려면 Gate가 허가 기록과 LLM 요청을 대조해야 한다. 이 대조는 croak-gate 범위다.

## 3. 작업

작업마다 테스트를 먼저 쓰고 구현한다. 각 작업이 끝나면 전체 게이트를 돌린다.

### Task 0. 추적표 정리

- 추적표 §G의 낡은 상태를 본문 표와 맞춘다. 지금 §G는 SC-01을 FAIL로 적고 있다.
- AU-01의 코드 위치를 현재 줄로 고친다.
- Phase 4 대상 ID를 이 계획의 작업 번호와 잇는다.

### Task 1. 스키마와 마이그레이션

- 테이블 네 개를 `src/delegation/delegation.sql.ts`에 선언한다.
- 마이그레이션 `20261109100000_delegation_runtime`을 추가한다.
- 테스트: 기존 DB에 마이그레이션을 적용해도 기존 세션 행이 그대로인지 확인한다. 새 테이블에 쓰고 읽을 수 있는지 확인한다.

### Task 2. Agent Registry와 Run 저장소

- `src/delegation/registry.ts`에 Principal 발급, 조회, 폐기와 Run 생성, 종료를 둔다.
- 발급은 런타임 서비스 계층에서만 부른다. HTTP 경로로는 발급하지 않는다.
- 테스트: AG-01부터 AG-05까지. 폐기된 Principal로 Run을 만들 수 없는지 확인한다.

### Task 3. Delegation Store

- `src/delegation/grants.ts`에 Grant 발급, 조회, 체인 조회, 만료를 둔다.
- 발급 검증: 부분집합, 범위, 만료 시각, revision, 순환, 깊이 3을 확인한다.
- 테스트: DG-01부터 DG-06까지. 깊이 4 발급 거부와 순환 거부를 포함한다.

### Task 4. 효과 권한 계산기

- `src/delegation/effective.ts`에 층별 판정과 최솟값 계산을 둔다.
- 관리자 정책 로더를 만든다. 서명 검증은 `verifyAdminPolicy`를 런타임에서 부른다.
- 테스트: DG-05. 다중 경로에서 합집합이 생기지 않는지 확인한다(F5). 정책이 좁아지면 기존 Grant의 효과 권한도 좁아지는지 확인한다.

### Task 5. 실행 직전 재인가

- `session/tools.ts`의 두 래퍼와 `prompt.ts`의 서브태스크 경로에 재인가를 넣는다.
- `ctx.ask` 앞에 패턴 단위 판정을 넣는다.
- 루트 세션의 첫 실행에서 루트 Principal과 Run을 만든다.
- 테스트: RV-03, RV-05, SC-05. 세 실행 경로가 모두 재인가를 거치는지 확인한다. DB 읽기 실패 시 deny를 확인한다.

### Task 6. task 도구 연결

- `task.ts`가 자식 Principal, Grant, Run을 만든다. Grant의 capabilities는 부모 효과 권한과 `inheritedPermission`의 교집합이다.
- 기존 `inherited_permission` 상한은 그대로 둔다. 두 장치가 함께 작동한다.
- 백그라운드 작업과 재개 경로도 같은 Run을 쓰게 한다.
- 테스트: F1, F2, F8, F9, F11. 기존 SC-01부터 SC-04까지가 계속 통과하는지 확인한다.

### Task 7. 철회

- `src/delegation/revocation.ts`에 Grant 철회 전파와 Principal 철회를 둔다.
- 활성 Run에 중단 신호를 보낸다.
- 관리자 인증 HTTP 경로를 추가한다.
- 테스트: RV-01, RV-02, RV-04, F3, F4.

### Task 8. 실행 감사

- `src/delegation/audit.ts`에 기록과 조회를 둔다.
- 재인가 판정, Grant 이벤트, Run 이벤트, 철회를 기록한다.
- 테스트: AU-01부터 AU-05까지. 감사 행에 프롬프트 원문이 없는지 확인한다.

### Task 9. 실행 허가 토큰 검증

- `src/delegation/permit.ts`에 표준 형식 JSON 변환, 토큰 파싱, Ed25519 검증, nonce 저장을 둔다.
- `src/delegation/permit-client.ts`에 Gate 요청 클라이언트를 둔다.
- 재인가 단계 끝에 토큰 검증을 넣는다.
- `contracts/src/server-auth.mjs`의 초안을 실제 형식으로 바꾼다.
- 요청 형식 문서 `docs/superpowers/architecture/2026-11-09-execution-permit-protocol.md`를 쓴다.
- 테스트: 가짜 Gate가 서명한 토큰으로 정상 실행, 서명 위조, 필드 불일치, 만료, nonce 재사용, 공개키 없음을 확인한다.

### Task 10. 문서와 게이트

- 추적표 상태를 실제 테스트 결과로 바꾼다. 가짜 PASS를 적지 않는다.
- README의 보안 상태 표에 Phase 4 항목을 더한다.
- 게이트 스크립트에 새 테스트 디렉터리 `test/delegation`을 넣는다.

## 4. 수용 기준

- DG-05, RV-01부터 RV-05, AU-02부터 AU-05, SC-05가 PASS다.
- SC-01부터 SC-04와 Phase 2 계약 테스트가 계속 PASS다.
- 전체 게이트가 PASS다. `BASELINE_FAIL`과 `FLAKE_FAIL`은 비어 있다.
- 허가 토큰 검증은 가짜 Gate 기준으로 PASS다. 실제 croak-gate와의 연동 시험은 croak-gate 구현 뒤에 한다. 추적표에는 이 항목을 FUTURE CONTRACT로 둔다.

## 5. 위험

| 위험 | 대응 |
|---|---|
| Run이 없는 실행 경로를 놓쳐 우회가 생긴다 | Run이 없으면 deny한다. 세 경로 각각에 테스트를 둔다 |
| 재인가의 DB 읽기가 도구 실행을 느리게 한다 | 도구 호출마다 읽기 네 번 이내로 제한하고, 실행 시간을 측정해 기록한다 |
| 기존 테스트가 Run 없이 도구를 실행해 대량으로 실패한다 | 테스트 헬퍼가 루트 Run을 만들게 한다. 헬퍼 변경과 기능 변경을 다른 커밋으로 나눈다 |
| 관리자 정책 배포 경로가 없다 | 정책이 없으면 조직 상한을 두지 않는다. 이 동작을 README에 적는다 |
| Gate 토큰 형식이 croak-gate 구현과 어긋난다 | 요청 형식 문서를 먼저 공유한다. 기본값을 `off`로 둔다 |
