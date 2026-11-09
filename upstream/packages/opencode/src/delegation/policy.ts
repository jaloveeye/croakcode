import { createHmac, timingSafeEqual } from "node:crypto"
import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { Permission } from "../permission"

// Phase 4 Task 4 — organisation policy (the "org max" layer).
//
// The policy is a JSON file named by CROAKCODE_ADMIN_POLICY_FILE, signed with
// HMAC-SHA256 in `<file>.sig` (hex) under CROAKCODE_ADMIN_POLICY_KEY. The
// verification mirrors control/src/admin-policy.mjs; upstream code does not
// import the root control package (dependency rule), so it is reimplemented
// here and kept equal by test.
//
// No file configured: no organisation limit, revision 0. A file configured
// but not verifiable: "invalid", which the effective layer turns into deny.
// The file is read on every load so a policy change applies to the next
// decision (Phase 4 decision: re-intersect with the current policy).
//
// Guarantee: HMAC with a key the client holds stops accidental and
// third-party edits of the policy file. It does not stop a user who holds
// the key; server-side enforcement is the execution permit (Task 9).

const Body = Schema.Struct({
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  rules: Schema.optional(Permission.Ruleset),
  maxDelegationDepth: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export type Loaded =
  | { readonly status: "none"; readonly revision: 0 }
  | {
      readonly status: "valid"
      readonly revision: number
      readonly rules?: Permission.Ruleset
      readonly maxDelegationDepth?: number
    }
  | { readonly status: "invalid"; readonly reason: string }

export function verify(body: string, signature: string, key: string | undefined): boolean {
  if (!key) return false
  try {
    JSON.parse(body)
  } catch {
    return false
  }
  const expected = Buffer.from(createHmac("sha256", key).update(body).digest("hex"), "hex")
  const given = Buffer.from(signature.trim(), "hex")
  if (expected.length !== given.length) return false
  return timingSafeEqual(expected, given)
}

const decode = Schema.decodeUnknownOption(Body)

export function load(env: NodeJS.ProcessEnv = process.env): Loaded {
  const file = env.CROAKCODE_ADMIN_POLICY_FILE
  if (!file) return { status: "none", revision: 0 }
  let body: string
  let signature: string
  try {
    body = readFileSync(file, "utf8")
    signature = readFileSync(`${file}.sig`, "utf8")
  } catch {
    return { status: "invalid", reason: "policy file or signature is unreadable" }
  }
  if (!verify(body, signature, env.CROAKCODE_ADMIN_POLICY_KEY)) {
    return { status: "invalid", reason: "policy signature does not verify" }
  }
  const parsed = decode(JSON.parse(body))
  if (parsed._tag === "None") return { status: "invalid", reason: "policy body has the wrong shape" }
  return {
    status: "valid",
    revision: parsed.value.revision,
    ...(parsed.value.rules ? { rules: parsed.value.rules } : {}),
    ...(parsed.value.maxDelegationDepth !== undefined ? { maxDelegationDepth: parsed.value.maxDelegationDepth } : {}),
  }
}

export * as Policy from "./policy"
