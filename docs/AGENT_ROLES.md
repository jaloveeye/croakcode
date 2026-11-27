# 공통 에이전트 역할

OpenCode와 croakcode는 다음 역할 체계를 사용한다. 개발자 권한 등급은 도구별로 다르다. 역할은 주 에이전트로 선택하거나, 권한이 허용되면 `task`로 위임할 수 있다.

| 역할 | 책임과 제한 |
|---|---|
| `orchestrator` | 작업을 분해하고 위임하며 결과를 통합·검증 |
| `planner` | 구현 계획과 검증 기준 수립; 파일 변경·셸 금지 |
| `developer-full` | 환경에서 허용한 도구로 구현과 검증 |
| `developer` (croakcode) | 파일 변경과 셸 실행 전에 승인 요청 |
| `developer-restricted` (croakcode) | 승인 후 편집; 셸·웹·위임 금지 |
| `tester` | 테스트 실행과 결과·미검증 위험 보고; 파일 변경 금지 |
| `explorer` | 코드 구조와 동작 조사; 읽기 전용 |
| `adversarial-reviewer` | 조사·기획·디자인·설계·코드 등 모든 결과물의 전제와 반례를 검토; 읽기 전용 |
| `code-reviewer` | 파일 변경과 셸 실행 없이 코드 리뷰 |
| `designer` | 사용자 경험·화면 설계; 파일 변경·셸 금지 |
| `product-planner` | 기획, 우선순위와 수용 기준; 파일 변경·셸 금지 |

모든 역할은 실제 계정·세션 권한, 승인, 샌드박스 및 croak-gate 정책을 따른다. `developer-full`도 이를 우회하거나 새 권한을 부여받지 않는다. croak-gate 계정 정책이 역할이나 도구를 막으면 사용할 수 없다. OpenCode에는 개발자 역할로 `developer-full`만 제공한다. croakcode에는 세 개발자 등급을 제공한다. 두 도구는 각자의 기본 모델과 기존 역할을 유지한다. 오케스트레이터의 위임 호출 가능 여부도 세션 권한에 좌우된다.
