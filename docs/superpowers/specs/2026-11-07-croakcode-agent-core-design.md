# croakcode — AI 에이전트 코어 설계

- 날짜: 2026-11-07
- 개정: 2026-11-07 (1차 외부 리뷰 반영, Phase 0 추가) / 2026-11-07 (2차 외부 리뷰 P0/P1 반영)
- 상태: 조건부 승인 반영 — Phase 0 계약 확정 후 Phase 1 구현 승인
- 범위: Phase 0~3 (AI 에이전트 코어). 게이트·관리웹(Phase 4)은 설계 범위 외.

## 0. 리뷰 반영 및 코드 검증 요약

### 0.1 1차 리뷰 반영 (코드 검증 포함)

외부 리뷰(P0 3건, P1 3건, 추가 10건)를 **실제 코드로 검증**한 뒤 반영했다. 검증 결과 일부 리뷰 전제는 사실과 달라 정정한다.

| 리뷰 지적 | 검증 판정 | 근거(실제 코드) |
|---|---|---|
| P0-1 Gate/Direct 보안 경계 부족 | **확인** | 문서에 설정 주체·서버/로컬 우선순위·Security Context 고정 부재. §5.4 신설로 보완 |
| P0-2 도구 실행 원자성 부족 | **부분 반박 + 보강** | opencode는 이미 `ToolState(pending/running/completed/error)` 영속화, interrupted orphan 처리(`prompt.ts:84-88`), abort 시 `status:"error", metadata.interrupted` 마킹. **부재한 것은 invocationId·UNKNOWN 복구·부작용 재실행 판단** → §4.5 신설 |
| P0-3 Fork 흡수 vs skeleton 중복 | **확인** | §1과 §8 긴장. "upstream 재사용 우선"으로 통일 (§8 재작성) |
| P1-1 의존성 경계 불명확 | **부분 반박** | 플러그인 전수: core 내부 직접 import **없음**, 전부 공개 plugin API. 단 패치 0006/0007이 추가한 공개 API(`session_message_footer`, `api.permission.mode`)는 계약 문서화 필요 → §3.4 |
| P1-2 Delta 계약 부족 | **부분 반박** | `packages/llm`이 이미 `tool-input-start/delta/end`+`tool-call` 구분, `ToolStream` 누적. session/TUI 경계는 delta 미전파(text-only) → 계약은 이 위에 얇게 (§5.5) |
| P1-3 동등성 기준 추상적 | **부분 정확** | 상태(PASS/FAIL/NOT TESTED/ACCEPTED DEVIATION)·OS·provider 기준 부재 → §6.6 매트릭스 |
| SQLite 동시성 부재 | **반박** | upstream이 이미 `WAL`, `busy_timeout=5000`, `Database.transaction(behavior:"immediate")` 사용(`storage/db.ts`, `sync/index.ts:151`). croakcode는 이를 **계승**하고 스키마 버전만 추가 (§4.4) |

**핵심 정정**: 리뷰의 "opencode가 해결한 복잡한 기능을 다시 구현할 위험"은 방향으로는 타당하나, opencode는 이미 SQLite/WAL/transaction, tool state 영속화, interrupted orphan 처리, partial tool-call 스트리밍을 갖고 있다. 따라서 croakcode는 **재구현이 아니라 검증된 코어 유지 + 제어 경계 확립**을 원칙으로 한다 (리뷰 최종 권고와 일치).

### 0.2 2차 리뷰 반영 (계약 일관성 4건 — P0 2건 포함)

2차 리뷰는 코드 검증 결과의 반박을 수용하고, "Approved, P0 잔여 없음"에는 동의하지 않았다. 남은 4건은 새 아키텍처가 아니라 **기존 계약의 일관성** 문제로 판단해 모두 반영했다.

| 2차 지적 | 처리 | 위치 |
|---|---|---|
| **P0-1** 도구 권한 검사 순서가 잘못 기술됨(실행 후 정책 차단 위험) | 실행 전 검사 순서를 **정본화**: 호출 검증 → `tool.execute.before` → `policyHook` → Permission 승인 → 실행 → `tool.execute.after`. **deny 최우선**, 정책(2,3)이 승인(4)보다 먼저. §4.3도 정본 참조로 통일 | §3.4, §4.3 |
| **P0-2** Gate 서버측 강제 범위 불명확 | Gate는 **LLM 요청만 경유**, 로컬 도구는 croakcode가 직접 실행 → **로컬 정책 강제**(정상 클라이언트 기준)와 **서버 실행 허가**(Phase 4)로 분리. Phase 0에서 신뢰 경계·인터페이스 초안만 확정 | §5.4, §8.4 |
| **P1-1** 복구 트랜잭션 표현 모순 | 실행 전체 단일 트랜잭션 불가 → **2-phase commit**: (T1)running 커밋 → 실행 → (T2)결과 커밋, 중간 종료 시 `unknown` 해석. `hasSideEffects`와 `reexecutionSafe` **분리** | §4.5 |
| **P1-2** Phase 간 슬롯 소유권 충돌 | **3단계 구분**: Phase 1 upstream 슬롯 API 사용·최소 실행 확인 / Phase 2 contracts로 API 계약 확정 / Phase 3 콘텐츠 이식 | §8.2, §8.3, §8.4, §8.6 |
| 추가 제안: 물리 패키지 분리 vs 논리 계약 | **논리 계약 우선 + 점진적 추출**. upstream 구조 유지, 추출 조건 만족 시에만 패키지 승격. Phase 0에서 추출 판정 표 | §2 |

**판정**: Phase 0 착수 가능(계약 테스트 포함). **Phase 1 구현은 Phase 0에서 위 4건 계약 테스트 통과 후 승인.**

## 1. 배경과 목표

### 제품 비전 (장기)
거버넌스 에이전트 + 게이트 + 관리웹(운영 콘솔)을 묶은 상업 제품. 배포는 하이브리드(온프레미스 설치형 + SaaS).

### 이번 설계의 범위 (Phase 0~3): AI 에이전트 코어만
- 게이트 연동은 어댑터 지점만 확보(no-op), 관리웹은 명시적 연기.

### 추진 이유
- **C (기술적 통제)**: 아키텍처를 자체 통제.
- **D (유지보수 부담)**: upstream opencode 패치 추적 종료.
- **E (제품 정체성)**: 새 제품명·UX로 리브랜딩.

### 전략
- **opencode(MIT)를 fork 흡수하고 리브랜딩**: `codefrog/croakcode` 신규 모노레포로 흡수. `codefrog-opencode`는 참조 소스로 유지.
- **원칙: 재사용 우선, 신규 구현 최소화.** opencode가 이미 검증한 실행 코어(세션 오케스트레이션, SQLite/WAL 영속화, tool state, streaming, retry/abort, partial tool-call)를 **그대로 유지**한다. croakcode가 새로 만드는 것은 **제어 경계**(권한/보안 컨텍스트, 연결 어댑터, 복구 계약, 게이트/관리웹 어댑터)에 한정한다.
- **개발 순서**: **Phase 0**(baseline 동결·계약 확정) → **Phase 1**(upstream 최소 단면 기반 Walking Skeleton) → **Phase 2**(코어 독립화·패치 흡수) → **Phase 3**(커스텀 이식). 최종 수용 기준은 "기존 opencode 동작 + codefrog 커스텀 기능이 검증 가능한 기준으로 전부 통과".
- **중복 개발 금지**: Phase 1은 upstream 실행 경로를 **재사용**해 구성하고, Phase 2에서 범위를 점진 확대한다. 독자 구현으로 먼저 완성한 뒤 upstream을 다시 가져오는 방식은 금지.

