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
