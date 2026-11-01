import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import { until } from "./support/driver-evidence.mjs";
import { CodexSession } from "../src/codex/session.mjs";
import { stopDriver } from "../src/codex/driver-client.mjs";
import { shutdownEvidence } from "../src/codex/shutdown.mjs";
import { createJob, readDriver, readTurn, writeDriver } from "../src/state/job-store.mjs";
import { alive, runProcess } from "../src/shared/io.mjs";
import { processStart } from "../src/shared/process-identity.mjs";

async function endedPid() {
  const result = await runProcess(process.execPath, [
    "-e",
    "process.stdout.write(String(process.pid))",
  ]);
  assert.equal(result.status, 0);
  return Number(result.stdout);
}

test("shutdown evidence refuses bare PIDs as captured process identities", () => {
  const root = { pid: 42, start: "root-birth" };
  for (const evidence of [
    shutdownEvidence(root, { identities: [root, 43] }),
    shutdownEvidence(root, { tree: [42, 43] }),
    shutdownEvidence(root, {}, { shutdownTree: [43], shutdownTreeUnknown: false }),
  ]) {
    assert.deepEqual(evidence.shutdownTree, [root]);
    assert.equal(evidence.shutdownTreeUnknown, true);
    assert.equal(evidence.shutdownCapturePending, false);
  }
});

test("session persists captured descendants before a stop loses its final reply", async () => {
  const root = { pid: 42, start: "root-birth" };
  const descendant = { pid: 43, start: "child-birth" };
  let saved = {};
  const session = new CodexSession(
    {},
    {
      checkpoint: async (patch) => {
        await Promise.resolve();
        saved = { ...saved, ...patch };
      },
      processes: {
        stop: async ({ onIdentified }) => {
          assert.equal(saved.shutdownIncomplete, true);
          assert.deepEqual(saved.shutdownTree, [root]);
          await onIdentified([root, descendant]);
          assert.deepEqual(saved.shutdownTree, [root, descendant]);
          throw new Error("stop helper lost its final reply");
        },
      },
    },
  );
  session.child = { pid: root.pid, kill() {} };
  session.childStart = root.start;
  await assert.rejects(session.close(), /lost its final reply/);
  assert.equal(saved.shutdownIncomplete, true);
  assert.equal(saved.shutdownTreeUnknown, false);
  assert.deepEqual(saved.shutdownTree, [root, descendant]);
});

test("pending shutdown preserves unknown identities and survivors, then clears after their exit", async (t) => {
  const f = fixture(t),
    gone = await endedPid(),
    child = f.spawnServer();
  const start = await until(() => processStart(child.pid));
  const tree = [
    { pid: gone, start: "ended" },
    { pid: child.pid, start },
  ];
  const jobId = createJob(f.state, {
    pid: gone,
    processStart: "ended",
    shutdownIncomplete: true,
    shutdownTree: tree,
    shutdownTreeUnknown: false,
  });
  let stopCalls = 0;
  const processes = {
    probe: { start: () => null },
    stop: async ({ pid, start: expected }) => {
      stopCalls++;
      assert.equal(pid, child.pid);
      assert.equal(expected, start);
      return { state: "alive", identities: [{ pid, start }] };
    },
  };
  await assert.rejects(stopDriver({ jobId }, { stateDir: f.state, processes }), {
    code: "STOP_INCOMPLETE",
  });
  assert.equal(stopCalls, 0, "an unreadable identity never authorizes a stop");
  assert.equal(readDriver(f.state, jobId).shutdownIncomplete, true);
  processes.probe.start = () => start;
  await assert.rejects(stopDriver({ jobId }, { stateDir: f.state, processes }), {
    code: "STOP_INCOMPLETE",
  });
  assert.equal(stopCalls, 1);
  assert.equal(readDriver(f.state, jobId).shutdownIncomplete, true);
  child.stdin.end();
  await until(() => !alive(child.pid));
  processes.stop = () => assert.fail("already-gone identities are not signalled");
  assert.deepEqual(await stopDriver({ jobId }, { stateDir: f.state, processes }), {
    state: "gone",
  });
  assert.equal(readDriver(f.state, jobId).shutdownIncomplete, false);
  assert.deepEqual(readDriver(f.state, jobId).shutdownTree, []);
});

