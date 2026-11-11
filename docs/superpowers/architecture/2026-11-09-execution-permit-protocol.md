# 실행 허가 토큰 프로토콜

- **날짜**: 2026-11-09
- **상태**: croakcode 쪽 검증과 croak-gate 쪽 발급과 대조를 구현했다. 운영 서버 배포 전이다.
- **관련 문서**: Phase 4 계획 §2.8과 Task 9(`docs/superpowers/plans/2026-11-09-phase4-delegation-runtime.md`), 보안 추적표 §K

## 1. 목적

이 프로토콜은 Gate가 허가한 도구 호출만 정상 클라이언트에서 실행되게 한다. croakcode는 도구를 실행하기 직전에 Gate에 허가를 요청한다. Gate는 그 호출 하나에 묶인 토큰에 서명한다. croakcode는 Gate의 공개키로 토큰을 검증하고, 검증에 실패하면 도구를 실행하지 않는다.

변조된 클라이언트는 이 검증을 건너뛸 수 있다. 변조 클라이언트까지 막으려면 Gate가 발급한 허가와 그 세션의 모델 요청을 대조해야 한다. 이 대조는 croak-gate의 몫이다.

## 2. 켜는 조건

기본으로는 로그인이 정한다. 로그인과 토큰 갱신 응답에 `execution_permits: {required, public_key}`가 온다. `required`는 그 계정 등급의 `require_permits`이고, `public_key`는 Gate의 공개키다. croakcode는 이 값을 로그인 정보(`session.json`)에 저장하고, 도구를 실행할 때마다 읽는다. 공개키가 있으면 등급과 상관없이 늘 허가를 받는다. 결과를 대조할지는 Gate의 `require_permits`가 정한다. 그래서 등급에 `require_permits`를 켠 직후에도, 예전 값을 가진 PC가 허가 없이 도구를 실행하는 틈이 없다. 공개키가 없고 `required`가 참이면 모든 도구를 거부한다. 허가를 발급하는 주소는 로그인한 Gate 주소다. 사용자 PC에는 설정할 것이 없다.

아래 환경 변수는 로그인 값보다 먼저 적용된다. 시험과 수동 설정에 쓴다. `CROAKCODE_EXECUTION_PERMIT`가 `required`이면 아래 두 값으로 켜고, 다른 값(예: `off`)이면 끈다.

| 환경 변수 | 뜻 | 기본값 |
|---|---|---|
| `CROAKCODE_EXECUTION_PERMIT` | `required`이면 켜고, 다른 값이면 끈다 | 없음(로그인 값을 따른다) |
| `CROAKCODE_GATE_PERMIT_PUBLIC_KEY` | Gate의 Ed25519 공개키. PEM(SPKI)과 32바이트 원시 키의 base64를 받는다 | 없음 |
| `CROAKCODE_GATE_PERMIT_URL` | 허가를 발급하는 Gate 주소 | 없음 |

검증은 연결 모드가 gate인 호출에만 적용한다. direct 모드 호출은 Gate를 거치지 않는다. 검증을 켰는데 공개키와 주소 가운데 하나라도 없으면 모든 도구 호출을 거부한다.

## 3. 허가 요청

croakcode는 도구마다 다음 요청을 보낸다.

```
POST {CROAKCODE_GATE_PERMIT_URL}/v1/execution-permits
Authorization: Bearer <croak 로그인 액세스 토큰>
Content-Type: application/json

{"sid": "ses_…", "pid": "apr_…", "rid": "run_…", "tool": "bash", "args": "<sha256 hex>", "rev": 0}
```

| 필드 | 뜻 |
|---|---|
| `sid` | 세션 ID |
| `pid` | 호출하는 Agent Principal ID |
| `rid` | 호출하는 Run ID |
| `tool` | 도구 이름. MCP 도구는 `서버_도구` 형식이다 |
| `args` | 도구 인자를 표준 형식 JSON으로 바꾼 뒤의 SHA-256(소문자 16진수) |
| `rev` | croakcode가 아는 정책 revision. Gate는 참고용으로만 쓴다 |

표준 형식 JSON은 모든 깊이에서 객체 키를 정렬하고, 값이 `undefined`인 키를 뺀다. 배열 순서는 그대로 둔다. 공백은 넣지 않는다.

응답은 `200`과 `{"token": "<토큰>"}`이다. 다른 응답, 연결 실패, 10초 초과는 모두 거부로 처리한다.

