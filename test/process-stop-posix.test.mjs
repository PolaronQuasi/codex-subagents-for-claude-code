import assert from "node:assert/strict";
import test from "node:test";
import { stopPosixTree } from "../src/shared/process-stop.mjs";
import { STOP_OUTCOME } from "../src/shared/constants.mjs";
import { SIGNALS } from "../src/shared/errors.mjs";

function operations(starts, options = {}) {
  const signals = [];
  return {
    signals,
    alive: () => true,
    start: () => (starts.length > 1 ? starts.shift() : starts[0]),
    commandLine: () => null,
    group: () => true,
    kill: (...args) => signals.push(args),
    now: () => 0,
    sleep: async () => {},
    ...options,
  };
}
const target = { pid: 42, start: "birth" };

test("POSIX persists captured targets before interrupt or any signal", async () => {
  let persisted = false,
    interrupted = false,
    running = true;
  const targets = [target, { pid: 43, start: "child" }];
  const probe = operations(["birth"], {
    descendants: () => targets.slice(1),
    alive: () => running,
    start: (pid) => (pid === 42 ? "birth" : "child"),
    kill: () => {
      assert.equal(persisted, true);
      assert.equal(interrupted, true);
      running = false;
    },
  });
  const result = await stopPosixTree(
    {
      ...target,
      onIdentified: async (identities) => {
        assert.deepEqual(identities, targets);
        persisted = true;
      },
      interrupt: async () => {
        assert.equal(persisted, true);
        interrupted = true;
      },
    },
    probe,
  );
  assert.equal(result.state, STOP_OUTCOME.STOPPED);
});

test("POSIX never interrupts or signals when persisting captured identities fails", async () => {
  const probe = operations(["birth"]);
  await assert.rejects(
    stopPosixTree(
      {
        ...target,
        onIdentified: () => {
          throw new Error("checkpoint failed");
        },
        interrupt: () => assert.fail("not durable"),
      },
      probe,
    ),
    /checkpoint failed/,
  );
  assert.deepEqual(probe.signals, []);
});

test("POSIX: a null identity immediately before signalling is unknown, never a successful stop", async () => {
  const probe = operations(["birth", null]);
  const answer = await stopPosixTree(target, probe);
  assert.equal(answer.state, STOP_OUTCOME.UNKNOWN);
  assert.deepEqual(probe.signals, []);
});

test("POSIX: a null start-time recheck after SIGTERM cannot confirm exit or trigger SIGKILL", async () => {
  const probe = operations(["birth", "birth", "birth", null]);
  assert.equal((await stopPosixTree(target, probe)).state, STOP_OUTCOME.UNKNOWN);
  assert.deepEqual(probe.signals, [[-target.pid, SIGNALS.SIGTERM]]);
});

test("POSIX: a captured descendant is drained after its group leader exits", async () => {
  let root = true,
    child = true,
    elapsed = 0;
  const probe = operations(["birth"], {
    alive: (pid) => (pid === 42 ? root : child),
    descendants: () => [{ pid: 43, start: "birth" }],
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
    kill: (pid, signal) => {
      probe.signals.push([pid, signal]);
      if (pid === -42) root = false;
      if (pid === 43 && signal === SIGNALS.SIGKILL) child = false;
    },
  });
  assert.equal((await stopPosixTree(target, probe)).state, STOP_OUTCOME.STOPPED);
  assert.equal(child, false);
  assert.ok(probe.signals.some(([pid, signal]) => pid === 43 && signal === SIGNALS.SIGKILL));
  assert.equal(probe.signals.filter(([pid]) => pid === -42).length, 1);
});

test("POSIX: a failed descendant capture is unknown and sends no signal", async () => {
  const probe = operations(["birth"], { descendants: () => null });
  assert.equal((await stopPosixTree(target, probe)).state, STOP_OUTCOME.UNKNOWN);
  assert.deepEqual(probe.signals, []);
});

test("POSIX: once the group root exits, its remembered group is never signalled again", async () => {
  let running = true;
  const probe = operations(["birth"], {
    alive: () => running,
    kill: (...args) => {
      probe.signals.push(args);
      running = false;
    },
  });
  await stopPosixTree(target, probe);
  assert.deepEqual(probe.signals, [[-target.pid, SIGNALS.SIGTERM]]);
  running = true;
  probe.signals.length = 0;
  await stopPosixTree(
    {
      ...target,
      interrupt: async () => {
        running = false;
      },
    },
    probe,
  );
  assert.deepEqual(probe.signals, [], "no group signal after an exit during interrupt");
});
