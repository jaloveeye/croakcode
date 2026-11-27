import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SafeError } from "./fsafe"
import { runShell, SHELL_MAX_OUTPUT_BYTES, validateShell } from "./shell"

const root = mkdtempSync(join(tmpdir(), "croak-shell-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("shell 허용목록", () => {
  test("정확히 일치하는 argv만 허용한다", () => {
    expect(validateShell("bun", ["--version"])).toEqual(["bun", "--version"])
    expect(() => validateShell("bun", ["--version", "--help"])).toThrow(SafeError)
    expect(() => validateShell("bun", ["test", "evil.ts"])).toThrow(SafeError)
  })

  test("경로 구분자·빈 명령·비문자열 인자를 거부한다", () => {
    expect(() => validateShell("/bin/bun", ["--version"])).toThrow(SafeError)
    expect(() => validateShell("bin\\bun", ["--version"])).toThrow(SafeError)
    expect(() => validateShell("", [])).toThrow(SafeError)
    expect(() => validateShell("bun", ["--version", 1])).toThrow(SafeError)
    expect(() => validateShell("bun", "nope")).toThrow(SafeError)
  })

  test("거부 사유는 shell_denied 로 구분된다", () => {
    try {
      validateShell("rm", ["-rf", "/"])
      throw new Error("should not reach")
    } catch (error) {
      expect(error).toBeInstanceOf(SafeError)
      expect((error as SafeError).code).toBe("shell_denied")
    }
  })
})

describe("shell 실행", () => {
  const run = (command: string, args: string[], allow = [[command, ...args]], timeoutMs?: number) =>
    runShell(root, command, args, allow, timeoutMs)

  test("cwd 안에서 실행하고 출력을 돌려준다", async () => {
    const result = await run("bun", ["-e", "console.log(process.cwd())"])
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.output.trim()).toBe(root)
  })

  test("종료 코드를 보존한다", async () => {
    const result = await run("bun", ["-e", "process.exit(3)"])
    expect(result.code).toBe(3)
  })

  test("민감 환경변수를 자식에게 넘기지 않는다", async () => {
    process.env.CROAK_SHELL_LEAK_TEST = "should-not-leak"
    try {
      const result = await run("bun", ["-e", "console.log(process.env.CROAK_SHELL_LEAK_TEST ?? 'missing')"])
      expect(result.output.trim()).toBe("missing")
    } finally {
      delete process.env.CROAK_SHELL_LEAK_TEST
    }
  })

  test("시간 제한을 넘기면 종료한다", async () => {
    const result = await run("bun", ["-e", "await Bun.sleep(5000)"], undefined, 100)
    expect(result.timedOut).toBe(true)
    expect(result.code).toBeNull()
  })

  test("출력이 상한을 넘으면 자른다", async () => {
    const result = await run("bun", ["-e", "process.stdout.write('x'.repeat(40000))"])
    expect(result.truncated).toBe(true)
    expect(result.output.length).toBeLessThanOrEqual(SHELL_MAX_OUTPUT_BYTES)
  })
})
