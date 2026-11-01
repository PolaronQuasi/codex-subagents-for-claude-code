import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import { until, clock } from "./support/driver-evidence.mjs";
import { alive } from "../src/shared/io.mjs";
import { stopDriver, createDriverClient } from "../src/codex/driver-client.mjs";
import { stopRunDriver } from "../src/run/lifecycle.mjs";
import { writerOwners } from "../src/state/state.mjs";
import { cancelJob } from "../src/run/cancel.mjs";
import {
  createJob,
  readTurn,
  readCancelIntent,
  jobPaths,
  writeFinal,
  writeTurn,
  readDriver,
  writeDriver,
} from "../src/state/job-store.mjs";
import { processStart } from "../src/shared/process-identity.mjs";
import { createIpcSecret, ipcEndpoint, readIpcSecret, serveIpc } from "../src/codex/ipc.mjs";
import { stopOwnedChild } from "../src/shared/process-stop.mjs";
import { Writable } from "node:stream";
import { delivered } from "./support/capture.mjs";

async function silentDriver(t) {
  const f = fixture(t, { exitOnStdinClose: false });
  const handle = f.spawnServer();
  const start = processStart(handle.pid);
  assert.ok(start);
  const jobId = createJob(f.state, {
    pid: handle.pid,
    processStart: start,
    generation: "g",
    protocol: 1,
    runKey: "a".repeat(32),
    turnId: "active",
    threadId: "thread",
    phase: "running",
    dispatching: true,
  });
  const endpoint = ipcEndpoint(f.state, jobId);
  const { writeDriver, readDriver } = await import("../src/state/job-store.mjs");
  const record = writeDriver(f.state, jobId, { ...readDriver(f.state, jobId), endpoint });
  createIpcSecret(f.state, jobId);
  const server = await serveIpc(record, readIpcSecret(f.state, jobId), async () => ({ ok: true }));
  t.after(() => server.close());
  return {
    f,
    handle,
    record,
    server,
    run: { jobId, worker: { jobId, pid: handle.pid, processStart: start } },
  };
}

test("cancel waits at least ten seconds, escalates identity-bound and keeps state on an incomplete stop", async (t) => {
  const d = await silentDriver(t);
  let clock = 0,
    stopAt;
  await assert.rejects(
    cancelJob(d.run, {
      stateDir: d.f.state,
      driver: {
        interrupt: async () => {
          assert.ok(readCancelIntent(d.f.state, d.run.jobId));
        },
      },
      timing: {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          await delay(1);
        },
      },
      processes: {
        probe: { start: () => d.record.processStart },
        stop: async (target) => {
          assert.equal(target.pid, d.handle.pid);
          assert.equal(target.start, d.record.processStart);
          stopAt = clock;
          return { state: "alive" };
        },
      },
    }),
    { code: "STOP_INCOMPLETE" },
  );
  assert.ok(stopAt >= 10_000);
  assert.equal(readTurn(d.f.state, d.run.jobId), null);
  assert.ok(fs.existsSync(jobPaths(d.f.state, d.run.jobId).driverFile));
});

test("cancel settles an owned forced stop as cancelled without claiming usage", async (t) => {
  const d = await silentDriver(t);
  let clock = 0;
  const result = await cancelJob(d.run, {
    stateDir: d.f.state,
    driver: { interrupt: async () => {} },
    timing: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        await delay(1);
      },
    },
    processes: {
      probe: { start: () => d.record.processStart },
      stop: async (target) => {
        assert.equal(target.pid, d.handle.pid);
        // Held handle since birth, supplied only after identity-bound targeting.
        d.handle.kill();
        await new Promise((resolve) => d.handle.once("exit", resolve));
        return { state: "stopped" };
      },
    },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.tokenUsage, null);
});

test("a terminal completion wins cancellation before any IPC or identity lookup", async (t) => {
  const f = fixture(t);
  const id = createJob(f.state);
  writeTurn(f.state, id, { status: "completed", finalSha256: writeFinal(f.state, id, "Winner") });
  const result = await cancelJob(
    { jobId: id },
    {
      stateDir: f.state,
      driver: { interrupt: () => assert.fail("terminal is first") },
      processes: { probe: { start: () => assert.fail("no query") } },
    },
  );
  assert.equal(result.status, "completed");
});

