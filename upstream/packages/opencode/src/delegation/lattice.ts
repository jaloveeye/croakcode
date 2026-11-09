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

/** The first probe where `child` decides more loosely than `parent`, if any. */
export function looserProbe(child: Permission.Ruleset, parent: Permission.Ruleset) {
  return probes(child, parent).find((probe) =>
    looser(decide(probe.permission, probe.pattern, child), decide(probe.permission, probe.pattern, parent)),
  )
}

export * as Lattice from "./lattice"
