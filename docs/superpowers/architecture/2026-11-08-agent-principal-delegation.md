# Agent Principal & Delegation Architecture

- **상태**: Proposed (설계 승인 대기 — 런타임 구현 없음)
- **날짜**: 2026-11-08
- **관련 문서**:
  - ADR: `docs/superpowers/adr/0001-agent-principal-and-delegation.md`
  - 설계 명세: `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md`
  - Phase 3 계획: `docs/superpowers/plans/2026-11-08-phase3-plugin-port.md`
  - Phase 4 Blueprint: `docs/superpowers/architecture/2026-11-08-phase4-blueprint.md`
- **근거 레이블**: 코드에서 직접 확인한 것은 **확인된 사실**, 코드 경로에 기반한 추론은 **설계상 추론**, 추가 확인이 필요한 것은 **미검증**.

> 이 문서는 croakcode의 에이전트를 **독립적 작업 주체(Agent Principal)** 로 다루고, 사람→오케스트레이터→개발자→테스트로 이어지는 **정식 다중 에이전트 위임**을 설계 수준에서 정의한다. **런타임 구현은 포함하지 않는다** — 구현은 Phase 4에서 별도 승인 후 진행한다.

---

## 1. Concept Model (개념 모델)

croakcode의 위임 아키텍처는 다음 7가지 개념으로 구성된다. 각 개념은 **서로 다른 수명주기와 저장 단위**를 가진다.

| 개념 | 정의 | 수명주기 | 저장 단위(권장) |
|---|---|---|---|
| **Human Principal** | 최상위 권한 보유자(사용자/조직 관리자). 모든 위임의 근원. | 장기 | 외부 IdP / 관리자 설정 |
| **Agent Definition** | 에이전트 **템플릿**(종류). 예: `plan`, `general`, `dev-safe`. 권한의 **기본값**만 가진다. | 설정 변경 시 | config(`.croakcode/agent/*.md`) |
| **Agent Principal** | 조직 내에서 **실제로 권한을 가진 인스턴스 주체**. `principalId`로 식별. Definition에서 파생되지만 **별개**. | Principal 생성~폐기 | Principal Registry |
| **Agent Run** | Principal이 특정 Session에서 **한 번 실행**한 단위. 재개/재시도마다 새 Run. | 짧음(턴~재개) | Run 로그 / Audit |
| **Session** | 대화·도구·이벤트의 **저장 단위**. 하나의 Session에 여러 Run이 가능. | 세션 생성~삭제 | `sessions` 테이블 |
| **Delegation Grant** | delegator가 delegatee에게 **권한의 부분집합**을 위임하는 명시적 레코드. | 발급~철회/만료 | Delegation Store |
| **Delegation Graph** | Grant들의 **트리/체인**. `parentGrantId`로 연결. | Grant 수명주기와 동일 | Delegation Store |

### 1.1 핵심 구분(반드시 지킬 것)
- **Definition ≠ Principal**: Definition은 "어떤 종류"이고, Principal은 "이 조직에서 실제로 권한을 가진 주체". 예: 같은 `general` Definition에서 여러 Principal이 생성될 수 있다.
- **Session 관계 ≠ 위임 관계**: `session.parentID`는 "대화 포함 관계"다. **위임은 Grant로만 성립**한다. 즉, 자식 세션(parentID 존재)이 있다고 해서 **권한 위임이 자동으로 성립하지 않는다**.
- **Agent ID ≠ Session ID**: Principal(`principalId`)과 Run(`runId`)과 Session(`sessionId`)은 **별개 식별자**다. 현재 upstream은 세션에 agent 이름만 저장하므로(`session.agent`), Principal/Run 계층을 추가해야 한다.

### 1.2 용어 정합성(확인된 사실 기반)
- 현재 upstream `Agent.Info.mode`는 `primary|subagent|all`이며 **연결 모드가 아니다**(`agent.ts:32`). 위임 모델의 "role"과 혼동하지 않는다.
- 현재 upstream에는 `force`/`connection-mode` 필드가 **없다**(확인된 사실).