### 네이밍
- 제품/리포: `croakcode`
- **실행 명령어: `cc`** (예: `cc`, `cc resume`, `cc --version`). 충돌 대비 `croakcode` 대체 명령 병행.
- 설정 경로: `~/.config/croakcode/`, 데이터: `~/.local/share/croakcode/`, 캐시: `~/.cache/croakcode/`
- 환경변수: `CROAKCODE_*`
- opencode 상표·브랜드 미사용. MIT 고지는 NOTICE 및 `--version`/About에 유지.

## 2. 리포 레이아웃

**원칙(P1-2 반영)**: **논리적 계약 분리**와 **물리적 패키지 분리**는 다르다. 처음부터 7개+ 독립 패키지로 쪼개지 않는다. upstream 구조를 최대한 유지하고, 필요한 경계에 **어댑터/contracts**를 둔다. 다음 조건을 만족하는 부분만 **점진적으로 별도 패키지로 추출**한다: (a) 독립적 변경 주기, (b) 독립 테스트 가능, (c) 독립 배포/버전관리 필요.

```
codefrog/
└── croakcode/                 ← 새 제품 리포
    ├── upstream/              ← opencode v1.15.12 흡수(구조 유지, 리브랜딩)
    │   └── packages/...       ← 기존 opencode 모노레포 구조 그대로
    ├── contracts/             ← 논리 계약 모듈(플러그인/훅/Connection/Gate/Admin 어댑터)
    ├── control/               ← 제어 경계 어댑터(권한 순서, 보안 컨텍스트, 복구)
    │   ├── permission-order/  ← §3.4 실행 전 검사 순서
    │   ├── security-context/  ← §5.4 모드/정책 스냅샷
    │   └── recovery/          ← §4.5 invocationId/unknown
    ├── plugins/               ← 초기엔 flat, 독립 필요 시 점진 추출
    │   ├── auth.mjs           ← (추출 조건 충족 시 packages/auth/로 승격)
    │   ├── gate-identity.mjs
    │   ├── local-stability.js
    │   ├── secret-paths.mjs
    │   ├── stall-recovery.mjs
    │   ├── tool-policy.mjs
    │   ├── usage-meter.mjs
    │   ├── hwp-read.mjs
    │   ├── usage-panel/       ← TUI 플러그인(콘텐츠)
    │   └── vendor/opencode-cache-hit/  (흡수, 패널 기본 접힘)
    ├── cli/                   ← `cc` 바이너리 + resources(dev-safe 에이전트, commands 3종)
    ├── docs/superpowers/specs/
    ├── NOTICE                   ← opencode MIT 고지 (필수)
    ├── LICENSE
    └── README.md
```

**패키지 경계 원칙**:
- **upstream은 구조 유지**: 코어 대규모 해체 금지(재사용 우선). 수정은 어댑터/계약 지점에 한정.
- **contracts는 논리 계약**: 플러그인은 `contracts`만 의존하고 core 내부를 직접 import하지 않는다(린트/구조 테스트로 강제). 물리 패키지가 아니어도 계약은 유효하다.
- **plugins는 초기 flat**: 자산 1개당 1파일로 시작. 아래 **추출 조건**을 만족하면 `packages/<name>/`로 승격한다.
  - 추출 조건: 독립 버전/배포 필요, 서로 다른 언어/런타임 필요, 큰 테스트 스위트 분리 필요, 여러 제품에서 재사용 필요.
- `dev-safe` 에이전트와 commands 3종은 코드가 아닌 **리소스**로 `cli/resources/`에 둔다.
- **Phase 0 산출물**: 각 플러그인의 추출 여부를 판정하는 표(추출함/안함 + 근거)를 작성한다. 초기 기본값은 **flat 유지**.

## 3. 아키텍처·모듈 경계

### 3.1 아키텍처 개요 (계층과 컴포넌트 구분)
**실행 계층(3개)**과 **컴포넌트(책임 단위)**를 구분한다. 계층은 배포/실행 단위, 컴포넌트는 모듈 경계다.

- **실행 계층**: Client / Runtime Core / Persistence·Extension
- **컴포넌트(6개)**: Session Orchestrator, LLM Streaming, Tool Executor, Permission Engine, Persistence(SessionStore/EventLog), Extension Points(hooks/adapters)

```
Client (cli/tui)
    ▲ events (SSE)        │ commands (HTTP/RPC)
Runtime Core (Bun/TS)
    ├─ Session Orchestrator (prompt loop, steering, abort)
    ├─ LLM Streaming (provider adapters, SSE)
    ├─ Tool Executor
    └─ Permission Engine
        │                    │
Persistence (SessionStore)  Extension Points (hooks, adapters)
```

### 3.2 레이어 책임
1. **Runtime Core**: 세션 오케스트레이션, LLM 스트리밍, 도구 실행, 권한 판단. 인터페이스로만 소통.
2. **Tool Executor**: 도구 디스패치(파일/셸/검색). 보안·권한은 Permission Engine과 분리.
3. **Permission Engine**: ask/deny/allow, mode(auto/ask). UI와 분리된 순수 상태머신.
4. **Persistence**: `SessionStore`/`EventLog` 인터페이스로 추상화. **Phase 1 로컬 구현은 SQLite 확정**(단일 파일 `~/.local/share/croakcode/croakcode.db`), 이후 원격 구현으로 교체 가능.
5. **Client (CLI/TUI)**: 코어와 HTTP/SSE로 소통하는 얇은 클라이언트. TUI 슬롯·아바타·사용량 패널은 플러그인.
6. **Extension Points**: 서버 플러그인 훅 + **Connection/Gate/Admin 어댑터**. Phase 1의 gate/admin은 no-op.

### 3.3 의존 규칙 (단방향)
```
Client → Core → {Tools, Permission} → Persistence
                       └→ Extension Points (hooks)
```
역방향 금지. Tool Executor는 Client를 몰라야 함. 이 규칙이 C(통제)의 핵심.

