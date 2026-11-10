import { statSync } from "fs"
import type { MessageV2 } from "@/session/message-v2"
import { AppFileSystem } from "@croakcode/core/filesystem"

// Phase 5 Task 5: edit and write change an existing file only after it was
// read in this session and has not changed since. The state is the file's
// modification time and size when it was last read or written.
//
// Two sources: a process map, updated as soon as a read, edit or write
// finishes (several edits in one answer see each other), and the tool
// results stored in the session (the state survives a restart).

export type Stamp = { readonly path: string; readonly mtimeMs: number; readonly size: number }

/** Key under which read, edit and write store their stamp in tool metadata. */
export const METADATA_KEY = "fileStamp"

const recent = new Map<string, Stamp>()
const key = (sessionID: string, filepath: string) => `${sessionID}\u0000${AppFileSystem.normalizePath(filepath)}`

/** The file's current stamp, or undefined when it does not exist. */
export function current(filepath: string): Stamp | undefined {
  try {
    const stat = statSync(filepath)
    if (!stat.isFile()) return undefined
    return { path: AppFileSystem.normalizePath(filepath), mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return undefined
  }
}

/** Records that the session has seen the file as it is now; returns the stamp for tool metadata. */
export function remember(sessionID: string, filepath: string): Stamp | undefined {
  const stamp = current(filepath)
  if (stamp) recent.set(key(sessionID, filepath), stamp)
  return stamp
}

/** The last stamp this session recorded for the file, from memory or from stored tool results. */
export function last(sessionID: string, filepath: string, messages: readonly MessageV2.WithParts[]): Stamp | undefined {
  const inMemory = recent.get(key(sessionID, filepath))
  if (inMemory) return inMemory
  const target = AppFileSystem.normalizePath(filepath)
  for (const message of [...messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const stamp = (part.state.metadata as Record<string, unknown> | undefined)?.[METADATA_KEY] as Stamp | undefined
      if (stamp?.path === target) return stamp
    }
  }
  return undefined
}

export type Verdict = "ok" | "unread" | "changed"

/** Whether an existing file may be changed now. A file that does not exist yet is always "ok". */
export function check(sessionID: string, filepath: string, messages: readonly MessageV2.WithParts[]): Verdict {
  const now = current(filepath)
  if (!now) return "ok"
  const seen = last(sessionID, filepath, messages)
  if (!seen) return "unread"
  return seen.mtimeMs === now.mtimeMs && seen.size === now.size ? "ok" : "changed"
}

/** The error shown to the model when check() refuses. */
export function refusal(verdict: Exclude<Verdict, "ok">, filepath: string) {
  return verdict === "unread"
    ? `You have not read ${filepath} in this session. Read it with the read tool before changing it.`
    : `${filepath} has changed since you last read it. Read it again before changing it.`
}

export * as ReadState from "./read-state"