---

## 2. Agent / Run / Session 관계

### 2.1 3계층 분리
```
Human Principal (owner)
   └─ Agent Principal (principalId, ownerId, role, status, policyRef, capabilities, resourceScopes, createdBy)
        └─ Agent Run (runId, principalId, sessionId, parentRunId, modelBinding, effectivePolicyRevision, status)
             └─ Session (sessionId, messages, parts, events)
```

### 2.2 불변식
- **INV-2.1**: 모든 Run은 정확히 하나의 Principal을 참조한다(`runId → principalId`).
- **INV-2.2**: 모든 Principal은 하나의 owner(상위 Principal 또는 Human)를 가진다(`ownerId`).
- **INV-2.3**: Run의 `parentRunId`는 위임 부모 Run을 가리키며, 없으면 최상위(사람이 시작한) Run이다.
- **INV-2.4**: 하나의 Session에 여러 Run이 있을 수 있으나, **동시에 활성인 Run은 최대 1개**(세션 직렬성). 재개 시 이전 Run은 `completed`/`aborted`로 마감.

### 2.3 `effectivePolicyRevision`
- 각 Run은 실행 시점의 **정책 revision**을 고정한다(턴 스냅샷, §5.4과 정합).
- `effectivePolicyRevision`이 바뀌면 **다음 Run/턴**부터 적용. 진행 중 Run의 정책은 고정(모델이 본 도구 집합이 턴 중 바뀌면 안 됨 — §4.7).
- **현재 코드와의 정합**: upstream은 세션 `permission`을 `prompt()` 시점에 덮어쓴다(`prompt.ts:1226-1233`, 확인된 사실). 이는 "턴 스냅샷"과 충돌할 수 있는 지점 → Phase 3에서 검증 대상.

### 2.4 세션 parentID vs 위임 parentRunId
- `session.parentID`: 대화 포함 관계(현재 `SessionTable.parent_id`, 확인된 사실).
- `parentRunId`: **권한 위임 관계**(신규).
- **두 관계는 독립**: 대화상 자식 세션이라도 위임 Grant가 없으면 **위임이 아니다**(fail-closed). 반대로 위임 Grant가 있어도 대화 세션이 반드시 분리될 필요는 없다.

---

## 3. Delegation Graph (위임 그래프)

### 3.1 구조
- 위임 그래프는 **트리(forest)** 이다. 각 Grant는 최대 하나의 `parentGrantId`를 가진다.
- **체인 예시**: Human → Orchestrator → Developer → Test
  ```
  G0: Human --delegate--> Orchestrator
  G1: Orchestrator --delegate--> Developer   (parentGrantId = G0)
  G2: Developer --delegate--> Test           (parentGrantId = G1)
  ```

### 3.2 Grant 속성(정본)
| 필드 | 의미 | 필수 |
|---|---|---|
| `grantId` | 고유 ID | ✅ |
| `delegatorPrincipalId` | 위임하는 주체 | ✅ |
| `delegateePrincipalId` | 위임받는 주체 | ✅ |
| `parentGrantId` | 상위 Grant(체인 연결) | 부모가 있으면 필수 |
| `parentRunId` | 위임이 발생한 Run | ✅ |
| `scope` | 위임 범위(예: 작업 디렉터리, 세션) | ✅ |
| `capabilities` | 위임하는 capability 집합(`agent.spawn`/`agent.delegate`/`tool.execute` 하위) | ✅ |
| `constraints` | 추가 제약(시간, 도구 화이트리스트 등) | ✅ |
| `issuedAt` | 발급 시각 | ✅ |
| `expiresAt` | 만료 시각 | ✅ |
| `status` | `active`/`revoked`/`expired`/`consumed` | ✅ |
| `policyRevision` | 발급 시점 정책 revision | ✅ |

