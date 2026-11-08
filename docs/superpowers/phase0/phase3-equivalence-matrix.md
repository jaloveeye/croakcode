# Phase 3 동등성 증거 매트릭스 (§6.3 C + §6.4)

> 상태 기준: PASS / FAIL / NOT TESTED / ACCEPTED DEVIATION (spec §6.6). 실행 증거로만 채운다.
> 이 문서는 Task 16에서 골격이 완성되고, 최종 상태는 Task 17 게이트 직전에 실측 결과로 확정된다.

## local-stability reconciliation (§4.9)

- local-stability의 `experimental.session.compacting` 훅은 `output.prompt`만 설정한다. 코어는 `compacting.prompt ?? buildPrompt(...)`로 **plugin prompt가 기본 prompt를 대체**한다(`upstream/packages/opencode/src/session/compaction.ts:404`). 즉 `context`는 미설정 시 코어 기본 경로로 처리되어 append 충돌이 없다.
- local-stability는 `CROAKCODE_STREAM_IDLE_TIMEOUT_MS`/`CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS` 플래그를 **변경하지 않는다** → §4.9 내장 idle guard는 그대로 유지된다(plugin compaction prompt와 독립).

## C. 커스텀 플러그인 동작 (골격 — Task 16에서 실측 채움)

| 기능 | 증거 | 상태 |
|---|---|---|
| croak-auth (로그인/세션/토큰/401) | tests/croak-auth-session.test.mjs, tests/croak-auth-server.test.mjs | NOT TESTED |
| croak-auth TUI (/login /logout /whoami /agent-perm) | tests/croak-auth-tui.e2e.test.mjs | NOT TESTED |
| gate-identity (x-croak-agent/session) | tests/gate-identity.test.mjs | NOT TESTED |
| local-stability (반복차단/qwen/compaction) | tests/local-stability.test.mjs | NOT TESTED |
| secret-paths | tests/secret-paths.test.mjs | NOT TESTED |
| stall-recovery | 대체/폐기 결정 기록 | ACCEPTED DEVIATION |
| tool-policy | tests/tool-policy.test.mjs | NOT TESTED |
| usage-meter | tests/usage-meter.test.mjs | NOT TESTED |
| usage-panel | upstream/packages/opencode/test/usage-panel/*.test.ts | NOT TESTED |
| hwp-read | tests/hwp-read.test.mjs | NOT TESTED |
| vendor/opencode-cache-hit | 폐기 결정 기록 | ACCEPTED DEVIATION |
| dev-safe + commands | tests/dev-safe-agent.test.mjs + 수동 체크리스트 | NOT TESTED |

## §5.4 우회 차단 5종 (Task 16a/16b에서 실측)

| # | 시나리오 | 테스트 | 상태 |
|---|---|---|---|
| 1 | `force:gate` + `--mode direct` 거부 | security-context + phase3-bypass | NOT TESTED |
| 2 | direct + `requiresAuth` 실행 전 오류 | security-context + phase3-bypass | NOT TESTED |
| 3 | 로컬 설정으로 서버 deny 완화 무시 | phase3-bypass | NOT TESTED |
| 4 | 인증 실패 시 direct 전환 시 게이트 전용 접근/토큰 차단 | phase3-bypass(4a) + phase3-context-e2e | NOT TESTED |
| 5 | 전환 후 비밀 컨텍스트 재주입 없음 | phase3-context-e2e (실제 payload) | NOT TESTED |
