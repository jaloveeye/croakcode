# Phase 0a Status (Contracts & Control)

Summary: Phase 0a contract work is COMPLETE (tasks 1-12 committed). Phase 0b documentation artifacts are in progress.

## Test results (verified 2026-11-07)

- `node --test`: **38 pass / 0 fail**
- `bun test tests`: **38 pass / 0 fail** (6 test files)

## Tasks (all COMPLETE, committed)

| # | Task | Commit message |
|---|---|---|
| 1 | `.gitignore` + workspace scaffold | `chore: scaffold croakcode workspace for phase 0a` |
| 2 | Test smoke (node:test + bun) | `test: add workspace smoke test (node:test compatible)` |
| 3 | Inventory generation script | `docs: capture baseline test inventory with patch gap notes` |
| 4 | Record baseline test run status | `docs: record baseline test run status (incl. croak-auth)` |
| 5 | Hook typedefs | `feat(contracts): add hook typedefs and HOOK_NAMES` |
| 6 | Connection/Delta/ToolSpec typedef | `feat(contracts): add Connection/Delta/ToolSpec contract` |
| 7 | `resolveExecutionPlan` (ask after policy deny) | `feat(control): deny-first execution order with ask-after-policy-deny` |
| 8 | `resolveEffectiveMode` (precedence incl. bypass row) | `feat(control): mode precedence incl. session-direct requiresAuth bypass row` |
| 9 | Server authorization interface (stub) | `feat(control): server authorization interface stub (phase 4, no logic)` |
| 10 | State machine + T1/T2 commit ports | `feat(control): recovery 2-phase commit contract (T1 before execute, T2 after)` |
| 11 | HMAC admin policy integrity | `feat(control): HMAC admin policy integrity (tamper-resistant)` |
| 12 | Full contract regression (node + bun) | _(regression verified — 38 pass / 0 fail)_ |

## Created modules

Control:
- `control/src/permission-order.mjs`
- `control/src/security-context.mjs`
- `control/src/recovery.mjs`
- `control/src/admin-policy.mjs`

Contracts:
- `contracts/src/hooks.mjs`
- `contracts/src/connection.mjs`
- `contracts/src/server-auth.mjs`

## Tests

- `tests/smoke.test.mjs`
- `tests/contracts.conformance.test.mjs`
- `tests/permission-order.test.mjs`
- `tests/security-context.test.mjs`
- `tests/recovery.test.mjs`
- `tests/admin-policy.test.mjs`

## Environment-limited baseline items

- `hwp-read` tests require the external `rhwp` binary (not installed here).
- `usage-panel` tests require `@opentui/solid/preload` (bun-only; needs node_modules symlink to the built opencode tree).

## Status

- Phase 0a contracts: COMPLETE.
- Phase 0b documentation artifacts: IN PROGRESS.
