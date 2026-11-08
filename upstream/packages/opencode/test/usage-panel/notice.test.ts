import { expect, test } from "bun:test"
import { activeNotice, makeNotice, noticeText, NOTICE_MS } from "../../../../.croakcode/plugins/usage-panel/notice.ts"

test("plugin and gate blocks become short notices", () => {
  expect(noticeText("[croak] '~/.ssh/id_rsa'은(는) 키, 인증서, 비밀 파일이라 읽을 수 없다 (규칙 .ssh).")).toBe(
    "🔒 키·비밀 파일 접근을 막았습니다",
  )
  expect(noticeText('Tool "webfetch" is disabled by the croak tool policy.')).toBe("⛔ 도구 정책으로 막았습니다")
  expect(noticeText({ data: { message: "[croak] 비밀정보가 들어 있어 요청을 보내지 않았다." } })).toBe(
    "🔒 비밀정보가 있어 요청을 막았습니다",
  )
  expect(noticeText("[croak] restricted 등급은 'build' 에이전트를 쓸 수 없다.")).toBe("⛔ 이 등급에서 쓸 수 없는 에이전트입니다")
  expect(noticeText("[croak] 이 대화는 다른 계정이 시작한 세션이다.")).toBe("⛔ 다른 계정의 세션입니다 · 새 세션을 여세요")
  expect(noticeText("[croak] 이 등급은 개인정보가 보이는 이미지나 문서를 쓸 수 없다.")).toBe("🛡 개인정보 때문에 요청을 막았습니다")
  expect(noticeText("Authentication Error, LiteLLM Virtual Key expected")).toBe("🔑 로그인이 필요합니다 · /login")
  expect(noticeText("[croak] 새로운 거부 사유")).toBe("⛔ Croak가 요청을 막았습니다")
})

test("ordinary errors are not notices", () => {
  expect(noticeText("ENOENT: no such file or directory")).toBeNull()
  expect(noticeText("비밀정보 관련 일반 오류")).toBeNull()
  expect(noticeText("")).toBeNull()
  expect(noticeText(undefined)).toBeNull()
})

test("a notice ends after 20s, on a new prompt, or when cleared", () => {
  const n = makeNotice("[croak] 비밀정보", 1_000)!
  expect(activeNotice(n, 1_000 + NOTICE_MS - 1, 0)).toBe(n)
  expect(activeNotice(n, 1_000 + NOTICE_MS, 0)).toBeUndefined()
  expect(activeNotice(n, 5_000, 900)).toBe(n) // the prompt that caused it
  expect(activeNotice(n, 5_000, 2_000)).toBeUndefined() // a newer prompt
  expect(activeNotice(undefined, 5_000, 0)).toBeUndefined()
})
