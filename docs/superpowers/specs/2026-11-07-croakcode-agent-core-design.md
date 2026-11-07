# croakcode — AI 에이전트 코어 설계

- 날짜: 2026-11-07
- 상태: 승인 대기 (사용자 리뷰)
- 범위: Phase 1~3 (AI 에이전트 코어). 게이트·관리웹(Phase 4)은 설계 범위 외.

## 1. 배경과 목표

### 제품 비전 (장기)
거버넌스 에이전트 + 게이트 + 관리웹(운영 콘솔)을 묶은 상업 제품. 배포는 하이브리드(온프레미스 설치형 + SaaS).

### 이번 설계의 범위 (Phase 1~3): AI 에이전트 코어만
- 게이트 연동은 어댑터 지점만 확보(no-op), 관리웹은 명시적 연기.

### 추진 이유
- **C (기술적 통제)**: 아키텍처를 자체 통제.
- **D (유지보수 부담)**: upstream opencode 패치 추적 종료.
- **E (제품 정체성)**: 새 제품명·UX로 리브랜딩.

### 전략
- **opencode(MIT)를 fork 흡수하고 리브랜딩**: `codefrog/croakcode` 신규 모노레포로 흡수. `codefrog-opencode`는 참조 소스로 유지.
- **개발 순서**: Walking Skeleton(Phase 1) → opencode 코어+패치 흡수(Phase 2) → 커스텀 플러그인 이식(Phase 3). 최종 수용 기준은 "현재 opencode 동작 + codefrog 커스텀 기능이 전부 완벽히 동작".

### 네이밍
- 제품/리포: `croakcode`
- **실행 명령어: `cc`** (예: `cc`, `cc resume`, `cc --version`). 충돌 대비 `croakcode` 대체 명령 병행.
- 설정 경로: `~/.config/croakcode/`, 데이터: `~/.local/share/croakcode/`, 캐시: `~/.cache/croakcode/`
- 환경변수: `CROAKCODE_*`
- opencode 상표·브랜드 미사용. MIT 고지는 NOTICE 및 `--version`/About에 유지.

## 2. 리포 레이아웃

```
codefrog/
└── croakcode/                 ← 새 제품 리포 (monorepo)
    ├── packages/
    │   ├── core/              ← Runtime Core (세션·스트리밍·오케스트레이션)
    │   ├── tools/             ← Tool Executor (파일/셸/검색)
    │   ├── permission/        ← Permission Engine (ask/deny/allow, mode)
    │   ├── persistence/       ← SessionStore 인터페이스 + 로컬 구현(SQLite)
    │   ├── contracts/         ← 플러그인/훅 + Gate/Admin/Connection 어댑터 계약
    │   ├── cli/               ← CLI 진입점 (cc 바이너리)
    │   ├── tui/               ← TUI 클라이언트 (SolidJS + OpenTUI)
    │   └── plugins/           ← 아래 플러그인 서브패키지(각 1패키지)
    │       ├── auth/          ← croak-auth 이식(로그인/세션/PKCE/슬래시)
    │       ├── gate-identity/ ← x-croak-agent/session 헤더
    │       ├── local-stability/ ← 반복 호출 차단·파라미터·compaction
    │       ├── secret-paths/  ← 비밀 경로 차단/출력 제거
    │       ├── stall-recovery/ ← SSE 스톨 재프롬프트
    │       ├── tool-policy/   ← /net-off /net-on /tool-status
    │       ├── usage-meter/   ← 토큰/속도 JSONL
    │       ├── usage-panel/   ← 사이드바/아바타/guard TUI
    │       ├── hwp-read/      ← hwp_read/hwp_cli 도구
    │       └── cache-hit/     ← vendor/opencode-cache-hit 흡수(패널 기본 접힘)
    ├── docs/superpowers/specs/
    ├── NOTICE                   ← opencode MIT 고지 (필수)
    ├── LICENSE
    └── README.md
```

**패키지 경계 원칙**: 플러그인은 위와 같이 **자산 1개당 서브패키지 1개**(총 10개). 각 서브패키지는 contracts의 훅 인터페이스만 의존하고 core 내부를 직접 import하지 않는다. `dev-safe` 에이전트와 commands 3종은 코드가 아닌 **리소스**로 `packages/cli/resources/`에 둔다.

