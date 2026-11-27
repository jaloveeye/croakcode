import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_FILE_BYTES } from "./fsafe"
import {
  clampOutput,
  findFiles,
  globToRegExp,
  grepFiles,
  listDir,
  MAX_LIST_ENTRIES,
  normalizeGlob,
  resolveInside,
} from "./scan"

let root = ""

function write(rel: string, content: string | Buffer): void {
  writeFileSync(join(root, rel), content)
}

function errorCode(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? "no_code"
  }
  return "no_code"
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "croak-scan-"))
  mkdirSync(join(root, "src", "deep"), { recursive: true })
  write("a.ts", "const a = 1\n// Needle here\n")
  write("b.md", "needle in markdown")
  write("src/c.ts", "export const c = 2\n")
  write("src/deep/d.ts", "needle deep\n")
  write(".env", "SECRET=needle\n")
  write("id_rsa", "needle private key\n")
  write("big.txt", "x".repeat(MAX_FILE_BYTES + 10))
  write("bin.dat", Buffer.from([0x6e, 0x00, 0x65]))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("resolveInside", () => {
  test("cwd 안의 하위 경로는 통과한다", () => {
    expect(resolveInside(root, "src/c.ts")).toBe(join(root, "src/c.ts"))
    expect(resolveInside(root, ".")).toBe(root)
  })

  test("절대 경로와 상위 탈출을 막는다", () => {
    expect(errorCode(() => resolveInside(root, "/etc/passwd"))).toBe("path_invalid")
    expect(errorCode(() => resolveInside(root, "../outside"))).toBe("path_invalid")
    expect(errorCode(() => resolveInside(root, "src/../../outside"))).toBe("path_invalid")
  })

  test("비밀 경로 세그먼트를 막는다", () => {
    expect(errorCode(() => resolveInside(root, ".ssh/id_ed25519"))).toBe("path_denied")
    expect(errorCode(() => resolveInside(root, ".env"))).toBe("path_denied")
  })
})

describe("normalizeGlob / globToRegExp", () => {
  test("빈 패턴·절대·상위 표기를 거부한다", () => {
    expect(errorCode(() => normalizeGlob("  "))).toBe("glob_invalid")
    expect(errorCode(() => normalizeGlob("/etc/*"))).toBe("glob_invalid")
    expect(errorCode(() => normalizeGlob("../*.ts"))).toBe("glob_invalid")
    expect(normalizeGlob("./src/*.ts")).toBe("src/*.ts")
  })

  test("*, **, ? 매칭", () => {
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true)
    expect(globToRegExp("**/*.ts").test("src/deep/d.ts")).toBe(true)
    expect(globToRegExp("src/*.ts").test("src/c.ts")).toBe(true)
    expect(globToRegExp("src/*.ts").test("src/deep/d.ts")).toBe(false)
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true)
    expect(globToRegExp("a?.ts").test("abc.ts")).toBe(false)
  })
})

describe("listDir", () => {
  test("정렬·디렉터리 표식·비밀 파일 제외", () => {
    const result = listDir(root)
    expect(result.entries).toEqual(["a.ts", "b.md", "big.txt", "bin.dat", "src/"])
    expect(result.truncated).toBe(false)
  })

  test("하위 디렉터리 조회", () => {
    expect(listDir(root, "src").entries).toEqual(["c.ts", "deep/"])
  })

  test("상한을 넘으면 잘라낸다", () => {
    const many = mkdtempSync(join(tmpdir(), "croak-scan-many-"))
    try {
      for (let i = 0; i < MAX_LIST_ENTRIES + 5; i++) writeFileSync(join(many, `f${i}.txt`), "")
      const result = listDir(many)
      expect(result.entries.length).toBe(MAX_LIST_ENTRIES)
      expect(result.truncated).toBe(true)
    } finally {
      rmSync(many, { recursive: true, force: true })
    }
  })
})

describe("findFiles", () => {
  test("중첩 경로에서 glob과 일치하는 파일만 돌려준다", () => {
    expect(findFiles(root, "**/*.ts").files.sort()).toEqual(["a.ts", "src/c.ts", "src/deep/d.ts"])
    expect(findFiles(root, "src/*.ts").files).toEqual(["src/c.ts"])
  })

  test("비밀 파일은 결과에서 빠진다", () => {
    expect(findFiles(root, "**/*").files.some((f) => f === ".env" || f === "id_rsa")).toBe(false)
  })
})

describe("grepFiles", () => {
  test("대소문자 무시 검색, 비밀·바이너리·대용량 제외", () => {
    const result = grepFiles(root, "NEEDLE")
    const files = result.hits.map((h) => h.file).sort()
    expect(files).toEqual(["a.ts", "b.md", "src/deep/d.ts"])
    expect(result.hits.find((h) => h.file === "a.ts")?.line).toBe(2)
  })

  test("include glob으로 대상을 좁힌다", () => {
    const result = grepFiles(root, "needle", "**/*.ts")
    expect(result.hits.map((h) => h.file).sort()).toEqual(["a.ts", "src/deep/d.ts"])
  })

  test("빈 검색어를 거부한다", () => {
    expect(errorCode(() => grepFiles(root, "  "))).toBe("grep_invalid")
  })
})

describe("clampOutput", () => {
  test("상한 이하면 그대로, 넘으면 자른다", () => {
    expect(clampOutput("short", 10)).toEqual({ text: "short", truncated: false })
    const result = clampOutput("가".repeat(10), 10)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(10)
  })
})
