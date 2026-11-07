import { expect, test } from "bun:test"
import { wrapSSE } from "../../src/provider/provider"
import { ResponseStreamError } from "../../src/provider/error"

test("an SSE timeout before any data is retryable", async () => {
  const source = new ReadableStream<Uint8Array>({ pull() {} })
  const response = wrapSSE(new Response(source, { headers: { "content-type": "text/event-stream" } }), 20, new AbortController())
  const error = await response.body!.getReader().read().catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ResponseStreamError)
})

test("an SSE timeout after data is not automatically retryable", async () => {
  let sent = false
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return
      sent = true
      controller.enqueue(new TextEncoder().encode("data: partial\n\n"))
    },
  })
  const response = wrapSSE(new Response(source, { headers: { "content-type": "text/event-stream" } }), 20, new AbortController())
  const reader = response.body!.getReader()
  await reader.read()
  const error = await reader.read().catch((e: unknown) => e)
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(ResponseStreamError)
})