### 3.3 그래프 불변식
- **INV-3.1**: `childGrant.capabilities ⊆ parentGrant.capabilities` (각 단계에서 부분집합).
- **INV-3.2**: `childGrant.scope ⊆ parentGrant.scope`.
- **INV-3.3**: `childGrant.constraints`는 부모 제약을 **약화할 수 없다**(추가 제약만 가능).
- **INV-3.4**: `childGrant.expiresAt ≤ parentGrant.expiresAt`.
- **INV-3.5**: `childGrant.policyRevision ≥ parentGrant.policyRevision`(정책은 단조 증가).
- **INV-3.6**: 위임 그래프는 **순환(cycle) 불가** — `parentGrantId` 체인에 자기 자신이 나오면 deny.

### 3.4 다중 경로 처리(union 증폭 금지)
- 같은 delegatee가 **여러 경로**로 Grant를 받을 수 있다.
- 이 경우 효과 권한은 **각 경로 min의 교집합**이다(합집합 아님).

  ```
  effective(delegatee) = ∩_{g ∈ grants(delegatee)} min(org, delegator(g), parentRun(g), ownPolicy, scope(g))
  ```

- **예시(금지)**: Developer가 G1(Orchestrator→Developer, `bash` 없음)과 G1'(Human→Developer, `bash` 있음)을 받았을 때 `bash` 권한을 얻으면 **union 증폭 위반**. 올바른 결과: `bash`는 두 경로 중 하나라도 없으면 **없음**(교집합).

### 3.5 위임 깊이 제한
- 조직 정책으로 **최대 위임 깊이**(예: 3단계)를 둘 수 있다.
- 깊이 초과 시 Grant 발급 **거부**(fail-closed).
- Phase 4 결정 사항(Decision Required).

---

## 4. Effective Authorization (효과 권한)

### 4.1 정본 불변식(INV-2)
```
effective(sub) ⊆ min(
    org max authority,               // 조직 상한
    delegator authority,             // 위임자 자신의 효과 권한
    parent Run effective authority,  // 부모 Run의 효과 권한
    own policy,                      // 서브 에이전트 Definition의 정책
    task scope / constraints         // Grant의 범위/제약
)
```

### 4.2 계산 순서(권장)
1. **org max** 로드(관리자 정책, 서명된 정책 파일 — §5.4 신뢰 수준 표).
2. **delegator effective** 계산(재귀적으로 상위 Grant 체인).
3. **parentRun effective** 로드(부모 Run의 고정 정책 revision).
4. **own policy** 로드(Definition + config).
5. **task scope/constraints** 로드(Grant).
6. 5개를 **교집합**. 빈 집합이면 **deny**(fail-closed).
7. 결과를 **Grant의 capabilities와 다시 교집합**.

### 4.3 union 증폭 금지
- 독립 위임 경로가 둘 이상이면(§3.4) **각 경로 effective의 교집합**을 취한다.
- **금지 예**: `effective = pathA ∪ pathB` (합집합). 이는 INV-3 위반.
- **허용 예**: `effective = pathA ∩ pathB`.

### 4.4 capability 분리와의 관계
- **`agent.spawn`**: delegatee가 새 Run을 만들 수 있는가.
- **`agent.delegate`**: delegatee가 하위 Grant를 발급할 수 있는가.
- **`tool.execute`**: delegatee가 실제 도구를 실행할 수 있는가.
- 각 capability는 **독립적으로 교집합**된다. 예: delegatee가 `agent.spawn`은 있으나 `tool.execute`가 없으면, 자식을 만들 수는 있지만 도구는 실행 못 함(자식의 tool.execute도 교집합에서 나옴).

### 4.5 기존 §3.4 실행 허용 불변식과의 관계
- §3.4: `Execute = ValidInput ∧ PluginAllow ∧ PolicySatisfied ∧ PermissionAllow`
- 위임 불변식은 **그 위에 얹히는 상위 제약**이다:
  ```
  Execute_delegate = Execute(§3.4) ∧ effectiveAuthorization(§4)
  ```
