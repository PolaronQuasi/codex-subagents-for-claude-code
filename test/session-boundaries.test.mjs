import assert from "node:assert/strict";
import test from "node:test";
import { CodexSession } from "../src/codex/session.mjs";
import { compactNotification } from "../src/codex/compact.mjs";
import { selectCodex } from "../src/codex/cli.mjs";
import { fixture } from "./support/codex-fixture.mjs";

test("session close refuses surviving descendants even when the root stopped", async () => {
  let elapsed = 0;
  const checkpoints = [];
  const session = new CodexSession(
    {},
    {
      checkpoint: (patch) => checkpoints.push(patch),
      timing: {
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
      },
      processes: { stop: async () => ({ state: "stopped", detail: "owned descendants remain" }) },
    },
  );
  session.child = {
    pid: 42,
    stdin: { end() {} },
    stdout: { destroy() {} },
    stderr: { destroy() {} },
    kill() {},
  };
  session.childStart = "owned-start";
  session.exit = Promise.resolve();
  await assert.rejects(session.close(), { code: "STOP_INCOMPLETE" });
  assert.ok(checkpoints.some((p) => p.shutdownIncomplete));
});

test("lost turn acknowledgement preserves submission uncertainty for history reconciliation", async (t) => {
  const f = fixture(t);
  const checkpoints = [];
  const session = new CodexSession(
    {
      model: "gpt-6.1-sol",
      effort: "low",
      cwd: process.cwd(),
      progress: "off",
      write: false,
      codex: await selectCodex(f.env, f.work),
    },
    { checkpoint: (patch) => checkpoints.push(patch) },
  );
  session.open = async () => {};
  session.checkModel = async () => {};
  session.request = async (method) => {
    if (method === "thread/start")
      return {
        thread: { id: "fake-thread" },
        model: "gpt-6.1-sol",
        approvalPolicy: "never",
        sandbox: { type: "readOnly" },
      };
    if (method === "turn/start") throw new Error("reply lost after dispatch");
    return {};
  };
  const result = await session.run("task");
  assert.ok(checkpoints.some((p) => p.dispatching));
  assert.equal(result.error.code, "SUBMISSION_UNCERTAIN");
});

test("null notification parameters are harmless before and during compaction", () => {
  const session = new CodexSession({});
  session.threadId = "thread";
  session.turnId = "turn";
  for (const compacting of [false, true]) {
    session.compacting = compacting ? { turnId: "turn", item: false } : null;
    for (const method of ["unknown/notification", "turn/completed", "account/rateLimits/updated"])
      for (const params of [null, undefined, [], true, 7, "bad"])
        assert.doesNotThrow(() => {
          session.notification(method, params);
          assert.equal(compactNotification(session, method, params), false);
        });
  }
  assert.equal(session.failure, null);
  assert.equal(session.terminal, null);
  assert.equal(session.turnId, "turn");
});

test("null wire notifications do not prevent compaction or the following turn", async (t) => {
  const f = fixture(t, {
    notificationsBeforeReply: [
      { method: "unknown/notification", params: null },
      { method: "turn/completed", params: null },
      { method: "account/rateLimits/updated", params: null },
    ],
  });
  const session = new CodexSession(
    {
      cwd: f.work,
      codex: await selectCodex(f.env, f.work),
      model: "fixture-model",
      effort: "max",
      threadId: "kept-thread",
      compact: true,
    },
    { env: f.env },
  );
  try {
    const result = await session.run("one fake follow-up");
    assert.equal(result.status, "completed", JSON.stringify(result.error));
    assert.equal(session.compaction.status, "completed");
    assert.equal(
      f.events().filter((event) => event.direction === "in" && event.method === "turn/start")
        .length,
      1,
    );
    assert.ok(f.events().some((event) => event.direction === "out" && event.params === null));
  } finally {
    await session.close();
  }
});

test("an interrupt acknowledgement lost after a terminal event does not override that evidence", async () => {
  const session = new CodexSession({});
  session.threadId = "thread";
  session.turnId = "turn";
  let calls = 0;
  session.request = async () => {
    calls++;
    session.terminal = { id: "turn", status: "interrupted" };
    throw new Error("RPC input ended");
  };
  assert.deepEqual(await session.interrupt({ cancel: true }), { terminal: true });
  assert.deepEqual(await session.interrupt({ cancel: true }), { terminal: true });
  assert.equal(calls, 1);
});
