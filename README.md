# croakcode

`opencode`(MIT)를 fork 흡수·리브랜딩한 **거버넌스 AI 에이전트 코어**. 검증된 opencode 실행 코어(세션 오케스트레이션, SQLite/WAL 영속화, tool state, streaming, retry/abort, partial tool-call)를 유지하고, 그 위에 **제어 경계**(권한/보안 컨텍스트, 연결 어댑터, 복구 계약, 게이트/관리웹 어댑터)를 얇게 얹는 것을 원칙으로 합니다.

> **현재 상태: Phase 3 제품 수용 HOLD.**
> SEC-01/02/03(P0) 수정과 SEC-03 후속 수정은 `master`에 merge되었습니다. Gate→Direct 운영 경로는 무-fixture E2E로 검증했습니다. 리뷰어가 보안 수용을 판정할 때까지 HOLD 표시를 유지합니다. 상세: [`docs/superpowers/phase0/phase3-equivalence-matrix.md`](docs/superpowers/phase0/phase3-equivalence-matrix.md)

## 저장소 구조

| 경로 | 설명 |
|---|---|
| `upstream/` | opencode fork 본체 (Bun 모노레포). 실행 코어와 앱이 여기에 있습니다 |
| `upstream/.croakcode/` | croakcode 플러그인·연결 모드·인증/정책 어댑터 |
| `contracts/`, `control/` | 런타임 계약과 제어(연결 모드 해석 등) 패키지 |
| `tests/` | 루트 통합/E2E 테스트 (`node --test`) |
| `docs/superpowers/` | 설계·ADR·Phase별 동등성 매트릭스·증거 |
| `scripts/` | 게이트 replay, 로더 스모크, 리브랜딩 검사 등 운영 스크립트 |

## 요구 사항

