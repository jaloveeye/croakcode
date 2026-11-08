# Phase 3 동등성 증거 매트릭스 (§6.3 C + §6.4)

> 상태 기준: PASS / FAIL / NOT TESTED / ACCEPTED DEVIATION (spec §6.6). **실행 증거로만 채운다.**
> 각 행의 상태는 아래에 기록된 실제 명령·출력으로만 확정한다. 추정 PASS 금지.

## local-stability reconciliation (§4.9)

- local-stability의 `experimental.session.compacting` 훅은 `output.prompt`만 설정하고 `system`/`context`를 건드리지 않는다.
- **정정(실측)**: `session/compaction.ts:404`는 `compacting.prompt ?? buildPrompt(...)`로 처리되어 plugin prompt가 코어 기본 prompt를 **대체**한다. 따라서 코어 기본 경로와 plugin prompt 사이에 append 충돌이 없다.
- `CROAKCODE_STREAM_IDLE_TIMEOUT_MS`/`CROAKCODE_COMPACTION_IDLE_TIMEOUT_MS`는 변경되지 않으므로 §4.9 내장 idle guard는 독립적으로 유지된다.
- 근거: `tests/local-stability.test.mjs` 4 pass, `tests/phase2-stream-guard-contract.test.mjs` 4 pass.

## stall-recovery 폐기 결정 (§6.6 ACCEPTED DEVIATION)

- 타깃 내장 스트림 유휴 가드는 `StreamIdleTimeoutError`(`errorCode: "STREAM_IDLE_TIMEOUT"`)로 오류를 방출한다(`upstream/packages/opencode/src/session/message-v2.ts:55-60`, `:1116-1124`; `contracts/src/stream-guard.mjs:5`).
- 기존 stall-recovery는 `"SSE read timed out after response data was received"` **문자열 매치**로 탐지했다. 이 문자열은 타깃에서 더 이상 발생하지 않는다 → 기존 탐지 로직 무효.
- 재프롬프트는 `experimental.compaction.autocontinue`/재시도 규칙과 의미가 중복된다.
- **결정**: 폐기(ACCEPTED DEVIATION). 동일 기능이 아니며(“탐지 후 안전 중단” vs “스톨 후 재프롬프트”) 정책 변경임을 명시한다. 결함 아님. Phase 4에서 `metadata.code` 기반 재도입 검토.

## C. 커스텀 플러그인 동작

| 기능 | 증거 (실행 증거) | 상태 |
|---|---|---|
| croak-auth 세션/토큰 | `node --test tests/croak-auth-session.test.mjs` → **9 pass** | PASS |
| croak-auth 서버 토큰 주입 (3중 조건) | `node --test tests/croak-auth-server.test.mjs` → **6 pass** (로그인전/정상/미설정provider/URL불일치/direct/id) | PASS |
| gate-identity (x-croak-agent/session) | `node --test tests/gate-identity.test.mjs` → **2 pass** | PASS |
| local-stability (반복차단/qwen/compaction) | `node --test tests/local-stability.test.mjs` → **4 pass** | PASS |
| secret-paths | `node --test tests/secret-paths.test.mjs` → **5 pass** | PASS |
| tool-policy (`/net-off` `/net-on` `/tool-status`, deny) | `node --test tests/tool-policy.test.mjs` → **8 pass** | PASS |
| usage-meter (JSONL) | `node --test tests/usage-meter.test.mjs` → **4 pass** | PASS |
| usage-panel (슬롯 3종·order 90) | `bun test test/usage-panel` → **55 pass**; `test/plugins/usage-panel.test.ts` → **1 pass** | PASS |
| hwp-read / hwp_cli | `node --test tests/hwp-read.test.mjs` → **8 pass** (rhwp 바이너리 미설치 → `exit 0` 미검증, wrapper 계약만 확인 — 아래 잔여 리스크) | PASS(부분) |
| croak-auth TUI (/login /logout /whoami /agent-perm) | `bun test test/plugins/croak-auth-tui.test.ts` → **2 pass** (슬래시 4개+슬롯 2개); `node --test tests/croak-auth-tui-registration.test.mjs` → **2 pass** | PASS |
| stall-recovery | 폐기 결정 기록 | ACCEPTED DEVIATION |
| vendor/opencode-cache-hit | 폐기 결정 기록 (아래) | ACCEPTED DEVIATION |
| dev-safe + commands | `node --test tests/dev-safe-agent.test.mjs` → **2 pass** | PASS |
| 플러그인 자동 스캔/등록 | `node --test tests/plugin-registration.test.mjs` → **2 pass**; 실 로더 스모크 `--print-logs models` → `loading plugin` **7건**, 실패 로그 0건, exit 0 | PASS |

