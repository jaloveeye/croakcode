import { describe, expect, test } from "bun:test"
import { isLoginError, legacyWindowsConsole } from "../../../src/cli/croak/terminal"

describe("legacy Windows console", () => {
  test("only Windows without a modern terminal counts", () => {
    expect(legacyWindowsConsole({}, "win32")).toBe(true)
    expect(legacyWindowsConsole({}, "linux")).toBe(false)
    expect(legacyWindowsConsole({}, "darwin")).toBe(false)
  })

  test("Windows Terminal, VS Code, ConEmu, WezTerm and TERM are fine", () => {
    for (const env of [{ WT_SESSION: "x" }, { TERM_PROGRAM: "vscode" }, { ConEmuANSI: "ON" }, { WEZTERM_EXECUTABLE: "x" }, { TERM: "xterm-256color" }])
      expect(legacyWindowsConsole(env, "win32")).toBe(false)
  })

  test("CROAKCODE_ALLOW_CONSOLE=1 skips the check", () => {
    expect(legacyWindowsConsole({ CROAKCODE_ALLOW_CONSOLE: "1" }, "win32")).toBe(false)
  })
})

describe("login hint", () => {
  test("the gate's answers for a missing or ended login", () => {
    expect(isLoginError("Error: Authentication Error, No api key passed in.")).toBe(true)
    expect(isLoginError("HTTP 401 Unauthorized")).toBe(true)
    expect(isLoginError("Cannot connect to API")).toBe(false)
  })
})

describe("reopening in Windows Terminal", () => {
  const { windowsTerminalRelaunch } = require("../../../src/cli/croak/terminal")
  const which = (name: string) => (name === "wt.exe" ? "C:\\\\WT\\\\wt.exe" : null)

  test("runs the launcher again in a new Windows Terminal window, in the same folder, with the same arguments", () => {
    expect(windowsTerminalRelaunch({ CROAKCODE_LAUNCHER: "C:\\\\bin\\\\croakcode.cmd" }, ["-s", "ses_1"], "C:\\\\work", which)).toEqual({
      command: "C:\\\\WT\\\\wt.exe",
      args: ["-d", "C:\\\\work", "cmd.exe", "/k", "C:\\\\bin\\\\croakcode.cmd", "-s", "ses_1"],
    })
  })

  test("not without Windows Terminal or without the launcher", () => {
    expect(windowsTerminalRelaunch({ CROAKCODE_LAUNCHER: "x.cmd" }, [], "C:\\\\", () => null)).toBeUndefined()
    expect(windowsTerminalRelaunch({}, [], "C:\\\\", which)).toBeUndefined()
  })
})
