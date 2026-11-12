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
- 플러그인 설치는 사용자의 npm 레지스트리에서 받는다. 프로젝트 설정의 플러그인은 코드를 실행한다. 이것은 upstream의 신뢰 모델이며 따로 정할 일로 남긴다.

## 3. 남은 위험

- 실행기를 거치지 않고 실행 파일을 직접 실행하면 `CROAK_AUTH_URL`이 없다. 이때는 게이트 모드가 아니다. 게이트 로그인도 되지 않으므로 게이트 기록과 권한이 없는 upstream과 같다.
- 내려받은 저장소의 프로젝트 설정은 플러그인과 MCP 서버를 정의할 수 있다. 둘 다 코드를 실행한다. 프로젝트 설정을 읽기 전에 사용자에게 묻는 기능은 따로 정한다.
- 서드파티 공급자 머리글의 `HTTP-Referer`는 upstream 도메인이다. 게이트 모드에서는 그 공급자가 목록에 없어 나가지 않는다.

## 4. 확인

- 단위 시험: `test/croak/outbound.test.ts`, `test/provider/provider.test.ts`의 게이트 시험 3개, `packages/core/test/models.test.ts`의 게이트 시험 1개
- 실제 CLI: 가짜 `HOME`과 가짜 게이트 주소로 `github install`, `console login`, `auth login`, `providers login`이 멈추는 것을 보았다. `providers list`는 동작했다.
