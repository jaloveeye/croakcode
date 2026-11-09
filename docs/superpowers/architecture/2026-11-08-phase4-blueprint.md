# Phase 4 Blueprint — Agent Registry, Delegation, Authorization, Revocation, Audit

- **상태**: 구현 완료(2026-11-09). 구현과 결정 기록은 `docs/superpowers/plans/2026-11-09-phase4-delegation-runtime.md`에 있다. 이 문서는 당시 청사진으로 남긴다
- **날짜**: 2026-11-08
- **관련 문서**:
  - ADR: `docs/superpowers/adr/0001-agent-principal-and-delegation.md`
  - 위임 아키텍처: `docs/superpowers/architecture/2026-11-08-agent-principal-delegation.md`
  - 보안 불변식/테스트 추적표: `docs/superpowers/architecture/2026-11-08-security-invariants-and-test-traceability.md`
  - 설계 명세 §5.4: `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md`

> 이 문서는 Phase 4에서 구현할 **5개 서브시스템**(Agent Registry, Delegation, Authorization, Revocation, Audit)의 책임·인터페이스·소유권 분담을 청사진으로 고정한다. **구현 코드는 포함하지 않는다.**

---

## 1. 범위와 비범위

### 1.1 범위(Phase 4 구현)
1. **Agent Registry** — Principal 발급/조회/폐기.
2. **Delegation Store** — Grant 발급/저장/조회/만료.
3. **Authorization Re-checker** — 효과 권한 교집합 계산 + 실행 직전 재확인.
4. **Revocation Cascade** — Grant/Principal 철회 전파.
5. **Execution Audit** — typed parentRunId/childRunId, 감사 레코드 기록.

### 1.2 비범위(이 청사진에서 제외)
- LLM 스트리밍/세션/도구 실행 자체(upstream 재사용).
- TUI/SaaS 멀티테넌시.
- 서버 실행 허가(§5.4)의 **프로토콜 구현**은 아래 §6에서 소유권만 정리하고, 상세는 별도 §5.4 계약 문서.

---

## 2. Agent Registry

### 2.1 책임
- Principal **발급**(생성 시 런타임이 신원 부여 — INV-5.3).
- Principal **조회**(`principalId` → `{ownerId, role, status, policyRef, capabilities, resourceScopes, createdBy}`).
- Principal **폐기**(status 전환 + 참조 Run 철회 트리거).

### 2.2 인터페이스 초안(contracts)
```ts
interface AgentRegistry {
  issue(input: {
    definitionRef: string;   // Agent Definition (템플릿)
    ownerId: string;         // 상위 Principal 또는 Human
    role: string;            // 역할(예: orchestrator/developer/test)
    policyRef: string;       // 정책 참조
    capabilities: Capability[];
    resourceScopes: Scope[];
    createdBy: string;       // 발급자(런타임)
  }): Promise<AgentPrincipal>;             // principalId 발급

  get(principalId: string): Promise<AgentPrincipal | undefined>;
  revoke(principalId: string, reason: string): Promise<void>;
  listByOwner(ownerId: string): Promise<AgentPrincipal[]>;
}
```

### 2.3 저장(권장)
- 새 테이블 `agent_principals`:
  `principal_id TEXT PK, owner_id TEXT, role TEXT, status TEXT, policy_ref TEXT, capabilities JSON, resource_scopes JSON, created_by TEXT, created_at INT, updated_at INT`.
- 기존 `sessions`/`messages`/`parts` 스키마와 **별개**(§4.4 스키마 버전 관리와 정합).

### 2.4 불변식
- 발급은 **런타임만** 수행. 입력의 `ownerId`/`role`이 신뢰 가능한 소스(관리자 정책/IdP)에서 온 경우에만.
- 폐기된 Principal로 Run 생성 **금지**.

---

## 3. Delegation Store

### 3.1 책임
- Grant **발급**(부모 체인 검증 후 저장).
- Grant **조회**(delegatee별, chain별).
- **만료** 처리(`expiresAt` 도달 → `status: expired`).
- Grant **철회** 트리거(Revocation으로 위임).

### 3.2 인터페이스 초안(contracts)
```ts
interface DelegationStore {
  issue(input: {
    delegatorPrincipalId: string;
    delegateePrincipalId: string;
    parentGrantId?: string;
    parentRunId: string;
    scope: Scope[];
    capabilities: Capability[];
    constraints: Constraint[];
    expiresAt: number;
    policyRevision: number;
  }): Promise<DelegationGrant>;            // grantId 발급

  get(grantId: string): Promise<DelegationGrant | undefined>;
  listByDelegatee(delegateePrincipalId: string): Promise<DelegationGrant[]>;
  listChain(grantId: string): Promise<DelegationGrant[]>;  // parentGrantId 추적
  expire(grantId: string): Promise<void>;
}
```

