// Run the actual atomicWrite function with an in-memory filesystem that can
// deny precisely one operation. This exercises both platform policies on every
// host without relying on a probabilistic filesystem sharing race.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as policy from "../src/shared/constants.mjs";
import { ERRNO } from "../src/shared/errors.mjs";

const source = fs.readFileSync(new URL("../src/shared/io.mjs", import.meta.url), "utf8");
const start = source.indexOf("export function atomicWrite(");
const end = source.indexOf("\nexport function ", start + 1);
assert.ok(start >= 0 && end > start, "load the actual exported function, not a test copy");
const actualFunction = source.slice(start, end).replace(/^export /, "");

function filesystem({ windows = true, failRename = () => null, failWrite, failSync } = {}) {
  const target = "/private/run.json";
  const stage = `${target}.fixed-nonce.tmp`;
  const events = [];
  const files = new Map([
    [target, "prior complete record"],
    ["/private/unrelated", "keep"],
  ]);
  let closed = false;
  let synced = false;
  let attempts = 0;
  const api = {
    openSync(file, flags, mode) {
      assert.equal(file, stage);
      assert.equal(flags, "wx", "stage must remain exclusively created");
      assert.equal(mode, 0o600);
      files.set(file, "");
      events.push("open");
      return 7;
    },
    writeFileSync(fd, data) {
      assert.equal(fd, 7);
      events.push("write");
      if (failWrite) throw failWrite;
      files.set(stage, data);
    },
    fsyncSync(fd) {
      assert.equal(fd, 7);
      events.push("sync");
      if (failSync) throw failSync;
      synced = true;
    },
    closeSync(fd) {
      assert.equal(fd, 7);
      closed = true;
      events.push("close");
    },
    renameSync(from, to) {
      assert.equal(from, stage, "every retry reuses the same stage");
      assert.equal(to, target);
      assert.equal(closed, true, "no rename while the stage is open");
      assert.equal(synced, true);
      assert.equal(files.get(stage), "new complete record");
      assert.equal(files.get(target), "prior complete record", "no target unlink or partial write");
      events.push("rename");
      const error = failRename(++attempts);
      if (error) throw error;
      files.set(target, files.get(stage));
      files.delete(stage);
    },
    rmSync(file, options) {
      assert.equal(file, stage, "cleanup owns only the stage");
      assert.deepEqual({ ...options }, { force: true });
      files.delete(file);
      events.push("cleanup");
    },
  };
  const waits = [];
  const context = {
    ...policy,
    IS_WINDOWS: windows,
    ERRNO,
    fs: api,
    crypto: { randomBytes: () => ({ toString: () => "fixed-nonce" }) },
    Atomics: {
      wait: (_array, index, expected, ms) => {
        assert.equal(index, 0);
        assert.equal(expected, 0);
        waits.push(ms);
      },
    },
    Int32Array,
    SharedArrayBuffer,
  };
  const write = vm.runInNewContext(`${actualFunction}\natomicWrite;`, context);
  return {
    run: (options) => write(target, "new complete record", options),
    events,
    files,
    waits,
    attempts: () => attempts,
    assertRetained() {
      assert.equal(files.get(target), "prior complete record");
      assert.equal(files.get("/private/unrelated"), "keep");
      assert.equal(files.has(stage), false);
      assert.equal(closed, true);
      assert.equal(events.at(-1), "cleanup");
    },
  };
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`atomic writes retry transient Windows ${code} only after closing the complete stage`, () => {
    const denied = Object.assign(new Error("sharing denial"), { code });
    const f = filesystem({ failRename: (attempt) => (attempt <= 2 ? denied : null) });
    f.run();
    assert.equal(f.attempts(), 3);
    assert.deepEqual(f.waits, [10, 10]);
    assert.deepEqual(f.events, [
      "open",
      "write",
      "sync",
      "close",
      "rename",
      "rename",
      "rename",
      "cleanup",
    ]);
    assert.equal(f.files.get("/private/run.json"), "new complete record");
    assert.equal(f.files.get("/private/unrelated"), "keep");
    assert.equal(f.files.size, 2);
  });
}

test("atomic write sharing retries are bounded and preserve the first denial and old target", () => {
  const first = Object.assign(new Error("initial sharing denial"), { code: "EPERM" });
  const later = Object.assign(new Error("still denied"), { code: "EACCES" });
  const f = filesystem({ failRename: (attempt) => (attempt === 1 ? first : later) });
  assert.throws(f.run, (error) => error === first);
  assert.equal(f.attempts(), 21, "one initial attempt and at most twenty retries");
  assert.deepEqual(f.waits, Array(20).fill(10));
  f.assertRetained();
});

test("a job store can extend the sharing bound without changing the default writer or its complete stage", () => {
  const denied = Object.assign(new Error("busy polling reader"), { code: "EPERM" });
  const f = filesystem({ failRename: (attempt) => (attempt <= 30 ? denied : null) });
  f.run({ renameRetries: 100 });
  assert.equal(f.attempts(), 31);
  assert.deepEqual(f.waits, Array(30).fill(10));
  assert.equal(f.files.get("/private/run.json"), "new complete record");
});

test("atomic writes refuse non-sharing errors and non-Windows sharing failures immediately", () => {
  for (const [windows, codes] of [
    [true, ["EIO", "ENOSPC", "EXDEV"]],
    [false, ["EPERM", "EACCES", "EBUSY"]],
  ]) {
    for (const code of codes) {
      const denied = Object.assign(new Error("denied"), { code });
      const f = filesystem({ windows, failRename: () => denied });
      assert.throws(f.run, (error) => error === denied);
      assert.equal(f.attempts(), 1);
      assert.deepEqual(f.waits, []);
      f.assertRetained();
    }
  }
  const transient = Object.assign(new Error("sharing denial"), { code: "EPERM" });
  const permanent = Object.assign(new Error("wrong filesystem"), { code: "EXDEV" });
  const changed = filesystem({ failRename: (attempt) => (attempt === 1 ? transient : permanent) });
  assert.throws(changed.run, (error) => error === permanent);
  assert.equal(changed.attempts(), 2, "a later non-sharing error stops immediately too");
  assert.deepEqual(changed.waits, [10]);
  changed.assertRetained();
});

test("atomic write and fsync failures close and clean their stage without attempting rename", () => {
  for (const field of ["failWrite", "failSync"]) {
    const denied = Object.assign(new Error("cannot finish stage"), { code: "ENOSPC" });
    const f = filesystem({ [field]: denied });
    assert.throws(f.run, (error) => error === denied);
    assert.equal(f.attempts(), 0);
    assert.deepEqual(f.waits, []);
    f.assertRetained();
  }
});
