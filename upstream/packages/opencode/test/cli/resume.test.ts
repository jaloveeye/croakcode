import { describe, expect, test } from "bun:test"
import { resolveResumeArgs } from "../../src/cli/cmd/resume"

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
