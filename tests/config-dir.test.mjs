import test from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";

test(".croakcode/plugins exists (config loader scans .croakcode only)", async () => {
  const s = await stat(new URL("../upstream/.croakcode/plugins", import.meta.url));
  assert.ok(s.isDirectory());
});