test("cancel retries one missed IPC interrupt while polling and the live driver publishes cancellation", async (t) => {
  const f = fixture(t, { hangTurn: true, omitRateLimitsUpdate: true });
  assert.equal((await f.invoke([...LAUNCH.slice(0, -2), "--detach", "--keep-state"])).code, 0);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  await until(() => readDriver(stateDir, run.jobId)?.turnId);
  const client = createDriverClient(run, { stateDir });
  let attempts = 0;
  const turn = await cancelJob(run, {
    stateDir,
    parentEnv: f.env,
    driver: {
      interrupt: () => {
        attempts++;
        if (attempts === 1) throw new Error("fixture IPC connection not ready");
        return client.interrupt();
      },
    },
  });
  assert.equal(attempts, 2);
  assert.equal(turn.status, "cancelled");
  assert.ok(readCancelIntent(stateDir, run.jobId));
  assert.equal(f.events().filter((event) => event.method === "turn/interrupt").length, 1);
  assert.equal(
    f.events().some((event) => event.method === "account/rateLimits/read"),
    false,
  );
  await until(() => !alive(run.worker.pid));
});

test("a held-child stop preserves an abort that arrives while its identity is being prepared", async () => {
  const controller = new AbortController();
  let kills = 0;
  await stopOwnedChild(
    {
      pid: 42,
      kill: () => {
        kills++;
      },
    },
    "birth",
    {
      signal: controller.signal,
      stop: async (target) => {
        assert.equal(target.signal, controller.signal);
        controller.abort(new Error("Waiter interrupted"));
        if (target.interrupt) await assert.rejects(target.interrupt(), /Waiter interrupted/);
        return { state: "unknown" };
      },
    },
  );
  assert.equal(kills, 0);
});