## 3. 아키텍처·모듈 경계

### 5개 레이어
```
Client (cli/tui)
    ▲ events (SSE)        │ commands (HTTP/RPC)
Runtime Core (Bun/TS)
    ├─ Session orchestrator (prompt loop, steering, abort)
    ├─ LLM streaming (provider adapters, SSE)
    ├─ Tool executor
    └─ Permission engine
        │                    │
Persistence (SessionStore)  Extension Points (hooks, adapters)
```

### 레이어 책임
1. **Runtime Core**: 세션 오케스트레이션, LLM 스트리밍, 도구 실행, 권한 판단. 인터페이스로만 소통.
2. **Tool Executor**: 도구 디스패치(파일/셸/검색). 보안·권한은 Permission Engine과 분리.
3. **Permission Engine**: ask/deny/allow, mode(auto/ask). UI와 분리된 순수 상태머신.
4. **Persistence**: `SessionStore`/`EventLog` 인터페이스로 추상화. **Phase 1 로컬 구현은 SQLite 확정**(단일 파일 `~/.local/share/croakcode/croakcode.db`), 이후 원격 구현으로 교체 가능.
5. **Client (CLI/TUI)**: 코어와 HTTP/SSE로 소통하는 얇은 클라이언트. TUI 슬롯·아바타·사용량 패널은 플러그인.
6. **Extension Points**: 서버 플러그인 훅 + **Connection/Gate/Admin 어댑터**. Phase 1의 gate/admin은 no-op.

### 의존 규칙 (단방향)
```
Client → Core → {Tools, Permission} → Persistence
                       └→ Extension Points (hooks)
```
역방향 금지. Tool Executor는 Client를 몰라야 함. 이 규칙이 C(통제)의 핵심.

### 핵심 설계 결정
- **코어와 UI 분리**: 코어를 헤드리스로 구동 가능하게 → 이후 관리웹/게이트/CI 연동 기반.
- **플러그인 훅 재설계**: `@opencode-ai/plugin` 타입 계승 + 자체 `contracts` 계약 모듈.
- **Persistence 인터페이스화**: Phase 1 로컬, Phase 2 원격 가능.
- **Gate/Admin/Connection 어댑터는 Phase 1 no-op**, 시그니처만 확정.

## 4. 데이터·이벤트 흐름

### 세션 생명주기
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

### 이벤트 모델 (client-facing, SSE)
| 이벤트 | 방향 | 설명 |
|---|---|---|
| `session.message` | core→client | 메시지 추가/갱신 |
| `session.part` | core→client | 스트리밍 텍스트/툴 델타 |
| `permission.request` | core→client | 승인 요청(ask) |
| `permission.reply` | client→core | 응답(allow/deny/always) |
| `session.status` | core→client | busy/idle/error |
| `session.error` | core→client | 스트리밍·도구 오류 |

### 훅 지점 (contracts)
- `chat.headers` (인증/게이트) — 플러그인 훅. `connection.prepare`보다 먼저 적용.
- `chat.params` (모델 파라미터)
- `tool.execute.before` / `after` (정책·시크릿 차단)
- `command.execute.before` (슬래시 명령)
- `event` (세션 이벤트 구독)
- `connection.adapter` / `gate.adapter` / `admin.adapter` (Phase 1 no-op)
- 순서: `chat.headers` → `chat.params` → `connection.prepare`(최종 인증 보강). 도구 실행 시 `tool.execute.before` → `policyHook` 순으로 deny 판정.

### Persistence 인터페이스
```ts
SessionStore { create, load, appendMessage, appendPart, updateStatus, list }
EventLog     { append(event), query(filter) }   // usage/audit
```
- **로컬 구현: SQLite 확정.** 파일: `~/.local/share/croakcode/croakcode.db`.
- 스키마(초안):
  - `sessions(id TEXT PK, model TEXT, permission_mode TEXT, cwd TEXT, created_at INT, updated_at INT, status TEXT)`
  - `messages(id TEXT PK, session_id TEXT, role TEXT, created_at INT, metadata JSON)`
  - `parts(id TEXT PK, message_id TEXT, type TEXT, content JSON, created_at INT)` — tool part 포함
  - `events(id INTEGER PK AUTOINCREMENT, type TEXT, session_id TEXT, payload JSON, created_at INT)`
