# Phase 2 Decision Gate — 코어 독립화 및 기존 동작 흡수

Spec: `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md` §8.3
Evidence: `docs/superpowers/phase0/phase2-equivalence-matrix.md` (§6.1 A + §6.2 B)
Replay: `scripts/phase2-gate-replay.sh`

- [x] upstream help snapshots regenerated for `cc` (`bun test -u`, 잔여 opencode 0) — Task 1
- [x] console/web packages removed; rebrand-check PASS — **core fully blocking**, Phase 4 packages explicitly DEFERRED — Task 2 (console/web 1236 files 삭제)
- [x] zen provider (id `opencode`) removed from catalog/loaders/transforms — `scripts/phase2-zen-check.sh` PASS, baseten 보존 교차검증 — Tasks 3, 5
- [x] zen tier/upsell removed from TUI, retry, provider list (일반 재시도 29/29 유지) — Task 4
- [x] TUI slot + permission.mode promoted to contracts (patch 0006/0007) — Task 6
- [x] harness contract + deny-tools-hidden registry gate (§4.7) — fail-closed(`allow`/`ask`만 노출), 목록=`agent.permission`·실행=병합 ruleset — Tasks 7, 10
- [x] harness refresh triggers: 런타임 연결 4종 / Phase 3 이관 2종 근거 기록 (§4.7) — Task 7
- [x] todo consistency (§4.8) — ① 서버 이벤트만 렌더 ② evidence:"tool"만 경고("none" 미경고) ③ 턴 경계 오탐 없음 ④ resume 복원 ⑤ 서브세션 격리 테스트 증명 — Task 11
- [x] compaction body-idle guard via `Stream.timeout` (§4.9) — delta-gap idle, compaction 120s always-on(stream은 명시 설정 시만), 무재시도 — Task 12
- [x] full regression replay PASS (`scripts/phase2-gate-replay.sh`) — baseline 실패 2건(nvidia) 외 전부 PASS
- [x] equivalence matrix: §6.1 A + §6.2 B 필수 기능 전부 PASS 또는 ACCEPTED DEVIATION (NOT TESTED 는 Phase 3 이관 명시분만 허용) — Task 13

## 구현 결정 기록

- **§4.9 stream 기본값**: spec §4.9 "미설정이면 켜지 않되, compaction은 항상 on"에 따라 **normal stream idle guard는 명시 설정(`CROAKCODE_STREAM_IDLE_TIMEOUT_MS`) 시에만 활성**, compaction은 기본 120s always-on. (Effect TestClock 환경에서 기본 on은 가상시간으로 hang 스트림을 즉시 종료시켜 업스트림 테스트를 깨므로, spec 문구와 테스트 게이트 양립을 위해 unset=off 채택.)
- **§4.7 목록 과노출 허용**: 목록 필터는 `agent.permission`만 사용, 실행은 `Permission.merge(agent.permission, session.permission ?? [])`. 세션 레벨 deny는 실행 시 차단되므로 보안 유지, 목록에서 보였다가 실행 거부되는 UX 비용만 발생.
- **§4.9 errorCode**: `StreamIdleTimeoutError` → `APIError`(metadata.code=`STREAM_IDLE_TIMEOUT`, isRetryable=false)로 매핑해 assistant 메시지 스키마를 유지하면서 관측성을 확보.

## Defer 목록 (Phase 3 이관, 명시)

- harness 트리거 `session_start`·`connection_mode_switch` 런타임 연결
- 패치 0005(WSL/CJK)·0008(CJK 타이틀 절단) 및 §6.5 미작성 신규 테스트 수동 검증
- DB-level §4.5 `run_state` 컬럼 (플러그인 이식과 함께)
- 슬롯 콘텐츠 등록 (Phase 2는 계약 확정까지)

## Gate result

Phase 3 approved only when every item is checked against real runs, and the equivalence matrix has no unresolved NOT TESTED on required features (§6.6).
현재: 필수 기능 §6.1 A + §6.2 B 전부 PASS(또는 명시 defer). **Phase 2 승인 조건 충족.**
