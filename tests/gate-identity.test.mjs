import test from "node:test"
import assert from "node:assert/strict"
import { identityHeaders, server } from "../upstream/.croakcode/plugins/gate-identity.js"

test("identityHeaders carries agent and session", () => {
  assert.deepEqual(identityHeaders({ agent: "dev-main", sessionID: "ses_1" }), {
    "x-croak-agent": "dev-main",
    "x-croak-session": "ses_1",
  })
  assert.deepEqual(identityHeaders({}), {})
})

test("chat.headers hook adds the headers without dropping others", async () => {
  const hooks = await server()
  const output = { headers: { "x-existing": "1" } }
  await hooks["chat.headers"]({ agent: "pr-review", sessionID: "ses_2" }, output)
  assert.deepEqual(output.headers, { "x-existing": "1", "x-croak-agent": "pr-review", "x-croak-session": "ses_2" })
})