### 3.4 계약 경계 (P1-1 반영)
- **플러그인은 core 내부를 직접 import하지 않는다**(현재 참조 리포도 전부 공개 plugin API만 사용 — 전수 검증 완료). croakcode도 **contracts 계약(논리 경계)** 만 의존하도록 강제한다. 물리 패키지 분리는 §2 추출 조건을 만족할 때만 한다.
- **capability 기반 contracts**: 플러그인이 쓸 수 있는 표면은 core/contracts에 명시된 포트로 제한한다 — `chat.headers`/`chat.params`(요청 메타), `tool.execute.*`(도구 인자/결과 + `ctx.ask`), `command.execute.*`, `event`(세션 이벤트), TUI `api.state.*`/`api.slots`/`api.keymap`/`api.permission.mode`. 그 외 내부 모듈 접근은 금지(린트/구조 테스트로 검증).
- **실행 문맥/TUI 데이터**: 플러그인이 core 내부 대신 contracts의 **ExecutionContext**(sessionID, directory, abort, ask)와 **TUI 상태 포트**를 통해 접근한다.
- **fork-added 공개 API 문서화**: 패치 0006(`session_message_footer` 슬롯), 0007(`api.permission.mode`)이 추가한 API는 **contracts에 정식 계약으로 승격**해 문서화한다(현재는 `packages/plugin/src/tui.ts`에 타입만 존재).
- **도구 실행 전 검사 순서(정본 — §4.3과 동일)**: 모든 필수 검사는 **도구 실행 전에** 완료되어야 하며, 실행 후 정책 차단은 금지한다. 순서는 다음과 같다:
  1. **호출 검증** (인자 스키마, `requiresAuth` 여부, 대상 경로 유효성)
  2. **플러그인 사전 정책 검사** (`tool.execute.before`)
  3. **Gate 정책 검사** (`policyHook`; direct 모드에서는 null)
  4. **Permission Engine 승인** (ask/deny/allow)
  5. **도구 실행** (Tool Executor)
  6. **결과 저장 + 사후 훅** (`tool.execute.after`)
  - **`deny` 최우선**: 어느 단계에서든 deny가 결정되면 즉시 차단하며, 뒤 단계는 실행하지 않는다. ask는 deny 판정이 모두 통과한 뒤에만 사용자에게 제시한다.
- **검사 우선순위 계약**: 정책 검사(2,3)가 승인(4)보다 **먼저**다. 즉 "승인했더라도 정책이 deny면 실행 불가". 이 순서는 contracts의 실행 파이프라인으로 고정하고 계약 테스트로 검증한다.(Persistence는 Core가 직접 사용하되 contracts 인터페이스로만 접근.)

### 3.5 핵심 설계 결정
- **코어와 UI 분리**: 코어를 헤드리스로 구동 가능하게 → 이후 관리웹/게이트/CI 연동 기반.
- **플러그인 훅 재설계**: `@opencode-ai/plugin` 타입 계승 + 자체 `contracts` 계약 모듈.
- **Persistence 인터페이스화**: Phase 1 로컬, Phase 2 원격 가능.
- **Gate/Admin/Connection 어댑터는 Phase 1 no-op**, 시그니처만 확정.

## 4. 데이터·이벤트 흐름

### 4.1 세션 생명주기
```
create → prompt(user) → orchestrator loop → stream assistant
       → tool calls → permission → results → persist → idle/resume
```
1. 세션 생성: `SessionStore.create()` → 메타(모델, 권한모드, cwd, id) 저장
2. 프롬프트 수신: user 메시지 append → `session.message` 이벤트
3. 오케스트레이션 루프: provider 스트리밍 → 델타 `session.part` 이벤트
4. 도구 호출: assistant tool part → tools 디스패치 → permission(ask/deny/allow) → 실행 → `tool.result`
5. 종료/대기: stop reason 또는 abort → 상태 `idle`, persist
6. 재개: `cc resume <id>` → store 로드 → 복원

### 4.2 이벤트 모델 (client-facing, SSE)
| 이벤트 | 방향 | 설명 |
|---|---|---|
| `session.message` | core→client | 메시지 추가/갱신 |
| `session.part` | core→client | 스트리밍 텍스트/툴 델타 |
| `permission.request` | core→client | 승인 요청(ask) |
| `permission.reply` | client→core | 응답(allow/deny/always) |
| `session.status` | core→client | busy/idle/error |
| `session.error` | core→client | 스트리밍·도구 오류 |

### 4.3 훅 지점 (contracts)
- `chat.headers` (인증/게이트) — 플러그인 훅. `connection.prepare`보다 먼저 적용.
- `chat.params` (모델 파라미터)
- `tool.execute.before` / `after` (정책·시크릿 차단)
- `command.execute.before` (슬래시 명령)
- `event` (세션 이벤트 구독)
- `connection.adapter` / `gate.adapter` / `admin.adapter` (Phase 1 no-op)
- 순서: `chat.headers` → `chat.params` → `connection.prepare`(최종 인증 보강). 도구 실행 순서는 §3.4 **도구 실행 전 검사 순서(정본)** 을 따른다 — 호출 검증 → `tool.execute.before` → `policyHook` → Permission 승인 → 실행 → `tool.execute.after`.

### 4.4 Persistence 인터페이스
```ts
SessionStore { create, load, appendMessage, appendPart, updateStatus, list }
EventLog     { append(event), query(filter) }   // usage/audit
```
- **로컬 구현: SQLite 확정.** 파일: `~/.local/share/croakcode/croakcode.db`.
- **동시성·복구 설정(inherit upstream)**: upstream과 동일하게 `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`을 사용하고, 쓰기는 `behavior:"immediate"` 트랜잭션으로 처리한다(`storage/db.ts`, `sync/index.ts:151` 검증). **단일 작성자 정책**: 앱 프로세스 1개가 writer, 다른 프로세스는 `busy_timeout` 내 재시도.
- **스키마 버전 관리**: `schema_version` 테이블 + 단조 증가 마이그레이션. 기존 opencode SQLite(`~/.local/share/opencode/opencode.db`) 마이그레이션은 Phase 0/1에서 별도 스크립트로 처리(읽기→변환→검증).
- 스키마(초안):
  - `sessions(id TEXT PK, model TEXT, permission_mode TEXT, cwd TEXT, created_at INT, updated_at INT, status TEXT)`
  - `messages(id TEXT PK, session_id TEXT, role TEXT, created_at INT, metadata JSON)`
  - `parts(id TEXT PK, message_id TEXT, type TEXT, content JSON, created_at INT)` — tool part 포함
  - `events(id INTEGER PK AUTOINCREMENT, type TEXT, session_id TEXT, payload JSON, created_at INT)`
- `EventLog` 보존 정책: **usage 로그와 보안 감사 로그를 분리**한다.
  - usage 로그: 기본 90일 보존(`usageRetentionDays`).
  - 감사 로그(정책 차단/인증/모드 전환/우회 시도): 기본 **365일 보존**(`auditRetentionDays`), 설정으로 상향 가능, 삭제 전 내보내기(export) 지원.
- 프롬프트 원문은 usage/event log에 저장하지 않음(메타데이터·토큰 수만). 감사 로그도 원문이 아닌 **정책 판정·대상 메타데이터**만 기록.

### 4.5 도구 실행 상태·복구 계약 (P0-2 반영)
opencode는 이미 `ToolState(pending/running/completed/error)`를 영속화하고 interrupted orphan을 처리한다(`prompt.ts:84-88`, abort 시 `metadata.interrupted`). croakcode는 이를 계승하되 다음을 **추가**한다:

