# 게이트 밖으로 나가는 통신 감사

- **날짜**: 2026-11-12
- **계기**: 대화 공유가 게이트를 거치지 않고 외부 서버로 나갈 수 있었다(PR #81). 같은 종류의 경로가 더 있는지 찾았다.
- **범위**: `upstream/packages/opencode/src`와 `upstream/packages/core/src`의 외부 주소, 제품 설정(`upstream/.croakcode`)
- **게이트 모드**: 설치 스크립트의 실행기는 `CROAK_AUTH_URL`을 설정한다. 이 값이 있으면 croakcode가 게이트 뒤에서 도는 것으로 본다.

## 1. 결과

| # | 경로 | 나가는 데이터 | 기본 상태 | 조치 |
|---|---|---|---|---|
| 1 | 프로젝트 설정의 다른 공급자 | 대화 전체와 코드 | 열림 | 막음 |
| 2 | 프로젝트 설정의 `litellm-head` 주소 바꾸기 | 대화 전체, croak 세션 토큰 | 열림 | 막음 |
| 3 | 환경 변수 키로 켜지는 공급자 | 대화 전체 | 키가 있으면 열림 | 막음 |
| 4 | 웹 검색(Exa, Parallel) | 모델이 만든 검색어 | 환경 변수로 켜짐 | 막음 |
| 5 | models.dev 모델 목록 | 버전이 든 User-Agent | 시작할 때 받음 | 막음 |
| 6 | `console login` | upstream 계정 정보 | 명령으로 실행 | 막음 |
| 7 | `github install`, `github run` | 저장소 정보, GitHub 토큰 | 명령으로 실행 | 막음 |
| 8 | `providers login` | 다른 공급자 자격 증명, 원격 설정 주소 | 명령으로 실행 | 막음 |
| 9 | TUI "Open docs" | 브라우저가 upstream 문서를 연다 | 명령 팔레트 | 지움 |
| 10 | MCP OAuth의 `client_uri` | upstream 도메인을 MCP 서버에 알린다 | MCP OAuth를 쓸 때 | 지움 |
| 11 | 대화 공유 | 대화 전체 | 열림 | PR #81에서 막음 |
| 12 | 자동 업데이트 | 없음 | 꺼짐 | 이미 막음(#63) |
| 13 | LSP 서버 내려받기 | 없음 | 꺼짐 | 그대로 둔다 |
| 14 | 포매터 | 없음 | 꺼짐 | 그대로 둔다 |
| 15 | ripgrep 내려받기 | 없음 | 시스템에 rg가 없을 때 | 그대로 둔다 |
| 16 | `webfetch` 도구 | 모델이 고른 주소 | 켜짐 | 정책으로 정한다 |
| 17 | 플러그인 npm 설치 | 패키지 이름 | 설정에 플러그인이 있을 때 | 그대로 둔다 |

## 2. 경로별 내용

### 2.1 다른 공급자(1~3)

croakcode는 작업 폴더에서 위로 올라가며 `.croakcode/croakcode.jsonc`를 읽는다. 내려받은 저장소에 이 파일이 있으면 그 설정이 제품 설정에 합쳐진다.

- 그 설정은 공급자를 새로 정의하고 `model`을 그쪽으로 바꿀 수 있었다. 그러면 대화와 코드가 그 서버로 갔다.
- 그 설정은 `litellm-head`의 `baseURL`도 바꿀 수 있었다. croak 세션 토큰이 그 서버로 갔다.
- `ANTHROPIC_API_KEY` 같은 환경 변수가 있으면 그 공급자가 목록에 올랐다.

제품 설정의 `enabled_providers`는 다른 설정 파일이 덮어쓸 수 있다. 그래서 코드에서 막았다(`src/provider/croak-gate.ts`).

- 게이트 모드에서는 `litellm-head`만 목록에 남는다.
- 요청을 만들 때 `litellm-head`의 주소를 `CROAK_AUTH_URL` + `/v1`로 다시 정한다. 설정 파일의 주소는 쓰지 않는다.
- 다른 공급자로 요청을 만들려 하면 거부한다.
- 플러그인이 공급자 모델을 채우는 단계도 같은 규칙을 따른다. upstream은 이 단계에서 `enabled_providers`를 보지 않았다.

### 2.2 웹 검색(4)

웹 검색 도구는 검색어를 `mcp.exa.ai`와 `search.parallel.ai`로 보낸다. `CROAKCODE_ENABLE_EXA`, `CROAKCODE_EXPERIMENTAL` 같은 환경 변수가 도구를 켠다. 게이트 모드에서는 환경 변수와 상관없이 도구를 등록하지 않는다. 실행 단계에서도 한 번 더 거부한다.

### 2.3 models.dev(5)

upstream은 모델 정보를 `models.dev`에서 받아 캐시한다. 게이트 모드에서 croakcode가 쓰는 모델은 게이트 목록에서 온다. 그래서 게이트 모드에서는 받지 않는다. 빌드에 든 사본과 캐시 파일은 그대로 읽는다.

### 2.4 명령(6~8)

다음 명령은 게이트 모드에서 아무 일도 하기 전에 멈춘다.

| 명령 | 연결하는 곳 |
|---|---|
| `console` | `console.croakcode.ai`. 이 프로젝트의 도메인이 아니다 |
| `github` | `api.croakcode.ai`. 이 프로젝트의 도메인이 아니다 |
| `providers login`, `auth login` | 다른 공급자. 주소를 주면 그 주소의 `/.well-known/croakcode`에서 원격 설정을 받는다 |

`providers list`와 `providers logout`은 그대로 쓸 수 있다.

### 2.5 그대로 둔 경로(13~17)

- LSP 서버와 포매터는 설정에 `lsp`와 `formatter`가 없으면 꺼진다. 제품 설정에는 둘 다 없다.
- ripgrep은 시스템에 `rg`가 없을 때만 GitHub에서 받는다. 사용자 데이터는 나가지 않는다.
- `webfetch`는 모델이 고른 주소를 읽는다. 주소에 데이터를 실어 보낼 수 있다. 도구 허용은 게이트의 등급 정책이 정한다. 이 감사에서는 바꾸지 않았다.
- 플러그인 설치는 사용자의 npm 레지스트리에서 받는다. 프로젝트 설정의 플러그인은 5절에서 다룬다.

## 3. 남은 위험

- 실행기를 거치지 않고 실행 파일을 직접 실행하면 `CROAK_AUTH_URL`이 없다. 이때는 게이트 모드가 아니다. 게이트 로그인도 되지 않으므로 게이트 기록과 권한이 없는 upstream과 같다.
- 내려받은 저장소의 프로젝트 설정은 5절의 신뢰 확인을 거친다. 사용자가 신뢰한 저장소의 설정은 upstream과 같이 코드를 실행할 수 있다.
- 서드파티 공급자 머리글의 `HTTP-Referer`는 upstream 도메인이다. 게이트 모드에서는 그 공급자가 목록에 없어 나가지 않는다.

## 4. 확인

- 단위 시험: `test/croak/outbound.test.ts`, `test/provider/provider.test.ts`의 게이트 시험 3개, `packages/core/test/models.test.ts`의 게이트 시험 1개
- 실제 CLI: 가짜 `HOME`과 가짜 게이트 주소로 `github install`, `console login`, `auth login`, `providers login`이 멈추는 것을 보았다. `providers list`는 동작했다.

## 5. 재검증 (2026-11-12)

1~4절을 마친 뒤 같은 기준으로 다시 찾았다. 기준은 "사용자 승인 없이 설정 값이 데이터를 게이트 밖으로 보내거나 코드를 실행하는가"였다.

### 5.1 찾은 것

| # | 경로 | 결과 |
|---|---|---|
| 18 | 프로젝트 설정의 `{env:}`, `{file:~/...}`를 원격 MCP 주소에 싣기 | 가짜 비밀 값이 나갔다 |
| 19 | 같은 값을 `instructions` URL에 싣기 | 가짜 비밀 값과 파일 내용이 나갔다 |
| 20 | 프로젝트 `.croakcode/plugins`, `plugin`, 로컬 MCP, `lsp`, `formatter`, `shell` | 열면 코드가 실행된다 |
| 21 | 프로젝트 `tui.json`의 `plugin` | TUI에서 코드가 실행된다 |
| 22 | 프로젝트 설정의 `permission`, 에이전트 파일의 `permission` | 확인 없이 도구를 실행하게 바꿀 수 있다 |
| 23 | 설정의 `connection.mode: "direct"` | 클라이언트의 실행 허가 검사를 건너뛴다 |
| 24 | 이전에 등록한 well-known 원격 설정과 계정 원격 설정 | 원격 서버가 사용자 설정처럼 MCP와 플러그인을 더할 수 있다 |

- 18과 19는 1~4절의 수정 뒤에도 재현됐다. 가짜 `HOME`, 가짜 프로젝트, 로컬 수신기로 `croakcode run`을 실행했다. 값은 모두 가짜였다.
- 실제 상황에서는 `{file:~/.config/croak/session.json}`으로 croak 세션 토큰을 보낼 수 있다.
- 23은 허가가 필수인 등급에서 게이트가 막는다(`croak_guardrail.py`의 `unpermitted_tool`). 클라이언트에서도 막았다.

### 5.2 조치: 저장소를 처음 열 때 묻는다

사용자 결정(2026-11-12)에 따라 게이트 모드에서는 저장소마다 한 번 묻는다. 판정은 `src/config/project-trust.ts` 하나가 맡는다. 설정 로더와 TUI가 이 모듈을 함께 쓴다.

- 프로젝트 설정은 작업 폴더에서 저장소 최상위까지의 `croakcode.json(c)`, `tui.json(c)`, `.croakcode` 폴더다. 사용자의 `~/.croakcode`와 `~/.config/croakcode`는 프로젝트 설정이 아니다.
- 신뢰하기 전에는 허용 목록의 키만 읽는다. 허용 목록은 네 분류다.

  | 분류 | 키 |
  |---|---|
  | 에이전트와 명령 | `agent`, `mode`, `command`, `default_agent` |
  | 모델 | `model`, `small_model` |
  | 지시와 도구 | `instructions`, `tools` |
  | 화면과 저장 | `username`, `layout`, `watcher`, `snapshot`, `compaction`, `tool_output`, `attachment` |
- 허용한 키도 줄인다. 에이전트의 `permission`, `tools`, `options`를 뺀다. `instructions`는 프로젝트 안의 상대 경로만 남긴다. `tools`는 끄는 값만 남긴다.
- `{env:}`는 빈 값이 된다. `{file:}`은 프로젝트 안의 파일만 읽는다.
- 프로젝트 플러그인 폴더, `package.json` 의존성 설치, `tui.json`의 `plugin`을 건너뛴다.
- TUI는 시작할 때 빠진 항목을 보여 주고 묻는다. 기본 선택은 "신뢰 안 함"이다. 신뢰하면 인스턴스를 다시 읽는다. `/trust`로 다시 정할 수 있다.
- `croakcode run`은 묻지 못한다. 빠진 항목을 한 줄로 알린다.
- 결정은 `~/.config/croak/trusted-projects.json`에 프로젝트 설정 파일의 SHA-256 지문과 함께 남긴다. 파일이 바뀌면 다시 묻는다.

### 5.3 그 밖의 조치

- 게이트 모드에서 연결 모드는 항상 `gate`다. 연결 모드 값이 없을 때의 기본값도 `gate`로 바꿨다.
- 게이트 모드에서는 well-known 원격 설정과 계정 원격 설정을 받지 않는다.

### 5.4 확인

- 재현 시험을 고친 코드로 다시 돌렸다. 신뢰하기 전에는 수신기에 요청이 오지 않았고, 프로젝트 플러그인도 실행되지 않았다.
- 신뢰를 기록하자 MCP 연결, instructions 요청, 플러그인 실행이 모두 일어났다. 설정 파일을 바꾸자 다시 제한 상태가 됐다.
- tmux로 TUI를 띄웠다. 질문 창에서 Enter를 누르자 "신뢰 안 함"이 기록됐다. `/trust`에서 신뢰를 고르자 인스턴스를 다시 읽었고 MCP가 연결됐다.
- 단위 시험: `test/croak/project-trust.test.ts`, `test/config/config.test.ts`의 게이트 시험 3개, provider 게이트 시험 3개
