# Package Extraction Decisions (Phase 0b)

Spec §2: 논리 계약 분리와 물리 패키지 분리는 다르다. 기본값은 **flat 유지**.
추출 조건(하나라도 해당 + 유지보수 이득이 클 때만):
(a) 독립 버전/배포 필요, (b) 다른 언어/런타임, (c) 큰 테스트 스위트 분리, (d) 여러 제품에서 재사용.

| Asset | Extract? | Condition met | Rationale |
|---|---|---|---|
| croak-auth | No | - | 공개 API만 사용, 단일 제품. Phase 3에서 flat 유지 |
| gate-identity | No | - | 22 lines (.mjs). 추출 가치 없음 |
| local-stability | No | - | 72 lines (.js) — 단일 제품 정책 |
| secret-paths | No | - | 92 lines (.mjs), 공개 훅만 사용 |
| stall-recovery | No | - | 49 lines (.mjs) |
| tool-policy | No | - | 88 lines (.mjs) + tool-policy-state.mjs, 상태 파일 공유, 단일 패키지가 응집도 높음 |
| usage-meter | No | (c)? | 134 lines (.mjs), 테스트 있으나 패키지 분리 이득 낮음 → flat |
| usage-panel | No | (c) 큰 UI 테스트군 | 기본 flat 유지, Phase 3에서 재판정 |
| hwp-read | No | (b)(d) rhwp 외부 의존, 재사용 가능 | 258 lines (.mjs). 기본 flat 유지, Phase 3에서 재판정 |
| cache-hit (vendor) | No | - | 제3자 벤더(`plugins/vendor/opencode-cache-hit`), 이미 독립 npm 패키지 |

**결론:** Phase 0 기준 **물리 추출 0개**. Phase 3 이식 후 usage-panel·hwp-read만 재판정.
