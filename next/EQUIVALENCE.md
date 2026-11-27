# `next/` ↔ 기존 croakcode 동등성 매트릭스

이 문서는 **독립 CLI 시제품 `next/`가 기존 croakcode(`upstream/`, opencode fork 본체)와
"동일한 사용성"을 보장하는지**를 기능 항목별로 근거와 함께 정리한다.

기준(a): **기존 croakcode TUI/CLI 사용자 경험과 동일한가.**

## 한 줄 결론

**아니다.** `next/`는 기존 croakcode의 부분집합 프로토타입이며, 이번 작업
(세션 간 메시징 + TUI)으로 **추가된 기능**이 있는 반면, 명령·도구·세션 관리·
인증·플러그인·위임 등 사용자 경험의 대부분은 **미구현**이다. 기존 croakcode와
"동일 사용성"을 보장하려면 아래 "동등성 도달 로드맵"이 필요하다.

이번 PR이 실제로 보장하는 것:

- `next/` 시제품의 기존 `run` 동작에 **회귀 없음**(테스트로 검증).
- `next/` 시제품에 **세션 간 메시징**과 **전체화면 TUI**를 추가.
- 위 두 사실 외의 "기존 croakcode 동등성"은 **보장하지 않음**.

## 근거 출처

| 구분 | 근거 |
|---|---|
| 기존 CLI 명령 | `upstream/packages/opencode/src/index.ts` (`.command(...)` 24개) |
| 기존 도구 | `upstream/packages/opencode/src/tool/` (실 도구 약 20개) |
| 기존 슬래시 명령 | `upstream/packages/opencode/src/command/index.ts` (`init`, `review` + `.croakcode/command/*.md`) |
| 기존 TUI 기능 | `upstream/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`, `.../component/prompt/index.tsx` |
| 기존 resume/run 옵션 | `upstream/packages/opencode/src/cli/cmd/resume.ts`, `.../run.ts` |
| `next/` 기능 | `next/cli.ts`, `next/session.ts`, `next/chat.ts`, `next/tui.ts` |

## 1. CLI 명령

| 기존 croakcode | `next/` | 상태 |
|---|---|---|
| (기본 TUI 실행) | `session [--name] [--tui\|--no-tui]` (자체 TUI) | △ 다른 TUI |
| `run` | `run <filename> [prompt]` | △ read 전용 |
| `resume`(`--last/--session/--list/--fork/--model/--agent`) | `sessions`(목록만) | ✗ 리줌/포크 없음 |
| `serve`, `web`, `attach` | 없음 | ✗ |
| `export`, `import` | 없음 | ✗ |
| `models`, `providers` | 없음 | ✗ |
| `agent`, `mcp`, `plugin`, `db` | 없음 | ✗ |
| `github`, `pr` | 없음 | ✗ |
| `upgrade`, `uninstall`, `stats`, `generate`, `debug`, `console`, `acp` | 없음 | ✗ |
| (completion) | 없음 | ✗ |
| — | `sessions`(세션 목록), 세션 내부 `/send`(신규) | ＋ 신규 |
| — | (참고) standalone `send` 명령은 의도적 비활성(안내만 출력) | ✗ |

## 2. 도구(tool)

| 기존 croakcode | `next/ run` | `next/ session` | 상태 |
|---|---|---|---|
| `read` | ✅ | ✅ | ✅ |
| `write`, `edit`, `apply_patch` | ✗ | ✗ | ✗ |
| `glob`, `grep` | ✗ | ✗ | ✗ |
| `shell` | ✗ | ✗ | ✗ |
| `task`(위임), `plan`, `question` | ✗ | ✗ | ✗ |
| `todo`, `lsp`, `skill` | ✗ | ✗ | ✗ |
| `webfetch`, `websearch`, `mcp-websearch` | ✗ | ✗ | ✗ |
| `repo_clone`, `repo_overview` | ✗ | ✗ | ✗ |
| — | — | `ListAgents`, `SendMessage`(신규) | ＋ 신규 |

## 3. 세션 관리 / 영속