- Node.js 22+
- [Bun](https://bun.sh) 1.3+
- (선택) `rhwp` — HWP 도구(`hwp_read`, `hwp_cli`, `hwp_memo`)를 쓰는 경우입니다. 실행 파일은 `CROAK_RHWP`로 지정하고, 없으면 `~/.local/bin/rhwp`를 씁니다. 바이너리가 있으면 `tests/hwp-read.rhwp.test.mjs`가 실제 실행을 검증하고, 없으면 이 테스트를 건너뜁니다. 메모 수정은 rhwp MCP 도구에만 있어서 `hwp_memo`가 `rhwp mcp-serve`를 호출 한 번 동안만 띄웁니다

## 클론 및 설치

```bash
git clone https://github.com/jaloveeye/croakcode.git
cd croakcode

# 루트 워크스페이스 설치 (필수): contracts, control 패키지를 연결합니다
bun install

# upstream 의존성 설치 (필수)
cd upstream
bun install
```

> **주의:** 루트에서 `bun install`을 하지 않으면 루트 테스트가
> `Cannot find package '@croakcode/control'` 오류로 실패합니다.
> `upstream`에서 `bun install`을 하지 않으면 `bun test`가
> `preload not found "@opentui/solid/preload"` 오류로 실패합니다.
> 일부 네이티브 모듈(`tree-sitter-powershell` 등)의 postinstall 빌드가 실패해도
> 테스트는 실행됩니다.

### 환경 변수

| 변수 | 필수 | 설명 |
|---|---|---|
| `CROAKCODE_EXECUTION_PERMIT` | 실행 허가를 쓸 때 | `required`이면 gate 모드의 도구 호출마다 Gate가 서명한 허가 토큰을 요구합니다. 기본은 꺼짐입니다. 형식은 `docs/superpowers/architecture/2026-11-09-execution-permit-protocol.md`에 있습니다 |
| `CROAKCODE_GATE_PERMIT_PUBLIC_KEY` | 실행 허가를 쓸 때 | Gate의 Ed25519 공개키입니다. 허가를 켰는데 없으면 모든 도구를 거부합니다 |
| `CROAKCODE_GATE_PERMIT_URL` | 실행 허가를 쓸 때 | 허가를 발급하는 Gate 주소입니다. 기본값이 없습니다. 허가를 켰는데 없으면 모든 도구를 거부합니다 |
| `CROAK_AUTH_URL` | 로그인을 쓸 때 | croak-gate 로그인 서버 주소입니다. 기본값이 없으므로 설정하지 않으면 `/login`이 오류를 표시하고, 모델 요청에 토큰을 싣지 않습니다 |
| `CROAKCODE_WEB_UI_URL` | 원격 웹 UI를 쓸 때 | 내장 UI가 없을 때 프록시할 웹 UI 호스트입니다. 기본값이 없습니다. 설정하지 않으면 UI 경로가 404를 돌려줍니다. 프록시 요청에는 로컬 서버의 `authorization`과 `cookie`를 싣지 않습니다 |
| `LITELLM_BASE_URL` | `litellm-head` 공급자를 쓸 때 | `croakcode.jsonc`의 공급자 주소입니다 |

## 테스트

### 루트 통합/E2E 테스트

```bash
# 저장소 루트에서
node --test 'tests/*.test.mjs'
```

현재 기준: **153 pass / 0 fail**. 여기에는 Gate→Direct 컨텍스트 E2E, SEC 출처/provenance 검사, 권한/우회 차단 등이 포함됩니다.

### opencode 패키지 테스트 (Bun)

```bash
cd upstream/packages/opencode

# 예: 보안/permission 관련 스위트
bun test test/permission test/tool/task.test.ts test/agent \
         test/session/processor-effect.test.ts

# 예: 프롬프트/컴팩션
bun test test/session/prompt.test.ts test/session/compaction.test.ts
```

### 타입 체크

```bash
cd upstream/packages/opencode
bun run typecheck
```

> `tsgo`가 없는 환경에서는 먼저 `upstream`에서 `bun install`을 수행하세요.
> 이어서 저장소 루트에서 `bash scripts/link-plugin-deps.sh`를 한 번 실행합니다.
> 이 스크립트는 `upstream/.croakcode/plugins/node_modules`를 opencode 패키지의 `node_modules`로 링크합니다.
> 링크가 없으면 `.croakcode/plugins`의 TUI 플러그인이 `@opentui/solid`를 찾지 못합니다.
> 그러면 타입 검사와 플러그인 테스트가 실패합니다.
> 런타임이 `.croakcode/node_modules`에 패키지를 설치하므로 링크는 `plugins` 아래에 둡니다.

## 알려진 실패 (회귀 아님)

2026-11-09에 전체 테스트 실패를 원인별로 나눴습니다. 리브랜딩 뒤 갱신되지 않은 테스트 15건은 기대값을 고쳤습니다. help-text 스냅샷은 영어 로캘로 고정했습니다. TUI 플러그인 테스트는 `scripts/link-plugin-deps.sh`로 의존성을 찾습니다.

웹 UI 프록시의 기본 주소를 지웠습니다. 원격 UI는 `CROAKCODE_WEB_UI_URL`을 설정할 때만 씁니다. CORS 허용 목록에서 `*.opencode.ai`를 뺐습니다. 원격 origin이 필요하면 `--cors`로 지정합니다. 이 조치로 `BASELINE_FAIL`은 비었습니다.

루트 `phase1-*.e2e` 테스트는 `scripts/phase1-headless-check.sh`가 만든 DB를 읽습니다. 게이트 스크립트는 이 스크립트를 먼저 실행합니다. DB는 내장 `node:sqlite`로 읽으므로 `sqlite3` CLI는 필요 없습니다.

`FLAKE_FAIL`은 비어 있습니다. shell 출력 경쟁으로 실패하던 2건은 P2-2에서 고쳤습니다. `running task tool preserves metadata ...`는 실패 기록 없이 등록돼 있었습니다. 2026-11-09에 64회 실행해 실패가 없어 목록에서 뺐습니다. 게이트에서 실패하면 로그가 `LOG_DIR`에 남습니다.

C 컴파일러가 없으면 `upstream`의 `bun install`이 `tree-sitter-powershell` 빌드에서 멈춥니다. 이때 `node_modules/.bin`이 생기지 않아 `bun run typecheck`가 `tsgo: command not found`로 실패합니다. 컴파일러를 설치할 수 없으면 `bun install --frozen-lockfile --ignore-scripts`로 링크를 완성합니다.

전체 목록과 게이트 판정은 [`scripts/phase2-gate-replay.sh`](scripts/phase2-gate-replay.sh)에 있습니다.

## `.croakcode` 상대 경로 주의

`src/session/llm/mode.ts`·`prompt.ts`가 `.croakcode/plugins/lib/connection.js`를 **상대 경로**로 import합니다.

- Bun 런타임은 `upstream/.croakcode`(레벨 5)로 해석
- `tsgo`는 `upstream/packages/.croakcode`(레벨 3)로 해석

`src/connection.d.ts` 모듈 선언으로 타입체크는 통과하지만, 번들링 시 이 경로가 보존되는지는 패키지 빌드에서 확인이 필요합니다(Phase 4 후속).

## 보안 상태 요약

| 항목 | 상태 |
|---|---|
| SEC-01 — 과거 `always` 승인이 현재 ruleset `deny`를 덮는 문제 | **수정 완료** (`790de4f`) |
| SEC-02 — 부모 agent 도출 시 세션 기록 agent만 사용해 실행 agent 제한 누락 | **수정 완료** (`481d91d`) |
| SEC-03 — 런타임이 gate 출처를 부여하지 않아 direct 필터가 실텍스트 통과 | **수정 완료** (`2836e2c`, 후속 `b4ed592`) |
| SEC-03 후속 — 압축 요청 필터 누락, 하위 에이전트 결과 출처 재분류, 구조 part로 direct 기록 손실 | **수정** (브랜치 `sec03-compaction-background`) |
| 운영 경로(Gate→Direct 무-fixture 재전송) E2E | 일반 응답, 압축, 하위 에이전트 결과 **검증** (`test/session/sec03-gate-direct-e2e.test.ts`, 8건) → Phase 3 보안 수용 판정 대기 |

## 문서

- 설계: [`docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md`](docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md)
- Phase별 동등성 매트릭스: `docs/superpowers/phase0/`
- ADR: `docs/superpowers/adr/`
- 아키텍처: `docs/superpowers/architecture/`

## 브랜치 / PR 흐름

- 기본 브랜치: `master`
- 기능/수정은 별도 브랜치 → PR → merge
- merge 후 feature 브랜치는 삭제

## 라이선스

upstream `opencode`는 MIT 라이선스를 따릅니다. 본 저장소의 흡수·리브랜딩도 해당 라이선스 조건을 따릅니다.
