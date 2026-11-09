import { Schema } from "effect"
import { Identifier } from "@/id/id"
import { withStatics } from "@croakcode/core/schema"

// Phase 4 delegation identifiers. Each is issued by the runtime only
// (INV-5.3); none is ever taken from model output or a prompt.

export const PrincipalID = Schema.String.check(Schema.isStartsWith("apr")).pipe(
  Schema.brand("PrincipalID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("principal", id)),
  })),
)
export type PrincipalID = Schema.Schema.Type<typeof PrincipalID>

export const RunID = Schema.String.check(Schema.isStartsWith("run")).pipe(
  Schema.brand("RunID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("run", id)),
  })),
)
export type RunID = Schema.Schema.Type<typeof RunID>

export const GrantID = Schema.String.check(Schema.isStartsWith("grt")).pipe(
  Schema.brand("GrantID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("grant", id)),
  })),
)
export type GrantID = Schema.Schema.Type<typeof GrantID>

export type PrincipalStatus = "active" | "revoked"
export type RunStatus = "running" | "completed" | "aborted"
export type GrantStatus = "active" | "revoked" | "expired"

/** Where a delegatee may act. `paths` are absolute directory roots. */
export type GrantScope = { readonly paths: readonly string[] }

/** Extra restrictions a Grant adds; a child Grant may only add more. */
export type GrantConstraint = { readonly kind: string; readonly value: unknown }

/** The human principal that roots every local delegation chain. */
export const HUMAN_LOCAL = "human:local"
