import type { openGate } from "./gate"

export interface Call {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export type Message = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: Call[]
  tool_call_id?: string
}

const MODEL = "croak"
const TIMEOUT_MS = 90_000
const MAX_BUFFER_BYTES = 512 * 1024

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read",
      parameters: {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
        additionalProperties: false,
      },
    },
  },
]

const TOOL_CHOICE = { type: "function", function: { name: "read" } }

function httpError(status: number): Error {
  return new Error(`chat request failed: HTTP ${status}`)
}

function streamError(reason: string): Error {
  return new Error(`chat stream invalid: ${reason}`)
}

type ToolCallState = { id: string; name: string; args: string }

type StreamResult = {
  text: string
  calls: Call[]
  finishReason: string | null
}

function parseEvent(data: string, state: { text: string; call: ToolCallState | null; finishReason: string | null }): boolean {
  if (data === "[DONE]") return true

  let chunk: unknown
  try {
    chunk = JSON.parse(data)
  } catch {
    throw streamError("malformed JSON event")
  }
  if (!chunk || typeof chunk !== "object") throw streamError("event is not an object")

  const record = chunk as Record<string, unknown>
  if (record.error !== undefined && record.error !== null) throw streamError("event reported an error")

  const choices = record.choices
  if (choices === undefined) return false
  if (!Array.isArray(choices)) throw streamError("choices is not an array")
  if (choices.length === 0) return false

  for (const choice of choices) {
    if (!choice || typeof choice !== "object") throw streamError("choice is not an object")
    const c = choice as Record<string, unknown>
    if (c.index !== 0) continue

    if (state.finishReason !== null) throw streamError("delta after finish")

    const delta = c.delta
    if (delta && typeof delta === "object") {
      const d = delta as Record<string, unknown>
      if (typeof d.content === "string" && d.content.length > 0) {
        state.text += d.content
      }
      const toolCalls = d.tool_calls
      if (toolCalls !== undefined) {
        if (!Array.isArray(toolCalls)) throw streamError("tool_calls is not an array")
        for (const raw of toolCalls) {
          if (!raw || typeof raw !== "object") throw streamError("tool call is not an object")
          const tc = raw as Record<string, unknown>
          if (tc.index !== 0) throw streamError("multiple tool calls are not supported")
          if (!state.call) state.call = { id: "", name: "", args: "" }
          const call = state.call
          if (typeof tc.id === "string" && tc.id.length > 0) call.id += tc.id
          const fn = tc.function
          if (fn && typeof fn === "object") {
            const f = fn as Record<string, unknown>
            if (typeof f.name === "string" && f.name.length > 0) call.name += f.name
            if (typeof f.arguments === "string") call.args += f.arguments
          }
        }
      }
    }

    if (typeof c.finish_reason === "string" && c.finish_reason.length > 0) {
      if (state.finishReason !== null) throw streamError("duplicate finish reason")
      state.finishReason = c.finish_reason
    }
  }

  return false
}

async function readStream(response: Response): Promise<StreamResult> {
  if (!response.body) throw streamError("missing body")

  const reader = response.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const state: { text: string; call: ToolCallState | null; finishReason: string | null } = {
    text: "",
    call: null,
    finishReason: null,
  }

  let buffer = ""
  let total = 0
  let done = false
  let sawDone = false

  const consume = (event: string): boolean => {
    const lines = event.split("\n")
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith("data:")) {
        let value = line.slice(5)
        if (value.startsWith(" ")) value = value.slice(1)
        dataLines.push(value)
      }
    }
    if (dataLines.length === 0) return false
    return parseEvent(dataLines.join("\n"), state)
  }

  try {
    while (!done) {
      const { value, done: eof } = await reader.read()
      if (eof) break
      if (!value) continue

      total += value.byteLength
      if (total > MAX_BUFFER_BYTES) throw streamError("response too large")

      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, "\n")

      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (consume(event)) {
          sawDone = true
          done = true
          break
        }
        boundary = buffer.indexOf("\n\n")
      }
    }

    if (!done) {
      buffer += decoder.decode()
      buffer = buffer.replace(/\r\n/g, "\n")
      if (buffer.trim().length > 0) {
        if (consume(buffer)) sawDone = true
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 취소 실패는 무시한다
    }
  }

  if (!sawDone && state.finishReason === null) throw streamError("stream ended without finish")

  const calls: Call[] = []
  if (state.call) {
    if (!state.call.id) throw streamError("tool call id missing")
    if (!state.call.name) throw streamError("tool call name missing")
    if (!TOOLS.some((tool) => tool.function.name === state.call!.name)) {
      throw streamError("unknown tool call name")
    }
    calls.push({
      id: state.call.id,
      type: "function",
      function: { name: state.call.name, arguments: state.call.args },
    })
  }

  return { text: state.text, calls, finishReason: state.finishReason }
}

export async function completion(
  gate: ReturnType<typeof openGate>,
  ids: { sid: string; rid: string },
  messages: Message[],
  first: boolean,
  options?: { tools?: unknown[]; toolChoice?: unknown; expect?: "tool" | "stop" | "any" },
): Promise<{ text: string; calls: Call[] }> {
  const tools = options?.tools ?? TOOLS
  const toolChoice = options?.toolChoice ?? TOOL_CHOICE
  const expect = options?.expect ?? (first ? "tool" : "stop")
  const body: Record<string, unknown> = {
    model: MODEL,
    stream: true,
    messages,
  }
  if (expect === "tool") {
    body.tools = tools
    body.tool_choice = toolChoice
  } else if (tools.length > 0) {
    body.tools = tools
  }

  let response: Response
  try {
    response = await gate.post("/v1/chat/completions", body, ids, TIMEOUT_MS)
  } catch (error) {
    const status = (error as { status?: unknown }).status
    if (typeof status === "number") throw httpError(status)
    throw new Error("chat request failed")
  }

  if (!response.ok) throw httpError(response.status)

  const result = await readStream(response)

  if (expect === "tool") {
    if (result.finishReason !== "tool_calls") throw streamError("expected tool_calls finish")
    if (result.calls.length === 0) throw streamError("missing tool call")
  } else if (expect === "stop") {
    if (result.finishReason !== "stop") throw streamError("expected stop finish")
    if (result.calls.length > 0) throw streamError("unexpected tool call")
    if (result.text.trim().length === 0) throw streamError("empty response text")
  }

  return { text: result.text, calls: result.calls }
}

/** 세션 모드용: 도구를 여러 번 호출할 수 있는 한 턴. execute는 도구 이름별 실행기다. */
export async function chatTurn(
  gate: ReturnType<typeof openGate>,
  ids: { sid: string; rid: string },
  messages: Message[],
  tools: unknown[],
  execute: (call: Call) => Promise<string>,
  maxRounds = 8,
): Promise<{ text: string; messages: Message[] }> {
  const history = [...messages]
  for (let round = 0; round < maxRounds; round++) {
    const result = await completion(gate, ids, history, round === 0, {
      tools,
      toolChoice: "auto",
      expect: "any",
    })
    const assistant: Message = {
      role: "assistant",
      content: result.text.length > 0 ? result.text : null,
      tool_calls: result.calls.length > 0 ? result.calls : undefined,
    }
    history.push(assistant)
    if (result.calls.length === 0) return { text: result.text, messages: history }
    for (const call of result.calls) {
      const toolMessage: Message = { role: "tool", content: await execute(call), tool_call_id: call.id }
      history.push(toolMessage)
    }
  }
  return { text: "도구 호출이 너무 많아 턴을 종료했다.", messages: history }
}
