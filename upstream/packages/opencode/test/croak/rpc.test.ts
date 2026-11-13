import { expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"

// A fake worker: records what the client posts, and can answer.
function fakeWorker() {
  const posted: any[] = []
  const target = {
    onmessage: null as any,
    postMessage: (data: string) => void posted.push(JSON.parse(data)),
  }
  const send = (message: unknown) => target.onmessage({ data: JSON.stringify(message) })
  return { target, posted, send }
}

test("calls wait until the worker says it listens", async () => {
  const { target, posted, send } = fakeWorker()
  const client = Rpc.client<{ ping: (n: number) => number }>(target as any)
  const answer = client.call("ping", 1)
  expect(posted).toEqual([])
  await send({ type: "rpc.ready" })
  expect(posted).toEqual([{ type: "rpc.request", method: "ping", input: 1, id: 0 }])
  await send({ type: "rpc.result", id: 0, result: 2 })
  expect(await answer).toBe(2)
})

test("an error in the worker rejects the call", async () => {
  const { target, send } = fakeWorker()
  const client = Rpc.client<{ ping: (n: number) => number }>(target as any)
  await send({ type: "rpc.ready" })
  const answer = client.call("ping", 1)
  await send({ type: "rpc.result", id: 0, error: "boom" })
  await expect(answer).rejects.toThrow("boom")
})
