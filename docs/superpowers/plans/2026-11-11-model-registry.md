# 모델 등록부와 추론 수준

- **날짜**: 2026-11-11
- **상태**: 계획
- **배경**: 2026-11-11에 서빙 경로를 읽기 전용으로 확인했다. 게이트 별칭(`qwen3.8-27b-nvfp4`, `default` 등)은 이름표일 뿐이고, 모두 같은 엔진으로 간다. 그 모델은 별칭과 다른 모델이었다. croakcode에는 그 별칭에 맞춘 처리가 남아 있다. 모델 ID에 묶인 temperature와 top_p, 생각 모드 값이다.
- **사용자 결정**:
  - 사용자는 어떤 모델인지 몰라도 된다. 기록에는 요청마다 실제 모델과 추론 수준이 남아야 한다.
  - 모델마다 추론 수준을 셋으로 둔다. none(생각 없음), low, high다.
  - 뒤의 서빙 엔진은 vLLM, SGLang, llama.cpp, TensorFold 가운데 무엇이든 될 수 있다. 엔진을 바꿀 때는 게이트(201 LiteLLM) 설정만 고친다. 모델 정보는 게이트와 croakcode가 함께 쓴다.

## 1. 확인한 사실 (2026-11-11, 운영 게이트)

같은 질문을 요청 값만 바꿔 보냈다.

| 요청 값 | 추론 토큰 |
|---|---|
| 없음 | 0 |
| `chat_template_kwargs.thinking: true` | 130 |
| `chat_template_kwargs.enable_thinking: true` | 생각함(쉬운 질문에서 18) |
| `thinking: true`와 `thinking_budget: 64` | 65 |
| `max_thinking_tokens`, `reasoning.max_tokens` | 무시됨(130) |
| 표준 `reasoning_effort` | 무시됨(0) |

지금 엔진은 생각 모드와 추론 예산을 요청마다 받는다. 표준 `reasoning_effort`는 받지 않는다. 엔진마다 값 이름이 다르므로 croakcode가 엔진 값을 직접 보내면 안 된다.

## 2. 구성

```
croakcode ── 모델 croak, 추론 수준 none|low|high ──▶ 게이트
게이트 ── 등록부에서 그 모델의 엔진 값을 찾아 요청을 바꾼다 ──▶ 뒤쪽 LiteLLM, 엔진
게이트 ── 요청마다 별칭, 실제 모델, 엔진, 추론 수준, Run ID를 기록한다
croakcode ◀── 로그인한 사용자에게 모델 목록과 화면 이름, 추론 수준 목록을 준다 ── 게이트
```

### 2.1 등록부

게이트 서버의 `models.yaml` 하나가 기준이다. 실제 값이 든 파일은 정책 파일처럼 저장소 밖(`local/models.yaml`)에 둔다. 저장소에는 예시 파일만 둔다.

```yaml
models:
  croak:                        # croakcode가 쓰는 별칭
    display: 사내 모델           # 화면 이름
    served_model: <실제 모델>    # 기록에만 쓴다. 화면에 보이지 않는다
    engine: <엔진>              # vllm | sglang | llamacpp | tensorfold
    upstream:                   # 뒤쪽 LiteLLM이 아는 이름과 주소
      model: openai/<뒤쪽 별칭>
      api_base: os.environ/UPSTREAM_API_BASE
    limits: { context: <토큰>, output: <토큰> }
    reasoning:
      default: none
      levels:                   # 수준마다 요청에 더할 값
        none: { chat_template_kwargs: { thinking: false } }
        low:  { chat_template_kwargs: { thinking: true }, thinking_budget: 1024 }
        high: { chat_template_kwargs: { thinking: true } }
```

수준별 값은 모델마다 직접 적는다. 같은 엔진이라도 모델의 채팅 템플릿에 따라 값 이름이 다르기 때문이다. 엔진별 예시는 3절에 둔다.

### 2.2 게이트

