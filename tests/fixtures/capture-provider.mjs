// Fake OpenAI-compatible endpoint that records what was actually sent.
// Used by tests/phase3-context-e2e.test.mjs to inspect the final request
// payload and headers after the real MessageV2 conversion.
import { createServer } from "node:http"

export function createCaptureProvider() {
  const captured = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      captured.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
  })
  return {
    captured,
    listen: () =>
      new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
