import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyPatch, parsePatch } from "./patch"

const root = mkdtempSync(join(tmpdir(), "croak-patch-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function workspace(): string {
  const dir = mkdtempSync(join(root, "ws-"))
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n")
  writeFileSync(join(dir, "del.txt"), "bye\n")
  writeFileSync(join(dir, "move.txt"), "old\n")
  return dir
}

function read(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf8")
}

const PATCH = `*** Begin Patch
*** Add File: new.txt
+hello
*** Update File: a.txt
@@
 two
-three
+THREE
*** Delete File: del.txt
*** Update File: move.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`

describe("apply_patch 파싱", () => {
  test("add/update/delete/move hunk를 읽는다", () => {
    const hunks = parsePatch(PATCH)
    expect(hunks).toHaveLength(4)
    expect(hunks[0]).toEqual({ type: "add", path: "new.txt", contents: "hello" })
    expect(hunks[1].type).toBe("update")
    expect(hunks[2]).toEqual({ type: "delete", path: "del.txt" })
    expect(hunks[3]).toMatchObject({ type: "update", path: "move.txt", move_path: "moved.txt" })
  })

  test("heredoc 래퍼와 End of File 표식을 허용한다", () => {
    const hunks = parsePatch(`cat <<'PATCH'
*** Begin Patch
*** Update File: a.txt
@@
 line
+tail
*** End of File
*** End Patch
PATCH`)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].type).toBe("update")
    if (hunks[0].type === "update") expect(hunks[0].chunks[0].is_end_of_file).toBe(true)
  })

  test("Begin/End 마커가 없으면 거부한다", () => {
    expect(() => parsePatch("*** Update File: a.txt\n@@\n-a\n+b")).toThrow("Begin Patch")
    expect(() => parsePatch("*** Begin Patch\n*** Update File: a.txt")).toThrow("End Patch")
    expect(() => parsePatch("")).toThrow()
  })
})

describe("apply_patch 적용", () => {
  test("여러 파일을 한 번에 추가·수정·삭제·이동한다", () => {
    const dir = workspace()
    const result = applyPatch(dir, PATCH)
    expect(read(dir, "new.txt")).toBe("hello\n")
    expect(read(dir, "a.txt")).toBe("one\ntwo\nTHREE\n")
    expect(existsSync(join(dir, "del.txt"))).toBe(false)
    expect(existsSync(join(dir, "move.txt"))).toBe(false)
    expect(read(dir, "moved.txt")).toBe("new\n")
    expect(result.added).toEqual(["new.txt"])
    expect(result.modified).toEqual(["a.txt", "moved.txt"])
    expect(result.deleted).toEqual(["del.txt", "move.txt"])
    expect(result.moved).toEqual([{ from: "move.txt", to: "moved.txt" }])
  })

  test("컨텍스트 줄과 End of File 로 마지막 일치를 고른다", () => {
    const dir = workspace()
    writeFileSync(join(dir, "eof.txt"), "a\nline\nline\n")
    applyPatch(
      dir,
      `*** Begin Patch
*** Update File: eof.txt
@@
 line
-line
+LINE
*** End of File
*** End Patch`,
    )
    expect(read(dir, "eof.txt")).toBe("a\nline\nLINE\n")
  })

  test("공백/유니코드 차이를 정규화해 컨텍스트를 찾는다", () => {
    const dir = workspace()
    writeFileSync(join(dir, "u.txt"), "“hello”\nnext\n")
    applyPatch(
      dir,
      `*** Begin Patch
*** Update File: u.txt
@@ “hello”
-next
+NEXT
*** End Patch`,
    )
    expect(read(dir, "u.txt")).toBe("“hello”\nNEXT\n")
  })

  test("파일 끝 개행을 보장한다", () => {
    const dir = workspace()
    writeFileSync(join(dir, "noeol.txt"), "a\nb")
    applyPatch(
      dir,
      `*** Begin Patch
*** Update File: noeol.txt
@@
-a
+A
*** End Patch`,
    )
    expect(read(dir, "noeol.txt")).toBe("A\nb\n")
  })

  test("한 패치 안에서 만든 파일을 삭제·이동한다", () => {
    const dir = workspace()
    applyPatch(
      dir,
      `*** Begin Patch
*** Add File: temp.txt
+gone
*** Delete File: temp.txt
*** Add File: src.txt
+body
*** Update File: src.txt
*** Move to: dst.txt
@@
-body
+body2
*** End Patch`,
    )
    expect(existsSync(join(dir, "temp.txt"))).toBe(false)
    expect(existsSync(join(dir, "src.txt"))).toBe(false)
    expect(read(dir, "dst.txt")).toBe("body2\n")
  })

  test("검증 실패 시 어떤 파일도 바꾸지 않는다", () => {
    const dir = workspace()
    expect(() =>
      applyPatch(
        dir,
        `*** Begin Patch
*** Add File: atomic.txt
+x
*** Update File: missing.txt
@@
-nope
+yep
*** End Patch`,
      ),
    ).toThrow()
    expect(existsSync(join(dir, "atomic.txt"))).toBe(false)
    expect(read(dir, "a.txt")).toBe("one\ntwo\nthree\n")
  })

  test("컨텍스트가 맞지 않으면 기존 파일을 그대로 둔다", () => {
    const dir = workspace()
    expect(() =>
      applyPatch(
        dir,
        `*** Begin Patch
*** Update File: a.txt
@@
-not here
+nope
*** End Patch`,
      ),
    ).toThrow("찾을 수 없다")
    expect(read(dir, "a.txt")).toBe("one\ntwo\nthree\n")
  })
})

describe("apply_patch 경로·크기 제한", () => {
  test("cwd 밖 경로를 거부한다", () => {
    const dir = workspace()
    expect(() =>
      applyPatch(dir, "*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch"),
    ).toThrow("밖")
    expect(existsSync(join(dir, "..", "escape.txt"))).toBe(false)
  })

  test("비밀 경로와 VCS 내부를 거부한다", () => {
    const dir = workspace()
    expect(() => applyPatch(dir, "*** Begin Patch\n*** Add File: .env\n+x\n*** End Patch")).toThrow("비밀")
    expect(() =>
      applyPatch(dir, "*** Begin Patch\n*** Add File: .git/config\n+x\n*** End Patch"),
    ).toThrow()
  })

  test("심볼릭 링크 대상을 거부한다", () => {
    const dir = workspace()
    symlinkSync(join(dir, "a.txt"), join(dir, "link.txt"))
    expect(() =>
      applyPatch(dir, "*** Begin Patch\n*** Update File: link.txt\n@@\n-one\n+ONE\n*** End Patch"),
    ).toThrow("심볼릭")
  })

  test("없는 파일 수정/삭제를 거부한다", () => {
    const dir = workspace()
    expect(() =>
      applyPatch(dir, "*** Begin Patch\n*** Update File: nope.txt\n@@\n-a\n+b\n*** End Patch"),
    ).toThrow("파일을 열 수 없다")
    expect(() => applyPatch(dir, "*** Begin Patch\n*** Delete File: nope.txt\n*** End Patch")).toThrow("없다")
  })

  test("쓰기 상한을 넘는 추가를 거부한다", () => {
    const dir = workspace()
    const line = "x".repeat(65 * 1024)
    expect(() =>
      applyPatch(dir, `*** Begin Patch\n*** Add File: big.txt\n+${line}\n*** End Patch`),
    ).toThrow("너무 크다")
    expect(existsSync(join(dir, "big.txt"))).toBe(false)
  })
})