## 4. 토큰 형식

토큰은 `base64url(payload).base64url(signature)`이다. 서명은 첫 조각, 곧 base64url로 인코딩한 payload 문자열의 ASCII 바이트에 대한 Ed25519 서명이다. 그래서 검증 쪽은 JSON을 다시 직렬화하지 않는다.

payload는 다음 필드를 모두 가진 JSON 객체다.

| 필드 | 형식 | 규칙 |
|---|---|---|
| `aud` | 문자열 | `croakcode` |
| `sid`, `pid`, `rid`, `tool`, `args` | 문자열 | 요청 본문과 같은 값 |
| `rev` | 숫자 | Gate의 정책 revision |
| `iat`, `exp` | 숫자 | 발급 시각과 만료 시각(밀리초). `exp - iat`는 60초 이하 |
| `nonce` | 문자열 | 토큰마다 새로 만든 값 |

## 5. 검증 규칙

croakcode는 다음 순서로 확인하고, 하나라도 맞지 않으면 그 호출을 거부한다. 거부 사유는 감사 기록의 `error_code`에 남는다.

| 순서 | 검사 | 거부 사유 |
|---|---|---|
| 1 | 두 조각 형식 | `permit_malformed` |
| 2 | Gate 공개키로 서명 확인 | `permit_signature` |
| 3 | payload 필드와 형식 | `permit_malformed` |
| 4 | `aud`, `sid`, `pid`, `rid`, `tool`, `args`가 현재 호출과 같음 | `permit_mismatch` |
| 5 | 유효 기간 60초 이하 | `permit_ttl` |
| 6 | `iat`가 현재보다 30초 넘게 미래가 아님 | `permit_not_yet_valid` |
| 7 | `exp`에서 30초가 지나지 않음 | `permit_expired` |
| 8 | 같은 `nonce`를 쓰지 않음 | `permit_replayed` |
| 9 | nonce 기록을 읽거나 쓸 수 있음 | `permit_nonce_unavailable` |

사용한 nonce는 croakcode 데이터베이스의 `permit_nonce` 테이블에 둔다. 프로세스를 다시 시작해도 기록이 남는다. 같은 데이터베이스를 쓰는 다른 프로세스도 같은 nonce를 쓰지 못한다. 기록은 토큰이 만료되고 시계 오차 30초가 지나면 지운다.

## 6. croak-gate가 구현할 것

- `POST /v1/execution-permits`를 연다. croak 로그인 토큰으로 호출자를 확인한다.
- 정책에 따라 각 호출의 허가 여부를 정한다. 거부할 때는 `200` 이외의 응답을 돌려준다.
- 허가할 때는 §4 형식의 토큰에 서명한다. 서명 키는 Gate만 가진다.
- 발급한 허가와 같은 세션의 모델 요청을 대조한다. 이 대조가 변조 클라이언트에 대한 강제다.
- 대리 호출 도구 `tool_call`의 결과는 안쪽 도구로 대조한다. croakcode는 `tool_call {"name", "input"}`이 부른 도구의 이름과 `input`으로 허가를 받기 때문이다. `tool_call` 이름으로는 허가를 발급하지 않는다. 그렇게 하면 등급이 막은 도구를 감싸 부를 수 있다.

## 7. 시험 상태

§6의 Gate 쪽 구현은 croakagent 저장소(github.com/jaloveeye/croakagent)의 `docs/execution-permits.md`가 설명한다.

| 항목 | 상태 |
|---|---|
| 토큰 검증 규칙(PT-01부터 PT-06) | croakcode 단위 테스트와 가짜 Gate 테스트로 PASS |
| 실제 루프의 gate 모드 실행 | 로컬 가짜 Gate로 PASS |
| 실제 croak-gate 연동(PT-07) | croakagent `gateway/tests/e2e_permits.py` 17건 PASS. 로컬 Docker 스택 |
| 로그인만으로 켜지는 허가(PT-09) | 2026-11-11 추가. 로그인 응답의 `execution_permits`로 croakcode가 스스로 허가 검증을 켠다. 환경 변수는 쓰지 않는다. E2E 22건 PASS |
| 허가 필수 상태의 croakcode 한 턴(PT-08) | 2026-11-10 전체 시험에서 추가. `tool_call` 결과가 대조를 통과하고, 허가는 안쪽 도구 이름으로 발급된다. E2E 19건 PASS |