test("shutdown recovery requires structured identities and a fully captured tree", async (t) => {
  const f = fixture(t),
    gone = await endedPid();
  const jobId = createJob(f.state, {
    pid: gone,
    processStart: "ended",
    shutdownIncomplete: true,
    shutdownTree: [gone],
    shutdownTreeUnknown: false,
  });
  const context = { stateDir: f.state, processes: { stop: () => assert.fail("no live targets") } };
  await assert.rejects(stopDriver({ jobId }, context), { code: "STOP_INCOMPLETE" });
  assert.equal(readDriver(f.state, jobId).shutdownIncomplete, true);
  writeDriver(f.state, jobId, {
    ...readDriver(f.state, jobId),
    shutdownTree: [{ pid: gone, start: "ended" }],
    shutdownTreeUnknown: false,
  });
  await stopDriver({ jobId }, context);
  assert.equal(readDriver(f.state, jobId).shutdownIncomplete, false);
  writeDriver(f.state, jobId, {
    ...readDriver(f.state, jobId),
    shutdownIncomplete: true,
    shutdownTree: [{ pid: gone, start: "ended" }],
    shutdownTreeUnknown: true,
  });
  await assert.rejects(stopDriver({ jobId }, context), { code: "STOP_INCOMPLETE" });
  assert.equal(readDriver(f.state, jobId).shutdownIncomplete, true);
  writeDriver(f.state, jobId, {
    ...readDriver(f.state, jobId),
    shutdownTree: null,
  });
  await assert.rejects(stopDriver({ jobId }, context), { code: "STOP_INCOMPLETE" });
  const incomplete = readDriver(f.state, jobId);
  assert.deepEqual(incomplete.shutdownTree, [{ pid: gone, start: "ended" }]);
  assert.equal(incomplete.shutdownCapturePending, false);
  assert.equal(incomplete.shutdownTreeUnknown, true);
});

test("a timeout before capture can recapture the same live root and does not latch forever", async (t) => {
  const f = fixture(t),
    gone = await endedPid(),
    child = f.spawnServer();
  const start = await until(() => processStart(child.pid));
  let saved = {};
  const session = new CodexSession(
    {},
    {
      checkpoint: (patch) => {
        saved = { ...saved, ...patch };
      },
      processes: { stop: async () => ({ state: "unknown", detail: "identity probe timed out" }) },
    },
  );
  session.child = child;
  session.childStart = start;
  await assert.rejects(session.close(), { code: "STOP_INCOMPLETE" });
  assert.equal(saved.shutdownCapturePending, true);
  assert.equal(saved.shutdownTreeUnknown, true);
  const jobId = createJob(f.state, {
    pid: gone,
    processStart: "ended",
    ...saved,
    appServer: { pid: child.pid, processStart: start },
  });
  const processes = {
    probe: { start: () => start },
    stop: async ({ onIdentified }) => {
      await onIdentified([{ pid: child.pid, start }]);
      assert.equal(readDriver(f.state, jobId).shutdownTreeUnknown, false);
      child.stdin.end();
      await until(() => !alive(child.pid));
      return { state: "stopped" };
    },
  };
  await stopDriver({ jobId }, { stateDir: f.state, processes });
  assert.equal(readDriver(f.state, jobId).shutdownIncomplete, false);
});

test("collection, sleep and close recover a settled shutdown without another turn", async (t) => {
  const f = fixture(t);
  const launched = await f.invoke([...LAUNCH.slice(0, -2), "--detach", "--keep-state"]);
  assert.equal(launched.code, 0, launched.stderr);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  await until(() => readTurn(stateDir, run.jobId));
  await until(() => !alive(run.worker.pid), "driver shutdown", 15_000);
  const driver = readDriver(stateDir, run.jobId);
  await until(() => !alive(driver.appServer.pid));
  for (const command of ["--run", "--sleep", "--close"]) {
    writeDriver(stateDir, run.jobId, {
      ...readDriver(stateDir, run.jobId),
      shutdownIncomplete: true,
      shutdownTree: [{ pid: driver.appServer.pid, start: driver.appServer.processStart }],
      shutdownTreeUnknown: false,
    });
    const result = await f.invoke([command, run.runKey]);
    assert.equal(result.code, 0, result.stderr);
    if (command !== "--close")
      assert.equal(readDriver(stateDir, run.jobId).shutdownIncomplete, false);
  }
  assert.equal(fs.existsSync(stateDir), false);
  assert.equal(
    f.events().filter((event) => event.direction === "in" && event.method === "turn/start").length,
    1,
  );
});
