import { describe, expect, test } from "bun:test"
import type { PromptInfo } from "../../../../src/cli/cmd/tui/component/prompt/history"
import { assign, expandPlaceholderRanges, strip } from "../../../../src/cli/cmd/tui/component/prompt/part"

describe("prompt part", () => {
  test("strip removes persisted ids from reused file parts", () => {
    const part = {
      id: "prt_old",
      sessionID: "ses_old",
      messageID: "msg_old",
      type: "file" as const,
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    }

    expect(strip(part)).toEqual({
      type: "file",
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    })
  })

  test("assign overwrites stale runtime ids", () => {
    const part = {
      id: "prt_old",
      sessionID: "ses_old",
      messageID: "msg_old",
      type: "file" as const,
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    } as PromptInfo["parts"][number]

    const next = assign(part)

    expect(next.id).not.toBe("prt_old")
    expect(next.id.startsWith("prt_")).toBe(true)
    expect(next).toMatchObject({
      type: "file",
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    })
  })
})

describe("expandPlaceholderRanges", () => {
  // Ranges count display width: each Hangul syllable is two columns wide.
  const width = (text: string) => Bun.stringWidth(text)

  test("keeps text typed after a placeholder with a Korean label", () => {
    const label = "[File: 연차보고서.hwp]"
    const input = `${label} 문서 내용을 분석해라`
    const expanded = expandPlaceholderRanges(input, [{ start: 0, end: width(label), text: '"/mnt/c/연차보고서.hwp"' }])
    expect(expanded).toBe('"/mnt/c/연차보고서.hwp" 문서 내용을 분석해라')
  })

  test("handles Korean text before a placeholder and several placeholders", () => {
    const a = "[File: 가.docx]"
    const b = "[Pasted ~3 lines]"
    const prefix = "분석: "
    const input = `${prefix}${a} 그리고 ${b} 끝`
    const aStart = width(prefix)
    const bStart = width(`${prefix}${a} 그리고 `)
    const expanded = expandPlaceholderRanges(input, [
      { start: aStart, end: aStart + width(a), text: "/a.docx" },
      { start: bStart, end: bStart + width(b), text: "x\ny\nz" },
    ])
    expect(expanded).toBe("분석: /a.docx 그리고 x\ny\nz 끝")
  })

  test("leaves input unchanged without ranges", () => {
    expect(expandPlaceholderRanges("그대로", [])).toBe("그대로")
  })
})
