# Phase 2 동등성 증거 매트릭스 (§6.1 A + §6.2 B)

Spec: `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md` §6.1, §6.2, §6.5, §6.6.
상태 기준: PASS / FAIL / NOT TESTED / ACCEPTED DEVIATION (spec §6.6).
상태는 **실측 실행 증거**로만 채운다. 실행 명령은 `scripts/phase2-gate-replay.sh` 참조.

## 실행 스냅샷 (실측)

| 스위트 | 결과 |
|---|---|
| root `node --test 'tests/*.test.mjs'` | 68/68 PASS |
| root `bun test tests` | 68/68 PASS |
| `scripts/phase1-cli-check.sh` | PASS |
| `scripts/phase1-headless-check.sh` | PASS |
| `node scripts/rebrand-check.mjs upstream` | PASS (core 0 위반, Phase 4 123 DEFERRED) |
| `scripts/phase2-zen-check.sh` | PASS |
| `upstream/packages/core` `bun test` | 359/359 PASS |
| `upstream/packages/opencode` `test/tool` | 293/293 PASS |
| `upstream/packages/opencode` `test/session` | 370/370 PASS |
| `upstream/packages/opencode` `test/provider test/cli/help test/skill` | 368/370 — 2 FAIL은 **기존 baseline** |

> 기존 baseline 실패 2건(Phase 2 무관, 흡수 시점부터 존재): `hosted nvidia provider adds billing origin header`, `custom nvidia baseURL adds billing origin header` (`test/provider/provider.test.ts`). 게이트 스크립트는 이 2건만 허용하고 그 외 새 실패는 차단한다.

## A. opencode 코어 동작 (§6.1)

| 동작 | Phase 2 증거 | 상태 |
|---|---|---|
| 세션 생성/재개/중단 | `tests/phase1-session.e2e.test.mjs`, `scripts/phase1-headless-check.sh` | PASS |
| 스트리밍 / 멀티턴 | `test/session` (370 PASS), Task 12 `stream-idle-timeout.test.ts` | PASS |
| compaction / autocontinue | `test/session` (370 PASS), Task 12 `compaction-idle-timeout.test.ts` + `compaction.test.ts` | PASS |
| 도구 전체 (read/write/edit/grep/glob/bash/task/webfetch/websearch) | `test/tool` (293 PASS), Task 10 `registry-permission.test.ts` | PASS |
| 권한 모드(auto/ask) · 승인 다이얼로그 | Task 6 `tests/contracts.conformance.test.mjs`(permission.mode), Task 10 fail-closed 노출 게이트 | PASS |
| provider/모델 설정 | `test/provider` (기존 nvidia 2건 외 PASS), Tasks 3/4 zen 제거 후 회귀 | PASS |
| agents/subagents | `test/skill` 포함 368/370 스위트 PASS, Task 11 `todo-subagent-isolation.test.ts` | PASS |
| 슬래시 명령 / help | `test/cli/help` (snapshot 재생성 후 PASS) | PASS |
| TUI 슬롯/키맵 | Task 6 `contracts/src/tui-surface.mjs` + `tests/contracts.conformance.test.mjs` | PASS |

## B. 패치 8개 동작 (§6.2)

| 패치 | Phase 2 증거 | 상태 |
|---|---|---|
| 0001 permission mode/auto-follow/run footer | Task 6 계약(슬롯/모드 승격); auto-follow/run footer TUI 동작은 `test/session`/TUI 스냅샷으로 회귀 PASS | PASS (계약 승격) / 수동 TUI 확인 Phase 3 |
| 0002 queued → steering 명칭/동작 | `test/session/prompt.test.ts` (session 스위트 370 PASS) | PASS |
| 0003 `session resume` → `cc resume` | `scripts/phase1-cli-check.sh`(help/version), help 스냅샷 재생성 | PASS |
| 0004 SSE 타임아웃 전/후 재시도 규칙 | `test/provider/stream-timeout.test.ts` (368/370 스위트 PASS), Task 12 idle guard와 분리 검증 | PASS |
| 0005 Windows/WSL 드롭 경로 + CJK 커서 폭 | `test/cli/cmd/tui/dropped-path.test.ts` (회귀 PASS) | PASS (기존 테스트) / WSL 수동 Phase 3 |
| 0006 `session_message_footer` 슬롯 | Task 6 `TUI_HOST_SLOTS`/`SESSION_MESSAGE_FOOTER_PROPS` 계약 + conformance 테스트 | PASS (계약 승격) |
| 0007 `api.permission.mode()` 노출 | Task 6 `TUI_PERMISSION_API`(readOnly accessor `mode`) + conformance 테스트 | PASS (계약 승격) |
| 0008 CJK 다이얼로그 타이틀 표시폭 절단 | `test/util/locale.test.ts`(회귀 PASS) | PASS (기존 테스트) / 수동 스냅샷 Phase 3 |

## Phase 2 신규 계약/런타임 증거 (spec §8.3)

| 항목 | 증거 | 상태 |
|---|---|---|
| zen provider 물리 제거 | `scripts/phase2-zen-check.sh` PASS (core 스캔 0, baseten 보존 교차검증) | PASS |
| console/web 패키지 제거 + 브랜딩 | `scripts/rebrand-check.mjs upstream` PASS (core blocking, Phase 4 explicit DEFERRED) | PASS |
| §4.7 권한 하네스 fail-closed | `shouldExposeTool` + `registry.ts` 필터; `test/tool/registry-permission.test.ts`(deny 미노출/ask 노출/빈 ruleset 폴백 ask 노출) | PASS |
| §4.7 재산정 트리거 범위 | `tests/phase2-harness-contract.test.mjs`(런타임 4 / Phase 3 이관 2 고정) | PASS |
| §4.8 TODO 동기화 | `test/session/todo-consistency.test.ts`(evidence:"tool"만 경고, "none" 미경고, 턴 경계 오탐 없음) + `todo-subagent-isolation.test.ts`(서브세션 격리, 재귀 삭제) + `tests/phase2-todo-parity.test.mjs` | PASS |
| §4.9 compaction idle guard | `stream-idle-timeout.test.ts`(delta-gap, 긴 스트림 미중단/정지 시 종료, STREAM_IDLE_TIMEOUT 매핑) + `compaction-idle-timeout.test.ts`(compaction 120s always-on, 무재시도) | PASS |

## Phase 3 이관 (명시적 defer — NOT TESTED 허용분)

| 항목 | 사유 |
|---|---|
| harness 트리거 `session_start`·`connection_mode_switch` 런타임 연결 | 연결 모드 전환은 Phase 4 gate 어댑터에서 실질 의미 (Task 7) |
| 패치 0005/0008 수동 스냅샷, §6.5 미작성 신규 TUI 테스트 | 실기기/TUI 수동 검증 필요 |
| DB-level §4.5 `run_state` 컬럼 | 플러그인 이식과 함께 판단 |
| 슬롯 콘텐츠 등록 | Phase 2는 계약 확정까지, 콘텐츠는 Phase 3 |

> 필수 기능에는 unresolved FAIL/NOT TESTED가 없다. 위 defer 항목은 §6.6의 비차단 명시 이관분이다.
