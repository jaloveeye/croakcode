import { GrantID, PrincipalID } from "@/delegation/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ForbiddenError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

// Phase 4 Task 7: revoke delegated authority. Admin-only: the routes refuse
// unless the server password is configured, in addition to Authorization.

const root = "/delegation"
const RevokePayload = Schema.Struct({ reason: Schema.optional(Schema.String) })
const RevokeResult = Schema.Struct({
  revokedGrants: Schema.Array(Schema.String),
  abortedRuns: Schema.Array(Schema.Struct({ runId: Schema.String, sessionId: Schema.String })),
})

export const DelegationApi = HttpApi.make("delegation")
  .add(
    HttpApiGroup.make("delegation")
      .add(
        HttpApiEndpoint.post("revokeGrant", `${root}/grant/:grantID/revoke`, {
          params: { grantID: GrantID },
          query: WorkspaceRoutingQuery,
          payload: RevokePayload,
          success: described(RevokeResult, "Grants revoked and runs stopped"),
          error: [ForbiddenError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "delegation.revokeGrant",
            summary: "Revoke a delegation grant",
            description: "Revoke a grant and every grant below it, and stop the runs started under them.",
          }),
        ),
        HttpApiEndpoint.post("revokePrincipal", `${root}/principal/:principalID/revoke`, {
          params: { principalID: PrincipalID },
          query: WorkspaceRoutingQuery,
          payload: RevokePayload,
          success: described(RevokeResult, "Principal revoked, its grants revoked and runs stopped"),
          error: [ForbiddenError, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "delegation.revokePrincipal",
            summary: "Revoke an agent principal",
            description: "Revoke a principal, every grant it issued or holds, and stop its runs.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "delegation", description: "Phase 4 delegation revocation routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
