import { describe, expect, test } from "bun:test"
import { formatSessionList, resolveResumeArgs } from "../../src/cli/cmd/resume"

describe("resume command", () => {
  test("opens the session selector by default", () => {
    expect(resolveResumeArgs({})).toMatchObject({
      continue: false,
      selectSession: true,
    })
  })

  test("resumes the latest session with --last", () => {
    expect(resolveResumeArgs({ last: true })).toMatchObject({
      continue: true,
      selectSession: false,
    })
  })

  test("resumes an explicit session without opening the selector", () => {
    expect(resolveResumeArgs({ session: "ses_example" })).toMatchObject({
      continue: false,
      selectSession: false,
      session: "ses_example",
    })
  })
})

describe("resume --list", () => {
  const at = new Date(2026, 10, 11, 8, 10).getTime()
  const session = (id: string, title: string) => ({ id, title, time: { created: at, updated: at } })

  test("prints one line per session with the title last, and how to resume", () => {
    const lines = formatSessionList([session("ses_a", "한글 제목"), session("ses_b", "second")]).split("\n")
    expect(lines[0]).toMatch(/^ID\s+마지막 사용\s+제목$/)
    expect(lines[1]).toMatch(/^ses_a\s+.+\s+한글 제목$/)
    expect(lines[2]).toMatch(/^ses_b\s+.+\s+second$/)
    expect(lines.at(-1)).toContain("croakcode resume -s <ID>")
  })

  test("says so when the folder has no sessions", () => {
    expect(formatSessionList([])).toBe("이 폴더에는 세션이 없습니다.")
  })
})
