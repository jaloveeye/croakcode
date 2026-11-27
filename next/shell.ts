import { basename } from "node:path"
import { SafeError } from "./fsafe"

/** shell 도구가 실행할 수 있는 argv 허용목록(정확히 일치해야 한다). */
export const SHELL_ALLOWLIST: readonly (readonly string[])[] = [
  ["bun", "--version"],
  ["bun", "test"],
  ["bun", "run", "test"],
  ["bun", "run", "test:next"],
  ["bun", "run", "test:e2e-tui"],
  ["bun", "run", "build:next"],
  ["npm", "test"],
]

export const SHELL_TIMEOUT_MS = 60_000
export const SHELL_MAX_OUTPUT_BYTES = 16 * 1024
const MAX_ARGS = 32

export type ShellResult = {
  code: number | null
  output: string
  truncated: boolean
  timedOut: boolean
}

function fail(code: string, message: string): never {
  throw new SafeError(code, message)
}

function allowed(argv: readonly string[], allow: readonly (readonly string[])[]): boolean {
  return allow.some((prefix) => prefix.length === argv.length && prefix.every((part, i) => part === argv[i]))
}

/**
 * 명령을 셸 없이 argv로 실행한다. 허용목록에 정확히 맞지 않으면 거부한다.
 * 반환 전에 stdout/stderr를 합쳐 바이트 상한으로 자른다.
 */
export function validateShell(command: unknown, args: unknown, allow = SHELL_ALLOWLIST): string[] {
  if (typeof command !== "string") fail("shell_invalid", "명령이 문자열이 아니다")
  const program = command.trim()
  if (!program) fail("shell_invalid", "명령이 비어 있다")
  if (program.includes("\0") || program.includes("/") || program.includes("\\") || basename(program) !== program) {
    fail("shell_invalid", "명령 이름에는 경로 구분자를 쓸 수 없다")
  }
  if (args !== undefined && !Array.isArray(args)) fail("shell_invalid", "args는 문자열 배열이어야 한다")
  const list = (args ?? []) as unknown[]
  if (list.length > MAX_ARGS) fail("shell_invalid", "인자가 너무 많다")
  const argv = [program]
  for (const arg of list) {
    if (typeof arg !== "string") fail("shell_invalid", "인자는 문자열이어야 한다")
    if (arg.includes("\0")) fail("shell_invalid", "인자에 NUL 문자는 허용되지 않는다")
    argv.push(arg)
  }
  if (!allowed(argv, allow)) fail("shell_denied", `허용되지 않은 명령이다: ${argv.join(" ")}`)
  return argv
}

async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const room = cap - total
      if (value.length >= room) {
        chunks.push(value.subarray(0, room))
        total += room
        truncated = true
        await reader.cancel()
        break
      }
      chunks.push(value)
      total += value.length
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 이미 취소된 리더
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated }
}

/** 허용된 명령을 실행한다. `validateShell`을 통과한 argv만 spawn 한다. */
export async function runShell(
  cwd: string,
  command: unknown,
  args: unknown,
  allow = SHELL_ALLOWLIST,
  timeoutMs = SHELL_TIMEOUT_MS,
): Promise<ShellResult> {
  const argv = validateShell(command, args, allow)
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key === "PATH" || key === "HOME" || key === "TMPDIR" || key === "LANG" || key === "LC_ALL",
    ),
  )
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch {
    fail("shell_failed", "명령을 실행할 수 없다")
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill("SIGKILL")
    } catch {
      // 이미 종료된 프로세스
    }
  }, timeoutMs)

  const [stdout, stderr, code] = await Promise.all([
    readCapped(proc.stdout as ReadableStream<Uint8Array>, SHELL_MAX_OUTPUT_BYTES),
    readCapped(proc.stderr as ReadableStream<Uint8Array>, SHELL_MAX_OUTPUT_BYTES),
    proc.exited,
  ]).finally(() => clearTimeout(timer))

  const combined = stdout.text + stderr.text
  return {
    code: timedOut ? null : code,
    output: combined,
    truncated: stdout.truncated || stderr.truncated,
    timedOut,
  }
}