- **invocationId**: 각 도구 호출에 고유 ID(`callID` 재사용 가능) 부여. `ToolPart.state`에 `invocationId` 포함.
- **실행 상태 모델**: `pending → running → succeeded | failed | unknown`.
  - **upstream 매핑(중요)**: upstream `ToolState`는 `pending/running/completed/error`(`message-v2.ts:249-288`)다. croakcode 상태는 다음으로 정확히 대응한다 — `succeeded ↔ completed`, `failed ↔ error`, `unknown` = `running` 잔존을 resume 시 `error`+`metadata.interrupted`로 마감하되 **`metadata.unknown=true`를 추가한 신규 식별**. 즉 영속 스키마는 upstream 필드를 유지하고 `metadata`만 확장한다(스키마 분기 없음).
  - `running` 진입 전 **WAL commit**(부작용 전 기록) → 프로세스 종료 시 `running` 잔존을 **`unknown`으로 복구**.
  - **외부 부작용 도구**(bash, write, hwp_cli 등)는 `unknown`을 **자동 재실행 금지**. resume 시 사용자에게 "결과 불명확 — 재실행/건너뜀/결과 입력" 확인 요청.
  - **부작용 없는 도구**(read/grep/glob)는 `unknown`이면 안전하게 재실행.
- **상태 전이 영속화(2-phase commit — 정본)**: 외부 부작용 도구의 실행 전체를 SQLite 단일 트랜잭션으로 묶어 원자성을 보장할 수 없다. 다음 순서를 따른다:
  1. `running`을 DB에 저장하고 **커밋**(트랜잭션 T1 종료)
  2. 외부 도구 실행 (트랜잭션 밖)
  3. 결과(`succeeded`/`failed`)를 DB에 저장하고 **커밋**(트랜잭션 T2 종료)
  4. 1과 3 사이에 프로세스가 종료되면 DB에는 `running`만 남는다 → resume 시 이를 **`unknown`으로 해석**(자동 재실행 금지, §4.5 정책 적용).
  - 두 커밋은 **별개 트랜잭션**이며, "실행 + 결과 저장"을 하나의 원자 단위로 가정하지 않는다. 이는 정확히 1회 실행을 보장하지 않지만, 무조건 재실행하는 위험을 제거한다.
- **부작용/재실행 안전성 분리**: contracts에서 **두 속성을 따로** 둔다 — `hasSideEffects: boolean`(외부 상태 변경 여부)과 `reexecutionSafe: boolean`(환경 변화에 무관하게 결과가 동일한가). 예: `read`는 둘 다 안전 쪽이나, 타임스탬프/외부 상태를 읽는 도구는 `hasSideEffects:false`여도 `reexecutionSafe:false`일 수 있다. 복구 시 `unknown` 처리 정책은 `reexecutionSafe`로 결정한다(`true`=재실행, `false`=사용자 확인).

### 4.6 에러 처리
- SSE 타임아웃: "첫 데이터 전"(`sse_timeout_before`) = 재시도 가능, "데이터 수신 후"(`sse_timeout_after`) = 재시도 금지(도구 중복 실행 방지). 판정은 ConnectionAdapter, 재시도 결정은 core.
  - **재시도 판단은 수신 여부만으로 하지 않는다**: (a) 직전 턴에 **부작용 도구**가 실행됐는지, (b) 스트림 중단/재개 상태(partial tool_call 완료 여부), (c) `error.retryable`을 종합해 판단. 부작용 발생 후 재시도는 금지하고 §4.5 복구 경로로 전환.
- 도구 실패: 결과에 오류 반환, 세션 계속.
- 권한 거부(deny): 모델에 거부 사유 전달.
- gate 불가(인증 실패/도달 불가): 명확한 오류 + `--mode direct` 안내, **자동 폴백 없음**.
- direct 모드에서 `requiresAuth` 작업: 실행 전 오류("gate 모드 필요") — 자동 업그레이드 없음.

## 5. 연결 모드 스위칭 (gate vs direct)

### 5.1 개념
"권한이 필요한 작업"(정책·게이트 인증·감사)과 "권한이 불필요한 일반 작업"(단순 LLM)을 **Connection Mode**로 분리. 사용자가 세션/전역 설정에서 쉽게 스위칭.

| 모드 | 경로 | 권한/인증 | 용도 |
|---|---|---|---|
| `gate` | croakcode → croak-gate → LLM | 필요(croak-auth 토큰, chat.headers, gate-identity 헤더, 정책 강제) | 거버넌스, 감사, restricted tier |
| `direct` | croakcode → LiteLLM/OpenAI 호환 직접 | 불필요(API key) | 일반 개발, 게이트 불가 환경, 로컬 vLLM |

### 5.2 ConnectionAdapter 인터페이스 (contracts)
```ts
type ChatRequest = {
  model: string
  messages: Message[]
  tools?: ToolSpec[]
  params: Record<string, unknown>       // temperature/topP 등
  headers: Record<string, string>       // 화이트리스트 헤더만
}
// Delta 정의는 §5.5 참조 (text / tool_call.start|delta|completed / usage / reasoning / stop / error)

interface ConnectionAdapter {
  id: "gate" | "direct"
  prepare(req: ChatRequest): Promise<ChatRequest>     // 헤더/인증/파라미터 주입 (Authorization 최종 소유)
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<Delta>  // 스트리밍 정규화
  requiresAuthorization(): boolean
  policyHook(): ToolPolicyHook | null                  // gate=강제, direct=no-op
}
```
- **SSE 타임아웃 분류는 어댑터 책임**: `stream`이 `sse_timeout_before`(첫 데이터 전, 재시도 가능) / `sse_timeout_after`(데이터 수신 후, 재시도 금지)를 구분해 Delta로 방출. core orchestration은 이 Delta를 받아 재시도/중단을 결정(패치 0004 로직은 어댑터에 캡슐화).
- **훅 순서(단일 기준 — 정본은 §3.4)**: (요청) `chat.headers` → `chat.params` → `connection.prepare`; (도구 실행) 호출 검증 → `tool.execute.before` → `policyHook` → Permission 승인 → 실행 → `tool.execute.after`. 두 곳이 어긋나면 §3.4 정본을 따른다.
- **policyHook vs Permission Engine**: Permission Engine(UI/도구 레벨 ask/deny/allow)은 항상 동작. `tool.execute.before` 훅(플러그인) → `policyHook`(gate 정책) 순으로 **deny가 하나라도 있으면 실행 차단**. direct 모드에서 `policyHook`은 null이지만 플러그인 훅(secret-paths/tool-policy)은 그대로 동작.

### 5.3 스위칭 지점 (3계층) + 우선순위

**우선순위(높음 → 낮음)**: `agent.force` > 세션 override(`cc --mode`) > 전역 `connection.mode`.