| 기존 croakcode | `next/` | 상태 |
|---|---|---|
| SQLite/WAL 다중 세션, 마이그레이션 | 최소 `sessions.db` | △ |
| `resume --last/--session/--list`, 포크 | `sessions` 목록만 | ✗ |
| 타임라인, 트리 분기 | 없음 | ✗ |
| 압축(compact)/요약 | 없음 | ✗ |
| undo/redo, revert | 없음 | ✗ |
| 세션 공유(share), export/import | 없음 | ✗ |
| 세션 간 메시징, 보류 큐, idle 구독 | `/send`, `/held`, `/notify` | ＋ 신규 |

## 4. TUI 사용성

| 기존 croakcode TUI | `next/` TUI | 상태 |
|---|---|---|
| 풀스크린 대화 UI | 자체 풀스크린(상태줄·로그·입력줄) | △ 단순 |
| 모델/에이전트 전환 | 없음 | ✗ |
| thinking 모드, which-key, 사이드바 | 없음 | ✗ |
| diff 뷰어, 편집 컨텍스트, stash | 없음 | ✗ |
| 이미지 첨부/붙여넣기, 클립보드 | 없음 | ✗ |
| 테마/키바인드 설정 | 색상 테마(고정) | △ |
| 플러그인 시스템 | 없음 | ✗ |
| 입력 편집·히스토리·커서 | ←/→, Home/End, Delete, Ctrl+A/E/K/U, ↑/↓ | ✅ |
| 메시지 전체화면 뷰어 | `/view` 뷰어(j/k, PgUp/PgDn, q/esc) | ＋ 신규 |

## 5. 인증 / 정책 / 거버넌스

| 기존 croakcode | `next/` | 상태 |
|---|---|---|
| `/login`, 게이트 로그인 | 없음 | ✗ |
| 게이트 모드 + 서명 permit | permit-gated `read`(gate.ts) | △ 부분 |
| 토큰 자동 갱신 | 없음 | ✗ |
| 다단 정책 규칙(전역/세션 deny) | read deny 일부 | △ 부분 |
| 위임 런타임(Phase 4), 하위 에이전트, 감사 | 없음 | ✗ |
| 에이전트 역할(`/agents`), task 위임 | 없음 | ✗ |

범례: ✅ 동등 · △ 부분/다름 · ✗ 미구현 · ＋ 기존에 없는 신규

## 6. 슬래시 명령

| 기존 croakcode | `next/ session` | 상태 |
|---|---|---|
| `init`, `review` (+ 사용자 `.croakcode/command/*.md`) | 없음 | ✗ |
| — | `/send /peers /held /view /rename /inbound /notify /help /quit` | ＋ 신규 |

## 검증 근거

| 명령 | 결과 | 범위 |
|---|---|---|
| `bun run test:next` | **29 pass / 0 fail** | next CLI·세션·TUI 단위 |
| `bun run test:e2e-tui` | **통과** | 두 세션 PTY(전송·수신·held·view·quit) |
| `bun run test` | **179 pass / 0 fail** | 기존 루트 통합/E2E(회귀 없음) |
| `scripts/phase1-headless-check.sh` | PASS | 헤드리스 기동 |

## 동등성 도달 로드맵 (기존 croakcode와 "동일 사용성" 목표 시)

우선순위 제안(각 항목은 별도 작업):

1. **도구 세트**: `write`/`edit`/`glob`/`grep`/`shell` 등 핵심 도구 이식(정책·permit 연동 포함).
2. **세션 관리**: `resume --last/--list/--session`, 포크, 기존 세션 DB 스키마 호환.
3. **인증/거버넌스**: `/login`, 토큰 갱신, 다단 정책, 게이트 연동 완성.
4. **에이전트/위임**: 역할 선택, `task` 위임, (장기) Phase 4 위임 런타임.
5. **TUI 동등**: 모델/에이전트 전환, 타임라인, 압축, undo/redo, 공유/export.
6. **플러그인/확장**: `.croakcode` 플러그인·커맨드 로딩.
7. **CLI 명령 전반**: `serve`/`web`/`export`/`import`/`models`/`providers` 등.

대안: `next/`를 `upstream/`에 통합해 세션 메시징·TUI 기능만 기존 코어에 얹는 경로.
이 경우 "동일 사용성"은 자연히 확보되고, `next/` 신규 기능은 이식 대상이 된다.

## 재현 방법

```bash
bun run build:next        # dist/croakcode-next
bun run test:next         # 단위 테스트
bun run test:e2e-tui       # PTY 통합 E2E (Linux)
bun run test              # 기존 루트 스위트(회귀 확인)
```