- `EventLog` 보존 정책: usage/audit 이벤트 기본 **90일 보존**(설정 `eventRetentionDays`), 이후 삭제. 세션/메시지는 사용자 삭제 전까지 보존.
- 프롬프트 원문은 usage/event log에 저장하지 않음(메타데이터·토큰 수만).

### 에러 처리
- SSE 타임아웃: "첫 데이터 전"(`sse_timeout_before`) = 재시도 가능, "데이터 수신 후"(`sse_timeout_after`) = 재시도 금지(도구 중복 실행 방지). 판정은 ConnectionAdapter, 재시도 결정은 core.
- 도구 실패: 결과에 오류 반환, 세션 계속.
- 권한 거부(deny): 모델에 거부 사유 전달.
- gate 불가(인증 실패/도달 불가): 명확한 오류 + `--mode direct` 안내, **자동 폴백 없음**.
- direct 모드에서 `requiresAuth` 작업: 실행 전 오류("gate 모드 필요") — 자동 업그레이드 없음.

## 5. 연결 모드 스위칭 (gate vs direct)

### 개념
"권한이 필요한 작업"(정책·게이트 인증·감사)과 "권한이 불필요한 일반 작업"(단순 LLM)을 **Connection Mode**로 분리. 사용자가 세션/전역 설정에서 쉽게 스위칭.

| 모드 | 경로 | 권한/인증 | 용도 |
|---|---|---|---|
| `gate` | croakcode → croak-gate → LLM | 필요(croak-auth 토큰, chat.headers, gate-identity 헤더, 정책 강제) | 거버넌스, 감사, restricted tier |
| `direct` | croakcode → LiteLLM/OpenAI 호환 직접 | 불필요(API key) | 일반 개발, 게이트 불가 환경, 로컬 vLLM |

### ConnectionAdapter 인터페이스 (contracts)
```ts
type ChatRequest = {
  model: string
  messages: Message[]
  tools?: ToolSpec[]
  params: Record<string, unknown>       // temperature/topP 등
  headers: Record<string, string>       // 어댑터가 주입/보강
}
type Delta =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }   // args 파싱 실패 시 어댑터가 error Delta 방출
  | { type: "usage"; usage: { in: number; out: number } }
  | { type: "error"; kind: "sse_timeout_before" | "sse_timeout_after" | "provider"; message: string }
  | { type: "done"; reason: string }

interface ConnectionAdapter {
  id: "gate" | "direct"
  prepare(req: ChatRequest): Promise<ChatRequest>     // 헤더/인증/파라미터 주입
  stream(req: ChatRequest): AsyncIterable<Delta>       // 스트리밍 정규화
  requiresAuthorization(): boolean
  policyHook(): ToolPolicyHook | null                  // gate=강제, direct=no-op(로컬 훅은 별도 유지)
}
```
- **SSE 타임아웃 분류는 어댑터 책임**: `stream`이 `sse_timeout_before`(첫 데이터 전, 재시도 가능) / `sse_timeout_after`(데이터 수신 후, 재시도 금지)를 구분해 Delta로 방출. core orchestration은 이 Delta를 받아 재시도/중단을 결정(패치 0004 로직은 어댑터에 캡슐화).
- **훅 순서(단일 기준 — 정본 정렬)**: (요청) `chat.headers` → `chat.params` → `connection.prepare`; (도구 실행) `tool.execute.before` → `policyHook`. 아래 훅 지점 섹션은 이 순서를 재확인할 뿐이며, 두 곳이 어긋나면 이 문장을 정본으로 본다.
- **policyHook vs Permission Engine**: Permission Engine(UI/도구 레벨 ask/deny/allow)은 항상 동작. `tool.execute.before` 훅(플러그인) → `policyHook`(gate 정책) 순으로 **deny가 하나라도 있으면 실행 차단**. direct 모드에서 `policyHook`은 null이지만 플러그인 훅(secret-paths/tool-policy)은 그대로 동작.

### 스위칭 지점 (3계층) + 우선순위

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

