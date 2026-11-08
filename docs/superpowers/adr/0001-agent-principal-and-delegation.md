# ADR-0001: Agent Principal과 위임(Delegation) 모델

- **상태**: Proposed (설계 승인 대기 — 런타임 구현 없음)
- **날짜**: 2026-11-08
- **관련 문서**:
  - 설계 명세: `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md`
  - 위임 아키텍처: `docs/superpowers/architecture/2026-11-08-agent-principal-delegation.md`
  - Phase 3 계획: `docs/superpowers/plans/2026-11-08-phase3-plugin-port.md`
- **범위**: 설계/ADR/분석만. Phase 4 런타임 구현은 별도 승인 대상.

> 이 ADR은 croakcode가 **에이전트를 독립적 작업 주체(Agent Principal)** 로 취급하고, 사람→오케스트레이터→개발자→테스트로 이어지는 **정식 다중 에이전트 위임**을 설계 수준에서 다루기 위한 결정을 기록한다. 기존 ADR은 저장소에 없으므로 신규 작성한다(중복 없음 — `docs/`·`docs/superpowers/` 전수 확인 완료).

---

## 1. 맥락(Context)

croakcode의 철학은 "에이전트 = 독립적 작업 주체"다. 현재 upstream 실행 경로는 이를 **세션 중심**(session-centric)으로만 모델링한다:

- 실행 주체는 **세션**(`SessionID`)이고, 에이전트는 세션에 붙는 **이름(agent name)** 이다.
- 서브에이전트는 `task` 도구가 **자식 세션**을 만들어 호출한다. 자식 세션은 `SessionTable.parent_id`로 부모와 연결된다.
- 권한은 **에이전트 ruleset**과 **세션 permission**의 **순서 있는 평탄 연결(ordered flat concat)** 로 합쳐지고, `findLast`(마지막 매칭 규칙 우선)로 평가된다.
- 위임에 대한 **1급 개념(Principal, Grant, 위임 그래프, 철회)** 이 없다. 따라서 "누가 누구에게 무엇을 위임했는가"를 **감사(audit) 가능한 형태로 표현할 수 없다**.

이 ADR은 위임을 **세션 parentID의 부산물이 아니라 1급 보안 개념**으로 승격해야 한다고 판단한다. 단, Phase 1~3에서는 **설계 계약(contract)으로만** 정의하고 런타임 구현은 Phase 4로 분리한다(스코프 크리프 방지).

---

## 2. 결정(Decision)

### D1. Agent Principal을 1급 주체로 정의한다
- **Agent Principal = 독립적 작업 주체 + 위임받은 권한의 보유자**.
- 필수 속성: `principalId`, `ownerId`, `role`, `status`, `policyRef`, `capabilities`, `resourceScopes`, `createdBy`.
- **Agent Definition(템플릿)과 구분**한다. Definition은 "어떤 에이전트 종류인가"(예: `plan`, `general`, `dev-safe`)이고, Principal은 "이 조직에서 실제로 권한을 가진 인스턴스 주체"다. **Definition ≠ Principal**.

### D2. Agent Run / Session / Principal을 분리한다
- **Agent Run**: `runId`, `principalId`, `sessionId`, `parentRunId`, `modelBinding`, `effectivePolicyRevision`, `status`.
- **Session**: 대화·도구·이벤트의 저장 단위.
- **관계**: 하나의 Session에서 **여러 Run**이 가능하다(재개·재시도·재프롬프트). Run은 Principal을 참조하고, `parentRunId`로 위임 부모 Run과 연결된다.
- **세션 관계 ≠ 위임 관계**: `session.parentID`(대화 포함 관계)는 위임 그래프의 **충분조건이 아니다**. 위임은 별도의 `Delegation Grant`로만 성립한다.

### D3. Delegation Grant를 1급 레코드로 정의한다
- 필수 속성: `grantId`, `delegatorPrincipalId`, `delegateePrincipalId`, `parentGrantId`, `parentRunId`, `scope`, `capabilities`, `constraints`, `issuedAt`, `expiresAt`, `status`, `policyRevision`.
- 위임은 **명시적 Grant** 없이는 성립하지 않는다(fail-closed).
- `parentGrantId`로 **위임 체인**(delegation chain)을 형성한다.

### D4. 효과 권한(effective authorization) 불변식 — **핵심 보안 결정**
- 서브 에이전트의 권한은 다음의 **교집합(min)** 을 초과할 수 없다:

  ```
  effective(sub) ⊆ min(
      org max authority,          // 조직 상한
      delegator authority,        // 위임자 권한
      parent Run effective authority,  // 부모 Run 유효 권한
      own policy,                 // 자기 정책
      task scope / constraints    // 위임 Grant의 범위/제약
  )
  ```