**모드 결정 표**:
| agent.force | 세션 override | 전역 | requiresAuth 작업 | 유효 모드 | 결과 |
|---|---|---|---|---|---|
| gate | direct | direct | – | **gate** | 허용 (force가 최우선) |
| gate | (없음) | direct | – | gate | 허용 |
| – | direct | gate | – | direct | 허용 |
| – | – | direct | true | direct | **오류**: "이 작업은 gate 모드 필요" |
| – | direct | gate | true | direct | **오류**: gate 필요 안내 |
| gate | direct | gate | – | gate | 허용, direct override 무시(경고 표시) |

- **전환 시점 동작**: 세션 중 `/mode`·`/gate`·`/direct` 로 모드를 바꾸면 **다음 턴부터 적용**. 진행 중인 스트리밍은 끝까지 유지하되, 모드가 gate→direct로 바뀌는 즉시 **새 턴부터 인증/정책 훅 해제**. 세션 재시작은 불필요.
- `force: gate` 에이전트에서 direct로 전환 시도 → **거부 + 경고**(세션은 gate 유지).
- `requiresAuth: true`는 **작업/에이전트 선언**(`agents.<name>.requiresAuth`)과 도구 메타데이터(`tool.requiresAuth`)로 표현. direct 모드에서 이런 작업 호출 시 **실행 전 오류**(자동 gate 업그레이드 없음).

### 5.4 Security Context Transition (P0-1 반영)

모드 전환은 단순 연결 변경이 아니라 **보안 컨텍스트 전이**로 취급한다.

**설정 주체와 신뢰 수준**:
| 수준 | 설정 주체 | 신뢰도 | 변경 가능 범위 |
|---|---|---|---|
| `agent.force` / `requiresAuth` | **관리자(서버 배포 설정, 서명된 정책)** | 높음 | 사용자가 덮어쓸 수 없음 |
| 전역 `connection.mode` | 관리자/사용자 | 중간 | 세션 override로만 조정 |
| 세션 override(`--mode`) | 사용자 | 낮음 | `force: gate`는 우회 불가 |

- **`agent.force`/`requiresAuth`는 관리자 정책**: 사용자 설정 파일로 변경 불가. 서명/해시 검증(정책 파일 변조 탐지)을 Phase 0 계약에 포함.
- **서버 정책 vs 로컬 설정**: **서버 Gate 정책이 최종 권한**. 로컬 설정은 서버 정책을 **완화할 수 없고**, 더 엄격하게만 만들 수 있다(monotonic tightening).

**Gate 신뢰 경계와 서버측 강제 범위 (P0-2 반영 — 명확화)**:
현재 아키텍처에서 `croakcode → croak-gate → LLM` 경로는 **LLM 요청**만 경유한다. `bash`, `write`, `hwp_cli` 등 로컬 도구는 croakcode가 **직접 실행**하므로, **Gate는 로컬 도구 실행을 자동으로 차단할 수 없다**. 따라서 두 방식을 구분한다:

| 방식 | 강제 주체 | 강제력 | 채택 시점 |
|---|---|---|---|
| **로컬 정책 강제** | croakcode 클라이언트(§3.4 실행 전 검사 순서) | 클라이언트가 정상일 때 유효. **변조된 클라이언트에 대한 강제력은 없음** | Phase 1~3 (기본) |
| **서버 실행 허가** | Gate의 서명된 허가 토큰을 도구 실행 직전 검증 | 온라인 연결·정책 프로토콜 필요, 변조 클라이언트도 차단 | **Phase 4 수용 기준** |

- **Phase 0 계약 필수**: Gate 신뢰 경계를 문서화한다 — (a) 어느 정책이 서버 권위인지, (b) 로컬 정책 강제가 보장하는 것/보장하지 못하는 것, (c) "서버 실행 허가" 프로토콜의 **인터페이스 초안**(서명 검증 지점, 온라인 요구, 실패 시 동작)만 정의(구현은 Phase 4).
- **정직한 보장 수준 명시**: Phase 1~3에서 "Gate 정책 강제"는 **정상 클라이언트 기준**임을 문서·에러 메시지에 명시한다. restricted agent의 `force: gate`는 로컬에서 강제되며, 변조 방지의 최종 보장은 Phase 4의 서버 실행 허가에서 완성된다.
- **서버측 인증 재확인 범위**: LLM 요청에 한해 Gate가 서버측에서 토큰/정책을 재확인한다(croak-auth 헤더·gate-identity). 로컬 도구 실행은 위 "로컬 정책 강제"가 담당하고, 서버 강제는 Phase 4로 분리한다.

**턴 단위 정책 스냅샷(고정)**:
- 각 **턴 시작**에 유효 모드·정책·requiresAuth 집합을 **스냅샷**으로 고정한다. 턴 진행 중 `/mode` 변경은 다음 턴부터 적용(스냅샷은 유지).
- gate→direct 전환 시: **대화 컨텍스트는 유지**하되, **게이트 전용 컨텍스트**(서버 정책으로 주입된 비밀/PII/감사 태그)는 새 턴에서 **재주입 금지·마스킹**. 이전 턴의 감사 로그는 삭제하지 않음(감사 무결성).

**우회 차단 검증 시나리오 (Phase 3 수용 필수)**:
1. `force: gate` 에이전트에서 `--mode direct` → 거부.
2. direct 세션에서 `requiresAuth` 도구 호출 → 실행 전 오류.
3. 로컬 설정으로 서버 deny 정책 완화 시도 → 무시(서버 정책 유지).
4. Gate 인증 실패 상태에서 direct 전환 시도 → 전환은 허용하되 게이트 전용 도구/컨텍스트 접근 차단.
5. gate→direct 전환 후 이전 턴의 비밀 컨텍스트가 새 프롬프트에 재주입되는지 검사 → 재주입 없음.

### 5.5 LLM 연결 계약 상세 (P1-2 반영)

`packages/llm`이 이미 partial/completed tool-call을 구분(`tool-input-start/delta/end`, `tool-call`, `ToolStream`)하므로 **재발명하지 않고 그 위에 얇게** 계약을 둔다.

```ts
type Delta =
  | { type: "text"; text: string }
  | { type: "tool_call.start"; id: string; name: string }
  | { type: "tool_call.delta"; id: string; argsFragment: string }      // 부분 JSON 조각
  | { type: "tool_call.completed"; id: string; args: unknown }         // 파싱 완료 — 실행은 이때만
  | { type: "usage"; usage: { in: number; out: number; cacheRead?: number; cacheWrite?: number } }
  | { type: "reasoning"; text: string }
  | { type: "stop"; reason: string }
  | { type: "error"; kind: "sse_timeout_before" | "sse_timeout_after" | "provider"; message: string; retryable: boolean; attempt?: number }
```
- **도구 실행은 `tool_call.completed`에서만** 허용(부분 delta로 실행 금지).
- **AbortSignal**: `stream(req, signal)`로 취소 전파. 취소 시 core가 도구 상태를 `error/interrupted`로 마감.
- **provider 차이 표준화**: tool-call ID, stop reason, reasoning, usage(비용·캐시 토큰 포함)를 Delta로 정규화.
- **stop reason 명시**: upstream `FinishReason`(`stop|length|tool-calls|content-filter|error|unknown`)을 `stop.reason`으로 그대로 전달. 단 도구 실행 게이팅은 `stop.reason`이 아니라 **`tool_call.completed` 수신**으로 판정한다(일관성).
- **`ToolSpec`은 croakcode contracts 신규 타입**(provider별 tool schema와 별개). 내부적으로 provider 어댑터가 각 provider 스키마로 변환한다.
- **SSE 재시도와 도구 재실행 분리**: 재시도는 `error.retryable`로 판단하되 `sse_timeout_after`는 `retryable:false`(도구 중복 실행 방지). 도구 재실행 결정은 §4.5 복구 계약이 담당(별도 책임).
- **헤더 보호 계약**: 일반 플러그인은 `Authorization` 등 보호 헤더를 **덮어쓸 수 없음**. `chat.headers`는 화이트리스트 헤더만 추가, 인증 헤더는 ConnectionAdapter가 최종 소유.

