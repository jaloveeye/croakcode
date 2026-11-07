import { PartID } from "@/session/schema"
import type { PromptInfo } from "./history"
import { displaySlice } from "@/cli/cmd/prompt-display"

type Item = PromptInfo["parts"][number]

export function strip(part: Item & { id: string; messageID: string; sessionID: string }): Item {
  const { id: _id, messageID: _messageID, sessionID: _sessionID, ...rest } = part
  return rest
}

export function assign(part: Item): Item & { id: PartID } {
  return {
    ...part,
    id: PartID.ascending(),
  }
}

export function expandPastedTextPlaceholders(text: string, parts: PromptInfo["parts"]) {
  return parts.reduce((result, part) => {
    if (part.type !== "text" || !part.source?.text) return result
    return result.replace(part.source.text.value, part.text)
  }, text)
}

/**
 * Replaces placeholder ranges in prompt input with their text. Ranges are textarea
 * offsets, which count display width, so a wide character such as Korean takes two.
 */
export function expandPlaceholderRanges(input: string, ranges: { start: number; end: number; text: string }[]) {
  return ranges
    .toSorted((a, b) => b.start - a.start)
    .reduce((result, range) => displaySlice(result, 0, range.start) + range.text + displaySlice(result, range.end), input)
}