test("a turn that ends on its own before the stop is delivered as it ended", async (t) => {
  const d = await silentDriver(t);
  const result = await cancelJob(d.run, {
    stateDir: d.f.state,
    processes: {
      probe: { start: () => d.record.processStart },
      stop: () => assert.fail("terminal wins"),
    },
    driver: {
      interrupt: async () => {
        writeTurn(d.f.state, d.run.jobId, {
          status: "completed",
          finalSha256: writeFinal(d.f.state, d.run.jobId, "Natural completion"),
        });
      },
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(alive(d.handle.pid), true, "cancel did not force a stop after terminal publication");
});

test("Ctrl-C during cancel before the stop leaves the driver and its running record", async (t) => {
  const d = await silentDriver(t),
    controller = new AbortController();
  const before = fs.readFileSync(jobPaths(d.f.state, d.run.jobId).driverFile);
  await assert.rejects(
    cancelJob(d.run, {
      stateDir: d.f.state,
      signal: controller.signal,
      processes: {
        probe: { start: () => d.record.processStart },
        stop: () => assert.fail("aborted before kill"),
      },
      driver: {
        interrupt: async () => {
          controller.abort(new Error("SIGINT before stop"));
          throw controller.signal.reason;
        },
      },
    }),
    /SIGINT before stop/,
  );
  assert.equal(readTurn(d.f.state, d.run.jobId), null);
  assert.deepEqual(fs.readFileSync(jobPaths(d.f.state, d.run.jobId).driverFile), before);
  assert.equal(alive(d.handle.pid), true);
});

test("a cancel whose stop leaves the driver running keeps the job and names the survivor", async (t) => {
  const d = await silentDriver(t);
  await assert.rejects(
    cancelJob(d.run, {
      stateDir: d.f.state,
      driver: { interrupt: async () => {} },
      timing: clock(() => delay(1)),
      processes: {
        probe: { start: () => d.record.processStart },
        stop: async () => ({ state: "alive", detail: `driver ${d.handle.pid} still runs` }),
      },
    }),
    (error) => error.code === "STOP_INCOMPLETE" && error.message.includes(String(d.handle.pid)),
  );
  assert.equal(readTurn(d.f.state, d.run.jobId), null);
  assert.equal(alive(d.handle.pid), true);
});

test("a stopped driver whose tree still runs keeps the job and names the surviving processes", async (t) => {
  const d = await silentDriver(t);
  const child = d.f.spawnServer();
  await until(() => processStart(child.pid));
  await assert.rejects(
    stopDriver(d.run, {
      stateDir: d.f.state,
      timing: clock(() => delay(1)),
      processes: {
        probe: { start: () => d.record.processStart },
        stop: async () => {
          d.handle.kill();
          await until(() => !alive(d.handle.pid));
          return { state: "stopped", detail: `processes ${child.pid} of its tree still run` };
        },
      },
    }),
    (error) => error.code === "STOP_INCOMPLETE" && error.message.includes(String(child.pid)),
  );
  assert.equal(readTurn(d.f.state, d.run.jobId), null);
  assert.equal(alive(child.pid), true);
});

test("a surviving app-server child keeps its job after the driver ended and names its PID", async (t) => {
  const d = await silentDriver(t),
    child = d.f.spawnServer();
  const start = await until(() => processStart(child.pid));
  writeDriver(d.f.state, d.run.jobId, {
    ...d.record,
    appServer: { pid: child.pid, processStart: start },
  });
  d.handle.kill();
  await until(() => !alive(d.handle.pid));
  await assert.rejects(
    stopDriver(d.run, {
      stateDir: d.f.state,
      timing: clock(),
      processes: {
        probe: { start: () => start },
        stop: async (target) => {
          assert.equal(target.pid, child.pid);
          assert.equal(target.start, start);
          return { state: "alive" };
        },
      },
    }),
    (error) => error.code === "STOP_INCOMPLETE" && error.message.includes(String(child.pid)),
  );
  assert.equal(alive(child.pid), true);
  assert.equal(readTurn(d.f.state, d.run.jobId), null);
});

for (const mode of ["cancel", "force-close"])
  test(`${mode} refuses an unconfirmed live PID with a named code`, async (t) => {
    const d = await silentDriver(t);
    const context = {
      stateDir: d.f.state,
      force: true,
      processes: {
        probe: { start: () => null },
        stop: () => assert.fail("unknown driver is never stopped"),
      },
    };
    await assert.rejects(
      mode === "cancel" ? cancelJob(d.run, context) : stopRunDriver(d.run, context),
      { code: "WORKER_UNCONFIRMED" },
    );
    assert.equal(readTurn(d.f.state, d.run.jobId), null);
    assert.equal(alive(d.handle.pid), true);
  });

test("a forced close whose driver survives keeps state and the writer lock with a named code", async (t) => {
  const f = fixture(t, { status: "running" });
  await f.invoke([...LAUNCH.slice(0, -2), "--detach", "--write"]);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  await until(() => readDriver(stateDir, run.jobId)?.phase === "running");
  // Drain startup checkpoints before replacing this test's diagnostic endpoint.
  assert.equal((await createDriverClient(run, { stateDir }).status()).phase, "running");
  const record = readDriver(stateDir, run.jobId);
  const endpoint = ipcEndpoint(f.root, run.jobId);
  if (process.platform !== "win32") fs.mkdirSync(path.dirname(endpoint), { recursive: true });
  const control = { ...record, endpoint };
  const server = await serveIpc(control, readIpcSecret(stateDir, run.jobId), async () => ({
    ok: true,
  }));
  try {
    writeDriver(stateDir, run.jobId, control);
    const before = fs.readFileSync(path.join(stateDir, "run.json"));
    const result = await f.invoke(["--close", run.runKey, "--force"], {
      timing: clock(() => delay(1)),
      processes: {
        probe: {
          start: (pid) =>
            pid === record.pid ? record.processStart : record.appServer.processStart,
        },
        stop: async (target) => {
          assert.equal(target.pid, record.pid);
          assert.equal(target.start, record.processStart);
          return { state: "alive", detail: `driver ${record.pid} still runs` };
        },
      },
    });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, new RegExp(String(record.pid)));
    assert.deepEqual(fs.readFileSync(path.join(stateDir, "run.json")), before);
    assert.equal(readTurn(stateDir, run.jobId), null);
    assert.ok(writerOwners(f.state).has(run.runKey));
    assert.equal(alive(record.pid), true);
    assert.equal(alive(record.appServer.pid), true);
  } finally {
    await server.close();
    f.configure({ status: "completed" });
  }
});

test("each outer timeout outlasts the worst case of the stop it wraps, by the driver and app-server constants", async () => {
  const c = await import("../src/shared/constants.mjs");
  assert.ok(c.DRIVER_INTERRUPT_MS >= 10_000);
  assert.ok(c.DRIVER_EXIT_MS >= 10_000);
  assert.ok(c.APP_SERVER_INTERRUPT_MS >= 10_000);
  assert.ok(c.APP_SERVER_EXIT_MS >= 10_000);
  // interrupt() waits for both the RPC response and turn/completed. The
  // authenticated outer request must allow both complete inner windows.
  assert.ok(
    c.DRIVER_INTERRUPT_MS + c.DRIVER_REPLY_MS > 2 * c.APP_SERVER_INTERRUPT_MS + c.DRIVER_POLL_MS,
  );
  assert.ok(c.DRIVER_EXIT_MS > c.APP_SERVER_EXIT_MS);
  assert.equal(c.STOP_PROGRESS_WORDS, c.STOP_ROUNDS + 1);
  assert.ok(c.STOP_PROGRESS_MS > c.STOP_EXIT_MS);
  assert.ok(
    c.STOP_TOTAL_MS >= c.STOP_PREPARE_MS + (c.STOP_PROGRESS_WORDS + 1) * c.STOP_PROGRESS_MS,
  );
  const signalled = (ms) => c.PROCESS_QUERY_MS + ms + c.PROCESS_QUERY_MS;
  assert.ok(
    c.STOP_TOTAL_MS >=
      c.PROCESS_QUERY_MS +
        c.COMMAND_LINE_QUERY_MS +
        c.PROCESS_QUERY_MS +
        signalled(c.STOP_GRACE_MS) +
        signalled(c.STOP_EXIT_MS),
  );
});

for (const recorded of [false, true])
  test(`an unavailable shutdown falls back to the identified driver and stops it (run worker=${recorded})`, async (t) => {
    const d = await silentDriver(t);
    await d.server.close();
    if (!recorded) delete d.run.worker;
    let stopped = 0;
    const result = await cancelJob(d.run, {
      stateDir: d.f.state,
      driver: { interrupt: async () => {} },
      timing: clock(),
      processes: {
        probe: { start: () => d.record.processStart },
        stop: async (target) => {
          assert.equal(target.pid, d.handle.pid);
          assert.equal(target.start, d.record.processStart);
          assert.ok(target.pattern.includes(d.run.jobId));
          stopped++;
          d.handle.kill();
          await until(() => !alive(d.handle.pid));
          return { state: "stopped" };
        },
      },
    });
    assert.equal(stopped, 1);
    assert.equal(result.status, "cancelled");
    assert.equal(alive(d.handle.pid), false);
  });

for (const damage of ["missing PID", "missing start time", "different recorded driver"])
  test(`driver shutdown refuses ${damage} and keeps its job without a kill`, async (t) => {
    const d = await silentDriver(t);
    const record = { ...d.record };
    if (damage === "missing PID") delete record.pid;
    if (damage === "missing start time") delete record.processStart;
    if (damage === "different recorded driver") d.run.worker.processStart = "another birth";
    writeDriver(d.f.state, d.run.jobId, record);
    await assert.rejects(
      stopDriver(d.run, {
        stateDir: d.f.state,
        processes: {
          probe: { start: () => d.record.processStart },
          stop: () => assert.fail("never stop an unconfirmed identity"),
        },
      }),
      { code: "WORKER_UNCONFIRMED" },
    );
    assert.equal(alive(d.handle.pid), true);
    assert.equal(readTurn(d.f.state, d.run.jobId), null);
  });

for (const damage of ["missing", "malformed", "different-pid"])
  test(`a ${damage} driver record refuses cancellation without interrupting or changing state`, async (t) => {
    const d = await silentDriver(t),
      file = jobPaths(d.f.state, d.run.jobId).driverFile;
    const saved = fs.readFileSync(file);
    const another = d.f.spawnServer();
    const birth = await until(() => processStart(another.pid));
    if (damage === "missing") fs.rmSync(file);
    if (damage === "malformed") fs.writeFileSync(file, "{");
    if (damage === "different-pid")
      writeDriver(d.f.state, d.run.jobId, { ...d.record, pid: another.pid, processStart: birth });
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    try {
      await assert.rejects(
        cancelJob(d.run, {
          stateDir: d.f.state,
          timing: clock(),
          processes: {
            probe: { start: () => birth },
            stop: () => assert.fail("damaged ownership cannot stop"),
          },
        }),
      );
      assert.equal(readCancelIntent(d.f.state, d.run.jobId), null);
      assert.equal(alive(d.handle.pid), true);
      assert.equal(alive(another.pid), true);
      assert.deepEqual(fs.existsSync(file) ? fs.readFileSync(file) : null, before);
      assert.equal(
        d.f.events().some((e) => e.method === "turn/interrupt"),
        false,
      );
    } finally {
      fs.writeFileSync(file, saved);
    }
  });

test("a cancel while another waiter holds the run stops the driver, and that waiter delivers the cancellation", async (t) => {
  const f = fixture(t, { status: "running" });
  await f.invoke([...LAUNCH.slice(0, -2), "--detach"]);
  const run = f.metadata(),
    dir = path.join(f.state, run.runKey);
  await until(() => readDriver(dir, run.jobId)?.turnId);
  const childPid = readDriver(dir, run.jobId).appServer.pid;
  let text = "",
    release;
  const controller = new AbortController();
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk;
      release = callback;
    },
  });
  const waiter = f.invoke(["--run", run.runKey, "--wait"], { stdout, signal: controller.signal });
  try {
    await until(() => fs.existsSync(path.join(f.state, `${run.runKey}.lock`, "owner.json")));
    const cancel = await f.invoke(["--cancel", run.runKey]);
    assert.equal(cancel.code, 0, cancel.stderr);
    assert.match(
      cancel.stdout,
      /^CANCEL REQUESTED: .*the waiting process .* will deliver its terminal record\.\n$/,
    );
    await until(() => release);
    release();
    release = null;
    const result = await waiter;
    assert.equal(result.code, 2, result.stderr);
    assert.equal(delivered(text).footer.status, "cancelled");
    assert.equal(alive(run.worker.pid), false);
    assert.equal(alive(childPid), false);
    assert.deepEqual(f.runs(), []);
  } finally {
    release?.();
    controller.abort();
    await waiter;
  }
});
