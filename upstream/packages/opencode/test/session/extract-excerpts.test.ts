import { describe, expect, test } from "bun:test"
import { excerptsFor } from "../../src/session/tools"

describe("webfetch extraction excerpts", () => {
  const filler = (n: number) => "Lorem ipsum dolor sit amet. ".repeat(n)

  test("a page within the limit goes whole", () => {
    expect(excerptsFor("short page", "anything", 100, 10)).toBe("short page")
  })

  test("a long page sends the head and the blocks with the question's words", () => {
    const page = "TITLE RFC " + filler(40) + "15.4.5. 304 Not Modified: the server sends 304 when..." + filler(200)
    const sent = excerptsFor(page, "304 Not Modified 설명을 알려줘", 3_000, 1_000)
    expect(sent.startsWith("TITLE RFC")).toBe(true)
    expect(sent).toContain("304 Not Modified: the server sends 304")
    expect(sent.length).toBeLessThanOrEqual(3_000 + 40)
  })

  test("with no matching words the head is sent", () => {
    const page = "HEAD " + filler(500)
    expect(excerptsFor(page, "전혀 없는 낱말", 1_000, 100)).toBe(page.slice(0, 1_000))
  })
})
