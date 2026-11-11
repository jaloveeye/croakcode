// croakcode-specific startup checks for the terminal and for login hints.

/**
 * True for the legacy Windows console (conhost), where the TUI shows only a
 * black screen: it never answers the terminal queries the renderer waits for,
 * and with input processing switched off for the TUI, ctrl+c cannot get out.
 * Windows Terminal, VS Code, ConEmu, WezTerm and terminals that set TERM are
 * fine. CROAKCODE_ALLOW_CONSOLE=1 skips the check.
 */
export function legacyWindowsConsole(env: NodeJS.ProcessEnv, platform: string = process.platform) {
  if (platform !== "win32") return false
  if (env.CROAKCODE_ALLOW_CONSOLE === "1") return false
  return !(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI || env.WEZTERM_EXECUTABLE || env.TERM)
}

/**
 * How to reopen the TUI in Windows Terminal from the legacy console, or
 * undefined when that is not possible. The launcher (croakcode.cmd) sets
 * CROAKCODE_LAUNCHER to itself; running it again in the new window sets the
 * gate settings there too, which a running Windows Terminal would not pass on.
 * The new window has WT_SESSION, so it does not reopen again.
 */
export function windowsTerminalRelaunch(
  env: NodeJS.ProcessEnv,
  args: string[],
  cwd: string,
  which: (name: string) => string | null | undefined,
): { command: string; args: string[] } | undefined {
  const launcher = env.CROAKCODE_LAUNCHER
  const wt = which("wt.exe") ?? which("wt")
  if (!launcher || !wt) return undefined
  // /k keeps the tab after croakcode exits, so its exit screen (how to resume) stays.
  return { command: wt, args: ["-d", cwd, "cmd.exe", "/k", launcher, ...args] }
}

export const RELAUNCHED_MESSAGE = "Windows Terminal 새 창에서 croakcode를 열었습니다."

export const LEGACY_CONSOLE_MESSAGE = [
  "이 창(Windows 기본 콘솔)에서는 croakcode 화면을 그릴 수 없습니다.",
  "Windows Terminal에서 실행하세요. 시작 메뉴에서 '터미널'을 열고 croakcode를 입력하면 됩니다.",
  "Windows 10은 Microsoft Store에서 Windows Terminal을 설치할 수 있습니다.",
  "화면 없이 쓰려면 croakcode run \"질문\"을 실행하세요.",
].join("\n")

/** A gate answer that means the croak login is missing or over. */
export function isLoginError(message: string) {
  return /No api key passed|Authentication Error|\b401\b|invalid.*key|key.*expired/i.test(message)
}

export const LOGIN_HINT = "croak 게이트에 로그인하지 않았거나 로그인이 끝났습니다. croakcode를 실행하고 /login을 입력하세요."