- **독립 경로 간 합집합 증폭(union amplification) 금지**: 서로 다른 위임 경로의 권한을 **합쳐서 늘릴 수 없다**. 다중 경로가 있으면 각 경로의 min을 다시 **교집합**한다.
- 이 불변식은 §3.4 실행 허용 불변식(`Execute = ValidInput ∧ PluginAllow ∧ PolicySatisfied ∧ PermissionAllow`) **위에 얹히는 상위 제약**이며, 기존 불변식을 **약화시키지 않는다**(monotonic tightening).

### D5. capability를 분리한다
- **`agent.spawn`**: 새 Principal/Run을 만드는 능력.
- **`agent.delegate`**: 권한의 하위 집합을 다른 Principal에게 위임하는 능력.
- **`tool.execute`**: 실제 도구를 실행하는 능력.
- **분리 이유**: spawn만 가능하고 delegate는 불가하면, "자식을 만들되 권한은 넘기지 못함". delegate는 별도 상한(조직 정책)으로 통제한다.
- **서브 에이전트의 권한 상승 금지(절대)**: 서브 에이전트는 자기 `agent.delegate`/`agent.spawn` 범위를 넘는 grant를 발급할 수 없다.

### D6. 신원(identity)은 모델 출력/프롬프트로부터 신뢰하지 않는다
- `principalId`/`role`은 **모델이 생성한 텍스트나 프롬프트에서 추출하지 않는다**.
- 신원은 **런타임이 부여**(생성 시 principal 레지스트리에서 발급)한다. 프롬프트는 신원의 **표현**일 뿐, 신원의 **근거**가 아니다.
- 현재 upstream은 세션에 `agent` 이름을 저장하지만, 실행 시점 에이전트는 **메시지 단위 `lastUser.agent`** 에서 읽는다(`prompt.ts:1334`). 이러한 "이름 기반" 모델은 Principal 신원으로 부적합 → Phase 4에서 Principal 레지스트리 도입.

### D7. 철회(revocation)는 캐스케이드된다
- Grant 철회는 **하위 grant 전체**로 전파된다(revocation cascade).
- 철회된 grant/principal은 **실행 직전 검사**에서 fail-closed.
- 캐스케이드는 `parentGrantId` 체인을 따라 **재귀적으로** 하위를 `status: revoked`로 표시한다.

### D8. 감사(audit)는 1급 요구사항이다
- Principal 생성/위임/철회/실행은 **감사 로그**에 기록한다(누가, 언제, 어떤 grant로, 어떤 정책 revision으로).
- 실행 기록은 **parent/child Run 연결**을 구조적으로 제공해야 한다(현재는 `ToolPart.metadata`의 free-form `{parentSessionId, sessionId}` + `x-parent-session-id` 헤더뿐). Phase 4에서 **typed 필드**로 승격한다.

### D9. 구현 분리(Phase 3 vs Phase 4)
- **Phase 3**: 설계 계약 + 문서 + **기존 동작 검증**(현재 위임 경로의 실제 동작을 테스트로 고정). 런타임 Principal 레지스트리/위임 실행기는 **구현하지 않는다**.
- **Phase 4**: Agent Registry, Delegation Grant 저장/검증, Authorization 재확인, Revocation 전파, Execution Audit을 구현한다.
- **강제 경계(정직성)**: Phase 1~3의 강제는 **로컬 정책 강제(정상 클라이언트 기준)**. 변조 클라이언트에 대한 강제는 Phase 4 **서버 실행 허가**(§5.4)에서 완성된다. 이 ADR은 "위임이 안전하다"는 주장을 **검증 가능한 계약**으로만 남긴다.

---

## 3. 대안(Alternatives) 및 기각 사유

| 대안 | 내용 | 기각 사유 |
|---|---|---|
| A1. 세션 parentID를 위임으로 간주 | `session.parentID` 존재 = 위임 성립 | **기각**. 대화 포함 관계와 권한 위임 관계는 다르다. parentID만으로는 위임자 권한·범위·철회를 표현할 수 없다. |
| A2. 에이전트 이름으로 신원 결정 | `agent.name`을 principal로 사용 | **기각**. 이름은 config 문자열이며 위조/재사용 가능. 신원은 런타임 발급이어야 한다(D6). |
| A3. 권한 합집합(union)으로 위임 | 부모+자식 권한 합집합 | **기각**. 권한 증폭 위험(불변식 위반, D4). |
| A4. Phase 3에서 즉시 런타임 구현 | Principal/Registry을 지금 구현 | **기각**. 스코프 크리프 + Phase 2/3 계약 회귀 위험. Phase 4로 분리(D9). |
| A5. 모델이 위임 여부를 텍스트로 결정 | 프롬프트에 "delegate to X" | **기각**. 신원/권한을 모델 출력에서 신뢰하면 안 된다(D6). 위임은 **구조화된 Grant**로만 성립. |

