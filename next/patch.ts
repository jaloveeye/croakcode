import { lstatSync } from "node:fs"
import {
  deleteFileBounded,
  readFileBounded,
  resolveInside,
  SafeError,
  validateDeleteTarget,
  validateWriteTarget,
  writeFileBounded,
} from "./fsafe"

/** upstream `*** Begin Patch` 형식의 hunk. */
export type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; move_path?: string; chunks: UpdateFileChunk[] }

export type UpdateFileChunk = {
  old_lines: string[]
  new_lines: string[]
  change_context?: string
  is_end_of_file?: boolean
}

export type ApplyResult = {
  added: string[]
  modified: string[]
  deleted: string[]
  moved: Array<{ from: string; to: string }>
}

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"
const END_OF_FILE = "*** End of File"

function fail(message: string, code = "patch_invalid"): never {
  throw new SafeError(code, message)
}

function stripHeredoc(input: string): string {
  const match = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/)
  return match ? match[2] : input
}

function parseHeader(
  lines: string[],
  index: number,
): { filePath: string; movePath?: string; nextIdx: number } | null {
  const line = lines[index]
  if (line.startsWith("*** Add File:")) {
    const filePath = line.slice("*** Add File:".length).trim()
    return filePath ? { filePath, nextIdx: index + 1 } : null
  }
  if (line.startsWith("*** Delete File:")) {
    const filePath = line.slice("*** Delete File:".length).trim()
    return filePath ? { filePath, nextIdx: index + 1 } : null
  }
  if (line.startsWith("*** Update File:")) {
    const filePath = line.slice("*** Update File:".length).trim()
    let movePath: string | undefined
    let nextIdx = index + 1
    if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
      movePath = lines[nextIdx].slice("*** Move to:".length).trim()
      nextIdx++
    }
    return filePath ? { filePath, movePath, nextIdx } : null
  }
  return null
}

function parseAddContent(lines: string[], startIdx: number, endIdx: number): { contents: string; nextIdx: number } {
  let contents = ""
  let i = startIdx
  while (i < endIdx && !lines[i].startsWith("***")) {
    if (lines[i].startsWith("+")) contents += lines[i].substring(1) + "\n"
    i++
  }
  if (contents.endsWith("\n")) contents = contents.slice(0, -1)
  return { contents, nextIdx: i }
}

function parseChunks(
  lines: string[],
  startIdx: number,
  endIdx: number,
): { chunks: UpdateFileChunk[]; nextIdx: number } {
  const chunks: UpdateFileChunk[] = []
  let i = startIdx
  while (i < endIdx && !lines[i].startsWith("***")) {
    if (!lines[i].startsWith("@@")) {
      i++
      continue
    }
    const change_context = lines[i].substring(2).trim()
    i++
    const old_lines: string[] = []
    const new_lines: string[] = []
    let is_end_of_file = false
    while (i < endIdx) {
      const line = lines[i]
      if (line === END_OF_FILE) {
        is_end_of_file = true
        i++
        break
      }
      if (line.startsWith("@@") || line.startsWith("***")) break
      if (line.startsWith(" ")) {
        const text = line.substring(1)
        old_lines.push(text)
        new_lines.push(text)
      } else if (line.startsWith("-")) {
        old_lines.push(line.substring(1))
      } else if (line.startsWith("+")) {
        new_lines.push(line.substring(1))
      }
      i++
    }
    chunks.push({
      old_lines,
      new_lines,
      ...(change_context ? { change_context } : {}),
      ...(is_end_of_file ? { is_end_of_file } : {}),
    })
  }
  return { chunks, nextIdx: i }
}