### vendor/opencode-cache-hit 폐기 결정

소스는 완전하나(3,484줄, `src/` 존재): (1) **테스트 부재** → §6.4 골든 테스트 미충족, (2) usage-panel과 `sidebar_content` **중복 렌더**(order 56 vs 90 — 충돌 아님), (3) usage-panel이 `hitRate`를 이미 제공. **폐기(ACCEPTED DEVIATION)**, Phase 4 재검토. 이식 시 peerDeps `@croakcode/*` 갱신·패널 중복 정리 필요.

## §6.4 수용 기준

| # | 기준 | 증거 | 상태 |
|---|---|---|---|
| 1 | 골든 동작 테스트 — 각 테스트 파일 통과 | Phase 0–2 계약 51 pass + 위 C 표 | PASS |
| 2 | UX 스냅샷 (슬롯/푸터/아바타/승인모드/타이틀) | 슬롯 등록 계약 테스트로 등록만 검증; 실제 렌더 UX는 수동 | NOT TESTED(수동) |
| 3 | 통합 E2E (로그인→세션→도구→정책차단→usage→스톨복구) | 부분: 로그인 세션은 HTTP fixture로 검증; 전체 라이브 E2E 미실행 | NOT TESTED |
| 4 | 패치 동작 단위테스트 (Phase 2) | Phase 2 결과 상속 — 51 pass 재실행 확인 | PASS |
| 5 | 수동 체크리스트 | 릴리스 게이트 항목, 본 세션 미수행 | NOT TESTED(수동) |

## 필수 기능 상태 (§6.6)

인증(croak-auth)·정책 차단(tool-policy/secret-paths/§5.4)·사용량 기록(usage-meter/usage-panel) = 위 표 기준 **PASS**. FAIL 없음. NOT TESTED 항목은 UX/E2E 수동 영역으로 명시.

## §5.4 우회 차단 5종

| # | 시나리오 | 증거 | 상태 |
|---|---|---|---|
| 1 | `force:gate` + direct 전환 거부 | security-context + phase3-bypass(1) | (16a/16b에서 확정) |
| 2 | direct + `requiresAuth` 실행 전 오류 | security-context + phase3-bypass(2) | (16a에서 확정) |
| 3 | 로컬 설정으로 서버 deny 완화 무시 | phase3-bypass(3/3b) | (16a에서 확정) |
| 4 | 인증 실패 시 direct 전환의 게이트 전용 토큰 차단 | phase3-bypass(4a, 판정) + **phase3-context-e2e(토큰 미주입 E2E)** | (16b 이후 확정) |
| 5 | 전환 후 비밀 컨텍스트 재주입 없음 | **phase3-context-e2e (실제 변환·전송 payload)** | (16b 이후 확정) |

## §4.5 복구

| 항목 | 증거 | 상태 |
|---|---|---|
| recovery 계약 | `node --test tests/recovery.test.mjs` (3) | PASS |
| Phase 1 복구 E2E | `node --test tests/phase1-recovery.e2e.test.mjs` (3) | PASS |

## 잔여 리스크 / 명시적 미검증

- **rhwp 바이너리 미설치**: `hwpCli`의 `exit 0` 경로는 이 환경에서 검증 불가. 테스트는 wrapper 계약(`$ rhwp …` echo, `exit \d+`, read 명령은 ask 없음, write는 ask, blocked 차단)만 확인. 실 바이너리 설치 환경에서 재검증 필요.
- **플러그인 로더 경로 해석**: `src/session/llm/mode.ts`·`prompt.ts`가 `.croakcode/plugins/lib/connection.js`를 상대 경로로 import한다. Bun 런타임은 `upstream/.croakcode`(레벨 5)로 해석하고 `tsgo`는 `upstream/packages/.croakcode`(레벨 3)로 해석한다. `src/connection.d.ts` 모듈 선언으로 typecheck는 통과하나, 번들링 시 이 경로가 보존되는지는 패키지 빌드에서 확인 필요(Phase 4).
- **`cancel finalizes interrupted bash tool output`**: baseline(`2f9a1d8` 이전)에서도 실패하는 환경성 flake. 회귀 아님.
- **plugin.xai / parsePluginSpecifier 테스트**: `@opencode`→`@croakcode` 브랜딩 패치 관련 기존 실패(baseline 동일). 회귀 아님.
- **usage-panel typecheck 범위**: tsconfig `include`에 `usage-panel/**/*.ts`를 추가하지 않았다(원본 tsconfig 유지). `croak-auth-tui.tsx`는 `readPolicy` 결과 타입을 명시해 tsgo를 통과시킨다.