---

## 4. 결과(Consequences)

### 긍정
- 위임이 **감사 가능**해진다(누가 누구에게 무엇을).
- 권한 불변식이 명시되어 **증폭 공격**을 설계 단계에서 차단.
- 세션/run/principal 분리로 **재개·재시도** 시 정책 일관성 확보.
- 기존 §3.4/§4.5/§5.4 계약을 **약화시키지 않음**(monotonic tightening).

### 부정/비용
- Principal 레지스트리·Grant 저장소의 **스키마 추가**(Phase 4). 기존 `sessions` 스키마와 별개.
- 실행 기록의 **typed parent/child Run 필드** 도입 필요(현재 free-form metadata).
- 오프라인 클라이언트에서 **철회 전파 지연** 가능 → 관리형 실행에서 fail policy 결정 필요(미해결 — Decision Required).

### 리스크
- **현재 코드의 실제 위임 경로에 이미 보안 결함 가능성**이 있다(아래 §5 근거). 이 ADR은 결함을 **고치지 않는다** — Phase 3에서 **검증**하고 Phase 4에서 **수정**한다.

---

## 5. 근거(코드 검증 — Phase 3에서 확정할 사실)

> 레이블: **확인된 사실**(코드 직접 확인) / **설계상 추론**(코드 경로 기반 추론) / **미검증**(추가 확인 필요).

- **task 도구 경로**(확인된 사실): `TaskTool`은 `agent.get(params.subagent_type)`로 자식 에이전트를 얻고(`task.ts:130`), `sessions.create({parentID: ctx.sessionID, permission: deriveSubagentSessionPermission(...)})`로 자식 세션을 만든다(`task.ts:142-159`). 이후 `ops.prompt({agent: next.name, tools: {...}, parts})`로 실행한다(`task.ts:183-199`).
- **자식 세션 저장**(확인된 사실): `SessionTable.parent_id` 컬럼 + `session_parent_idx` 인덱스(`session.sql.ts:25,57`), `children()` 쿼리(`session.ts:584-591`), 삭제 시 재귀(`session.ts:595-616`).
- **권한 병합 의미**(확인된 사실): `merge(...rulesets) = rulesets.flat()`(평탄 연결), `evaluate`는 `findLast`(마지막 매칭 우선, 기본 `ask`) — `upstream/packages/core/src/permission.ts:21-35`. **합집합도 교집합도 아니다.**
- **부모→자식 권한 전달**(확인된 사실): `deriveSubagentSessionPermission`은 **부모 에이전트의 edit-deny + 부모 세션의 deny/external_directory + 기본 todowrite/task deny**만 전달한다(`subagent-permissions.ts:17-34`). 부모의 **allow/ask는 전달하지 않는다**.
- **⚠️ 잠재적 권한 상승 경로**(확인된 사실 + 설계상 추론):
  1. 자식 세션 생성 시 `permission = deriveSubagentSessionPermission(...)` (edit-deny 포함) — `task.ts:147-158` (확인된 사실).
  2. 그러나 `ops.prompt({tools:{task:false}})`(`general`은 `todowrite` 규칙을 이미 가져 `todowrite:false`가 생략됨; `explore`/`scout`는 `{todowrite:false, task:false}`) 호출 → `prompt()`가 **`input.tools`가 비어있지 않으면 `session.permission`을 tools 맵으로 덮어쓴다** — `prompt.ts:1226-1233`, `setPermission`은 **전체 교체** `patch({permission: [...input.permission]})` — `session.ts:735-739` (확인된 사실).
  3. 결과: **부모 plan의 edit-deny가 자식 세션에서 소실**되고, 자식 에이전트(general: `"*": "allow"`)의 own ruleset이 edit을 허용 (설계상 추론).
  4. `tools` 맵이 비어있으면(예: task/todowrite 규칙 있는 커스텀 서브에이전트) 덮어쓰기가 일어나지 않아 deny가 유지됨 (설계상 추론 — **미검증** 통합 재현 필요).