/** upstream 형식의 패치 텍스트를 hunk 목록으로 파싱한다. */
export function parsePatch(patchText: unknown): Hunk[] {
  if (typeof patchText !== "string" || patchText.trim().length === 0) fail("패치가 비어 있다")
  const cleaned = stripHeredoc(patchText.trim())
  const lines = cleaned.split("\n")
  const beginIdx = lines.findIndex((line) => line.trim() === BEGIN)
  if (beginIdx === -1) fail(`패치 형식이 잘못되었다: ${BEGIN} 가 없다`)
  const endIdx = lines.findIndex((line, index) => index > beginIdx && line.trim() === END)
  if (endIdx === -1) fail(`패치 형식이 잘못되었다: ${END} 가 없다`)

  const hunks: Hunk[] = []
  let i = beginIdx + 1
  while (i < endIdx) {
    const header = parseHeader(lines, i)
    if (!header) {
      i++
      continue
    }
    if (lines[i].startsWith("*** Add File:")) {
      const { contents, nextIdx } = parseAddContent(lines, header.nextIdx, endIdx)
      hunks.push({ type: "add", path: header.filePath, contents })
      i = nextIdx
    } else if (lines[i].startsWith("*** Delete File:")) {
      hunks.push({ type: "delete", path: header.filePath })
      i = header.nextIdx
    } else {
      const { chunks, nextIdx } = parseChunks(lines, header.nextIdx, endIdx)
      hunks.push({ type: "update", path: header.filePath, move_path: header.movePath, chunks })
      i = nextIdx
    }
  }
  return hunks
}

function normalizeUnicode(value: string): string {
  return value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/\u00a0/g, " ")
}

function tryMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: (a: string, b: string) => boolean,
  eof: boolean,
): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length
    if (fromEnd >= startIndex) {
      let matches = true
      for (let j = 0; j < pattern.length; j++) {
        if (!compare(lines[fromEnd + j], pattern[j])) {
          matches = false
          break
        }
      }
      if (matches) return fromEnd
    }
  }
  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    let matches = true
    for (let j = 0; j < pattern.length; j++) {
      if (!compare(lines[i + j], pattern[j])) {
        matches = false
        break
      }
    }
    if (matches) return i
  }
  return -1
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
  if (pattern.length === 0) return -1
  const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof)
  if (exact !== -1) return exact
  const rstrip = tryMatch(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof)
  if (rstrip !== -1) return rstrip
  const trim = tryMatch(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), eof)
  if (trim !== -1) return trim
  return tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
    eof,
  )
}

type Replacement = [start: number, length: number, lines: string[]]

function computeReplacements(originalLines: string[], filePath: string, chunks: UpdateFileChunk[]): Replacement[] {
  const replacements: Replacement[] = []
  let lineIndex = 0
  for (const chunk of chunks) {
    if (chunk.change_context) {
      const contextIdx = seekSequence(originalLines, [chunk.change_context], lineIndex)
      if (contextIdx === -1) throw new Error(`컨텍스트를 찾을 수 없다 '${chunk.change_context}' (${filePath})`)
      lineIndex = contextIdx + 1
    }
    if (chunk.old_lines.length === 0) {
      const insertionIdx =
        originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
          ? originalLines.length - 1
          : originalLines.length
      replacements.push([insertionIdx, 0, chunk.new_lines])
      continue
    }
    let pattern = chunk.old_lines
    let newSlice = chunk.new_lines
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file)
    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1)
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1)
      found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file)
    }
    if (found === -1) {
      throw new Error(`패치할 줄을 찾을 수 없다 (${filePath}):\n${chunk.old_lines.join("\n")}`)
    }
    replacements.push([found, pattern.length, newSlice])
    lineIndex = found + pattern.length
  }
  return replacements.sort((a, b) => a[0] - b[0])
}

function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
  const result = [...lines]
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [startIdx, oldLen, newSegment] = replacements[i]
    result.splice(startIdx, oldLen)
    for (let j = 0; j < newSegment.length; j++) result.splice(startIdx + j, 0, newSegment[j])
  }
  return result
}

/** 원본 텍스트에 update chunk들을 적용한 새 내용을 만든다(쓰기는 하지 않는다). */
export function deriveNewContents(filePath: string, chunks: UpdateFileChunk[], originalText: string): string {
  const originalLines = originalText.split("\n")
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") originalLines.pop()
  const replacements = computeReplacements(originalLines, filePath, chunks)
  const newLines = applyReplacements(originalLines, replacements)
  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") newLines.push("")
  return newLines.join("\n")
}

type PlannedFile = { kind: "file"; rel: string; content: string; onDisk: boolean }
type PlannedDelete = { kind: "delete"; rel: string }
type Planned = PlannedFile | PlannedDelete

