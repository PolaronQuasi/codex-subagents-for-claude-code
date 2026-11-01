import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { alive } from "../src/shared/io.mjs";
import { acquireLock } from "../src/state/state.mjs";
import { fixture, LAUNCH } from "./support/runner-fixture.mjs";
import { EXIT } from "../src/shared/errors.mjs";
import { createJob } from "../src/state/job-store.mjs";
import { LAG_CONFIRMATIONS, LAG_RECHECK_MS } from "../src/shared/constants.mjs";

function clock() {
  let elapsed = 0;
  const waits = [];
  return {
    waits,
    now: () => elapsed,
    async sleep(ms, signal) {
      signal?.throwIfAborted();
      waits.push(ms);
      elapsed += ms;
    },
  };
}

test("main IO timing advances lock deadlines and observes atomic terminal state", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke()).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  const unlock = acquireLock(f.state, key);
  const timing = clock();
  try {
    const busy = await f.invoke(["--run", key, "--wait-ms", "1200"], { timing });
    assert.equal(busy.code, EXIT.STILL_RUNNING, busy.stderr);
    assert.deepEqual(timing.waits, [1000, 200]);
  } finally {
    unlock();
  }
  f.configure({ status: "completed" });
  for (let n = 0; n < 500 && alive(f.metadata().worker.pid); n++) await delay(10);
  const lag = clock();
  const done = await f.invoke(f.resume(), { timing: lag });
  assert.equal(done.code, EXIT.COMPLETED, done.stderr);
  assert.deepEqual(lag.waits, []);
});

test("main IO timing reaches writer release guards without failing delivery", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--write", "--keep-state"])).code, EXIT.STILL_RUNNING);
  const writers = path.join(f.state, "writers");
  const lock = fs.readdirSync(writers).find((name) => name.endsWith(".lock"));
  fs.mkdirSync(path.join(writers, `${lock}.recovery`));
  f.configure({ status: "completed" });
  for (let n = 0; n < 500 && alive(f.metadata().worker.pid); n++) await delay(10);
  const timing = clock();
  const done = await f.invoke(f.resume(), { timing });
  assert.equal(done.code, EXIT.COMPLETED, done.stderr);
  assert.deepEqual(timing.waits, Array(20).fill(100));
  assert.match(done.stderr, /writer lock stayed busy/);
});

test("main IO timing advances lag confirmations before settling a dead driver even at an expired bound", async (t) => {
  const f = fixture(t);
  await f.invoke([...LAUNCH, "--keep-state"]);
  const run = f.metadata(),
    dir = path.join(f.state, run.runKey);
  const jobId = createJob(dir, {
    pid: run.worker.pid,
    processStart: run.worker.processStart,
    phase: "starting",
  });
  run.jobId = jobId;
  delete run.worker;
  delete run.result;
  run.retriedJobs = [{ jobId: "task-previous-death", reason: "worker-died" }];
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
  const timing = clock();
  const result = await f.invoke(["--run", run.runKey, "--wait-ms", "0"], { timing });
  assert.equal(result.code, 2, result.stderr);
  assert.deepEqual(timing.waits, Array(LAG_CONFIRMATIONS - 1).fill(LAG_RECHECK_MS));
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
});