- 즉, 위임 제약은 기존 불변식을 **약화시키지 않고 강화**한다(monotonic tightening).
- `mode: "gate"` vs `"direct"`에 따라 `PolicySatisfied`의 의미가 다르나(§3.4), 위임 제약은 **모드와 무관하게 동일**하게 적용된다.

### 4.6 현재 코드와의 갭(확인된 사실)
- 현재 코드는 **교집합을 계산하지 않는다**. `merge`는 평탄 연결이고 `findLast`로 마지막 매칭 규칙 우선(`core/src/permission.ts:21-35`, 확인된 사실).
- 따라서 "child ⊆ parent" 런타임 검사가 **없다**(확인된 사실).
- Phase 4에서 **효과 권한 교집합 계산기**를 도입해야 한다.

---

## 5. Spawn / Delegate Protocol (생성·위임 프로토콜)

### 5.1 두 가지 프로토콜
- **Spawn**: 새 Principal/Run을 만든다(부모가 자식을 실행).
- **Delegate**: 하위 Grant를 발급한다(권한을 넘긴다).
- **주의**: Spawn과 Delegate는 **분리**될 수 있다. Spawn만 하고 Delegate는 안 할 수 있다(권한 없는 자식).

### 5.2 Spawn 프로토콜(권장 시퀀스)
```
1. caller가 agent.spawn 권한을 effective 검사로 보유하는가?  (deny 시 중단)
2. delegatee Definition 해석(agent.get → Definition)
3. 새 Principal 발급(principalId) — 레지스트리에 등록
4. 새 Run 생성(runId, parentRunId=caller run, principalId, sessionId)
5. effective 권한 계산(§4) — Grant가 있으면 Grant scope 적용
6. Turn 스냅샷 고정(effectivePolicyRevision)
7. 실행 시작
```

### 5.3 Delegate 프로토콜(권장 시퀀스)
```
1. caller가 agent.delegate 권한을 effective 검사로 보유하는가?  (deny 시 중단)
2. delegatee Principal이 존재하는가? (없으면 spawn 먼저)
3. 새 Grant 구성:
   - capabilities ⊆ caller effective capabilities
   - scope ⊆ caller effective scope
   - constraints ⊇ caller constraints
   - expiresAt ≤ caller expiresAt
   - policyRevision ≥ caller policyRevision
4. Grant 저장(Delegation Store)
5. 감사 로그 기록(grantId, delegator, delegatee, scope, revision)
6. delegatee Run 시작 시 effective 재계산(§4)
```

### 5.4 프로토콜 불변식
- **INV-5.1**: Delegate는 caller effective 권한의 **부분집합만** 넘길 수 있다(INV-3.1~3.5로 구체화).
- **INV-5.2**: 서브 에이전트는 자기 `agent.delegate` 범위를 넘는 Grant를 **발급할 수 없다**(권한 상승 금지).
- **INV-5.3**: 신원(`principalId`, `role`)은 **런타임이 부여**한다. 모델 출력/프롬프트에서 신원을 추출/신뢰하지 않는다.
- **INV-5.4**: Spawn/Delegate는 **명시적 Grant 없이 성립하지 않는다**(fail-closed).

### 5.5 현재 task 도구와의 매핑(확인된 사실)
- 현재 `task` 도구는 spawn만 수행하며 **Delegate 개념이 없다**: 자식 세션을 만들고 `deriveSubagentSessionPermission`으로 제한된 permission을 넘긴다(`task.ts:142-159`).
- 자식 에이전트의 `agent`는 `ops.prompt({agent: next.name})`으로 전달되며, 자식 세션에 `agent`를 **저장하지 않는다**(확인된 사실).
- 신원은 "이름" 기반이며 Principal 레지스트리가 **없다**.

