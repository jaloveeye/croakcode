# Baseline Test Inventory (Phase 0a)

Reference repo: `/Users/herace/workspace/ideas/codefrog-opencode`
Plugin/invariant test files: 12

## Plugin & invariant tests (run with node --test / bun test)

- `plugins/croak-auth/session.test.mjs`
- `plugins/gate-identity.test.mjs`
- `plugins/hwp-read.test.mjs`
- `plugins/secret-paths.test.mjs`
- `plugins/stall-recovery.test.mjs`
- `plugins/tool-policy.test.mjs`
- `plugins/usage-meter.test.mjs`
- `plugins/usage-panel/controller.test.ts`
- `plugins/usage-panel/elapsed.test.ts`
- `plugins/usage-panel/guard.test.ts`
- `plugins/usage-panel/notice.test.ts`
- `plugins/usage-panel/usage-panel.test.ts`

## Patch-added tests (per patch file)

- `0001-herace-base-TUI-customizations-permission-mode-auto-.patch`: `packages/opencode/test/cli/cmd/tui/permission-mode.test.tsx`, `packages/opencode/test/cli/permission-mode.test.ts`, `packages/opencode/test/cli/run/footer.view.test.tsx`, `packages/opencode/test/cli/tui/auto-follow.test.ts`, `packages/opencode/test/cli/tui/keymap.test.tsx`, `packages/opencode/test/config/tui.test.ts`
- `0002-Clarify-queued-prompts-as-steering.patch`: `packages/opencode/test/session/prompt.test.ts`
- `0003-feat-tui-add-session-resume-command.patch`: `packages/opencode/test/cli/help/help-snapshots.test.ts`, `packages/opencode/test/cli/resume.test.ts`
- `0004-fix-provider-distinguish-SSE-timeouts-before-and-aft.patch`: `packages/opencode/test/provider/stream-timeout.test.ts`
- `0005-feat-tui-accept-Windows-file-drops-in-WSL.patch`: `packages/opencode/test/cli/cmd/tui/dropped-path.test.ts`, `packages/opencode/test/cli/cmd/tui/prompt-part.test.ts`
- `0006-feat-tui-add-session_message_footer-plugin-slot.patch`: (adds NO tests — must be covered by a new Phase 2/3 test)
- `0007-feat-tui-expose-the-permission-approval-mode-to-plug.patch`: (adds NO tests — must be covered by a new Phase 2/3 test)
- `0008-fix-tui-truncate-dialog-titles-by-display-width.patch`: `packages/opencode/test/util/locale.test.ts`

## Baseline run status (captured 2026-11-07)

Environment: Node v22.14.0, Bun 1.3.14, `rhwp` NOT installed.

### plugins/*.test.mjs
```
1..28
# tests 28
# pass 27
# fail 1
```
Failure: `hwp-read.test.mjs` "hwpCli asks before writing and never runs blocked commands"
— depends on the external `rhwp` binary, which is not installed in this environment
(`rhwp edit --help` => exit 1). Environment-dependent, not a code defect.

### croak-auth/session.test.mjs
```
1..9
# tests 9
# pass 9
# fail 0
```

### usage-panel
```
bun test v1.3.14
error: preload not found "@opentui/solid/preload"
```
NOT RUN: needs `node_modules` symlinked to the built opencode tree
(`opencode/work/packages/opencode/node_modules`) to resolve `@opentui/solid/preload`.
