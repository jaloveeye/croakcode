import type { MessageV2 } from "./message-v2"

// Phase 5 Task 3: recover from two output patterns that mid-size self-hosted
// models produce now and then. Both are bounded: one retry per turn, one
// level of unwrapping.

/** Finish reasons after which an empty answer is worth one more try. */
const RETRYABLE_FINISH = new Set(["stop", "other", "unknown"])

/**
 * True when the model ended its turn without any answer text and without a
 * tool call. A turn cut by the length limit, a content filter or an error is
 * not empty in this sense: asking again would end the same way.
 */
export function isEmptyAnswer(finish: string | undefined, hasError: boolean, parts: readonly MessageV2.Part[]) {
  if (hasError) return false
  if (!finish || !RETRYABLE_FINISH.has(finish)) return false
  return !parts.some(
    (part) =>
      part.type === "tool" ||
      part.type === "file" ||
      (part.type === "text" && !part.synthetic && part.text.trim().length > 0),
  )
}

/**
 * Tool arguments that arrived as a JSON string holding the object, e.g.
 * "{\"filePath\":\"a.ts\"}" instead of {"filePath":"a.ts"}. Returns the
 * object; any other value is returned unchanged for the schema to judge.
 */
export function unwrapStringifiedArgs(args: unknown): unknown {
  if (typeof args !== "string") return args
  const parsed = parseJson(args)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return args
  return parsed
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export * as Anomaly from "./anomaly"