### 5.6 잠재적 권한 상승 경로(Phase 3 검증 대상 — 확인된 사실 + 설계상 추론)
- **경로**: plan 부모 → general 자식
  1. `task.ts:147-158`에서 `permission: deriveSubagentSessionPermission(...)` (부모 plan edit-deny 포함) (확인된 사실).
  2. `ops.prompt({tools:{task:false}})`(`general`은 이미 `todowrite` 규칙이 있어 `todowrite:false` 생략; `explore`/`scout`는 `{todowrite:false, task:false}`) → `prompt.ts:1226-1233`에서 **`session.permission`을 tools 맵으로 덮어씀** (확인된 사실). `setPermission`은 전체 교체(`session.ts:735-739`, 확인된 사실).
  3. 결과적으로 **부모 plan edit-deny가 소실**, 자식 general의 `"*": "allow"`가 edit 허용 (설계상 추론).
- **단, tools 맵이 비어있으면** 덮어쓰기 없음 → deny 유지 (설계상 추론, **미검증**).
- **현재 테스트 한계**: `test/agent/plan-mode-subagent-bypass.test.ts`는 helper를 격리 검증하며, **덮어쓰기 경로를 거치지 않는다** → 잠재적 상승 경로를 **포착하지 못함** (설계상 추론).
- **결론**: Phase 3에서 **통합 재현 테스트**를 추가하고, Phase 4에서 수정해야 한다. 이 문서는 **결함을 고치지 않는다**(스코프 분리).

---

## 6. Revocation Cascade (철회 캐스케이드)

### 6.1 철회 트리거
- Human/관리자가 Grant 또는 Principal을 **명시적으로 철회**.
- `expiresAt` 도달 → `status: expired`.
- 정책 revision 변경으로 `policyRevision`이 부모와 어긋남.
- 보안 사고 대응(관리자 긴급 철회).

### 6.2 캐스케이드 규칙
- Grant 철회 시 **하위 Grant 전체**를 재귀적으로 `status: revoked`로 표시한다(`parentGrantId` 체인).
- Principal 철회 시 **그 Principal이 발급한 모든 Grant**와 **그 Principal을 참조하는 모든 Run**을 철회/중단한다.
- **INV-6.1**: 철회는 **하위 우선(top-down) 캐스케이드**이며, **누락 없이** 전파된다.
- **INV-6.2**: 철회된 Grant/Principal은 **실행 직전 검사**에서 fail-closed.
- **INV-6.3**: 철회는 **감사 로그**에 남는다(누가, 언제, 무엇을).

### 6.3 철회 메커니즘 선택지(Decision Required)
| 메커니즘 | 설명 | 장점 | 단점 |
|---|---|---|---|
| **epoch** | 전역 철회 epoch 증가. Run은 자신의 epoch을 참조. epoch < 현재면 deny. | 단순, 빠름 | 세밀한 Granularity 부족 |
| **policy revision** | `effectivePolicyRevision` 비교. 낮으면 deny. | 정책과 정합 | revision 증가만으로는 특정 Grant 철회 불가 |
| **실행 직전 재확인** | 매 도구 실행 직전 Grant status를 조회. | 정확 | DB 조회 비용, 오프라인 문제 |

- **권장**: **실행 직전 재확인 + policy revision 결합**. 단, 오프라인 클라이언트에서는 **fail policy** 결정 필요(§8).

### 6.4 현재 코드와의 갭(확인된 사실)
- 현재 코드에 **revocation 개념이 없다**. 실행 직전 검사는 `ctx.ask`(Permission evaluate + live approved)뿐(`session/tools.ts:64-72`, 확인된 사실).
- 부모 권한 재검증이 **없다**(확인된 사실).

---

## 7. Context Isolation (컨텍스트 격리)

### 7.1 격리 대상
- **서브 에이전트의 컨텍스트**: 부모 대화·도구 결과·민감정보(gate 주입 secret/PII 등)와 **격리**.
- **위임 경계**: delegatee는 delegator의 컨텍스트를 **무분별하게 상속하지 않는다**.

