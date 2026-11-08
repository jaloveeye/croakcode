import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveIdleTimeout,
  shouldRetryAfterIdle,
  STREAM_GUARD_DEFAULTS,
  STREAM_IDLE_ERROR_CODE,
  STREAM_TIMEOUT_PHASES,
} from "@croakcode/contracts";

test("compaction idle guard is always on with a default", () => {
  assert.equal(resolveIdleTimeout("compaction", {}), 120_000);
  assert.equal(resolveIdleTimeout("compaction", { bodyIdleTimeoutMs: 0 }), 120_000);
  assert.equal(resolveIdleTimeout("compaction", { bodyIdleTimeoutMs: 30_000 }), 30_000);
});

test("normal stream can be explicitly disabled but defaults on", () => {
  assert.equal(resolveIdleTimeout("stream", {}), 60_000);
  assert.equal(resolveIdleTimeout("stream", { bodyIdleTimeoutMs: 0 }), 0);
  assert.equal(resolveIdleTimeout("stream", { bodyIdleTimeoutMs: 15_000 }), 15_000);
});

test("compaction never auto-retries after idle", () => {
  assert.equal(shouldRetryAfterIdle("compaction"), false);
  assert.equal(shouldRetryAfterIdle("stream"), true);
});

test("stream guard declares phases, defaults, and error code", () => {
  assert.deepEqual(STREAM_TIMEOUT_PHASES, ["head", "body_idle"]);
  assert.equal(STREAM_IDLE_ERROR_CODE, "STREAM_IDLE_TIMEOUT");
  assert.equal(STREAM_GUARD_DEFAULTS.compaction.alwaysOn, true);
});
