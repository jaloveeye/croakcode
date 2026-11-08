import test from "node:test";
import assert from "node:assert/strict";
import { verifyAdminPolicy, signAdminPolicy } from "@croakcode/control";

const KEY = Buffer.from("test-hmac-key");
const body = JSON.stringify({ agents: { "dev-safe": { force: "gate", requiresAuth: true } } });

test("valid signature verifies", () => {
  const signature = signAdminPolicy(body, KEY);
  assert.equal(verifyAdminPolicy(body, signature, { key: KEY }), true);
});

test("tampered body with stale signature fails", () => {
  const signature = signAdminPolicy(body, KEY);
  assert.equal(verifyAdminPolicy(body + " ", signature, { key: KEY }), false);
});

test("tampered body WITH recomputed HMAC using wrong key fails", () => {
  const tampered = body.replace('"gate"', '"direct"');
  const wrongKey = Buffer.from("wrong-hmac-key");
  const signature = signAdminPolicy(tampered, wrongKey);
  assert.equal(verifyAdminPolicy(tampered, signature, { key: KEY }), false);
});

test("malformed policy fails even with valid signature", () => {
  const bad = "not json";
  const signature = signAdminPolicy(bad, KEY);
  assert.equal(verifyAdminPolicy(bad, signature, { key: KEY }), false);
});

// Fail-closed when the key is missing: verification must return false, not throw.
// An empty key is rejected too, because anyone can compute an HMAC with it.
test("missing or empty key fails closed without throwing", () => {
  const signature = signAdminPolicy(body, KEY);
  for (const opts of [undefined, {}, { key: undefined }, { key: null }, { key: "" }, { key: Buffer.alloc(0) }, { key: 42 }]) {
    assert.equal(verifyAdminPolicy(body, signature, opts), false, `opts=${JSON.stringify(opts)}`);
  }
});

test("signature with an empty key cannot verify", () => {
  const forged = signAdminPolicy(body, "");
  assert.equal(verifyAdminPolicy(body, forged, { key: "" }), false);
});