### 3.3 발급 검증(정본 — INV-3.1~3.6)
```
issue:
  1. delegator의 effective 권한 로드
  2. parentGrantId가 있으면 parent Grant 로드
  3. 검증:
     - capabilities ⊆ delegator.capabilities ⊆ parent.capabilities
     - scope ⊆ delegator.scope ⊆ parent.scope
     - constraints ⊇ delegator.constraints (약화 불가)
     - expiresAt ≤ parent.expiresAt
     - policyRevision ≥ parent.policyRevision
     - 그래프 순환 없음
  4. 통과 시 저장(grantId 발급) + 감사 기록(grant.issued)
```

### 3.4 저장(권장)
- 새 테이블 `delegation_grants`:
  `grant_id TEXT PK, delegator_principal_id TEXT, delegatee_principal_id TEXT, parent_grant_id TEXT, parent_run_id TEXT, scope JSON, capabilities JSON, constraints JSON, issued_at INT, expires_at INT, status TEXT, policy_revision INT`.
- `parent_grant_id` 인덱스(체인 조회/철회 캐스케이드).

---

## 4. Authorization Re-checker

### 4.1 책임
- **효과 권한 교집합(min)** 계산(INV-2/INV-8).
- **실행 직전 재확인** — 도구 실행 전에 Grant status/Principal status/policy revision을 확인(fail-closed).
- 기존 §3.4 `resolveExecutionPlan` 앞단에 **상위 제약**으로 통합.

### 4.2 인터페이스 초안(contracts)
```ts
interface AuthorizationRechecker {
  // 효과 권한 계산 (교집합)
  computeEffective(input: {
    principalId: string;
    runId: string;
    parentRunId?: string;
    grants: DelegationGrant[];
    orgMax: Capability[];
    ownPolicy: Capability[];
    taskScope: Capability[];
  }): Promise<EffectiveAuthorization>;

  // 실행 직전 재확인 — deny면 실행 불가
  checkBeforeExecute(input: {
    principalId: string;
    runId: string;
    toolId: string;
    args: unknown;
    policyRevision: number;
  }): Promise<{ allowed: boolean; errorCode?: string }>;
}
```

### 4.3 계산(정본 — INV-2/INV-3.4)
```
effective = orgMax
          ∩ delegatorEffective(chain)
          ∩ parentRunEffective
          ∩ ownPolicy
          ∩ taskScope
          ∩ (각 grant의 capabilities 교집합)   // 다중 경로 union 금지
```

### 4.4 실행 직전 재확인 순서(§3.4와 통합)
```
1. 호출 검증 (인자 스키마 등)
2. 플러그인 사전 정책 검사 (tool.execute.before)
3. Gate 정책 검사 (policyHook)
4. [NEW] Authorization Re-checker (위임/철회/정책 revision)
5. Permission Engine 승인 (ask/deny/allow)
6. 도구 실행
7. 결과 저장 + 사후 훅
```
- **주의**: 4단계는 deny 최우선 원칙에 따라 **deny 시 즉시 중단**(§3.4 정합).
- 4단계 추가는 기존 불변식을 **약화하지 않는다**(monotonic tightening — SC-INV-1).

### 4.5 불변식
- 교집합이 빈 집합이면 deny.
- 철회된 Grant/Principal/만료 Grant는 deny.
- `policyRevision` 불일치(실행 시점 > Grant revision 허용 여부)는 정책에 따라 결정(Decision Required).

---

## 5. Revocation Cascade

### 5.1 책임
- Grant 철회 → 하위 Grant 재귀 철회.
- Principal 철회 → 발급 Grant 전체 + 참조 Run 중단.
- 철회 이벤트 **감사 기록**.
- 실행 중 Run의 **중단 신호**(§4 execution recheck와 정합).

### 5.2 인터페이스 초안(contracts)
```ts
interface RevocationCascade {
  revokeGrant(grantId: string, reason: string): Promise<{ revoked: string[] }>;   // 하위 포함
  revokePrincipal(principalId: string, reason: string): Promise<{ revokedGrants: string[]; abortedRuns: string[] }>;
  isRevoked(grantId: string): Promise<boolean>;
  isPrincipalRevoked(principalId: string): Promise<boolean>;
}
```

### 5.3 캐스케이드 알고리즘(정본 — INV-6.1)
```
revokeGrant(grantId):
  queue = [grantId]
  revoked = []
  while queue:
    g = queue.pop()
    if g.status == revoked: continue
    g.status = revoked; revoked.push(g)
    queue += grants with parentGrantId == g     // 자식
  audit(grant.revoked, revoked)
  // 실행 중 Run은 §4 checkBeforeExecute에서 deny되거나 abort 신호
```

### 5.4 오프라인 처리(Decision Required)
- 오프라인 클라이언트는 철회 상태를 즉시 알 수 없다.
- **fail policy 선택지**:
  - (a) **deny(권장)**: 철회 상태 확인 불가 시 실행 deny.
  - (b) queue: 실행 보류 후 재개.
  - (c) grace period: 일정 시간 허용(위험).
- 관리형 실행(§6 서버 실행 허가)이 있으면 서버가 철회 상태를 강제할 수 있다.

---

## 6. Execution Audit

### 6.1 책임
- Principal/Grant/Run/도구 실행의 **감사 레코드** 기록(AU-INV-1~4).
- **typed** parentRunId/childRunId 연결(AU-02).
- usage 로그와 **분리**(AU-INV-4).

