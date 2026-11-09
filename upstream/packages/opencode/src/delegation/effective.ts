import path from "path"
import { Context, Effect, Layer } from "effect"
import { AppFileSystem } from "@croakcode/core/filesystem"
import { Grants } from "./grants"
import { Lattice, type Action } from "./lattice"
import { Policy } from "./policy"
import { Registry } from "./registry"
import { HUMAN_LOCAL, type RunID } from "./schema"

// Phase 4 Task 4 — effective authorization.
//
//   effective = organisation ∩ principal ∩ parent runs ∩ every grant path ∩ scope
//
// Each layer is evaluated with the existing permission evaluate(); the result
// is the strictest decision (deny < ask < allow). Several delegation paths to
// the same principal intersect (INV-3, no union). Anything that cannot be
// established — a missing run, a revoked principal, an inactive or expired
// grant, an invalid organisation policy — is a deny. This layer only adds
// denies on top of the existing permission engine (monotonic tightening).

export type Layer = "organisation" | "principal" | "parent_run" | "grant" | "scope"

export type Reason =
  | "allowed"
  | "layer_decision"
  | "policy_invalid"
  | "run_inactive"
  | "principal_inactive"
  | "no_grant"
  | "grant_inactive"
  | "out_of_scope"
  | "state_unreadable"

export type Decision = {
  readonly action: Action
  readonly reason: Reason
  /** The layer that produced the strictest decision, when one did. */
  readonly layer?: Layer
  readonly policyRevision: number
}

export type DecideInput = {
  readonly runId: RunID
  readonly permission: string
  readonly pattern: string
  /** An absolute filesystem path the call touches; checked against grant scope. */
  readonly path?: string
  /**
   * A tool-level check made before the tool runs, when its patterns are not
   * known yet. A grant then denies only when it names no non-deny rule for
   * the permission at all, or denies the permission outright; path-scoped
   * grant rules are checked later at the pattern level.
   */
  readonly toolLevel?: boolean
}

export interface Interface {
  readonly decide: (input: DecideInput) => Effect.Effect<Decision>
}

export class Service extends Context.Service<Service, Interface>()("@croakcode/DelegationEffective") {}

/** Bounds the parent-run walk; deeper than any valid chain (max depth 3). */
const MAX_RUN_ANCESTORS = 16

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* Registry.Service
    const grants = yield* Grants.Service

    const evaluate = Effect.fnUntraced(function* (input: DecideInput) {
      const policy = Policy.load()
      if (policy.status === "invalid") {
        return { action: "deny", reason: "policy_invalid", layer: "organisation", policyRevision: -1 } as Decision
      }
      const revision = policy.revision
      const denied = (reason: Reason, layer?: Layer): Decision => ({
        action: "deny",
        reason,
        ...(layer ? { layer } : {}),
        policyRevision: revision,
      })

      let action: Action = "allow"
      let layer: Layer | undefined
      const apply = (next: Action, from: Layer) => {
        const merged = Lattice.stricter(action, next)
        if (merged !== action) {
          action = merged
          layer = from
        }
      }
      type Ruleset = Parameters<typeof Lattice.decide>[2]
      // Organisation policy and a principal's rules restrict: an unnamed
      // point has no opinion there.
      const restrict = (ruleset: Ruleset) => Lattice.decideLayer(input.permission, input.pattern, ruleset, "neutral")
      // A grant is an allow-list: an unnamed point is not delegated.
      const delegated = (ruleset: Ruleset): Action => {
        if (!input.toolLevel) return Lattice.decideLayer(input.permission, input.pattern, ruleset, "deny")
        const outright = Lattice.explicit(input.permission, "*", ruleset)
        if (outright?.action === "deny" && outright.pattern === "*") return "deny"
        const named = ruleset.some(
          (rule) => rule.action !== "deny" && Lattice.explicit(input.permission, rule.pattern, [rule]) !== undefined,
        )
        return named ? "allow" : "deny"
      }

      if (policy.status === "valid" && policy.rules) apply(restrict(policy.rules), "organisation")

      const run = yield* registry.getRun(input.runId)
      if (!run || run.status !== "running") return denied("run_inactive")

      // The run's own principal, then each ancestor run's principal.
      let current: typeof run | undefined = run
      let first = true
      for (let step = 0; current && step < MAX_RUN_ANCESTORS; step++) {
        const principal = yield* registry.getPrincipal(current.principalId)
        if (!principal || principal.status !== "active") return denied("principal_inactive", first ? "principal" : "parent_run")

        // The grant this run started under must still hold, even when the
        // principal has another active grant on a different path.
        if (current.grantId) {
          const own = yield* grants.listChain(current.grantId)
          if (own.length === 0) return denied("grant_inactive", "grant")
          for (const link of own) {
            if (link.status !== "active") return denied("grant_inactive", "grant")
            if (link.expiresAt <= Date.now()) {
              yield* grants.expire(link.id)
              return denied("grant_inactive", "grant")
            }
          }
        }
        apply(restrict(principal.capabilities), first ? "principal" : "parent_run")

        // Every active grant path to a non-root principal, intersected.
        if (principal.ownerId !== HUMAN_LOCAL) {
          const received = (yield* grants.listByDelegatee(principal.id)).filter((grant) => grant.status === "active")
          if (received.length === 0) return denied("no_grant", "grant")
          for (const grant of received) {
            const chain = yield* grants.listChain(grant.id)
            for (const link of chain) {
              if (link.status !== "active") return denied("grant_inactive", "grant")
              if (link.expiresAt <= Date.now()) {
                yield* grants.expire(link.id)
                return denied("grant_inactive", "grant")
              }
              apply(delegated(link.capabilities), "grant")
              if (input.path !== undefined) {
                const inside =
                  path.isAbsolute(input.path) &&
                  link.scope.paths.some((root) => AppFileSystem.contains(root, input.path!))
                if (!inside) return denied("out_of_scope", "scope")
              }
            }
          }
        }

        first = false
        current = current.parentRunId ? yield* registry.getRun(current.parentRunId) : undefined
        if (current === undefined && run.parentRunId && step === 0) {
          // The direct parent run is gone: its effective authority is unknown.
          return denied("run_inactive", "parent_run")
        }
      }

      return {
        action,
        reason: action === "allow" ? "allowed" : "layer_decision",
        ...(layer && action !== "allow" ? { layer } : {}),
        policyRevision: revision,
      } as Decision
    })

    const decide = Effect.fn("DelegationEffective.decide")(function* (input: DecideInput) {
      // State that cannot be read is a deny (Phase 4 decision 4).
      return yield* evaluate(input).pipe(
        Effect.catchDefect(() =>
          Effect.succeed({ action: "deny", reason: "state_unreadable", policyRevision: -1 } as Decision),
        ),
      )
    })

    return Service.of({ decide })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Layer.mergeAll(Registry.defaultLayer, Grants.defaultLayer)))

export * as Effective from "./effective"
