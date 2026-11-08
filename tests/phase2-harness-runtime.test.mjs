import test from "node:test";
import assert from "node:assert/strict";
import { shouldExposeTool, resolveHarnessInclusion } from "@croakcode/contracts";

test("shouldExposeTool is fail-closed", () => {
  assert.equal(shouldExposeTool("allow"), true);
  assert.equal(shouldExposeTool("ask"), true);
  assert.equal(shouldExposeTool("deny"), false);
  assert.equal(shouldExposeTool(undefined), false);
  assert.equal(shouldExposeTool(null), false);
  assert.equal(shouldExposeTool("not_applicable"), false);
  assert.equal(shouldExposeTool("typo"), false);
  assert.equal(shouldExposeTool(""), false);
});

test("contract inclusion agrees with exposure for allow/ask/deny", () => {
  assert.equal(resolveHarnessInclusion("allow"), "include");
  assert.equal(resolveHarnessInclusion("ask"), "include_requires_approval");
  assert.equal(resolveHarnessInclusion("deny"), "exclude");
  assert.equal(shouldExposeTool("deny"), false);
});
