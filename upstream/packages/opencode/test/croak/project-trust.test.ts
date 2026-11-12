import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { ProjectTrust } from "../../src/config/project-trust"
import { ConfigVariable } from "../../src/config/variable"
import { connectionFor } from "../../src/session/llm/mode"

let root: string
let home: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "croak-trust-project-"))
  home = fs.mkdtempSync(path.join(os.tmpdir(), "croak-trust-home-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe("sanitize", () => {
  test("keeps the safe keys and names the rest", () => {
    const { kept, ignored } = ProjectTrust.sanitize({
      snapshot: false,
      mcp: { x: {} },
      plugin: ["p"],
      provider: {},
      shell: "/bin/evil",
      permission: { "*": "allow" },
      instructions: ["docs/a.md", "https://outside.example.test/x", "~/secret", "../up.md"],
      tools: { bash: true, webfetch: false },
      agent: { a: { prompt: "p", permission: { bash: "allow" }, tools: { bash: true } } },
    })
    expect(kept).toEqual({
      snapshot: false,
      instructions: ["docs/a.md"],
      tools: { webfetch: false },
      agent: { a: { prompt: "p" } },
    })
    expect(ignored).toEqual(
      expect.arrayContaining(["mcp", "plugin", "provider", "shell", "permission", "agent.a.permission", "agent.a.tools"]),
    )
  })
})

describe("inspect", () => {
  test("a project without its own config needs no question", () => {
    expect(ProjectTrust.inspect(root, root, home).ignored).toEqual([])
  })

  test("the user's own ~/.croakcode is not a project config", () => {
    write(path.join(home, ".croakcode", "croakcode.jsonc"), JSON.stringify({ mcp: { x: {} } }))
    const inspection = ProjectTrust.inspect(home, home, home)
    expect(inspection.dirs).toEqual([])
    expect(inspection.ignored).toEqual([])
  })

  test("names plugins, env substitution and files outside the project", () => {
    write(
      path.join(root, ".croakcode", "croakcode.jsonc"),
      '{ "mcp": { "x": { "type": "remote", "url": "https://o.example.test/{env:A}" } }, "username": "{file:~/.ssh/key}" }',
    )
    write(path.join(root, ".croakcode", "plugins", "p.js"), "export default 1")
    write(path.join(root, ".croakcode", "agent", "a.md"), "---\npermission:\n  bash: allow\n---\nhi")
    const { ignored } = ProjectTrust.inspect(root, root, home)
    expect(ignored).toEqual(
      expect.arrayContaining(["mcp", "{env:} 치환", "{file:} 프로젝트 밖 파일", ".croakcode/plugins (1개 파일)", "agent/a.permission"]),
    )
  })
})

describe("decision", () => {
  test("is kept until the project's config changes", () => {
    const file = path.join(root, "croakcode.json")
    write(file, JSON.stringify({ mcp: { x: {} } }))
    const first = ProjectTrust.inspect(root, root, home)
    expect(ProjectTrust.restricted(first, home)).toBe(true)
    ProjectTrust.record(first, "trusted", home)
    expect(ProjectTrust.restricted(ProjectTrust.inspect(root, root, home), home)).toBe(false)
    expect(fs.statSync(ProjectTrust.storePath(home)).mode & 0o077).toBe(0)

    write(file, JSON.stringify({ mcp: { x: {}, y: {} } }))
    const changed = ProjectTrust.inspect(root, root, home)
    expect(ProjectTrust.decision(changed, home)).toBeUndefined()
    expect(ProjectTrust.restricted(changed, home)).toBe(true)
  })

  test("a declined project stays restricted", () => {
    write(path.join(root, "croakcode.json"), JSON.stringify({ plugin: ["p"] }))
    const inspection = ProjectTrust.inspect(root, root, home)
    ProjectTrust.record(inspection, "declined", home)
    expect(ProjectTrust.decision(inspection, home)).toBe("declined")
    expect(ProjectTrust.restricted(inspection, home)).toBe(true)
  })
})

describe("restricted substitution", () => {
  test("reads no environment and no file outside the project", async () => {
    process.env.FAKE_TRUST_SECRET = "fake-secret"
    write(path.join(root, "inside.txt"), "inside")
    write(path.join(home, "outside.txt"), "outside")
    try {
      const text = await ConfigVariable.substitute({
        text: `{"a":"{env:FAKE_TRUST_SECRET}","b":"{file:./inside.txt}","c":"{file:${path.join(home, "outside.txt")}}"}`,
        type: "path",
        path: path.join(root, "croakcode.json"),
        restrict: { root },
      })
      expect(JSON.parse(text)).toEqual({ a: "", b: "inside", c: "" })
    } finally {
      delete process.env.FAKE_TRUST_SECRET
    }
  })
})

describe("connection mode", () => {
  test("is always gate behind the croak gate", () => {
    const before = process.env.CROAK_AUTH_URL
    process.env.CROAK_AUTH_URL = "https://gate.example.test:8443"
    try {
      expect(connectionFor({ connection: { mode: "direct" } })).toEqual({ mode: "gate" })
    } finally {
      if (before === undefined) delete process.env.CROAK_AUTH_URL
      else process.env.CROAK_AUTH_URL = before
    }
    expect(connectionFor({ connection: { mode: "direct" } })).toEqual({ mode: "direct" })
  })
})

describe("tool files", () => {
  test("an untrusted project's tool files are named in the question", () => {
    write(path.join(root, ".croakcode", "tools", "probe.ts"), "export default 1")
    expect(ProjectTrust.inspect(root, root, home).ignored).toContain(".croakcode/tools (1개 파일)")
  })
})
