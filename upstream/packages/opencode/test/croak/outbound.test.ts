import { describe, expect, test } from "bun:test"
import { croakGate, GATE_PROVIDER } from "../../src/provider/croak-gate"
import { outsideGateCommand } from "../../src/cli/croak/outbound"
import { webSearchEnabled } from "../../src/tool/registry"
import { ProviderID } from "../../src/provider/schema"

describe("croak gate mode", () => {
  test("is off without CROAK_AUTH_URL", () => {
    expect(croakGate({})).toBeUndefined()
    expect(croakGate({ CROAK_AUTH_URL: "  " })).toBeUndefined()
  })

  test("pins the gate provider to the launcher's address", () => {
    expect(croakGate({ CROAK_AUTH_URL: "https://gate.example.test:8443/" })).toEqual({
      provider: GATE_PROVIDER,
      npm: "@ai-sdk/openai-compatible",
      baseURL: "https://gate.example.test:8443/v1",
    })
  })
})

describe("commands that leave the gate", () => {
  test("are recognised", () => {
    expect(outsideGateCommand(["console", "login"])).toBe("console")
    expect(outsideGateCommand(["github", "install"])).toBe("github")
    expect(outsideGateCommand(["providers", "login"])).toBe("providers login")
    expect(outsideGateCommand(["auth", "login", "https://x.example.test"])).toBe("auth login")
  })

  test("others pass", () => {
    expect(outsideGateCommand([])).toBeUndefined()
    expect(outsideGateCommand(["run", "github"])).toBeUndefined()
    expect(outsideGateCommand(["providers", "list"])).toBeUndefined()
    expect(outsideGateCommand(["auth", "logout"])).toBeUndefined()
  })
})

describe("web search", () => {
  test("stays off behind the gate even when a flag enables it", () => {
    const before = process.env.CROAK_AUTH_URL
    process.env.CROAK_AUTH_URL = "https://gate.example.test:8443"
    try {
      expect(webSearchEnabled(ProviderID.make(GATE_PROVIDER), { exa: true, parallel: true })).toBe(false)
    } finally {
      if (before === undefined) delete process.env.CROAK_AUTH_URL
      else process.env.CROAK_AUTH_URL = before
    }
    expect(webSearchEnabled(ProviderID.make(GATE_PROVIDER), { exa: true, parallel: false })).toBe(true)
  })
})

describe("execution permit bookkeeping", () => {
  const { Permit } = require("../../src/delegation/permit")

  test("a permit is remembered per session, not per call id alone", () => {
    Permit.markPermitted("ses_a", "call_1")
    expect(Permit.wasPermitted("ses_a", "call_1")).toBe(true)
    // A fork copies the call id into another session.
    expect(Permit.wasPermitted("ses_b", "call_1")).toBe(false)
  })

  test("a tool_call proxy call is permitted as the tool it called, like the gate reads it", () => {
    expect(Permit.permitTarget("read", { filePath: "/a" })).toEqual({ tool: "read", args: { filePath: "/a" } })
    expect(Permit.permitTarget("tool_call", { name: "todowrite", input: { todos: [] } })).toEqual({
      tool: "todowrite",
      args: { todos: [] },
    })
    // Not the proxy's shape: left as it is.
    expect(Permit.permitTarget("tool_call", { name: "x" })).toEqual({ tool: "tool_call", args: { name: "x" } })
  })
})