- **손자 생성**(확인된 사실): `task`는 모든 에이전트에 등록된다. `general`/`explore`/`scout`는 defaults `"*": "allow"`를 상속하므로 **노출 게이트(`registry.ts:330-341`)에서 `task`는 allow로 노출된다(기본 deny 아님)**. 실제 제한은 `deriveSubagentSessionPermission`이 자식 세션에 `{permission:"task", pattern:"*", action:"deny"}`를 주입하고(`subagent-permissions.ts:22,32`), 실행 시 `ctx.ask`가 `merge(agent, session)`에서 session-last로 이 deny를 최종 매칭(`findLast`)해 차단하는 것이다(`session/tools.ts:64-72`). 또한 `task.ts:195`가 tools 맵에 `task:false`를 넣는다. **에이전트 config에 `task` 규칙이 명시된 경우에만** 손자 생성이 가능하다.
- **취소 전파**(확인된 사실): 포그라운드는 `ctx.abort` 리스너 → `ops.cancel(nextSession.id)`(`task.ts:260-269`), 백그라운드는 `SessionRunState.cancel`의 `metadata.parentSessionId` 매칭(`run-state.ts:122-128`).
- **실행 기록 연결**(확인된 사실): `ToolPart.metadata`에 `{parentSessionId, sessionId, model}`(`task.ts:168-178`) + `x-parent-session-id` 헤더(`session/llm/request.ts:165`). **typed 교차세션 부모/자식 필드는 없음.**
- **에이전트 vs 세션 분리**(확인된 사실): `Session.Info.id` + `Session.Info.agent`(optional) 분리(`session.ts:209-221`, `session.sql.ts:19,44`). 그러나 실행 시 에이전트는 **메시지 단위 `lastUser.agent`** (`prompt.ts:1334`).
- **철회 개념 부재**(확인된 사실): 코드베이스에 revocation/authorization 재확인 개념 없음. 실행 직전 검사는 `ctx.ask`(Permission evaluate + live approved list)뿐(`session/tools.ts:64-72`, `permission/index.ts:176-186`). **부모 권한 재검증은 없음.**
- **기존 보안 회귀 테스트**(확인된 사실): `test/agent/plan-mode-subagent-bypass.test.ts`는 `deriveSubagentSessionPermission` + merge를 **격리 환경에서** 검증하며 5/5 통과. 그러나 이 테스트는 **`prompt()`의 덮어쓰기 경로를 거치지 않으므로** 위 3번 경로를 포착하지 못한다(설계상 추론). `test/tool/task.test.ts`는 15/15 통과하며, 그중 abort 전파(포그라운드 `:290`, 백그라운드 재귀 취소 `:705`)는 검증되지만 **no-task-rule 자식의 task deny**와 **plan→general 통합 상승 경로**는 검증하지 않는다(실행 증거: `docs/superpowers/evidence/agent-principal-delegation/2026-11-08-test-evidence.md`).

---

## 6. 결정이 필요한 항목(Decision Required — 사용자 승인)

1. **Agent Run vs Session**: 한 세션에 다중 Run을 허용하는가? (재개/재시도 시 runId 발급 정책)
2. **Grant 저장소**: 새 DB 테이블(`delegation_grants`)로 둘 것인가, 세션 metadata에 임베드할 것인가? (새 테이블 권장)
3. **철회 메커니즘**: epoch / policy revision / 실행 직전 재확인 중 무엇을 채택하는가?
4. **오프라인 철회 한계**: 오프라인 클라이언트에서 철회 전파 지연을 어떻게 처리하는가? 관리형 실행에서 fail policy(deny vs queue)?
5. **강제 경계**: 강제 권한을 "신뢰 실행기(trusted executor)" vs "원격 서버" 중 어디에 둘 것인가? (Phase 4 §5.4 서버 실행 허가와의 범위 분담)
6. **위임 불변식 강도**: `min()` 교집합을 **런타임에서 매 실행마다** 검증할 것인가, 아니면 Grant 발급 시점에만 검증할 것인가?

---

## 7. 관련 불변식 요약(정본)

| ID | 불변식 | 위반 시 |
|---|---|---|
| INV-1 | 신원은 런타임 발급. 모델 출력/프롬프트에서 신원을 신뢰하지 않는다. | fail-closed |
| INV-2 | `effective(sub) ⊆ min(org, delegator, parentRun, ownPolicy, taskScope)` | deny |
| INV-3 | 독립 위임 경로 간 union 증폭 금지 | deny |
| INV-4 | 서브 에이전트는 자기 권한을 초과하는 grant를 발급할 수 없다. | deny |
| INV-5 | Grant/Principal 철회는 하위로 캐스케이드되고 실행 직전 검사에서 fail-closed. | deny + audit |
| INV-6 | 위임은 명시적 Grant 없이 성립하지 않는다. | deny |
| INV-7 | 위임·실행은 감사 로그에 기록된다(정책 revision 포함). | audit 누락 = 결함 |
| INV-8 | 기존 §3.4 실행 허용 불변식을 약화시키지 않는다(monotonic tightening). | deny |

---

## 8. 후속 작업(Follow-ups)

- Phase 3: 위 §5 근거를 **테스트로 고정**(특히 잠재적 권한 상승 경로의 통합 재현). → `docs/superpowers/plans/2026-11-08-phase3-plugin-port.md` 영향 분석 참조.
- Phase 4: Principal Registry / Delegation Store / Authorization 재확인 / Revocation / Audit 구현 → `docs/superpowers/architecture/2026-11-08-phase4-blueprint.md`.