### 5.6 슬래시 명령
- `/mode` (현재 모드 표시·전환), `/gate`, `/direct` — tool-policy `/net-off`와 같은 keymap 레이어.

### 5.7 fail-safe (보안 원칙 — 확정)
- `gate` 모드에서 게이트 인증 실패/도달 불가 → **명확한 오류 + 안내**. **자동 direct 폴백 금지**(권한 우회 방지).
- restricted agent는 폴백 불가(항상 gate 강제).

### 5.8 정책·보안 경계
- gate: secret-paths/tool-policy가 게이트 정책과 **논리적으로 일치**하도록 유지한다. **클라측 훅이 로컬 강제를 담당**하고, 서버측 강제는 Phase 4 서버 실행 허가에서 완성된다(§5.4).
- direct: 클라측 훅(secret-paths, tool-policy)은 여전히 동작(로컬 보호 유지), 게이트 감사는 없음.
- "권한 필요" 판단: `requiresAuth: true`인 에이전트/도구는 gate에서만 실행. direct에서 호출 시 실행 전 오류.

### 5.9 설정 예시
```
connection:
  mode: gate           # gate | direct
  gate:   { url, caFile, providers: [litellm-head] }
  direct: { provider: openai-compatible | herace-local, baseURL, apiKey }
agents:
  dev-safe: { force: gate, requiresAuth: true }
tools:
  hwp_cli:  { requiresAuth: true }   # 예시: 인증 필요 도구
```

## 6. 동작 동등성 요구 (최종 목표)

현재 `codefrog-opencode`(opencode v1.15.12 + 패치 8개 + 플러그인 전체)와 기능·UX·정책 면에서 동등.

### 6.1 A. opencode 코어 동작
- 세션 생성/재개/중단, steering(queued→steering)
- 스트리밍, 멀티턴, compaction/autocontinue
- 도구 전체: read/write/edit/grep/glob/bash/task(서브에이전트)/webfetch/websearch
- 권한 모드(auto/ask), 승인 다이얼로그
- provider/모델 설정, agents/subagents, 슬래시 명령, TUI 슬롯/키맵

### 6.2 B. 패치 8개 동작 흡수
- 0001 base TUI: permission mode, auto-follow, run footer
- 0002 queued → steering 명칭/동작
- 0003 `session resume` → `cc resume`
- 0004 SSE 타임아웃 전/후 구분(재시도 규칙)
- 0005 Windows/WSL 드롭 경로 변환 + CJK 커서 폭
- 0006 `session_message_footer` 슬롯
- 0007 `api.permission.mode()` 노출
- 0008 CJK 다이얼로그 타이틀 표시폭 절단

### 6.3 C. 커스텀 플러그인 동작
- croak-auth: 로그인/로그아웃/세션/토큰 갱신/PKCE, `/login /logout /whoami /agent-perm`, 401 경고
- gate-identity: `x-croak-agent`/`x-croak-session` 헤더
- local-stability: 반복 도구 호출 3회 차단, qwen 파라미터 보정, compaction 커스터마이즈
- secret-paths: 비밀 경로 read 차단 + 출력 라인 제거
- stall-recovery: SSE 스톨 후 재프롬프트(최대 2회)
- tool-policy: `/net-off /net-on /tool-status`, 정책 파일 기반 툴 차단
- usage-meter: 토큰/속도 JSONL 기록(프롬프트 원문 제외)
- usage-panel: 사이드바 사용량/속도/아바타(sprites), guard 상태머신, 세션 재시작, 푸터/프롬프트 타이머
- hwp-read: `hwp_read`/`hwp_cli` 도구(rhwp, 캐시, Windows→WSL 경로)
- vendor/opencode-cache-hit: 패널(기본 접힘)
- dev-safe 에이전트 + commands 3종

### 6.4 수용 기준 (동등성 검증 5종)
1. 골든 동작 테스트: 각 커스텀 기능의 기존 `*.test.mjs` 이식·통과
2. UX 스냅샷: 슬롯/푸터/아바타/승인모드/타이틀 절단
3. 통합 시나리오 E2E: 로그인→세션→도구→정책 차단→usage→스톨 복구
4. 패치 동작 단위테스트: SSE 전/후, WSL 변환, CJK 폭
5. 수동 체크리스트: 기존 codefrog와 나란히 비교(릴리스 게이트)

### 6.5 테스트 추적표 (동등성 매트릭스)
현재 참조 리포 기준: 최상위 `*.test.mjs` 테스트가 있는 자산은 6개(gate-identity, hwp-read, secret-paths, stall-recovery, tool-policy, usage-meter)다. 추가로 croak-auth는 서브패스 `croak-auth/session.test.mjs`, usage-panel은 `usage-panel/*.test.ts` 5종이 있다. 나머지(local-stability, cache-hit, dev-safe+commands)는 **테스트 부재**라 아래처럼 신규/수동을 명시한다.

| 기능 | 기존 테스트 경로 | 상태 | 신규/수동 |
|---|---|---|---|
| gate-identity | `plugins/gate-identity.test.mjs` | 있음(이식) | – |
| hwp-read | `plugins/hwp-read.test.mjs` | 있음(이식) | – |
| secret-paths | `plugins/secret-paths.test.mjs` | 있음(이식) | – |
| stall-recovery | `plugins/stall-recovery.test.mjs` | 있음(이식) | – |
| tool-policy | `plugins/tool-policy.test.mjs` | 있음(이식) | – |
| usage-meter | `plugins/usage-meter.test.mjs` | 있음(이식) | – |
| croak-auth | `plugins/croak-auth/session.test.mjs` | 있음(이식) | TUI 슬래시는 신규 E2E |
| local-stability | (없음) | 신규 작성 | 단위테스트 신규(반복차단·파라미터) |
| usage-panel | `usage-panel/*.test.ts` 5종 | 있음(이식) | UX 스냅샷 신규 |
| cache-hit | (없음) | 신규 | 패널 접힘 스냅샷 신규 |
| dev-safe+commands | (없음) | 수동 | 수동 체크리스트 |
| 패치 0001 | (신규) | 신규 | permission mode/auto-follow 단위·스냅샷 |
| 패치 0002 | (신규) | 신규 | steering 명칭 단위 |
| 패치 0003 | (신규) | 신규 | `cc resume` 통합 |
| 패치 0004 | (신규) | 신규 | SSE 전/후 단위 |
| 패치 0005 | (신규) | 신규 | WSL 변환·CJK 폭 단위 |
| 패치 0006 | (신규) | 신규 | footer 슬롯 스냅샷 |
| 패치 0007 | (신규) | 신규 | permission.mode 노출 단위 |
| 패치 0008 | (신규) | 신규 | CJK 타이틀 절단 단위 |

