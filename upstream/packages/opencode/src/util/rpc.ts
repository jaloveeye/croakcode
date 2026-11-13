type Definition = {
  [method: string]: (input: any) => any
}

// croakcode: the worker sets its message handler only after its modules load.
// A request posted before that was lost now and then, and the TUI waited on a
// blank screen for an answer that never came. The worker now says when it
// listens (rpc.ready) and the client holds calls until then. A method that
// throws answers with the error instead of never answering.
export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.request") {
      try {
        const result = await rpc[parsed.method](parsed.input)
        postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        postMessage(JSON.stringify({ type: "rpc.result", error: message, id: parsed.id }))
      }
    }
  }
  postMessage(JSON.stringify({ type: "rpc.ready" }))
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  let ready = false
  const held: string[] = []
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.ready") {
      ready = true
      for (const message of held.splice(0)) target.postMessage(message)
      return
    }
    if (parsed.type === "rpc.result") {
      const entry = pending.get(parsed.id)
      if (entry) {
        pending.delete(parsed.id)
        if ("error" in parsed) entry.reject(new Error(parsed.error))
        else entry.resolve(parsed.result)
      }
    }
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        const message = JSON.stringify({ type: "rpc.request", method, input, id: requestId })
        if (ready) target.postMessage(message)
        else held.push(message)
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

export * as Rpc from "./rpc"
