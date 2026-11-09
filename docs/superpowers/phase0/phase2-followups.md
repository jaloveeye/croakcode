# Phase 2 후속 이슈 (P2 — 비차단, Phase 3 초기 처리)

Phase 2 승인(`ACCEPTED WITH DOCUMENTED EXCEPTIONS`)에 따라 등록하는 후속 이슈.
두 항목 모두 **Phase 2가 도입한 회귀가 아니다** (기존 테스트 기대값 / 선재 타이밍 flake).

| ID | 제목 | 심각도 | 처리 시점 | 책임 범위 | 상태 |
|---|---|---|---|---|---|
| P2-1 | NVIDIA 테스트 기대값 갱신 (`opencode` → `croakcode`) | P2 | Phase 3 초기 | provider 테스트 소유자 | 해결 (PR #10, `5e5fdef`) |
| P2-2 | Bash abort/truncation 타이밍 경쟁 및 테스트 안정화 | P2 | Phase 3에서 추적·재현·수정 | shell tool + session 테스트 소유자 | 해결 (2026-11-09) |

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

### P2-2 처리 기록 (2026-11-09)

- **원인**: 출력 읽기 파이버는 `Effect.forkScoped`로 scope에 묶여 있었다. 명령이 끝나면 scope가 닫히면서 이 파이버가 중단됐다. 파이프에 남은 출력은 읽히지 않았다.
- **범위**: 취소 경로에만 있는 문제가 아니었다. 정상 종료에서도 같은 일이 일어났다. 출력 읽기는 청크마다 `ctx.metadata`를 기다린다. 세션 DB가 느리면 읽기가 밀리고, 밀린 만큼 출력이 사라진다.
- **재현**: `metadata`를 2ms 늦춘 shell 단위 테스트 2건을 더했다.
  - 정상 종료 테스트에서는 40000줄 중 5956줄까지만 결과에 남았다.
  - 취소 테스트에서도 마지막 표식 줄이 빠졌다.
  - 두 테스트는 수정 전 코드에서 모두 실패했다.
- **수정**: `shell.ts`가 결과를 만들기 전에 출력 읽기 파이버를 `Fiber.join`으로 기다린다.
  - 남은 출력을 읽는 동안에는 청크별 `metadata` 갱신을 건너뛴다.
  - 정상 종료에서는 파이프가 이미 닫혀 있으므로 그대로 기다린다.
  - 취소와 타임아웃에서는 손자 프로세스가 파이프를 쥘 수 있어 5초 상한을 둔다.
- **두 번째 결함**: 전체 스위트에서 정상 종료 재현 테스트가 다시 실패했다.
  - 저장 파일에는 40000줄이 모두 있었다. 결과 끝부분에는 stderr 표식 한 줄만 남았다.
  - 결과용 버퍼는 크기가 `keep`을 넘으면 앞 청크를 통째로 버렸다.
  - 남은 출력을 한꺼번에 읽으면 `keep`보다 큰 청크가 생긴다. 뒤에 작은 청크가 오면 큰 청크가 버려졌다.
  - 이제 남은 양이 `keep` 이상일 때만 앞 청크를 버린다.
  - 재현 테스트는 stdout 표식을 결과 끝부분에서 찾는다. stderr 표식은 저장 파일에서 찾는다. 두 파이프의 순서가 고정되지 않기 때문이다.
- **세션 테스트 정정**: `cancel finalizes ...` 테스트는 첫 응답 150ms 뒤에 취소했다.
  - 부하가 걸리면 취소 시점에 출력이 278줄뿐이었다. 이 경우 `truncated: false`가 맞는 결과다.
  - 테스트는 이제 명령이 출력을 다 쓰고 만든 표식 파일을 확인한 뒤 취소한다. 마지막 줄이 결과에 있는지도 확인한다.
- **검증**: CPU 16코어 부하에서 단독 20회씩 실행했다.
  - `cancel finalizes ...`, `captures stderr in output`, 취소 재현 테스트가 모두 20/20 통과했다.
  - 정상 종료와 취소 재현 테스트는 버퍼 수정 뒤 20/20 통과했다.
  - shell, prompt, task 스위트는 118건 모두 통과했다. 전체 게이트도 통과했다.
- **게이트**: `captures stderr in output`과 `cancel finalizes ...`를 `FLAKE_FAIL`에서 뺐다.
  - `running task tool preserves metadata ...`는 부하에서 20/20 통과했다.
  - 그러나 원인을 확인하지 못해 목록에 남겼다.

### `running task tool preserves metadata ...` 조사 기록 (2026-11-09)

- **등록 근거**: 이 테스트는 `b4c4746`에서 `FLAKE_FAIL`에 들어갔다. 그 커밋의 문서와 게이트 로그에는 이 테스트의 실패 출력이 없었다.
- **실행 결과**: 모든 실행에서 CPU 16코어에 부하를 걸었다.

  | 코드 | 범위 | 횟수 | 실패 |
  |---|---|---|---|
  | 현재 `master` | 단독 | 20 | 0 |
  | 현재 `master` | `prompt.test.ts` 전체 | 10 | 0 |
  | 현재 `master` | 게이트 범위 | 8 | 0 |
  | `b4c4746` | 단독 | 20 | 0 |
  | `b4c4746` | 게이트 범위 | 6 | 0 |

- **코드 확인**: 세 가지 경로를 확인했고, 모두 문제가 없었다.
  - tool-call 전환은 `running` 상태의 metadata를 유지한다.
  - task 도구는 metadata를 한 번만 기록한다.
  - 테스트 LLM 서버는 제목 요청에 따로 응답한다. 응답 순서가 섞이지 않는다.
- **조치**: 재현되지 않는 실패를 재시도 목록에 두지 않기로 했다. 목록에 두면 진짜 회귀가 가려지기 때문이다. `FLAKE_FAIL`에서 뺐다.
- **다음 실패 시**: 게이트가 멈추고 `LOG_DIR`에 로그가 남는다. 그 로그에서 실패 지점을 확인한다.

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
