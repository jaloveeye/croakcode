import { Context, Effect, Layer, Schema } from "effect"
import { accessToken } from "../../../../.croakcode/plugins/lib/croak-auth-session.js"

// Phase 4 Task 9 — asks Gate for an execution permit for one tool call.
// Request: POST {CROAKCODE_GATE_PERMIT_URL}/v1/execution-permits with the
// croak login token, body {sid, pid, rid, tool, args, rev}. Response: {token}.
// The protocol is documented in
// docs/superpowers/architecture/2026-11-09-execution-permit-protocol.md.

export const REQUEST_TIMEOUT_MS = 10_000

export type PermitRequest = {
  readonly sid: string
  readonly pid: string
  readonly rid: string
  readonly tool: string
  readonly args: string
  readonly rev: number
}

export class PermitRequestError extends Schema.TaggedErrorClass<PermitRequestError>()("PermitRequestError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Execution permit request failed: ${this.reason}`
  }
}

export interface Interface {
  readonly request: (url: string, body: PermitRequest) => Effect.Effect<string, PermitRequestError>
}

export class Service extends Context.Service<Service, Interface>()("@croakcode/DelegationPermitClient") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    request: (url, body) =>
      Effect.tryPromise({
        try: async () => {
          const token = await accessToken()
          if (!token) throw new Error("not logged in to croak")
          const response = await fetch(`${url}/v1/execution-permits`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
          if (!response.ok) throw new Error(`gate answered ${response.status}`)
          const json = (await response.json()) as { token?: unknown }
          if (typeof json.token !== "string" || !json.token) throw new Error("gate answered without a token")
          return json.token
        },
        catch: (error) => new PermitRequestError({ reason: error instanceof Error ? error.message : String(error) }),
      }),
  }),
)

export const defaultLayer = layer

export * as PermitClient from "./permit-client"