| 일 | 내용 |
|---|---|
| LiteLLM 설정 | 등록부에서 `config.yaml`의 `model_list`를 만든다. 별칭마다 항목이 하나다 |
| 요청 변환 | 정책 훅(pre_call)이 요청의 `reasoning_effort`(none, low, high)를 읽는다. 등록부의 그 수준 값을 요청에 넣고 `reasoning_effort`는 지운다. 값이 없으면 모델의 `default`를 쓴다. 모르는 수준은 거부한다 |
| 기록 | 사용량 기록에 `alias`, `served_model`, `engine`, `reasoning`, `run`을 더한다. `run`은 croakcode가 보내는 `x-croak-run` 머리글이다 |
| 공유 | `GET /v1/croak/models`(로그인 필요)가 모델 목록을 준다. 항목은 별칭, 화면 이름, 추론 수준 목록, 기본 수준, 한도다. `served_model`과 `engine`은 주지 않는다 |
| 이전 별칭 | `qwen3.8-27b-nvfp4`, `default`는 한동안 남긴다. 예전 croakcode가 계속 동작하게 하기 위해서다 |

### 2.3 croakcode

- 모델은 게이트의 목록으로 만든다. 지금 기준으로는 `croak` 하나다. 화면 이름은 등록부의 `display`다.
- 추론 수준은 opencode의 모델 변형(variant)으로 고른다. 화면 이름은 "생각 없이", "짧게 생각", "깊게 생각"이다. 고른 값은 `reasoning_effort`로 보낸다.
- 모델 ID에 묶인 처리를 지운다. 대상은 `local-stability`의 temperature, top_p, 출력 한도 경고와 "바로 답하기" 모드의 `enable_thinking`이다. upstream의 ID 기반 값(`qwen`이면 temperature 0.55 등)은 `croak` 별칭에 걸리지 않는다.
- 모든 모델 요청에 `x-croak-run` 머리글을 붙인다.
- 응답 메시지에 별칭과 추론 수준을 남긴다. 화면에는 보이지 않는다.
- 제품 설정의 `$schema`(`croakcode.ai`)를 지운다. 이 프로젝트의 도메인이 아니다.

## 3. 엔진별 추론 수준 예시

| 엔진 | none | low | high | 상태 |
|---|---|---|---|---|
| 지금 운영 엔진 | `chat_template_kwargs.thinking: false` | `thinking: true`, `thinking_budget: 1024` | `thinking: true` | 2026-11-11 운영에서 확인 |
| TensorFold(다른 배포) | 운영 엔진 값을 시작점으로 쓴다 | 같음 | 같음 | 엔진을 바꿀 때 확인 |
| vLLM | `chat_template_kwargs.enable_thinking: false` | 모델과 버전에 따라 다르다 | `enable_thinking: true` | 엔진을 바꿀 때 확인 |
| SGLang | `chat_template_kwargs.enable_thinking: false` | 모델과 버전에 따라 다르다 | `enable_thinking: true` | 엔진을 바꿀 때 확인 |
| llama.cpp | 템플릿 인자로 끈다 | 모델과 버전에 따라 다르다 | 템플릿 인자로 켠다 | 엔진을 바꿀 때 확인 |

엔진을 바꾸면 등록부의 수준 값을 1절과 같은 시험으로 다시 확인한다. 확인한 엔진만 "확인"으로 적는다.

## 4. 작업

| # | 저장소 | 작업 | 수용 |
|---|---|---|---|
| 1 | croakagent | 등록부 형식, 예시 파일, 검사기(`check_models.py`), `config.yaml` 생성 | 예시 등록부에서 지금과 같은 `model_list`가 나온다. 형식이 틀리면 배포가 멈춘다 |
| 2 | croakagent | 요청 변환과 기록 | 세 수준이 엔진 값으로 바뀐다. 사용량 기록에 다섯 값이 남는다. 모르는 수준은 거부된다 |
| 3 | croakagent | `/v1/croak/models` | 로그인한 사용자가 목록을 받는다. `served_model`이 응답에 없다 |
| 4 | croakcode | 게이트 목록으로 모델 만들기, 추론 수준 고르기, 모델별 처리 지우기, `x-croak-run`, `$schema` 지우기 | 화면에 "사내 모델"과 세 수준이 보인다. 고른 수준이 게이트 기록에 남는다 |
| 5 | 운영 | 실제 등록부 작성, 게이트 배포, 세 수준 확인 | 세 수준의 추론 토큰이 none < low < high다 |

## 5. 정할 것

| 항목 | 추천 |
|---|---|
| low의 추론 예산 | 1,024토큰. 사용해 보며 조정한다 |
| 기본 수준 | none. 지금과 같은 속도다 |
| high의 상한 | 없음(모델의 최대 출력 안에서) |
