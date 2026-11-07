# Equivalence Matrix (Phase 0b draft — Phase 2/3에서 갱신)

Status legend: PASS / FAIL / NOT TESTED / ACCEPTED DEVIATION (spec §6.6).
Release rule: 필수 기능에 FAIL/NOT TESTED 가 있으면 최종 수용 불가.

## Required features (최소 집합)
session create/resume/abort, streaming, tools(read/write/edit/grep/glob/bash/task/websearch/webfetch),
permission modes, gate/direct switch + bypass block, session recovery (§4.5), auth(login/token),
policy block(secret-paths/tool-policy), usage recording.

## A. opencode core
| Feature | Existing test | Status |
|---|---|---|
| session lifecycle | (upstream) | NOT TESTED |
| streaming | (upstream) | NOT TESTED |
| tool loop | (upstream) | NOT TESTED |

## B. patches 0001-0008
| Patch | Test source | Status |
|---|---|---|
| 0001 TUI/perm | test/cli/permission-mode.test.ts, test/cli/tui/auto-follow.test.ts | NOT TESTED |
| 0002 steering | test/session/prompt.test.ts | NOT TESTED |
| 0003 resume | test/cli/resume.test.ts | NOT TESTED |
| 0004 SSE timeout | test/provider/stream-timeout.test.ts | NOT TESTED |
| 0005 WSL/CJK | test/cli/cmd/tui/dropped-path.test.ts | NOT TESTED |
| 0006 footer slot | (adds NO test) | NOT TESTED |
| 0007 permission.mode | fixture only | NOT TESTED |
| 0008 CJK title | test/util/locale.test.ts | NOT TESTED |

## C. plugins
| Plugin | Existing test | Status |
|---|---|---|
| croak-auth | plugins/croak-auth/session.test.mjs | NOT TESTED |
| gate-identity | plugins/gate-identity.test.mjs | NOT TESTED |
| local-stability | (none — new test needed) | NOT TESTED |
| secret-paths | plugins/secret-paths.test.mjs | NOT TESTED |
| stall-recovery | plugins/stall-recovery.test.mjs | NOT TESTED |
| tool-policy | plugins/tool-policy.test.mjs | NOT TESTED |
| usage-meter | plugins/usage-meter.test.mjs | NOT TESTED |
| usage-panel | usage-panel/*.test.ts (5, bun-only) | NOT TESTED |
| cache-hit | (none — new snapshot needed) | NOT TESTED |
| dev-safe + commands | (manual) | NOT TESTED |

Note: `local-stability` (`plugins/local-stability.js`, 72 lines) currently has no test — a new test is needed.

## Env criteria (spec §6.6)
Linux x64 + macOS arm64 required; Windows via WSL (recorded).
direct=local vLLM; gate=croak-gate (Phase 3+).
