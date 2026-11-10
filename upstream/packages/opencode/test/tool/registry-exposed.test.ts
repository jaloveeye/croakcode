import { describe, expect, test } from "bun:test"
import { exposed } from "@/tool/registry"

const rule = (permission: string, pattern: string, action: "allow" | "deny" | "ask") => ({ permission, pattern, action })

describe("tool exposure", () => {
  test("follows the * decision", () => {
    expect(exposed("bash", [rule("bash", "*", "allow")])).toBe(true)
    expect(exposed("bash", [rule("bash", "*", "ask")])).toBe(true)
    expect(exposed("bash", [rule("bash", "*", "deny")])).toBe(false)
  })

  test("exposes a tool when a specific pattern is allowed after a * deny", () => {
    // skill {"*": "deny", "pdf": "allow"}: the pdf skill is listed, so the skill tool must exist.
    expect(exposed("skill", [rule("skill", "*", "deny"), rule("skill", "pdf", "allow")])).toBe(true)
    expect(exposed("task", [rule("task", "*", "deny"), rule("task", "explore", "ask")])).toBe(true)
  })

  test("stays hidden when every rule after the last * deny also denies", () => {
    expect(exposed("skill", [rule("skill", "pdf", "allow"), rule("skill", "*", "deny")])).toBe(false)
    expect(exposed("skill", [rule("skill", "*", "deny"), rule("skill", "pdf", "deny")])).toBe(false)
  })

  test("rules for other tools do not count", () => {
    expect(exposed("skill", [rule("skill", "*", "deny"), rule("bash", "ls", "allow")])).toBe(false)
  })
})