### 6.2 인터페이스 초안(contracts)
```ts
interface ExecutionAudit {
  record(event: AuditEvent): Promise<void>;
  query(filter: { principalId?: string; runId?: string; parentRunId?: string; since?: number }): Promise<AuditEvent[]>;
}
```

### 6.3 감사 이벤트(정본)
- `principal.created`, `principal.revoked`
- `grant.issued`, `grant.revoked`, `grant.expired`
- `run.started`, `run.ended`, `run.aborted`
- `tool.allowed`, `tool.denied`, `tool.asked`
- 각 이벤트에 `policyRevision`, `errorCode`(§3.4), `parentRunId`(해당 시).

### 6.4 저장(권장)
- 새 테이블 `execution_audit`:
  `audit_id INTEGER PK AUTOINCREMENT, event_type TEXT, principal_id TEXT, run_id TEXT, parent_run_id TEXT, session_id TEXT, grant_id TEXT, decision TEXT, error_code TEXT, policy_revision INT, created_at INT`.
- 프롬프트 원문 **미저장**(AU-INV-3).

---

## 7. croak-gate vs 신규 소유권 분담

Phase 4의 위임 서브시스템은 **croak-gate(기존 게이트)** 와 **croakcode 신규 위임 계층** 간 소유권을 명확히 한다.

| 기능 | 소유 | 근거 |
|---|---|---|
| Gate 정책 결정(LMM 요청 정책) | **croak-gate** | §5.4 기존 |
| Gate 인증/토큰 재확인(LLM 요청) | **croak-gate** | §5.4 "서버측 인증 재확인 범위" |
| **Agent Principal Registry** | **croakcode(신규)** | 위임 주체는 클라이언트 측 개념 + 감사 |
| **Delegation Grant Store** | **croakcode(신규)** | 위임 그래프 |
| **Authorization Re-checker** | **croakcode(신규)** | §3.4 실행 파이프라인 확장 |
| **Revocation Cascade** | **croakcode(신규)** + Gate가 철회 상태 서명 전파 가능 | 오프라인 한계 → Gate 보강 |
| **Execution Audit** | **croakcode(신규)** | 감사 레코드 |
| **서버 실행 허가(§5.4, Phase 4 수용)** | **croak-gate(기존)** | 변조 클라이언트 강제 |

### 7.1 경계 원칙
- **로컬 강제(정상 클라이언트)**: croakcode 신규 서브시스템.
- **서버 강제(변조 클라이언트)**: croak-gate 서버 실행 허가(§5.4).
- **감사 일원화**: 로컬 감사(croakcode) + 서버 감사(gate) → **정합 검증**(Phase 4 수용 기준).
- **철회 전파**: Gate가 서명된 철회 상태를 내려보내 croakcode가 로컬에서 강제(오프라인 한계 보완).

---

## 8. 마이그레이션·호환성

### 8.1 스키마
- 새 테이블 4개(`agent_principals`, `delegation_grants`, `execution_audit` + 기존 `sessions` 확장). `schema_version` 단조 증가 마이그레이션(§4.4 정합).
- 기존 세션/메시지/파트 스키마와 **하위 호환**(필수 필드 추가 없음).

### 8.2 기존 동작과의 정합
- Phase 3에서 확인된 잠재적 권한 상승 경로(§5.6)를 **Phase 4에서 수정**.
- `prompt()`의 session.permission 덮어쓰기(`prompt.ts:1226-1233`)는 위임 모델과 충돌 가능 → Phase 4에서 턴 스냅샷과 정합하도록 재설계(Decision Required).

### 8.3 계약 회귀
- Phase 2 계약 테스트(`phase2-stream-guard-contract`, `permission-order`)는 **불변 유지**. Phase 4 서브시스템은 **추가 계층**으로만 얹힌다.

---

## 9. 수용 기준(Phase 4)

- 다음 테스트가 **PASS**:
  - DG-05(교집합, INV-8) — 현재 FAIL → Phase 4에서 PASS 전환.
  - RV-01~05(철회 캐스케이드/실행 직전 deny).
  - AU-02~05(typed 감사).
  - SC-01/SC-02(잠재적 상승 경로 수정 후 deny 유지).
  - SC-05(monotonic tightening 계약 테스트).
- §5.4 서버 실행 허가 수용 기준 통과(croak-gate 소유).
- **가짜 PASS 금지** — §6.6 상태 기준 준수.

---

## 10. 미해결(Decision Required — 사용자 승인)

1. Principal Registry 저장(새 테이블 vs 기존 확장).
2. Grant Store 저장(새 테이블 권장).
3. 철회 메커니즘(epoch vs policy revision vs 실행 직전 재확인).
4. 오프라인 철회 fail policy(deny 권장 vs queue).
5. 강제 경계(trusted executor vs remote) 범위 분담.
6. `session.permission` 덮어쓰기 vs 턴 스냅샷 충돌 해소 방식.
7. 위임 깊이 제한(최대 단계수).
