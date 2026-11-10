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

/** Files smaller than this are read again: the notice is about 250 characters. */
export const MIN_DEDUP_BYTES = 2048

/**
 * Phase 5 Task 6: an earlier read of the same file and range whose output the
 * model still sees, with the file unchanged since. Returns that read's start
 * time, or undefined when the file must be read again: no read of that range,
 * the file changed, or the earlier output is gone (compacted away or pruned).
 * Reads of other ranges in between are skipped: they do not hide the earlier
 * output, and any change to the file shows in the stamp.
 */
export function unchangedRead(
  messages: readonly MessageV2.WithParts[],
  filepath: string,
  args: { readonly offset?: unknown; readonly limit?: unknown },
  minBytes = MIN_DEDUP_BYTES,
): number | undefined {
  const now = current(filepath)
  // A small file costs about as much as the notice; just read it again.
  if (!now || now.size < minBytes) return undefined
  for (const message of [...messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (part.type !== "tool" || part.tool !== "read" || part.state.status !== "completed") continue
      if (part.state.time.compacted) continue
      const metadata = part.state.metadata as Record<string, unknown> | undefined
      // A notice carries no content; only a read that returned the file counts.
      if (metadata?.unchanged === true) continue
      const stamp = metadata?.[METADATA_KEY] as Stamp | undefined
      if (stamp?.path !== now.path) continue
      const input = part.state.input as { offset?: unknown; limit?: unknown }
      if (input.offset !== args.offset || input.limit !== args.limit) continue
      return stamp.mtimeMs === now.mtimeMs && stamp.size === now.size ? part.state.time.start : undefined
    }
  }
  return undefined
}

/** What read returns instead of the content when unchangedRead() found one. */
export function unchangedNotice(filepath: string, readAt: number) {
  const at = new Date(readAt).toISOString().slice(11, 19)
  return `${filepath} has not changed since you read it at ${at} UTC (same range). Its content is above in this conversation; use that instead of reading again.`
}

/** The error shown to the model when check() refuses. */
export function refusal(verdict: Exclude<Verdict, "ok">, filepath: string) {
  return verdict === "unread"
    ? `You have not read ${filepath} in this session. Read it with the read tool before changing it.`
    : `${filepath} has changed since you last read it. Read it again before changing it.`
}

export * as ReadState from "./read-state"
