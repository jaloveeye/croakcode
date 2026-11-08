/**
 * TUI 표면 계약 — patch 0006/0007 승격. Spec §3.4, §8.3.
 * upstream plugin/src/tui.ts 의 타입을 croakcode 계약으로 고정한다.
 * Phase 2: 계약 확정만. 슬롯 콘텐츠는 Phase 3.
 */
export const TUI_HOST_SLOTS = Object.freeze([
  "app",
  "app_bottom",
  "home_logo",
  "home_prompt",
  "home_prompt_right",
  "home_bottom",
  "home_footer",
  "session_prompt",
  "session_prompt_right",
  "session_message_footer",
  "sidebar_title",
  "sidebar_content",
  "sidebar_footer",
]);

export const SESSION_MESSAGE_FOOTER_PROPS = Object.freeze(["session_id", "message_id"]);

export const TUI_PERMISSION_MODES = Object.freeze(["ask", "auto"]);

export const TUI_PERMISSION_API = Object.freeze({
  readOnly: true,
  accessor: "mode",
  note: "patch 0007: plugins read the current permission mode; no setter is exposed.",
});
