# Phase 3 계획 영향 분석 (Agent Principal & Delegation)

- **상태**: Proposed (설계 분석 — 런타임 구현 없음)
- **날짜**: 2026-11-08
- **대상 계획**: `docs/superpowers/plans/2026-11-08-phase3-plugin-port.md` (HEAD `efb44fc`)
- **관련 문서**:
  - ADR: `docs/superpowers/adr/0001-agent-principal-and-delegation.md`
  - 위임 아키텍처: `docs/superpowers/architecture/2026-11-08-agent-principal-delegation.md`
  - 보안 불변식/테스트: `docs/superpowers/architecture/2026-11-08-security-invariants-and-test-traceability.md`
  - Phase 4 Blueprint: `docs/superpowers/architecture/2026-11-08-phase4-blueprint.md`

> 이 문서는 **Agent Principal/위임 설계 도입**이 기존 Phase 3 계획에 미치는 영향을 Task별로 분류한다. **Phase 3 계획 자체를 변경하지 않는다** — 분류와 권고만 기록한다. Phase 3 계획 수정은 사용자 승인 후 별도 커밋.

---

## 분류 기준 (5종 — 요청된 정본)

| 분류 | 의미 |
|---|---|
| **변경 없음** | 위임 설계와 직접 관련 없음. 그대로 진행. |
| **계약·문서 보강** | 런타임 변경 없이 문서/계약/테스트 주석 보강만 필요. |
| **기존 구현 검증 필요** | 현재 위임 경로의 실제 동작을 **테스트로 고정**해야 함(설계상 추론 → 확인된 사실 승격). |
| **Phase 4에서 구현** | 위임 런타임 구현은 Phase 4. Phase 3에서는 건드리지 않음. |
| **설계 변경 승인 필요** | 제품 코드/계약을 바꾸는 결정 → 사용자 승인 필요. |

> **금지**: 이 분석을 근거로 Phase 3 계획을 임의로 수정하지 않는다. 각 항목의 "권고"는 승인 후 적용.

---

## Task별 분류

### Chunk 1: 공유 정책 상태 + 보안 1선

| Task | 내용 | 분류 | 근거/권고 |
|---|---|---|---|
| **Task 0** | `.croakcode` 디렉터리 준비(설정 로더 경로) | **변경 없음** | 위임 설계와 무관. 경로 확정은 기존대로. |
| **Task 0a** | `litellm-head` Provider 설정 + 로딩 스모크 | **변경 없음** | Provider 로딩과 위임은 독립. |
| **Task 1** | 공유 정책 상태 lib(`policy-state`) 이식 | **변경 없음** | 위임 계층은 Phase 4이므로 영향 없음. |
| **Task 2** | croak-auth 세션 모듈 이식 | **변경 없음** | 인증 세션과 위임 Principal은 별개. |
| **Task 3** | croak-auth 서버 플러그인(토큰 주입) | **계약·문서 보강** | **auth-header 3조건 계약**(provider∈CROAK_PROVIDERS ∧ baseURL origin==authUrl origin ∧ mode==gate, unknown→fail-closed)은 §5.4 보안 컨텍스트와 정합. 위임 문서에 "인증 헤더는 ConnectionAdapter 소유"를 명시(§5.5 정합). 런타임 변경 없음. |
| **Task 4** | gate-identity 이식 | **계약·문서 보강** | Gate 신원과 Agent Principal 신원은 **다른 계층**. 혼동 방지 주석 필요("gate-identity ≠ principalId"). 런타임 변경 없음. |
| **Task 5** | tool-policy 플러그인 이식 | **계약·문서 보강** | §3.4 실행 전 검사 순서와 정합(deny 최우선). 위임 re-checker(Phase 4)는 **추가 단계**로 얹힐 것임을 주석. 런타임 변경 없음. |
| **Task 6** | secret-paths 플러그인 이식 | **계약·문서 보강** | §5.4 gate context 격리(INV-7.2)와 정합. secret 경로 차단은 위임 여부와 무관히 유지. 런타임 변경 없음. |

### Chunk 2: 안정성·관측

| Task | 내용 | 분류 | 근거/권고 |
|---|---|---|---|
| **Task 7** | local-stability 이식 + §4.9 reconciliation | **변경 없음** | 안정성/스트림 guard와 위임은 독립. |
| **Task 8** | stall-recovery 폐기/유지 결정 문서화 | **변경 없음** | 이미 ACCEPTED DEVIATION 승인. 위임과 무관. |
| **Task 9** | usage-meter 이식 | **변경 없음** | usage/감사 로그 **분리**는 §4.4 정합으로 유지. |

### Chunk 3: HWP 툴 + TUI 슬롯 콘텐츠

| Task | 내용 | 분류 | 근거/권고 |
|---|---|---|---|
| **Task 10** | hwp-read 커스텀 툴 이식 | **변경 없음** | 도구 실행은 §3.4 경로. 위임 re-checker는 Phase 4. |
| **Task 11** | croak-auth TUI 플러그인(`/login`/`/logout`/`/whoami`/`/agent-perm`) | **계약·문서 보강** | `/agent-perm`은 **세션/에이전트 permission 표시**. Agent Principal의 `capabilities`와 혼동 방지 주석 필요. 런타임 변경 없음. |
| **Task 12** | usage-panel 이식(슬롯 콘텐츠) | **변경 없음** | 슬롯 콘텐츠와 위임은 독립. |
| **Task 12a** | 런타임 연결 모드 배선(옵션 A 전제 — 제품 코드 변경) | **설계 변경 승인 필요** | **제품 코드 변경**(`session/llm/request.ts`, `session/llm.ts`, `connection.js`). 위임 설계와 직접 충돌은 없으나, **턴 스냅샷(§5.4)** 과 `session.permission` **덮어쓰기**(`prompt.ts:1226-1233`)가 상호작용한다. **턴 스냅샷이 덮어쓰기에 의해 깨지지 않는지** 계약 테스트 필요(SC-02). 승인 필요. |
| **Task 13** | vendor/opencode-cache-hit 이식 결정 | **변경 없음** | 폐기 승인(usage-panel 통합). 위임과 무관. |