function diskFileExists(cwd: string, rel: string): boolean {
  try {
    return lstatSync(resolveInside(cwd, rel)).isFile()
  } catch {
    return false
  }
}

function virtualContent(cwd: string, planned: Map<string, Planned>, rel: string): string {
  const abs = resolveInside(cwd, rel)
  const entry = planned.get(abs)
  if (entry) {
    if (entry.kind === "delete") fail(`삭제된 파일은 수정할 수 없다: ${rel}`)
    return entry.content
  }
  return readFileBounded(abs)
}

/**
 * 패치를 검증·계획한 뒤 적용한다. 모든 hunk의 경로·컨텍스트·크기를 먼저 확인하고,
 * 하나라도 실패하면 파일을 전혀 건드리지 않는다.
 */
export function applyPatch(cwd: string, patchText: unknown): ApplyResult {
  const hunks = parsePatch(patchText)
  if (hunks.length === 0) fail("적용할 파일 변경이 없다")

  const planned = new Map<string, Planned>()
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  const moved: Array<{ from: string; to: string }> = []

  for (const hunk of hunks) {
    if (hunk.type === "add") {
      const content = hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
      const abs = validateWriteTarget(cwd, hunk.path, content)
      planned.set(abs, { kind: "file", rel: hunk.path, content, onDisk: diskFileExists(cwd, hunk.path) })
      added.push(hunk.path)
      continue
    }
    if (hunk.type === "delete") {
      const abs = resolveInside(cwd, hunk.path)
      const prior = planned.get(abs)
      if (prior?.kind === "delete") {
        deleted.push(hunk.path)
        continue
      }
      if (prior?.kind === "file") {
        validateWriteTarget(cwd, hunk.path, "")
        if (!prior.onDisk) {
          planned.delete(abs)
        } else {
          planned.set(abs, { kind: "delete", rel: hunk.path })
        }
        deleted.push(hunk.path)
        continue
      }
      validateDeleteTarget(cwd, hunk.path)
      planned.set(abs, { kind: "delete", rel: hunk.path })
      deleted.push(hunk.path)
      continue
    }

    validateWriteTarget(cwd, hunk.path, "")
    const original = virtualContent(cwd, planned, hunk.path)
    let content: string
    try {
      content = deriveNewContents(hunk.path, hunk.chunks, original)
    } catch (error) {
      fail(error instanceof Error ? error.message : "패치를 적용할 수 없다")
    }
    if (hunk.move_path) {
      const fromAbs = resolveInside(cwd, hunk.path)
      const fromPlanned = planned.get(fromAbs)
      const toAbs = validateWriteTarget(cwd, hunk.move_path, content)
      if (fromAbs === toAbs) fail("같은 경로로 이동할 수 없다")
      if (fromPlanned?.kind === "file" && !fromPlanned.onDisk) {
        planned.delete(fromAbs)
      } else {
        validateDeleteTarget(cwd, hunk.path)
        planned.set(fromAbs, { kind: "delete", rel: hunk.path })
      }
      const toPlanned = planned.get(toAbs)
      const toOnDisk = toPlanned?.kind === "file" ? toPlanned.onDisk : diskFileExists(cwd, hunk.move_path)
      planned.set(toAbs, { kind: "file", rel: hunk.move_path, content, onDisk: toOnDisk })
      modified.push(hunk.move_path)
      deleted.push(hunk.path)
      moved.push({ from: hunk.path, to: hunk.move_path })
    } else {
      const abs = validateWriteTarget(cwd, hunk.path, content)
      const prior = planned.get(abs)
      const onDisk = prior?.kind === "file" ? prior.onDisk : diskFileExists(cwd, hunk.path)
      planned.set(abs, { kind: "file", rel: hunk.path, content, onDisk })
      modified.push(hunk.path)
    }
  }

  // 모든 검증이 끝난 뒤에만 기록한다.
  for (const entry of planned.values()) {
    if (entry.kind === "delete") deleteFileBounded(cwd, entry.rel)
    else writeFileBounded(cwd, entry.rel, entry.content)
  }
  return { added, modified, deleted, moved }
}
