import { describe, expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

describe("Locale.truncateWidth", () => {
  test("counts display cells for CJK text", () => {
    expect(Locale.truncateWidth("전체 35.123s", 6)).toBe("전체 …")
  })

  test("keeps strings that fit", () => {
    expect(Locale.truncateWidth("abc", 3)).toBe("abc")
  })

  test("never splits a wide character", () => {
    expect(Locale.truncateWidth("전체", 3)).toBe("전…")
  })

  test("handles a zero budget", () => {
    expect(Locale.truncateWidth("abc", 0)).toBe("")
    expect(Locale.truncateWidth("abc", 1)).toBe("…")
  })
})
