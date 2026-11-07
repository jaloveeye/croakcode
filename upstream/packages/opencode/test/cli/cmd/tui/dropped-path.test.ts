import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import {
  candidates,
  isTextFile,
  parseMountRoot,
  quoteForText,
  resolve,
  toLocalPath,
  tokenize,
  type DropEnv,
} from "../../../../src/cli/cmd/tui/component/prompt/dropped-path"

const wsl: DropEnv = { platform: "linux", wslDistro: "Ubuntu", mountRoot: "/mnt" }
const linux: DropEnv = { platform: "linux", mountRoot: "/mnt" }

describe("toLocalPath", () => {
  test("converts a Windows drive path under WSL", () => {
    expect(toLocalPath("C:\\Users\\me\\a b.png", wsl)).toBe("/mnt/c/Users/me/a b.png")
    expect(toLocalPath("d:/work/x.txt", wsl)).toBe("/mnt/d/work/x.txt")
    expect(toLocalPath("C:\\", wsl)).toBe("/mnt/c")
    expect(toLocalPath("C:\\Users\\me\\", wsl)).toBe("/mnt/c/Users/me")
  })

  test("uses a custom automount root", () => {
    expect(toLocalPath("C:\\a.txt", { ...wsl, mountRoot: "/win/" })).toBe("/win/c/a.txt")
  })

  test("converts a UNC path into this distro", () => {
    expect(toLocalPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\a.txt", wsl)).toBe("/home/me/a.txt")
    expect(toLocalPath("\\\\wsl$\\ubuntu\\home\\me", wsl)).toBe("/home/me")
  })

  test("leaves a UNC path into another distro unchanged", () => {
    const raw = "\\\\wsl.localhost\\Debian\\home\\me\\a.txt"
    expect(toLocalPath(raw, wsl)).toBe(raw)
  })

  test("keeps POSIX backslash unescaping outside WSL", () => {
    expect(toLocalPath("/home/me/a\\ b.txt", linux)).toBe("/home/me/a b.txt")
    // Without WSL a drive path is not converted.
    expect(toLocalPath("C:\\a.txt", linux)).toBe("C:a.txt")
  })

  test("decodes file URLs", () => {
    expect(toLocalPath("file:///home/me/a%20b.txt", wsl)).toBe("/home/me/a b.txt")
  })

  test("leaves Windows paths alone on win32", () => {
    expect(toLocalPath("C:\\a.txt", { platform: "win32", mountRoot: "/mnt" })).toBe("C:\\a.txt")
  })
})

describe("parseMountRoot", () => {
  test("reads the automount root", () => {
    expect(parseMountRoot("[boot]\nsystemd=true\n[automount]\nroot = /win/ # comment\n")).toBe("/win")
  })

  test("ignores root in other sections and defaults to /mnt", () => {
    expect(parseMountRoot("[other]\nroot=/x\n")).toBe("/mnt")
    expect(parseMountRoot("")).toBe("/mnt")
  })
})

describe("tokenize", () => {
  test("splits on whitespace and keeps quoted spaces", () => {
    expect(tokenize(`"C:\\a b\\x.png" C:\\y.txt`)).toEqual(["C:\\a b\\x.png", "C:\\y.txt"])
    expect(tokenize(`'/mnt/c/a b' /tmp/c`)).toEqual(["/mnt/c/a b", "/tmp/c"])
  })

  test("keeps backslash-escaped spaces in one token", () => {
    expect(tokenize("/home/me/a\\ b.txt /tmp/x")).toEqual(["/home/me/a\\ b.txt", "/tmp/x"])
  })

  test("returns undefined on an unterminated quote", () => {
    expect(tokenize(`"C:\\a b`)).toBeUndefined()
  })
})

describe("candidates", () => {
  test("tries the whole paste first, then the split paths", () => {
    expect(candidates(`"C:\\a.txt" "D:\\b c.txt"`, wsl)).toEqual([
      ["/mnt/c/a.txt\" \"D:/b c.txt"],
      ["/mnt/c/a.txt", "/mnt/d/b c.txt"],
    ])
  })

  test("ignores URLs, multi-line text and ordinary words", () => {
    expect(candidates("https://example.com/a.png", wsl)).toEqual([])
    expect(candidates("hello world", wsl)).toEqual([])
    expect(candidates("README.md", wsl)).toEqual([])
    expect(candidates("line one\nline two", wsl)).toEqual([])
  })

  test("still offers a bare image name", () => {
    expect(candidates("shot.png", wsl)).toEqual([["shot.png"]])
  })
})

describe("resolve", () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dropped-path-"))
    await writeFile(path.join(dir, "a b.txt"), "hello")
    await writeFile(path.join(dir, "c.txt"), "world")
    await mkdir(path.join(dir, "sub"))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("finds one unquoted path with spaces", async () => {
    expect(await resolve(path.join(dir, "a b.txt"), linux)).toEqual([{ path: path.join(dir, "a b.txt"), kind: "file" }])
  })

  test("finds several quoted paths and a directory", async () => {
    const text = `'${path.join(dir, "a b.txt")}' ${path.join(dir, "c.txt")} ${path.join(dir, "sub")}`
    expect(await resolve(text, linux)).toEqual([
      { path: path.join(dir, "a b.txt"), kind: "file" },
      { path: path.join(dir, "c.txt"), kind: "file" },
      { path: path.join(dir, "sub"), kind: "directory" },
    ])
  })

  test("returns undefined when any path is missing", async () => {
    expect(await resolve(`${path.join(dir, "c.txt")} ${path.join(dir, "missing.txt")}`, linux)).toBeUndefined()
  })
})

describe("isTextFile", () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dropped-text-"))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("accepts UTF-8 text including Korean", async () => {
    const p = path.join(dir, "ko.md")
    await writeFile(p, "한국어 문서\n")
    expect(await isTextFile(p)).toBe(true)
  })

  test("accepts text whose sniff window cuts a multi-byte character", async () => {
    const p = path.join(dir, "long.txt")
    await writeFile(p, "a" + "가".repeat(4000))
    expect(await isTextFile(p)).toBe(true)
  })

  test("rejects binary data", async () => {
    const p = path.join(dir, "bin.dat")
    await writeFile(p, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))
    expect(await isTextFile(p)).toBe(false)
  })

  test("rejects invalid UTF-8", async () => {
    const p = path.join(dir, "latin1.txt")
    await writeFile(p, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20]))
    expect(await isTextFile(p)).toBe(false)
  })
})

test("quoteForText quotes only paths with whitespace", () => {
  expect(quoteForText("/mnt/c/a b.zip")).toBe('"/mnt/c/a b.zip"')
  expect(quoteForText("/mnt/c/a.zip")).toBe("/mnt/c/a.zip")
})
