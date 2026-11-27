import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  editFileBounded,
  MAX_WRITE_BYTES,
  SafeError,
  validateWriteTarget,
  writeFileBounded,
} from "./fsafe"

let root = ""
let cwd = ""
let outside = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "croak-fsafe-"))
  cwd = join(root, "work")
  outside = join(root, "outside")
  mkdirSync(cwd)
  mkdirSync(outside)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof SafeError) return error.code
    throw error
  }
  throw new Error("expected SafeError")
}

describe("writeFileBounded", () => {
  test("새 파일을 만들고 다시 쓰면 덮어쓴다", () => {
    expect(writeFileBounded(cwd, "a.txt", "하나")).toBe(Buffer.byteLength("하나"))
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("하나")
    writeFileBounded(cwd, "a.txt", "둘")
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("둘")
  })

  test("하위 디렉터리 파일도 쓸 수 있다", () => {
    mkdirSync(join(cwd, "src"))
    writeFileBounded(cwd, "src/app.ts", "export {}\n")
    expect(readFileSync(join(cwd, "src/app.ts"), "utf8")).toBe("export {}\n")
  })

  test("기존 파일 권한을 보존한다", () => {
    const path = join(cwd, "perm.txt")
    writeFileSync(path, "old")
    chmodSync(path, 0o640)
    writeFileBounded(cwd, "perm.txt", "new")
    expect(statSync(path).mode & 0o777).toBe(0o640)
  })

  test("절대 경로·상위 탈출·비밀 경로·VCS 내부를 거부한다", () => {
    expect(codeOf(() => writeFileBounded(cwd, join(outside, "x"), "x"))).toBe("path_invalid")
    expect(codeOf(() => writeFileBounded(cwd, "../x", "x"))).toBe("path_invalid")
    expect(codeOf(() => writeFileBounded(cwd, ".env", "x"))).toBe("path_denied")
    mkdirSync(join(cwd, ".git", "hooks"), { recursive: true })
    expect(codeOf(() => writeFileBounded(cwd, ".git/hooks/pre-commit", "x"))).toBe("path_denied")
  })

  test("상위 디렉터리 누락·디렉터리 대상·심볼릭 링크를 거부한다", () => {
    expect(codeOf(() => writeFileBounded(cwd, "missing/a.txt", "x"))).toBe("write_failed")
    expect(codeOf(() => writeFileBounded(cwd, ".", "x"))).toBe("path_invalid")
    writeFileSync(join(outside, "secret.txt"), "secret")
    symlinkSync(join(outside, "secret.txt"), join(cwd, "link.txt"))
    expect(codeOf(() => writeFileBounded(cwd, "link.txt", "x"))).toBe("write_failed")
  })

  test("심볼릭 링크 상위 디렉터리로 cwd 밖에 쓰지 못한다", () => {
    symlinkSync(outside, join(cwd, "out"))
    expect(codeOf(() => writeFileBounded(cwd, "out/escape.txt", "x"))).toBe("path_invalid")
    expect(existsSync(join(outside, "escape.txt"))).toBe(false)
  })

  test("크기 상한과 NUL 문자를 거부한다", () => {
    expect(codeOf(() => writeFileBounded(cwd, "big.txt", "x".repeat(MAX_WRITE_BYTES + 1)))).toBe("write_too_large")
    expect(codeOf(() => writeFileBounded(cwd, "nul.txt", "a\0b"))).toBe("write_invalid")
    expect(codeOf(() => validateWriteTarget(cwd, "nul2.txt", "a\0b"))).toBe("write_invalid")
  })
})

describe("editFileBounded", () => {
  test("정확히 한 곳을 바꾼다", () => {
    writeFileSync(join(cwd, "e.txt"), "alpha beta alpha\n")
    expect(editFileBounded(cwd, "e.txt", "beta", "BETA")).toBe(1)
    expect(readFileSync(join(cwd, "e.txt"), "utf8")).toBe("alpha BETA alpha\n")
  })

  test("여러 곳 일치는 replaceAll 없이 거부하고 replaceAll 로 바꾼다", () => {
    writeFileSync(join(cwd, "e.txt"), "x x x")
    expect(codeOf(() => editFileBounded(cwd, "e.txt", "x", "y"))).toBe("edit_ambiguous")
    expect(readFileSync(join(cwd, "e.txt"), "utf8")).toBe("x x x")
    expect(editFileBounded(cwd, "e.txt", "x", "y", true)).toBe(3)
    expect(readFileSync(join(cwd, "e.txt"), "utf8")).toBe("y y y")
  })

  test("일치 없음·빈 oldString·심볼릭 링크를 거부한다", () => {
    writeFileSync(join(cwd, "e.txt"), "abc")
    expect(codeOf(() => editFileBounded(cwd, "e.txt", "zzz", "y"))).toBe("edit_no_match")
    expect(codeOf(() => editFileBounded(cwd, "e.txt", "", "y"))).toBe("edit_invalid")
    writeFileSync(join(outside, "secret.txt"), "abc")
    symlinkSync(join(outside, "secret.txt"), join(cwd, "link.txt"))
    expect(codeOf(() => editFileBounded(cwd, "link.txt", "abc", "y"))).toBe("write_failed")
  })

  test("편집 결과가 상한을 넘으면 거부한다", () => {
    writeFileSync(join(cwd, "e.txt"), "start")
    const huge = "x".repeat(MAX_WRITE_BYTES + 1)
    expect(codeOf(() => editFileBounded(cwd, "e.txt", "start", huge))).toBe("write_too_large")
    expect(readFileSync(join(cwd, "e.txt"), "utf8")).toBe("start")
  })
})
