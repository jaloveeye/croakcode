// Short notices for the avatar speech bubble when something was blocked:
// by the secret-paths or tool-policy plugins (a tool error), or by the Croak
// gate (a session error whose message starts with "[croak]").
//
// A notice shows until the first of: NOTICE_MS passes, the user sends a new
// prompt, or the avatar is clicked.

export const NOTICE_MS = 20_000

export type Notice = { text: string; at: number; until: number }

/** Rules in order; the first match wins. */
const RULES: [RegExp, string][] = [
  [/키, 인증서, 비밀 파일/, "🔒 키·비밀 파일 접근을 막았습니다"],
  [/disabled by the croak tool policy|tool policy file is unreadable/i, "⛔ 도구 정책으로 막았습니다"],
  [/다른 계정이 시작한 세션/, "⛔ 다른 계정의 세션입니다 · 새 세션을 여세요"],
  [/에이전트를 쓸 수 없다/, "⛔ 이 등급에서 쓸 수 없는 에이전트입니다"],
  [/이 도구를 쓸 수 없다/, "⛔ 등급에서 금지한 도구가 있습니다"],
  [/비밀정보/, "🔒 비밀정보가 있어 요청을 막았습니다"],
  [/개인정보/, "🛡 개인정보 때문에 요청을 막았습니다"],
  [/검사하지 못해/, "⚠ 게이트가 요청을 검사하지 못했습니다"],
  [/\b401\b|Authentication Error|invalid.*key|login-required/i, "🔑 로그인이 필요합니다 · /login"],
]

/** Bubble text for an error message, or null when it is not a block. */
export function noticeText(message: unknown): string | null {
  const text = typeof message === "string" ? message : JSON.stringify(message ?? "")
  if (!text) return null
  const blocked = text.includes("[croak") || /croak tool policy|Authentication Error|\b401\b/i.test(text)
  if (!blocked) return null
  for (const [re, label] of RULES) if (re.test(text)) return label
  return "⛔ Croak가 요청을 막았습니다"
}

export function makeNotice(message: unknown, now: number): Notice | null {
  const text = noticeText(message)
  return text ? { text, at: now, until: now + NOTICE_MS } : null
}

/** The notice still showing at `now`, given the newest user prompt time. */
export function activeNotice(notice: Notice | undefined, now: number, lastPromptAt: number): Notice | undefined {
  if (!notice) return undefined
  if (now >= notice.until) return undefined
  if (lastPromptAt > notice.at) return undefined
  return notice
}
