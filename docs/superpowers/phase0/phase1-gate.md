# Phase 1 Decision Gate — Upstream Walking Skeleton

Spec: `docs/superpowers/specs/2026-11-07-croakcode-agent-core-design.md` §8.2
Plan: `docs/superpowers/plans/2026-11-07-phase1-upstream-skeleton.md`

- [x] upstream v1.15.12 absorbed as new history + 8 fork patches — verified: `upstream/packages/opencode/src/cli/permission-mode.ts`, `test/provider/stream-timeout.test.ts`, `test/cli/resume.test.ts` all exist (patches applied to tag tree, not the patched work HEAD)
- [x] rebrand applied (core packages) — verified: `node scripts/rebrand-check.mjs upstream` = `PASS`, 0 hits in `packages/{opencode,core,ui,sdk,plugin,script}`; injected-branding negative test exits 1
- [x] bin `cc`, env `CROAKCODE_*`, config `croakcode.json/jsonc`, dir `.croakcode`, db `croakcode.db`, NOTICE attribution — verified: CLI help shows `cc` and contains zero `opencode` tokens
- [x] typecheck clean — verified: `bun run typecheck` (19/19 projects) and `bun run fix-node-pty` in `upstream/packages/opencode`
- [x] CLI help/version — verified: `bash scripts/phase1-cli-check.sh` = `PASS: cli help+version ok`
- [x] headless server + session creation — verified: `bash scripts/phase1-headless-check.sh` = `PASS: headless server up + session created` (isolated HOME, `CROAKCODE_DB=croakcode.db`, `/global/health`, `POST /session`)
- [x] session row persisted — verified: `node --test tests/phase1-session.e2e.test.mjs` = 1 pass (row exists in `session` table)
- [x] sqlite path + file-persistent pragma — verified: `node --test tests/phase1-sqlite.e2e.test.mjs` = 2 pass (`journal_mode=wal` on disk; `busy_timeout`/`foreign_keys`/`journal_mode` confirmed in `storage/db.ts` source)
- [x] §4.5 unknown recovery contract — verified: `node --test tests/phase1-recovery.e2e.test.mjs` = 3 pass (pure functions; DB-level mapping deferred to Phase 2 because upstream `part` stores ToolState in `data` JSON with no `run_state` column)
- [x] Phase 1 hook stubs (interface only, no-op) — verified: `node --test tests/contracts.conformance.test.mjs` = 5 pass
- [x] full regression — verified: `node --test 'tests/*.test.mjs'` = 45 pass / 0 fail; `bun test tests` = 45 pass / 0 fail

## Known deferrals (Phase 2, not Phase 1 gate)

- Physical removal of the zen/console provider (`packages/core/src/plugin/provider/opencode.ts`, provider id `"opencode"`, `packages/opencode/src/provider/transform.ts` `opencode-go` handling) — Phase 1 only deactivates exposure.
- Internal workspace package names `packages/opencode` and `packages/core` keep `"name": "opencode"` because other packages depend on them via `workspace:*`.
- Rebrand hits outside the distributable core (`packages/{app,web,console,desktop,enterprise,stats,docs,slack}`, `github/`, `infra/`, root `.opencode/` fixtures): 158 hits, reported as `DEFERRED` by rebrand-check.
- Comment-only `opencode` mentions and functional identifiers (`opencodeProvider`, `opencodeTheme`, DOM ids, provider ids) are intentionally untouched.
- Upstream `test/cli/help/__snapshots__/help-snapshots.test.ts.snap` is stale after the `cc` rebrand; regenerating it and running the full upstream suite is a Phase 2 task, not a Phase 1 gate.

## Notes

- `node --test` with no argument walks into `upstream/node_modules/.bun/**` (1908 test files) and never finishes; the root `test` script is scoped to `tests/*.test.mjs` for this reason.
- Session/sqlite e2e tests depend on a prior `scripts/phase1-headless-check.sh` run; the script kills the server and truncates the WAL before exiting so the tests read a settled database.

## Gate result

All Phase 1 items are checked with real execution evidence. Phase 2 work (zen/console physical removal, real hook adapters, DB-level §4.5 mapping) is unblocked.