### 7.2 격리 규칙
- **INV-7.1**: 서브 에이전트 Run은 부모 Session의 **전체 메시지를 상속하지 않는다**. 필요한 컨텍스트만 **명시적 전달**(prompt parts)한다.
- **INV-7.2**: gate 전용 컨텍스트(`origin:"gate"`, `sensitivity:"secret"`)는 **direct 모드/위임 경계에서 제외**한다(§5.4 옵션 A).
- **INV-7.3**: 서브 에이전트의 도구 결과는 부모에게 **요약/정제된 형태**로만 전달된다(원본 주입 금지).
- **INV-7.4**: 위임 Grant의 `scope`는 컨텍스트 접근 범위도 제한한다.

### 7.3 현재 코드와의 정합(확인된 사실)
- `task.ts`는 `params.prompt`만 자식에 전달하며, 부모 대화 전체를 넘기지 않는다(`task.ts:183-199`). → **부분적 격리**.
- 하지만 자식 세션은 `parentID`로 연결되어 **조회 가능**하며, 부모 컨텍스트가 자식에게 자동 주입되는 경로는 코드상 **명시적이지 않음**(확인된 사실).
- provenance 태그(`TextPart.metadata`/`ToolPart.metadata` free-form)로 gate 컨텍스트 추적 가능(확인된 사실 — `message-v2.ts:103-119, 316-323`).
- 요청 조립 시 필터 지점: `prompt.ts:1439-1445`(`experimental.chat.messages.transform` → `toModelMessagesEffect`) (확인된 사실).

### 7.4 격리 실패 시나리오
- 부모의 secret 컨텍스트가 자식에게 유출 → gate 우회.
- 자식의 도구 결과가 부모 프롬프트에 원본 주입 → 민감정보 재노출.
- 다중 위임 경로에서 교차 컨텍스트 누수.

---

## 8. Execution Audit (실행 감사)

### 8.1 감사 대상(필수)
- Principal 생성/폐기.
- Grant 발급/철회/만료.
- Run 시작/종료/중단.
- 도구 실행(allow/deny/ask 결정, `errorCode`, 정책 revision).
- 위임 체인(parentRunId → runId).

### 8.2 감사 레코드 필드(권장)
| 필드 | 의미 |
|---|---|
| `auditId` | 고유 ID |
| `eventType` | `principal.created`/`grant.issued`/`grant.revoked`/`run.started`/`run.ended`/`tool.executed`/`tool.denied` 등 |
| `principalId` / `runId` / `sessionId` | 주체 |
| `parentRunId` / `grantId` | 위임 연결 |
| `decision` | `allow`/`deny`/`ask` |
| `errorCode` | §3.4 errorCode(`INVALID_INPUT`/`PERMISSION_DENIED` 등) |
| `policyRevision` | 실행 시점 정책 |
| `timestamp` | 시각 |

### 8.3 보존·분리
- usage 로그와 **보안 감사 로그를 분리**한다(§4.4).
- 감사 로그 기본 보존 365일(§4.4 정합).
- 프롬프트 원문은 **기록하지 않는다**(도구/스킬 ID와 판정만 — §4.7 정합).

### 8.4 현재 코드와의 정합(확인된 사실)
- 실행 기록 연결은 `ToolPart.metadata`의 free-form `{parentSessionId, sessionId, model}`(`task.ts:168-178`) + `x-parent-session-id` 헤더(`session/llm/request.ts:165`)뿐이다.
- **typed parentRunId/childRunId 필드가 없다** → Phase 4에서 승격 필요.
- `EventLog { append, query }` 계약은 이미 존재(§4.4) → 감사 레코드의 저장소로 재사용 가능(설계상 추론).

---

## 9. Failure Scenarios (실패 시나리오)