### Chunk 4: 에이전트·명령, 등록, 등가 매트릭스

| Task | 내용 | 분류 | 근거/권고 |
|---|---|---|---|
| **Task 14** | dev-safe 에이전트 + commands 이식 | **기존 구현 검증 필요** | `dev-safe.md`는 `task: deny` 등 permission 규칙을 가진다. 이는 **손자 생성 제한**(SC-03)과 정합. 테스트는 frontmatter만 검증하므로, **실제 런타임에서 task 비활성**이 되는지 **검증 필요**(현재는 텍스트 검증만). |
| **Task 15** | 서버 플러그인 자동 스캔 확인 + croakcode.jsonc 생성 | **변경 없음** | 로더/JSONC. 위임과 무관. |
| **Task 16** | Phase 3 등가 매트릭스 작성(§6.3 C + §6.4) | **계약·문서 보강** | 매트릭스에 **위임 관련 SC/CX 상태 행 추가 권고**(SC-01~06, CX-01~02). 단 상태는 **실행 결과로만** PASS 기재(가짜 PASS 금지). 런타임 변경 없음. |
| **Task 16a** | §5.4 우회 차단 5종 중 1·2·3·4a 단위/계약 테스트 | **기존 구현 검증 필요** | §5.4 시나리오는 **위임 경계**와 상호작용한다(gate context 격리). 단위 테스트는 기존 계획대로. **추가 권고**: plan→general edit 상승(SC-01) 통합 재현을 **이 Task 또는 별도 Task**로 고정. |
| **Task 16b** | §5.4 시나리오 4·5 실제 요청 경로 E2E | **기존 구현 검증 필요** | **CX-02**(gate context가 direct 요청 조립 시 제외)를 이 E2E로 검증. 요청 조립 지점 `prompt.ts:1439-1445`. 위임 경계에서도 동일 필터 적용 확인. |
| **Task 17** | 최종 게이트(Phase 3 replay) | **계약·문서 보강** | 게이트에 위임 상태 행(SC/CX) 포함 권고. **단, Phase 4 항목은 FUTURE CONTRACT로 남기고 PASS로 승격 금지**(SC-INV-4 정직성). |

---

## 요약 표

| 분류 | Task |
|---|---|
| **변경 없음** | 0, 0a, 1, 2, 7, 8, 9, 10, 12, 13, 15 |
| **계약·문서 보강** | 3, 4, 5, 6, 11, 16, 17 |
| **기존 구현 검증 필요** | 14, 16a, 16b |
| **Phase 4에서 구현** | (없음 — 위임 런타임은 Phase 3 계획에 포함하지 않음. Phase 4 Blueprint 참조) |
| **설계 변경 승인 필요** | 12a |

> 참고: Task 12a는 **제품 코드 변경**(기존 계획에서 이미 "최소 침습"으로 명시). 위임 설계 도입으로 인해 **턴 스냅샷 vs `session.permission` 덮어쓰기** 충돌 검증이 추가로 필요하므로 **설계 변경 승인 필요**로 분류.

---

## 핵심 위험 (Phase 3에서 반드시 다룰 것)

1. **plan→general edit 상승 경로(SC-01)**: 기존 `test/agent/plan-mode-subagent-bypass.test.ts`는 helper 격리만 검증하며 **덮어쓰기 경로를 거치지 않는다**. Phase 3에서 **통합 재현 테스트**를 추가하지 않으면 이 결함은 계속 미검증으로 남는다.
2. **`session.permission` 덮어쓰기(SC-02)**: `prompt.ts:1226-1233` + `session.ts:735-739`가 턴 스냅샷(§5.4)을 깨는지 검증 필요.
3. **위임을 PASS로 주장 금지(SC-INV-4)**: Phase 3 exit criteria에 위임 항목을 넣더라도, Principal/Grant/Revocation은 **FUTURE CONTRACT**로 명시.

---

## 권고 조치(승인 후 적용)

- **Task 16a 보강**: plan→general 통합 재현 테스트 1건 추가(현재 격리 테스트로 미포착).
- **Task 16b 보강**: 위임 경계에서 gate context 필터 적용 확인.
- **Task 16/17 매트릭스**: SC-01~06, CX-01~02, DG-05(FAIL 현재 상태) 행 추가. Phase 4 항목은 FUTURE CONTRACT.
- **Task 12a**: 턴 스냅샷 vs 덮어쓰기 계약 테스트 추가(SC-02).
- **문서 주석**: Task 3/4/5/6/11에 위임 계층과의 경계 주석(gate-identity ≠ principalId, re-checker는 Phase 4 추가 단계 등).

> 이 권고는 **Phase 3 계획 파일을 직접 수정하지 않는다**. 사용자 승인 후 별도 커밋으로 반영한다.
