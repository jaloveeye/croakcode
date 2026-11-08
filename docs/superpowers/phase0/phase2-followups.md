# Phase 2 후속 이슈 (P2 — 비차단, Phase 3 초기 처리)

Phase 2 승인(`ACCEPTED WITH DOCUMENTED EXCEPTIONS`)에 따라 등록하는 후속 이슈.
두 항목 모두 **Phase 2가 도입한 회귀가 아니다** (기존 테스트 기대값 / 선재 타이밍 flake).

| ID | 제목 | 심각도 | 처리 시점 | 책임 범위 |
|---|---|---|---|---|
| P2-1 | NVIDIA 테스트 기대값 갱신 (`opencode` → `croakcode`) | P2 | Phase 3 초기 | provider 테스트 소유자 |
| P2-2 | Bash abort/truncation 타이밍 경쟁 및 테스트 안정화 | P2 | Phase 3에서 추적·재현·수정 | shell tool + session 테스트 소유자 |

---

## P2-1 — NVIDIA 테스트 기대값 갱신

- **위치**: `upstream/packages/opencode/test/provider/provider.test.ts:1090,1103`
  - `hosted nvidia provider adds billing origin header`
  - `custom nvidia baseURL adds billing origin header`
- **현상**: 테스트는 `X-Title: "opencode"`, `X-BILLING-INVOKE-ORIGIN: "OpenCode"`를 기대하지만, 로더는 Phase 1 커밋 `8489dbf`부터 `X-Title: "croakcode"`를 출력한다 (`provider.ts:430`).
- **근거**: `provider.ts`의 nvidia 블록은 Phase 2 diff(`0299fbb..HEAD`)에 포함되지 않음 → **Phase 2 회귀 아님, 선재 stale 테스트**.
- **조치**: 테스트 기대값을 `croakcode` (및 확정된 billing origin)으로 갱신. 소스 변경 불필요.
- **수용 기준**: 두 테스트 PASS, `BASELINE_FAIL` allowlist에서 제거.

## P2-2 — Bash abort/truncation 타이밍 경쟁 및 테스트 안정화

- **위치**: `upstream/packages/opencode/test/session/prompt.test.ts:1691`
  - `cancel finalizes interrupted bash tool output through normal truncation`
- **현상**: 동일 커밋 `9efe12f` 기준 isolated 10회 실행 시 **3 pass / 7 fail**(비결정적). 실패 지점은 `expect(tool.state.metadata.truncated).toBe(true)` → `received false`. base `0299fbb`에서도 동일 실패.
- **메커니즘**: `shell.ts`에서 truncation 상태(`cut`, `:445`)가 스트림 소비 파이버(`Stream.runForEach`, `:487-527`)에서 비동기로 갱신되는데, 테스트는 150ms 후 취소(`prompt.test.ts` cancel)를 호출한다. abort race(`:533-556`)가 먼저 resolve되면 `cut`이 아직 `false`인 상태로 메타데이터(`:579-591`)가 기록된다.
- **근거**: 동일 커밋이 워크트리/부하에 따라 pass/fail이 갈림(3/10 vs 0/10) → **환경 의존 선재 flake**, Phase 2 회귀 아님.
- **중요 — 단순 테스트 불안정성으로 영구 분류 금지**:
  - 실제 취소 시 **결과 메타데이터가 잘못 기록되는지**(사용자 관점에서 `truncated=false`/`outputPath` 누락)를 별도 검증할 것.
  - 스트림 소비 파이버 종료를 abort 전에 보장(또는 finalizer에서 최종 메타 재계산)하는 수정으로 제품 동작 자체를 개선할지 판단.
- **조치**:
  1. 취소 경로에서 truncation 메타데이터가 실제로 유실되는지 재현 테스트 작성.
  2. `shell.ts` finalizer에서 flush/close 후 최종 `cut`/`file`로 메타 재계산하도록 수정 검토.
  3. 수정 후 테스트를 결정적으로 안정화(고정 횟수 반복 실행으로 확인).
- **수용 기준**: isolated 20회 연속 PASS, 실제 취소 시나리오에서 `truncated`/`outputPath` 정합성 확인.

---

## 게이트 기록 원칙 (릴리스 보고서에 유지)

- **예외 허용 게이트 PASS ≠ 전 테스트 PASS**. 이 차이는 이후 모든 릴리스 보고서에 명시한다.
- 게이트 스크립트(`scripts/phase2-gate-replay.sh`)는:
  - first-run 로그와 retry 로그를 **보존**(`LOG_DIR`).
  - retry에서 통과한 first-run 실패를 `FLAKY_PASS`로 보고(plain `PASS`와 구분).
  - `BASELINE_FAIL`(stale rebrand)과 `FLAKE_FAIL`을 구분 라벨링.
  - allowlist 밖 실패는 first-run/retry 모두 차단.

## 최종 증거 보존

- HEAD `06297b8` 기준 게이트 실행 로그: `docs/superpowers/phase0/evidence/phase2-gate/upstream-first.log`, `upstream-retry.log`
  - first-run: 1029 pass / 5 skip / 1 todo / 4 fail (baseline 2 + flaky 2)
  - retry: 위 flaky 2건이 통과 → `FLAKY_PASS` 2건, baseline 2건 유지 → **게이트 PASS**
- 재현 명령: `LOG_DIR=docs/superpowers/phase0/evidence/phase2-gate bash scripts/phase2-gate-replay.sh` (로그 덮어쓰기 주의 — 별도 LOG_DIR 권장)
