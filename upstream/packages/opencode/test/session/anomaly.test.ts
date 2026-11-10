import { describe, expect, test } from "bun:test"
import { Anomaly } from "../../src/session/anomaly"
import type { MessageV2 } from "../../src/session/message-v2"

const text = (value: string, synthetic = false) => ({ type: "text", text: value, synthetic }) as unknown as MessageV2.Part
const reasoning = (value: string) => ({ type: "reasoning", text: value }) as unknown as MessageV2.Part
const tool = () => ({ type: "tool", tool: "read" }) as unknown as MessageV2.Part

describe("Anomaly.isEmptyAnswer", () => {
  test("an answer with no text and no tool call is empty", () => {
    expect(Anomaly.isEmptyAnswer("stop", false, [])).toBe(true)
    expect(Anomaly.isEmptyAnswer("stop", false, [text("   \n")])).toBe(true)
    // Thinking without an answer still leaves the user with nothing.
    expect(Anomaly.isEmptyAnswer("stop", false, [reasoning("let me think")])).toBe(true)
    expect(Anomaly.isEmptyAnswer("unknown", false, [text("note", true)])).toBe(true)
  })

  test("text or a tool call is an answer", () => {
    expect(Anomaly.isEmptyAnswer("stop", false, [text("Hello")])).toBe(false)
    expect(Anomaly.isEmptyAnswer("stop", false, [tool()])).toBe(false)
  })

  test("length, content filter, tool calls and errors are not retried", () => {
    expect(Anomaly.isEmptyAnswer("length", false, [])).toBe(false)
    expect(Anomaly.isEmptyAnswer("content-filter", false, [])).toBe(false)
    expect(Anomaly.isEmptyAnswer("tool-calls", false, [])).toBe(false)
    expect(Anomaly.isEmptyAnswer("stop", true, [])).toBe(false)
    expect(Anomaly.isEmptyAnswer(undefined, false, [])).toBe(false)
  })
})

describe("Anomaly.unwrapStringifiedArgs", () => {
  test("turns an object sent as a JSON string back into the object", () => {
    expect(Anomaly.unwrapStringifiedArgs(JSON.stringify({ filePath: "a.ts", limit: 5 }))).toEqual({ filePath: "a.ts", limit: 5 })
  })

  test("leaves every other shape for the schema to judge", () => {
    const object = { filePath: "a.ts" }
    expect(Anomaly.unwrapStringifiedArgs(object)).toBe(object)
    expect(Anomaly.unwrapStringifiedArgs("plain text")).toBe("plain text")
    expect(Anomaly.unwrapStringifiedArgs("[1,2]")).toBe("[1,2]")
    expect(Anomaly.unwrapStringifiedArgs('"quoted"')).toBe('"quoted"')
  })
})
