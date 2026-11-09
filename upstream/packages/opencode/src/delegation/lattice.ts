import { Wildcard } from "@croakcode/core/util/wildcard"
import { Permission } from "../permission"

// Decision order for delegation layers: deny is the strictest, allow the
// loosest. Phase 4 combines layers by taking the strictest decision, never
// the loosest (no union amplification, INV-3).

export type Action = "allow" | "ask" | "deny"

const rank: Record<Action, number> = { deny: 0, ask: 1, allow: 2 }

export function stricter(a: Action, b: Action): Action {
  return rank[a] <= rank[b] ? a : b
}

export function looser(a: Action, b: Action): boolean {
  return rank[a] > rank[b]
}

export function decide(permission: string, pattern: string, ruleset: Permission.Ruleset): Action {
  return Permission.evaluate(permission, pattern, ruleset).action
}

/**
 * Every (permission, pattern) pair named by a rule in any of the rulesets.
 * Comparing two rulesets on these points catches the cases a rule-by-rule
 * comparison misses, such as a child `read *` against a parent
 * `read /secret/*` deny. It does not enumerate every wildcard overlap, so it
 * is an issuance guard; the execution-time intersection (Task 4) is the
 * enforcement.
 */
export function probes(...rulesets: Permission.Ruleset[]) {
  const seen = new Set<string>()
  const out: { permission: string; pattern: string }[] = []
  for (const rule of rulesets.flat()) {
    const key = `${rule.permission}\u0000${rule.pattern}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ permission: rule.permission, pattern: rule.pattern })
  }
  return out
}

/** The last rule in `ruleset` that matches the point, if one does. */
export function explicit(permission: string, pattern: string, ruleset: Permission.Ruleset) {
  return ruleset.findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))
}

/**
 * How a layer reads a point none of its rules names. A restriction layer
 * (organisation policy, a principal's own rules) has no opinion there. A
 * grant is an allow-list: what it does not name, it does not delegate.
 */
export type Unmatched = "neutral" | "deny"

export function decideLayer(
  permission: string,
  pattern: string,
  ruleset: Permission.Ruleset,
  unmatched: Unmatched,
): Action {
  const rule = explicit(permission, pattern, ruleset)
  if (rule) return rule.action
  return unmatched === "deny" ? "deny" : "allow"
}

/**
 * The first probe where `child` lets through something `source` denies.
 *
 * Delegation layers are enforced as denies only: an allow or ask passes to
 * the existing permission engine. So a grant escalates exactly when its
 * source denies a point and the grant names that point without denying it.
 * A point the grant does not name is a deny for an allow-list grant, so it
 * cannot escalate.
 */
export function looserProbe(child: Permission.Ruleset, source: Permission.Ruleset, sourceUnmatched: Unmatched) {
  return probes(child, source).find((probe) => {
    const rule = explicit(probe.permission, probe.pattern, child)
    if (!rule || rule.action === "deny") return false
    return decideLayer(probe.permission, probe.pattern, source, sourceUnmatched) === "deny"
  })
}

export * as Lattice from "./lattice"