### 6.6 동등성 매트릭스 상태 기준 (P1-3 반영)
각 기능 행에 **상태**를 부여하고, 상태별 릴리스 규칙을 둔다.

| 상태 | 의미 | 릴리스 규칙 |
|---|---|---|
| `PASS` | 기존/신규 테스트 통과 + 수동 비교 일치 | 허용 |
| `FAIL` | 기존 대비 동작 불일치 | **필수 기능이면 릴리스 차단** |
| `NOT TESTED` | 검증 미수행 | **필수 기능이면 릴리스 차단** |
| `ACCEPTED DEVIATION` | 의도적 차이(사유·영향 기록, 사용자 승인) | 허용(기록 필수) |

**필수 기능 목록**(최소): 세션 생성/재개/중단, 스트리밍, 도구 전체, 권한 모드, gate/direct 전환·우회 차단, 세션 복구(§4.5), 인증(로그인/토큰), 정책 차단(secret-paths/tool-policy), 사용량 기록. 이들 중 `FAIL`/`NOT TESTED`가 남으면 **최종 수용 불가**.

**테스트 환경 기준**:
- **OS/아키텍처**: Linux x64, macOS arm64 필수. Windows는 WSL 경유 검증(필수 아님, 결과 기록).
- **연동**: `direct`=로컬 vLLM(OpenAI-compatible), `gate`=croak-gate(Phase 3 이후). provider 호환성은 골든 응답 fixture로 검증.
- **수용 상태 기록 위치**: 매트릭스를 문서로 유지하고, 각 Phase 종료 시 상태를 갱신해 커밋한다.

## 7. 테스트·마이그레이션·배포·리스크

### 7.1 테스트 전략
| 계층 | 방식 | 대상 |
|---|---|---|
| 순수 로직 단위 | `bun test`/`node --test` | permission, policy 상태머신, SSE 타임아웃, WSL 경로, CJK 폭, guard |
| 계약 테스트 | 인터페이스 conformance | SessionStore, EventLog, ConnectionAdapter, 훅 |
| 통합 | 세션/스트리밍 골든 | 델타 정규화, 도구→권한→실행 루프 |
| UX 스냅샷 | TUI 스냅샷 | 푸터/슬롯/아바타/배지/타이틀/auto-follow |
| E2E | 체크리스트 | 로그인→…→스톨 복구, gate↔direct 스위칭 |
| 동등성 회귀 | 기존 테스트 이식 | 커스텀 플러그인 + 패치별 테스트 |

릴리스 게이트: 동등성 5종 + 기존 codefrog 병렬 비교 통과.

### 7.2 마이그레이션 (codefrog-opencode → croakcode)
1. `codefrog-opencode`는 read-only 참조로 유지.
2. opencode v1.15.12 소스를 `codefrog/croakcode`로 흡수(새 이력, NOTICE에 upstream commit 명시).
3. 8개 패치를 코어 코드에 직접 반영(패치 파일 없이).
4. `plugins/` 자산 이식·리브랜딩(`croak-*` → croakcode 명명), API는 contracts로 정리.
5. 데이터 경로 이전 스크립트: `~/.config/croak/`→`~/.config/croakcode/`, `~/.local/share/croak/`→`~/.local/share/croakcode/`, `~/.cache/croak/`→`~/.cache/croakcode/`.
6. 명령어 `opencode`→`cc`.

**마이그레이션 수용 기준**:
- 기존 `session.json`(croak-auth)이 croakcode 경로에서 로드·갱신된다.
- `tool-policy.json`/`usage.jsonl`이 새 경로에서 읽히고 계속 기록된다.
- 기존 codefrog 세션을 `cc resume <id>`로 로드·재개할 수 있다.
- 모든 변경 파일은 `*.bak-<timestamp>`로 백업된다.
- 1회성 세션 호환 스크립트: **포맷이 바뀌면 필수**. `cc resume`가 기존 세션을 로드하지 못하면 자동 변환을 제공하고(포맷은 `session.json`의 `schemaVersion`으로 판별), 변환 불가 세션은 명시적 오류로 보고한다(무음 실패 금지). 포맷 동일 시 생략. 제공 시 "이전 세션 N개 변환 성공/M개 실패" 보고.
- **롤백**: 스크립트는 이전 경로를 삭제하지 않고 복사만 하며, `--rollback`으로 `.bak` 복원. 실패 시 원본 경로는 그대로 유지(비파괴).

### 7.3 `cc` 명령어 충돌 처리
- 설치 시 `which cc`로 기존 바이너리 존재 확인. 충돌하면 **설치 중단 + 안내**: "`cc`가 이미 존재합니다. `croakcode`로 설치하거나 `--bin-name <name>`을 지정하세요." (기본은 설치 거부, 강제 덮어쓰기 없음).
- PATH에 `croakcode` 심볼릭 링크/별칭을 항상 함께 설치해 대체 경로 보장.

### 7.4 배포 (하이브리드)
- 단일 바이너리 `cc` (Bun compile): Linux/macOS(x64/arm64), Windows는 WSL 안내.
- 온프레미스: 바이너리 or 컨테이너(gate/direct 설정 템플릿 포함).
- SaaS(이후): 헤드리스 코어 + 원격 persistence + 관리웹 — 이번엔 어댑터 지점만.
- 라이선스: NOTICE(opencode MIT, cache-hit MIT) + `--version`/About 고지. 상표는 croakcode만.
  - **transitive dependency 고지 의무**: 배포 바이너리/SaaS에 포함되는 npm 의존성의 라이선스를 스캔(예: `license-checker`)해 NOTICE에 누적. MIT/Apache-2.0 등 고지 의무가 있는 항목은 개별 저작권 문구를 포함한다. (최종 적합성은 실제 배포 형태·종속성 기준으로 Phase 0에서 별도 검증.)

### 7.5 리스크와 대응
| 리스크 | 대응 |
|---|---|
| opencode 강결합 해체 비용 | Phase 1은 upstream 실행 경로 **재사용**, 점진적 절단(재구현 금지) |
| 패치 8개 동작 누락 | 패치별 테스트 이식 + 수동 비교(§6.6 매트릭스) |
| 플러그인 API 결합 | contracts + capability + conformance 테스트 |
| Bun/TS 생태계 의존 | 런타임 인터페이스 유지 → 장기 Go 교체 여지 |
| `cc` 명령어 충돌(C 컴파일러) | 설치 시 충돌 검사, `croakcode` 병행 |
| gate→direct 자동 폴백·우회 | §5.4 우회 차단 5종 시나리오를 테스트로 강제 |
| 도구 부작용 후 종료 시 재실행 | §4.5 invocationId + unknown 복구(자동 재실행 금지) |
| 동등성 판정 모호 | §6.6 PASS/FAIL/NOT TESTED/ACCEPTED DEVIATION 매트릭스 |

