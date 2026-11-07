/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { GlobalEvent } from "@croakcode/sdk/v2"
import { onMount } from "solid-js"
import { SDKProvider } from "@/cli/cmd/tui/context/sdk"
import { ProjectProvider } from "@/cli/cmd/tui/context/project"
import { PermissionModeProvider, usePermissionMode } from "@/cli/cmd/tui/context/permission"
import { createEventSource, json, wait } from "./sync-fixture"

function permission(id: string): GlobalEvent {
  return {
    directory: "global",
    payload: {
      id: `event-${id}`,
      type: "permission.asked",
      properties: {
        id,
        sessionID: "session-1",
        permission: "bash",
        patterns: ["echo test"],
        metadata: {},
        always: [],
      },
    },
  }
}

test("automatic permission mode approves pending and future requests once", async () => {
  const events = createEventSource()
  const replies: Array<{ path: string; body: unknown }> = []
  let mode!: ReturnType<typeof usePermissionMode>
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    replies.push({
      path: new URL(request.url).pathname,
      body: await request.json(),
    })
    return json(true)
  }) as typeof globalThis.fetch

  function Probe() {
    const value = usePermissionMode()
    onMount(() => {
      mode = value
      mounted()
    })
    return <box />
  }

  const app = await testRender(() => (
    <SDKProvider url="http://test" directory="/tmp/opencode" fetch={fetch} events={events.source}>
      <ProjectProvider>
        <PermissionModeProvider>
          <Probe />
        </PermissionModeProvider>
      </ProjectProvider>
    </SDKProvider>
  ))

  try {
    await ready
    await app.renderOnce()
    events.emit(permission("permission-1"))
    await Bun.sleep(20)
    expect(replies).toHaveLength(0)

    expect(mode.toggle()).toBe("auto")
    await wait(() => replies.length === 1)
    expect(replies[0]).toEqual({
      path: "/permission/permission-1/reply",
      body: {
        reply: "once",
      },
    })

    events.emit(permission("permission-2"))
    await wait(() => replies.length === 2)
    expect(replies[1]?.path).toBe("/permission/permission-2/reply")

    expect(mode.toggle()).toBe("ask")
    events.emit(permission("permission-3"))
    await Bun.sleep(20)
    expect(replies).toHaveLength(2)
  } finally {
    app.renderer.destroy()
  }
})
