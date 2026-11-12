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