### 슬래시 명령
- `/mode` (현재 모드 표시·전환), `/gate`, `/direct` — tool-policy `/net-off`와 같은 keymap 레이어.

### fail-safe (보안 원칙 — 확정)
- `gate` 모드에서 게이트 인증 실패/도달 불가 → **명확한 오류 + 안내**. **자동 direct 폴백 금지**(권한 우회 방지).
- restricted agent는 폴백 불가(항상 gate 강제).

### 정책·보안 경계
- gate: secret-paths/tool-policy가 게이트 정책과 일치(서버측 강제와 클라측 훅 동일).
- direct: 클라측 훅(secret-paths, tool-policy)은 여전히 동작(로컬 보호 유지), 게이트 감사는 없음.
- "권한 필요" 판단: `requiresAuth: true`인 에이전트/도구는 gate에서만 실행. direct에서 호출 시 실행 전 오류.

### 설정 예시
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

### A. opencode 코어 동작
- 세션 생성/재개/중단, steering(queued→steering)
- 스트리밍, 멀티턴, compaction/autocontinue
- 도구 전체: read/write/edit/grep/glob/bash/task(서브에이전트)/webfetch/websearch
- 권한 모드(auto/ask), 승인 다이얼로그
- provider/모델 설정, agents/subagents, 슬래시 명령, TUI 슬롯/키맵

### B. 패치 8개 동작 흡수
- 0001 base TUI: permission mode, auto-follow, run footer
- 0002 queued → steering 명칭/동작
- 0003 `session resume` → `cc resume`
- 0004 SSE 타임아웃 전/후 구분(재시도 규칙)
- 0005 Windows/WSL 드롭 경로 변환 + CJK 커서 폭
- 0006 `session_message_footer` 슬롯
- 0007 `api.permission.mode()` 노출
- 0008 CJK 다이얼로그 타이틀 표시폭 절단

### C. 커스텀 플러그인 동작
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

### 수용 기준 (동등성 검증 5종)
1. 골든 동작 테스트: 각 커스텀 기능의 기존 `*.test.mjs` 이식·통과
2. UX 스냅샷: 슬롯/푸터/아바타/승인모드/타이틀 절단
3. 통합 시나리오 E2E: 로그인→세션→도구→정책 차단→usage→스톨 복구
4. 패치 동작 단위테스트: SSE 전/후, WSL 변환, CJK 폭
5. 수동 체크리스트: 기존 codefrog와 나란히 비교(릴리스 게이트)

### 테스트 추적표 (동등성 매트릭스)
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

## 7. 테스트·마이그레이션·배포·리스크

### 테스트 전략
| 계층 | 방식 | 대상 |
|---|---|---|
| 순수 로직 단위 | `bun test`/`node --test` | permission, policy 상태머신, SSE 타임아웃, WSL 경로, CJK 폭, guard |
| 계약 테스트 | 인터페이스 conformance | SessionStore, EventLog, ConnectionAdapter, 훅 |
| 통합 | 세션/스트리밍 골든 | 델타 정규화, 도구→권한→실행 루프 |
| UX 스냅샷 | TUI 스냅샷 | 푸터/슬롯/아바타/배지/타이틀/auto-follow |
| E2E | 체크리스트 | 로그인→…→스톨 복구, gate↔direct 스위칭 |
| 동등성 회귀 | 기존 테스트 이식 | 커스텀 플러그인 + 패치별 테스트 |

릴리스 게이트: 동등성 5종 + 기존 codefrog 병렬 비교 통과.

### 마이그레이션 (codefrog-opencode → croakcode)
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
- 1회성 세션 호환 스크립트는 **선택 사항(optional)**: 세션 저장 포맷이 바뀔 경우에만 제공하고, 바뀌지 않으면 생략. 제공 시 "이전 세션 N개 변환 성공/M개 실패" 보고.
- **롤백**: 스크립트는 이전 경로를 삭제하지 않고 복사만 하며, `--rollback`으로 `.bak` 복원. 실패 시 원본 경로는 그대로 유지(비파괴).