## 8. 단계별 완료 정의

> 실행 계획: **Phase 0 → 1 → 2 → 3을 연속 진행**한다. Phase 3 완료 시점이 이번 작업의 종료 지점이며, Phase 4(게이트/관리웹)는 이후 별도 설계로 다룬다. **각 Phase는 완료 기준(결정 게이트)을 통과해야 다음으로 넘어간다.**

### 8.1 Phase 0 — Baseline 동결 및 계약 확정 (신규)
- **목표**: 기존 `codefrog-opencode` 동작을 기준선으로 고정하고, 구현 전 계약을 확정한다. (코드 구현 없음 — 설계/검증 준비 단계)
- **작업**:
  1. 패치 8개 + 플러그인 10개 테스트 인벤토리 확보(실제 12개 테스트 파일 확인 완료, §6.5) 및 현재 통과 상태 기록.
  2. contracts 확정: Permission, ConnectionAdapter(§5.5), SessionStore/EventLog + 도구 복구 상태(§4.5), capability 표면(§3.4), gate/admin 어댑터 stubs.
  3. **도구 실행 전 검사 순서(§3.4 정본)를 계약 테스트로 고정** — deny 최우선, 정책(2,3)이 승인(4)보다 먼저.
  4. **Gate 신뢰 경계(§5.4)** 확정: 로컬 정책 강제의 보장 범위 명시 + 서버 실행 허가 프로토콜 인터페이스 초안(구현은 Phase 4).
  5. 관리자 정책(`agent.force`/`requiresAuth`)의 서명/변조 탐지 방식 확정(§5.4).
  6. SQLite 계승 설정(WAL/transaction) + croakcode 스키마 버전 + opencode DB 마이그레이션 계획 확정(§4.4).
  7. **복구 2-phase commit(§4.5) 계약 테스트**: 실행 전 running 커밋 → 실행 → 결과 커밋, 중간 종료 시 unknown 해석, `hasSideEffects`/`reexecutionSafe` 분리.
  8. **패키지 추출 판정 표**(§2): 각 플러그인 추출함/안함 + 근거. 초기 기본값 flat 유지.
  9. 동등성 매트릭스 초안 작성(상태 = NOT TESTED).
- **완료 조건(결정 게이트)**: 기준 구현 확정 + 계약 문서 승인 + **위 3·4·7 계약 테스트 작성·통과** + 필수 기능 목록 확정 + 매트릭스 초안 존재.

### 8.2 Phase 1 — Upstream 기반 Walking Skeleton
- **목표**: opencode의 **기존 실행 경로를 재사용**해 `cc` CLI/TUI와 헤드리스 코어를 구동한다(재구현 금지).
- **완료 조건**: 기본 에이전트 종단 간 실행(세션 생성→스트리밍→도구→권한→저장→재개) + 장애 복구 테스트(§4.5 unknown 경로) 통과 + 헤드리스 구동 검증.
  - Phase 1의 훅은 스텁(`chat.headers`/`chat.params`/`tool.execute.before`/`command.execute.before`/`event` = 인터페이스만, 기본 no-op). 권한(ask/deny/allow)·승인 다이얼로그는 실제 동작.
  - **슬롯 소유권(Phase 1)**: **upstream 슬롯 API를 그대로 사용**해 최소 실행(슬롯 등록/렌더가 실제로 동작하는지)만 확인한다. croakcode contracts로의 계약화는 Phase 2, 콘텐츠 이식은 Phase 3.

### 8.3 Phase 2 — 코어 독립화 및 기존 동작 흡수
- **목표**: opencode 강결합을 contracts 중심으로 분리하면서 패치 8개를 반영. 매 변경마다 baseline 회귀 테스트.
- **완료 조건**: 섹션 6의 A + B가 매트릭스에서 PASS(또는 승인된 ACCEPTED DEVIATION).
  - **슬롯 소유권(Phase 2)**: 슬롯 **API를 croakcode contracts로 계약 확정**(패치 0006 `session_message_footer`, 0007 `api.permission.mode` 포함). 슬롯은 여전히 비어 있음(콘텐츠는 Phase 3).

### 8.4 Phase 3 — 커스텀 플러그인 이식
- **목표**: 인증·보안·HWP·사용량·안정성·TUI 기능 이식. Gate/Direct 우회 테스트(§5.4) 포함.
- **완료 조건**: 섹션 6의 C가 매트릭스에서 PASS. §5.4 우회 차단 5종 + §4.5 복구 테스트 통과. 필수 기능에 FAIL/NOT TESTED 없음.
  - **보장 수준**: Phase 3의 정책 강제는 **로컬 정책 강제(정상 클라이언트 기준)**. 변조 클라이언트에 대한 서버측 강제는 **Phase 4 서버 실행 허가** 수용 기준에서 완성된다(§5.4).
  - **슬롯 소유권(Phase 3)**: 플러그인 **슬롯 콘텐츠 이식**(usage-panel/cache-hit/아바타)은 Phase 3. 플러그인은 슬롯에 "내용을 등록"만 하고 슬롯 API/호스트는 만들지 않는다.

### 8.5 Phase 4 (게이트/관리웹)
- 설계 범위 외. 단 Phase 4 수용 기준에 **서버 실행 허가(§5.4)** 구현·검증 포함.

### 8.6 최종 수용
- **Phase 2+3의 동등성 매트릭스에서 필수 기능이 전부 PASS**(또는 승인된 ACCEPTED DEVIATION) + §5.4 우회·§4.5 복구 테스트 통과 = 수용. "완벽히 동작"이라는 모호한 표현 대신 **검증 가능한 pass/fail 조건**으로 대체한다.

**슬롯 소유권 규칙(3단계 — 충돌 해소)**:
1. **Phase 1**: upstream 슬롯 API를 그대로 사용해 최소 실행 확인(등록/렌더 동작).
2. **Phase 2**: 슬롯 API를 croakcode contracts로 계약 확정(0006/0007 포함). 슬롯은 비어 있음.
3. **Phase 3**: 플러그인이 슬롯 **콘텐츠**를 등록(슬롯 API/호스트는 만들지 않음).

## 9. 명시적 비목표 (Phase 1에서 안 함)
- croak-auth 로그인/세션, 게이트 정책·인증 연동, 보안 경로 차단 완전판, HWP 도구, 사용량 패널/아바타, 관리웹, SaaS 멀티테넌시.
- 단, 훅 지점/플러그인/어댑터 API는 남겨 이후 페이즈에서 얹을 수 있게 함.
- **upstream 코어 기능의 재구현**(세션/영속화/스트리밍/retry)은 비목표: 재사용한다.
