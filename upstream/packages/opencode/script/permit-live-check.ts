// PT-07: asks a running croak-gate for an execution permit with croakcode's
// real permit client, then verifies it the way the tool wrappers do.
//
//   CROAKCODE_GATE_PERMIT_URL=https://127.0.0.1:8499 \
//   CROAKCODE_GATE_PERMIT_PUBLIC_KEY=<base64> CROAK_CONFIG_DIR=<dir with session.json> \
//   NODE_EXTRA_CA_CERTS=<ca.crt> bun run script/permit-live-check.ts <sid> <tool> '<args json>'
//
// Prints one JSON line: {"ok": true, ...} or {"ok": false, "reason": ...}.
import { Effect } from "effect"
import { Permit } from "../src/delegation/permit"
import { PermitClient } from "../src/delegation/permit-client"

const [sid = "ses_live_check", tool = "read", rawArgs = '{"filePath":"/tmp/x"}'] = process.argv.slice(2)
const config = Permit.loadConfig({ ...process.env, CROAKCODE_EXECUTION_PERMIT: "required" })
if (!config.enabled || !config.publicKey || !config.url) {
  console.log(JSON.stringify({ ok: false, reason: "missing CROAKCODE_GATE_PERMIT_URL or CROAKCODE_GATE_PERMIT_PUBLIC_KEY" }))
  process.exit(2)
}
const expected = { sid, pid: "apr_live_check", rid: "run_live_check", tool, args: Permit.argsHash(JSON.parse(rawArgs)) }
const outcome = await Effect.runPromiseExit(
  Effect.gen(function* () {
    return yield* (yield* PermitClient.Service).request(config.url!, { ...expected, rev: 0 })
  }).pipe(Effect.provide(PermitClient.defaultLayer)),
)
if (outcome._tag === "Failure") {
  console.log(JSON.stringify({ ok: false, reason: "request_failed", detail: String(outcome.cause) }))
  process.exit(1)
}
const verdict = Permit.verify(outcome.value, expected, { publicKey: config.publicKey, nonces: new Permit.NonceStore() })
console.log(
  JSON.stringify(
    verdict.ok
      ? { ok: true, tool: verdict.payload.tool, ttl: verdict.payload.exp - verdict.payload.iat }
      : { ok: false, reason: verdict.reason },
  ),
)
process.exit(verdict.ok ? 0 : 1)
