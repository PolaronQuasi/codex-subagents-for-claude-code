import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { driveStop } from "../src/shared/process-stop.mjs";

function helper(first, receive = () => {}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    kill() {
      this.exitCode = 0;
      this.stdout.end();
    },
  });
  child.stdin.on("data", (chunk) => receive(chunk.toString(), child));
  queueMicrotask(() => child.stdout.write(`${JSON.stringify(first)}\n`));
  return child;
}
const root = { pid: 42, start: "root-birth" };
const descendant = { pid: 43, start: "child-birth" };

test("Windows protocol persists both the initial tree and later descendants before each proceed", async () => {
  const captured = [];
  let gates = 0,
    interrupted = false;
  const child = helper({ state: "identified", identities: [root] }, (line, child) => {
    assert.equal(line, "proceed\n");
    assert.equal(interrupted, true);
    gates++;
    assert.equal(captured.length, gates);
    child.stdout.write(
      `${JSON.stringify(
        gates === 1
          ? { state: "progress", capture: true, identities: [root, descendant] }
          : {
              state: "stopped",
              tree: [42, 43],
              identities: [root, descendant],
              alive: [],
              failed: [],
            },
      )}\n`,
    );
  });
  const result = await driveStop(child, {
    ...root,
    onIdentified: async (targets) => {
      await Promise.resolve();
      captured.push(targets);
    },
    interrupt: async () => {
      assert.equal(captured.length, 1);
      interrupted = true;
    },
  });
  assert.equal(result.state, "stopped");
  assert.equal(gates, 2);
  assert.deepEqual(captured, [[root], [root, descendant]]);
});

test("Windows protocol never proceeds after missing identities or a failed checkpoint", async () => {
  const missing = helper({ state: "identified", tree: [42] }, () => assert.fail("no proceed"));
  assert.equal(
    (
      await driveStop(missing, {
        ...root,
        onIdentified: () => assert.fail("no identities"),
        interrupt: () => assert.fail("no interrupt"),
      })
    ).state,
    "unknown",
  );
  const failed = helper({ state: "identified", identities: [root] }, () =>
    assert.fail("no proceed"),
  );
  await assert.rejects(
    driveStop(failed, {
      ...root,
      onIdentified: () => {
        throw new Error("checkpoint failed");
      },
      interrupt: () => assert.fail("no interrupt"),
    }),
    /checkpoint failed/,
  );
});