| # | 시나리오 | 기대 동작 | 불변식 | 현재 상태 |
|---|---|---|---|---|
| F1 | 서브 에이전트가 부모 권한 초과 시도 | deny + audit | INV-2, INV-5.2 | **미검증** (런타임 교집합 없음) |
| F2 | Grant 없이 위임 시도 | deny(fail-closed) | INV-5.4 | **없음** (Grant 개념 부재) |
| F3 | 철회된 Grant로 실행 | 실행 직전 deny | INV-6.2 | **없음** (revocation 부재) |
| F4 | 철회 캐스케이드 누락 | 상위 철회 시 하위 자동 철회 | INV-6.1 | **없음** |
| F5 | 다중 경로 union 증폭 | 교집합으로 차단 | ADR INV-3 / §3.4·§4.3 | **없음** |
| F6 | gate secret 컨텍스트가 direct/위임에 유출 | 요청 조립 시 제외 | INV-7.2 | Phase 3 검증(Task 16b) |
| F7 | plan 부모 → general 자식 edit 상승 | deny 유지 | INV-2 | **잠재적 위반**(§5.6) — Phase 3 검증 대상 |
| F8 | 신원을 프롬프트/모델 출력으로 위조 | 런타임 신원만 신뢰 | INV-5.3 | **없음** (이름 기반) |
| F9 | 손자 생성으로 권한 우회 | 세션 task deny + ctx.ask로 차단 | INV-5.2 | **부분 확인**(세션 주입 deny + `ctx.ask`; 노출 게이트는 allow) |
| F10 | 부모 취소 후 자식 계속 실행 | 취소 전파 | — | 확인된 사실(abort chain + metadata) |
| F11 | 순환 위임 그래프 | 발급 거부 | INV-3.6 | **없음** |
| F12 | 오프라인 철회 지연 | fail policy(deny 권장) | INV-6.2 | Decision Required |
| F13 | `session.permission` 덮어쓰기로 deny 소실 | 턴 스냅샷 유지 | §2.3 / §5.4(턴 스냅샷) | **잠재적 위반**(§5.6) |
| F14 | 감사 로그 누락 | 결함으로 간주 | INV-7 | **없음**(typed 필드 부재) |

---

## 10. Phase 3 / Phase 4 Scope

### 10.1 Phase 3(설계·검증만 — 런타임 구현 없음)
- **설계 계약 확정**: 본 문서 + ADR + spec 반영.
- **기존 동작 검증**: 현재 위임 경로의 실제 동작을 테스트로 **고정**한다.
  - F7/F13 잠재적 상승 경로의 **통합 재현 테스트**(현재 격리 테스트로는 미포착).
  - F9 손자 생성 제한 확인.
  - F10 취소 전파 확인.
  - F6 gate 컨텍스트 제외(Task 16b E2E).
- **Phase 3 계획 영향 분류**: 각 Task를 `변경 없음`/`계약·문서 보강`/`기존 구현 검증 필요`/`Phase 4에서 구현`/`설계 변경 승인 필요`로 분류(별도 문서 `docs/superpowers/phase3-impact/` 참조).
- **금지**: Principal 레지스트리, Grant 저장, revocation 실행기, 교집합 계산기 **구현 금지**(Phase 4).

### 10.2 Phase 4(구현 — 별도 승인 필요)
- Agent Principal Registry.
- Delegation Grant Store(스키마, 발급/철회).
- Authorization 재확인기(효과 권한 교집합, 실행 직전).
- Revocation Cascade 실행기.
- Execution Audit(typed parentRunId, 감사 레코드).
- 서버 실행 허가(§5.4)와의 **소유권 분담**(Phase 4 Blueprint 문서 참조).

### 10.3 강제 경계(정직성)
- Phase 3까지의 강제는 **로컬 정책 강제(정상 클라이언트 기준)**.
- 변조 클라이언트에 대한 강제는 Phase 4 **서버 실행 허가**(§5.4)에서 완성된다.
- 본 문서는 위임 안전성을 **검증 가능한 계약과 테스트 추적표**로만 주장한다 — **가짜 PASS 금지**(§6.6 상태 기준: PASS/FAIL/NOT TESTED/FUTURE CONTRACT).

### 10.4 테스트 추적표
→ `docs/superpowers/architecture/2026-11-08-security-invariants-and-test-traceability.md` 참조(AG/DG/RV/CX/AU/SC ID 매트릭스).
