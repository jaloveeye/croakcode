import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  globalDenied,
  isDenied,
  matches,
  normalizePolicy,
  readPolicy,
  sessionDenied,
  toggleSessionTool,
  writePolicy,
} from "./policy"

let root = ""
let file = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "croak-policy-"))
  file = join(root, "tool-policy.json")
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("policy", () => {
  test("normalize keeps strings, trims, dedupes and drops empty sessions", () => {
    const policy = normalizePolicy({
      deny: [" read ", "read", 3, ""],
      sessions: { s1: ["write", "write"], s2: [], s3: "not-a-list" },
    })
    expect(policy).toEqual({ deny: ["read"], sessions: { s1: ["write"] } })
    expect(normalizePolicy(null)).toEqual({ deny: [], sessions: {} })
  })

  test("patterns support exact, wildcard and prefix", () => {
    expect(matches("*", "bash")).toBe(true)
    expect(matches("rhwp_*", "rhwp_read")).toBe(true)
    expect(matches("rhwp_*", "rhwp")).toBe(false)
    expect(matches("bash", "bash")).toBe(true)
    expect(matches("bash", "grep")).toBe(false)
  })

  test("deny merges global, sessions[*] and the session's own rules", () => {
    const policy = normalizePolicy({
      deny: ["webfetch"],
      sessions: { "*": ["websearch"], s1: ["bash"] },
    })
    expect(isDenied(policy, "s1", "webfetch")).toBe(true)
    expect(isDenied(policy, "s1", "websearch")).toBe(true)
    expect(isDenied(policy, "s1", "bash")).toBe(true)
    expect(isDenied(policy, "s2", "bash")).toBe(false)
    expect(globalDenied(policy, "bash")).toBe(false)
    expect(globalDenied(policy, "websearch")).toBe(true)
    expect(sessionDenied(policy, "s1", "bash")).toBe(true)
    expect(sessionDenied(policy, "s2", "bash")).toBe(false)
  })

  test("missing and malformed files mean no restrictions", () => {
    expect(readPolicy(file)).toEqual({ deny: [], sessions: {} })
    writeFileSync(file, "{not json")
    expect(readPolicy(file)).toEqual({ deny: [], sessions: {} })
  })

  test("writePolicy strips unknown fields and round-trips", () => {
    writePolicy({ deny: [" read "], sessions: { s1: ["write"] } }, file)
    expect(readPolicy(file)).toEqual({ deny: ["read"], sessions: { s1: ["write"] } })
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    expect(typeof raw.updatedAt).toBe("string")
  })

  test("toggleSessionTool turns one tool off and on without touching other sessions", () => {
    writePolicy({ deny: [], sessions: { s2: ["grep"] } }, file)

    const off = toggleSessionTool("s1", "read", file)
    expect(off.denied).toBe(true)
    expect(off.policy.sessions).toEqual({ s2: ["grep"], s1: ["read"] })

    const on = toggleSessionTool("s1", "read", file)
    expect(on.denied).toBe(false)
    expect(on.policy.sessions).toEqual({ s2: ["grep"] })
  })
})
