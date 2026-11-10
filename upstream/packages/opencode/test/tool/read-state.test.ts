import { describe, expect, test } from "bun:test"
import { mkdtempSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { ReadState } from "@/tool/read-state"
import type { MessageV2 } from "@/session/message-v2"

const dir = mkdtempSync(path.join(tmpdir(), "read-state-"))
const file = (name: string, content: string) => {
  const target = path.join(dir, name)
  writeFileSync(target, content)
  return target
}
let n = 0
const session = () => `ses_read_state_${++n}`

/** A stored session whose history holds one completed tool result with this stamp. */
const history = (stamp: ReadState.Stamp): MessageV2.WithParts[] =>
  [
    {
      info: { role: "assistant" },
      parts: [{ type: "tool", tool: "read", state: { status: "completed", metadata: { [ReadState.METADATA_KEY]: stamp } } }],
    },
  ] as unknown as MessageV2.WithParts[]

describe("ReadState", () => {
  test("a file that does not exist yet may be written", () => {
    expect(ReadState.check(session(), path.join(dir, "new.txt"), [])).toBe("ok")
  })

  test("an existing file that was never read is refused", () => {
    expect(ReadState.check(session(), file("a.txt", "a"), [])).toBe("unread")
  })

  test("after a read the file may be changed, until it changes underneath", () => {
    const id = session()
    const target = file("b.txt", "b")
    ReadState.remember(id, target)
    expect(ReadState.check(id, target, [])).toBe("ok")
    writeFileSync(target, "changed by someone else")
    expect(ReadState.check(id, target, [])).toBe("changed")
  })

  test("a later write by the session itself is remembered", () => {
    const id = session()
    const target = file("c.txt", "c")
    ReadState.remember(id, target)
    writeFileSync(target, "edited")
    ReadState.remember(id, target)
    expect(ReadState.check(id, target, [])).toBe("ok")
  })

  test("another session's read does not count", () => {
    const target = file("d.txt", "d")
    ReadState.remember(session(), target)
    expect(ReadState.check(session(), target, [])).toBe("unread")
  })

  test("after a restart the stamp comes from the stored tool results", () => {
    const target = file("e.txt", "e")
    const stamp = ReadState.current(target)!
    expect(ReadState.check(session(), target, history(stamp))).toBe("ok")
    const time = new Date(Date.now() + 5000)
    utimesSync(target, time, time)
    expect(ReadState.check(session(), target, history(stamp))).toBe("changed")
  })

  test("the refusal tells the model what to do", () => {
    expect(ReadState.refusal("unread", "/x/a.ts")).toContain("Read it with the read tool")
    expect(ReadState.refusal("changed", "/x/a.ts")).toContain("has changed since you last read it")
  })
})

describe("ReadState.unchangedRead", () => {
  const readPart = (target: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}, compacted?: number) => ({
    type: "tool",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: target, ...input },
      metadata: { [ReadState.METADATA_KEY]: ReadState.current(target), ...extra },
      time: { start: 1_700_000_000_000, end: 1_700_000_000_100, ...(compacted ? { compacted } : {}) },
    },
  })
  const messages = (...parts: unknown[]) => [{ info: { role: "assistant" }, parts }] as unknown as MessageV2.WithParts[]

  test("a visible earlier read of the same range of an unchanged file counts", () => {
    const target = file("f.txt", "f")
    expect(ReadState.unchangedRead(messages(readPart(target, {})), target, {}, 0)).toBe(1_700_000_000_000)
  })

  test("a different range, a change or a pruned output means reading again", () => {
    const target = file("g.txt", "g")
    expect(ReadState.unchangedRead(messages(readPart(target, { offset: 10 })), target, {}, 0)).toBeUndefined()
    expect(ReadState.unchangedRead(messages(readPart(target, {}, {}, Date.now())), target, {}, 0)).toBeUndefined()
    const earlier = messages(readPart(target, {}))
    writeFileSync(target, "g changed")
    expect(ReadState.unchangedRead(earlier, target, {}, 0)).toBeUndefined()
  })

  test("a small file is always read again", () => {
    const target = file("small.txt", "tiny")
    expect(ReadState.unchangedRead(messages(readPart(target, {})), target, {})).toBeUndefined()
  })

  test("a notice is skipped; the read that returned the content decides", () => {
    const target = file("h.txt", "h")
    const notice = readPart(target, {}, { unchanged: true })
    expect(ReadState.unchangedRead(messages(notice), target, {}, 0)).toBeUndefined()
    expect(ReadState.unchangedRead(messages(readPart(target, {}, {}, Date.now()), notice), target, {}, 0)).toBeUndefined()
    expect(ReadState.unchangedRead(messages(readPart(target, {}), notice), target, {}, 0)).toBe(1_700_000_000_000)
  })
})
