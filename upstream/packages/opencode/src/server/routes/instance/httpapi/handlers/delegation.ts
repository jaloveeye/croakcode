import { Revocation } from "@/delegation/revocation"
import type { GrantID, PrincipalID } from "@/delegation/schema"
import { ServerAuth } from "@/server/auth"
import { SessionPrompt } from "@/session/prompt"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ForbiddenError } from "../errors"

export const delegationHandlers = HttpApiBuilder.group(InstanceHttpApi, "delegation", (handlers) =>
  Effect.gen(function* () {
    const revocation = yield* Revocation.Service
    const prompt = yield* SessionPrompt.Service
    const auth = yield* ServerAuth.Config

    // Revocation is an admin action. Without a server password every local
    // process could call it, so the routes refuse instead.
    const requireAdmin = Effect.suspend(() =>
      ServerAuth.required(auth)
        ? Effect.void
        : Effect.fail(new ForbiddenError({ message: "Revocation requires CROAKCODE_SERVER_PASSWORD to be set." })),
    )

    // Runs are already closed in the database; cancel what is still in flight.
    const stop = (result: Revocation.Result) =>
      Effect.forEach(result.abortedRuns, (run) => prompt.cancel(run.sessionId), { discard: true }).pipe(
        Effect.as({ revokedGrants: [...result.revokedGrants], abortedRuns: result.abortedRuns.map((run) => ({ ...run })) }),
      )

    const revokeGrant = Effect.fn("DelegationHttpApi.revokeGrant")(function* (ctx: {
      params: { grantID: GrantID }
      payload: { reason?: string }
    }) {
      yield* requireAdmin
      const result = yield* revocation
        .revokeGrant(ctx.params.grantID, ctx.payload.reason ?? "revoked by admin")
        .pipe(Effect.catchTag("DelegationGrantNotFoundError", () => Effect.fail(new HttpApiError.NotFound())))
      return yield* stop(result)
    })

    const revokePrincipal = Effect.fn("DelegationHttpApi.revokePrincipal")(function* (ctx: {
      params: { principalID: PrincipalID }
      payload: { reason?: string }
    }) {
      yield* requireAdmin
      const result = yield* revocation
        .revokePrincipal(ctx.params.principalID, ctx.payload.reason ?? "revoked by admin")
        .pipe(Effect.catchTag("DelegationPrincipalNotFoundError", () => Effect.fail(new HttpApiError.NotFound())))
      return yield* stop(result)
    })

    return handlers.handle("revokeGrant", revokeGrant).handle("revokePrincipal", revokePrincipal)
  }),
)
