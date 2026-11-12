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

  test("an older launcher without CROAKCODE_LAUNCHER is found where the installer puts it", () => {
    const installed = "C:\\Users\\u\\.local\\bin\\croakcode.cmd"
    const relaunch = windowsTerminalRelaunch({ USERPROFILE: "C:\\Users\\u" }, [], "C:\\w", which, (f: string) => f === installed)
    expect(relaunch?.args).toEqual(["-d", "C:\\w", "cmd.exe", "/k", installed])
    expect(windowsTerminalRelaunch({ USERPROFILE: "C:\\Users\\u" }, [], "C:\\w", which, () => false)).toBeUndefined()
  })

  test("not without Windows Terminal or without the launcher", () => {
    expect(windowsTerminalRelaunch({ CROAKCODE_LAUNCHER: "x.cmd" }, [], "C:\\\\", () => null)).toBeUndefined()
    expect(windowsTerminalRelaunch({}, [], "C:\\\\", which)).toBeUndefined()
  })
})

describe("WSL in the legacy Windows console", () => {
  const { legacyWslConsole, wslTerminalRelaunch, keepShellAfterRelaunch } = require("../../../src/cli/croak/terminal")
  const wsl = { WSL_DISTRO_NAME: "Ubuntu", TERM: "xterm-256color", HOME: "/home/u" }

  test("WSL without a modern terminal counts, even with TERM set", () => {
    expect(legacyWslConsole(wsl, "linux")).toBe(true)
    expect(legacyWslConsole({ WSL_INTEROP: "/run/WSL/1_interop", TERM: "xterm" }, "linux")).toBe(true)
  })

  test("plain Linux, Windows Terminal, VS Code, tmux, screen and ssh are fine", () => {
    expect(legacyWslConsole({ TERM: "xterm-256color" }, "linux")).toBe(false)
    expect(legacyWslConsole(wsl, "win32")).toBe(false)
    for (const extra of [{ WT_SESSION: "x" }, { TERM_PROGRAM: "vscode" }, { TMUX: "/tmp/t" }, { STY: "1.s" }, { SSH_CONNECTION: "a b c d" }])
      expect(legacyWslConsole({ ...wsl, ...extra }, "linux")).toBe(false)
  })

  test("a window croakcode opened itself is never reopened", () => {
    expect(legacyWslConsole({ ...wsl, CROAKCODE_RELAUNCHED: "wsl" }, "linux")).toBe(false)
    expect(legacyWslConsole({ ...wsl, CROAKCODE_ALLOW_CONSOLE: "1" }, "linux")).toBe(false)
  })

  test("reopens the launcher in a Windows Terminal tab of the same distribution", () => {
    const which = (name: string) => (name === "wt.exe" ? "/mnt/c/WindowsApps/wt.exe" : null)
    const exists = (file: string) => file === "/home/u/.local/bin/croakcode"
    expect(wslTerminalRelaunch(wsl, ["--continue", "a;b"], "/home/u/proj", which, exists)).toEqual({
      command: "/mnt/c/WindowsApps/wt.exe",
      args: ["wsl.exe", "-d", "Ubuntu", "--cd", "/home/u/proj", "--exec", "env", "CROAKCODE_RELAUNCHED=wsl",
        "/home/u/.local/bin/croakcode", "--continue", "a\\;b"],
    })
  })

  test("no launcher or no Windows Terminal: no relaunch", () => {
    const which = (name: string) => (name === "wt.exe" ? "/mnt/c/WindowsApps/wt.exe" : null)
    expect(wslTerminalRelaunch(wsl, [], "/p", which, () => false)).toBeUndefined()
    expect(wslTerminalRelaunch(wsl, [], "/p", () => null, () => true)).toBeUndefined()
  })

  test("only a relaunched WSL tab keeps a shell after exit", () => {
    expect(keepShellAfterRelaunch({ CROAKCODE_RELAUNCHED: "wsl", SHELL: "/bin/zsh" })).toBe("/bin/zsh")
    expect(keepShellAfterRelaunch({ CROAKCODE_RELAUNCHED: "wsl" })).toBe("/bin/bash")
    expect(keepShellAfterRelaunch({})).toBeUndefined()
  })
})