### `cc` 명령어 충돌 처리
- 설치 시 `which cc`로 기존 바이너리 존재 확인. 충돌하면 **설치 중단 + 안내**: "`cc`가 이미 존재합니다. `croakcode`로 설치하거나 `--bin-name <name>`을 지정하세요." (기본은 설치 거부, 강제 덮어쓰기 없음).
- PATH에 `croakcode` 심볼릭 링크/별칭을 항상 함께 설치해 대체 경로 보장.

### 배포 (하이브리드)
- 단일 바이너리 `cc` (Bun compile): Linux/macOS(x64/arm64), Windows는 WSL 안내.
- 온프레미스: 바이너리 or 컨테이너(gate/direct 설정 템플릿 포함).
- SaaS(이후): 헤드리스 코어 + 원격 persistence + 관리웹 — 이번엔 어댑터 지점만.
- 라이선스: NOTICE(opencode MIT, cache-hit MIT) + `--version`/About 고지. 상표는 croakcode만.

### 리스크와 대응
| 리스크 | 대응 |
|---|---|
| opencode 강결합 해체 비용 | Phase 1에서 헤드리스 구동 검증, 점진적 절단 |
| 패치 8개 동작 누락 | 패치별 테스트 이식 + 수동 비교 |
| 플러그인 API 결합 | contracts + conformance 테스트 |
| Bun/TS 생태계 의존 | 런타임 인터페이스 유지 → 장기 Go 교체 여지 |
| `cc` 명령어 충돌(C 컴파일러) | 설치 시 충돌 검사, `croakcode` 병행 |
| gate→direct 자동 폴백 유혹 | fail-safe 규칙을 테스트로 강제 |
| 동등성 판정 모호 | 5종 수용 기준으로 정의 |

## 8. 단계별 완료 정의

> 실행 계획: Phase 1 → 2 → 3을 **연속으로 진행**한다. Phase 3 완료 시점이 이번 작업의 종료 지점이며, Phase 4(게이트/관리웹)는 이후 별도 설계로 다룬다.

- **Phase 1 (Walking Skeleton)**: 새 이름 CLI/TUI 실행, LLM 스트리밍, 파일/검색/셸 도구, 세션 생성·저장·재개, 승인 흐름, 단위테스트+단일 바이너리 빌드. + 헤드리스 구동 검증.
  - **Phase 1의 훅은 스텁**: `chat.headers`/`chat.params`/`tool.execute.before`/`command.execute.before`/`event`는 **인터페이스만 존재하고 기본 no-op**. secret-paths/tool-policy의 "완전판"은 Phase 3. 단, 권한(ask/deny/allow)과 승인 다이얼로그는 Phase 1에서 실제 동작.
  - **TUI 슬롯 프레임워크는 Phase 1에 포함**(빈 슬롯 레지스트리 + `session_message_footer` 등 슬롯 존재). 슬롯 **내용**은 Phase 2/3.
- **Phase 2 (코어 흡수)**: 섹션 6의 A + B 완료. 여기서 **TUI 슬롯 프레임워크(패치 0006)와 permission.mode 노출(0007)이 확정**되고, 슬롯은 아직 비어 있음.
- **Phase 3 (커스텀 이식)**: 섹션 6의 C 완료. **슬롯 내용**(usage-panel/cache-hit/아바타)과 플러그인 훅(secret-paths/tool-policy/auth 등)이 이때 채워짐.
- **Phase 4 (게이트/관리웹)**: 설계 범위 외.
- **최종 수용**: Phase 2+3 동등성 5종(테스트 추적표) 통과 = "완벽히 동작".

**슬롯 소유권 규칙(충돌 해소)**: 슬롯 **프레임워크(슬롯 등록 API/호스트 위치)** = Phase 2(core/tui 소유). 슬롯에 **렌더링되는 내용(플러그인)** = Phase 3(plugins 소유). 따라서 usage-panel은 Phase 3에서 "슬롯에 내용을 등록"만 하고 슬롯 자체는 만들지 않는다.

## 9. 명시적 비목표 (Phase 1에서 안 함)
- croak-auth 로그인/세션, 게이트 정책·인증 연동, 보안 경로 차단 완전판, HWP 도구, 사용량 패널/아바타, 관리웹, SaaS 멀티테넌시.
- 단, 훅 지점/플러그인/어댑터 API는 남겨 이후 페이즈에서 얹을 수 있게 함.
