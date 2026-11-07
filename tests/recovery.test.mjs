import test from "node:test";
import assert from "node:assert/strict";
import { runWithRecovery, recoverOnResume, canAutoReexecute } from "@croakcode/control";

function makeStore() {
  const commits = [];
  return {
    commits,
    async commitRunning(id) {
      commits.push({ kind: "running", id });
    },
    async commitResult(id, state) {
      commits.push({ kind: "result", id, state });
    },
  };
}

test("T1 running is committed BEFORE execute, T2 result AFTER", async () => {
  const store = makeStore();
  const state = await runWithRecovery(
    { id: "run-1", traits: { hasSideEffects: false, reexecutionSafe: true } },
    store,
    async () => ({ ok: true }),
  );
  assert.equal(store.commits[0].kind, "running");
  assert.equal(store.commits[1].kind, "result");
  assert.equal(store.commits[1].state, "succeeded");
  assert.equal(state, "succeeded");
});

test("process dies between T1 and T2 => running survives => resume yields unknown", async () => {
  const commits = [];
  const store = {
    async commitRunning(id) {
      commits.push({ kind: "running", id });
    },
    async commitResult(id, state) {
      // Simulate a crash: the T2 write never lands, the process dies.
      throw new Error("process died before T2");
    },
  };
  await assert.rejects(() =>
    runWithRecovery(
      { id: "run-2", traits: { hasSideEffects: false, reexecutionSafe: true } },
      store,
      async () => ({ ok: true }),
    ),
  );
  assert.equal(commits.some((c) => c.kind === "result"), false);
  assert.equal(commits.some((c) => c.kind === "running"), true);
  assert.equal(recoverOnResume("running"), "unknown");
});

test("side-effect tool never auto-reexecutes, even if marked reexecutionSafe", () => {
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: true, reexecutionSafe: true }), false);
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: true, reexecutionSafe: false }), false);
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: false, reexecutionSafe: true }), true);
  assert.equal(canAutoReexecute("unknown", { hasSideEffects: false, reexecutionSafe: false }), false);
});
