import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { openStartReader } from "../src/shared/process-identity.mjs";
import { IS_WINDOWS, PROCESS_QUERY_MS, START_RETRY_MS } from "../src/shared/constants.mjs";

function fakeReader(t) {
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill() {
      this.exitCode = 0;
      this.emit("exit", 0);
    },
  });
  t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reader = openStartReader();
  t.after(() => {
    reader.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { child, reader };
}

test(
  "Windows start reader allows bounded cold startup but keeps warm queries short",
  { skip: !IS_WINDOWS },
  async (t) => {
    const { reader, child } = fakeReader(t);
    let settled = false;
    const first = reader.start(900000001).then((value) => {
      settled = true;
      return value;
    });
    t.mock.timers.tick(PROCESS_QUERY_MS + 1);
    await Promise.resolve();
    assert.equal(settled, false, "cold startup has not exhausted its separate budget");
    child.stdout.write("900000001 123456789\n");
    assert.equal(await first, "123456789");
    const warm = reader.start(900000002);
    t.mock.timers.tick(PROCESS_QUERY_MS);
    assert.equal(await warm, null, "a warm query still fails closed at its original deadline");
  },
);

test(
  "Windows start reader never accepts a late first answer after its cold deadline",
  { skip: !IS_WINDOWS },
  async (t) => {
    const { reader, child } = fakeReader(t);
    const first = reader.start(900000001);
    t.mock.timers.tick(START_RETRY_MS);
    assert.equal(await first, null);
    child.stdout.write("900000001 123456789\n");
    assert.equal(child.stdin.writableEnded, true, "the timed-out reader is abandoned");
  },
);
