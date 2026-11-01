import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/runner-fixture.mjs";
import { lostJobCandidate, retryJob, canRetry } from "../src/run/launch.mjs";
import { createJob } from "../src/state/job-store.mjs";
import { readDriver, readTurn, appendEvent, appendLog } from "../src/state/job-store.mjs";
import { fixture as direct } from "./support/codex-fixture.mjs";
import { until, captureDrivers } from "./support/driver-evidence.mjs";
import { alive } from "../src/shared/io.mjs";
import { delivered } from "./support/capture.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { jobPaths, writeDriver } from "../src/state/job-store.mjs";
import { DRIVER_GATE_MS, LAUNCH_SETTLE_MS } from "../src/shared/constants.mjs";

async function preparedLaunch(t, { empty = false, old = true, gated = false } = {}) {
  const f = direct(t),
    spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args) => {
    if (args[1]?.[0]?.endsWith("driver.mjs")) throw new Error("fixture spawn refused");
    return spawn(...args);
  });
  syncBuiltinESMExports();
  let failed;
  try {
    failed = await f.invoke([...LAUNCH, "--write", "--request-id", "prepared", "--keep-state"]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(failed.code, 1, failed.stderr);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  const jobId = fs.readdirSync(path.join(stateDir, "jobs"))[0],
    paths = jobPaths(stateDir, jobId);
  assert.equal(readTurn(stateDir, jobId).status, "failed");
  for (const file of fs.readdirSync(paths.directory)) {
    if (empty || file !== "driver.json") fs.rmSync(path.join(paths.directory, file));
  }
  const date = new Date(Date.now() - (old ? DRIVER_GATE_MS + LAUNCH_SETTLE_MS + 1000 : 0));
  if (!empty) {
    writeDriver(stateDir, jobId, { ...readDriver(stateDir, jobId), startedAt: date.toISOString() });
    fs.utimesSync(paths.driverFile, date, date);
  }
  if (gated) fs.writeFileSync(path.join(paths.directory, "gate.json"), "{}");
  fs.utimesSync(paths.directory, date, date);
  return { f, run, stateDir, jobId };
}

for (const empty of [false, true])
  for (const mode of ["--run", "--cancel", "--close"])
    test(`an aged ${empty ? "empty job folder" : "prepared job without a PID"} recovers through ${mode}`, async (t) => {
      const { f, run, stateDir, jobId } = await preparedLaunch(t, { empty });
      const result = await f.invoke([
        mode,
        run.runKey,
        ...(mode === "--close" ? ["--force"] : ["--wait-ms", "8000"]),
      ]);
      assert.equal(result.code, mode === "--cancel" ? 2 : 0, result.stderr);
      if (mode === "--run") {
        assert.equal(delivered(result.stdout).footer.status, "completed");
        assert.equal(readTurn(stateDir, jobId).status, "failed");
        assert.equal(f.events().filter((event) => event.method === "turn/start").length, 1);
      } else {
        assert.equal(
          f.events().some((event) => event.method === "turn/start"),
          false,
        );
        if (mode === "--cancel") assert.equal(delivered(result.stdout).footer.status, "failed");
        else assert.equal(fs.existsSync(stateDir), false);
      }
      assert.deepEqual(fs.readdirSync(path.join(f.state, "writers")), []);
    });

test("a recent prepared job or an aged job with gate evidence stays uncertain and cannot be forced closed", async (t) => {
  for (const options of [{ old: false }, { gated: true }]) {
    const { f, run, stateDir, jobId } = await preparedLaunch(t, options);
    const waiting = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
    assert.equal(waiting.code, 3, waiting.stderr);
    const refused = await f.invoke(["--close", run.runKey, "--force"]);
    assert.equal(refused.code, 1, refused.stderr);
    assert.equal(readTurn(stateDir, jobId), null);
    assert.equal(
      f.events().some((event) => event.method === "turn/start"),
      false,
    );
    assert.equal(fs.existsSync(stateDir), true);
    assert.ok(fs.readdirSync(path.join(f.state, "writers")).some((name) => name.endsWith(".lock")));
  }
});

test("lost launch discovery ignores archived and retried jobs and refuses multiple candidates", async (t) => {
  const f = fixture(t),
    key = "a".repeat(32),
    stateDir = path.join(f.state, key);
  fs.mkdirSync(stateDir);
  const old = createJob(stateDir),
    retried = createJob(stateDir),
    current = createJob(stateDir);
  const run = { jobId: null, turns: [{ jobId: old, retriedJobs: [{ jobId: retried }] }] };
  assert.equal((await lostJobCandidate(run, { stateDir })).job.id, current);
  createJob(stateDir);
  assert.equal((await lostJobCandidate(run, { stateDir })).kind, "ambiguous");
});

test("a lost accepted launch is adopted from the job store without a second submission", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--keep-prompt"])).code, 3);
  const run = f.metadata(),
    file = path.join(f.state, run.runKey, "run.json");
  run.jobId = null;
  delete run.worker;
  fs.writeFileSync(file, JSON.stringify(run));
  assert.equal((await f.invoke(["--run", run.runKey, "--wait-ms", "0"])).code, 3);
  assert.ok(f.metadata().worker);
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
});

test("failed definitely-unsent retry restores the original job and cannot retry its reason twice", async (t) => {
  const f = fixture(t),
    key = "a".repeat(32),
    stateDir = path.join(f.state, key);
  fs.mkdirSync(stateDir);
  const jobId = createJob(stateDir),
    run = { runKey: key, jobId, cwd: f.work, codex: {} };
  await assert.rejects(
    retryJob(run, "worker-died", { stateDir, parentEnv: f.env, save() {}, warn() {} }),
    /not submitted again/,
  );
  assert.equal(run.jobId, jobId);
  assert.equal(run.retriedJobs, undefined);
  assert.equal(canRetry({ retriedJobs: [{ reason: "worker-died" }] }, "worker-died"), false);
  assert.equal(f.events().length, 0);
});

for (const continued of [false, true])
  test(`a driver that died before dispatch is retried once on ${continued ? "a continued turn" : "a launch"}`, async (t) => {
    const f = direct(t);
    if (continued)
      assert.equal(
        (
          await f.invoke([
            ...LAUNCH.slice(0, -2),
            "--wait-ms",
            "8000",
            "--keep-state",
            "--keep-prompt",
          ])
        ).code,
        0,
      );
    f.configure({ hangMethods: ["initialize"] });
    const children = captureDrivers(t);
    const args = continued
      ? ["--continue", f.runs()[0], "--prompt-file", "prompt.md", "--detach"]
      : [...LAUNCH.slice(0, -2), "--detach", "--keep-state"];
    assert.equal((await f.invoke(args)).code, 0);
    const run = f.metadata(),
      stateDir = path.join(f.state, run.runKey);
    await until(() => readDriver(stateDir, run.jobId)?.appServer);
    children[0].kill();
    await until(() => !alive(run.worker.pid));
    f.configure({ hangMethods: [] });
    const result = await f.invoke(["--run", run.runKey, "--wait-ms", "8000"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(delivered(result.stdout).footer.turn, continued ? 2 : 1);
    const kept = f.metadata();
    assert.deepEqual(kept.retriedJobs, [{ jobId: run.jobId, reason: "worker-died" }]);
    assert.notEqual(kept.jobId, run.jobId);
    assert.equal(children.length, 2);
    const requests = f.events().filter((e) => e.method === "turn/start");
    assert.equal(requests.length, continued ? 2 : 1);
    assert.equal(requests.at(-1).params.input[0].text, "The exact original prompt: λ.\n");
    if (continued)
      assert.equal(
        f.events().findLast((e) => e.method === "thread/resume").params.threadId,
        run.turns[0].result.threadId,
      );
  });

test("a turn whose retried driver dies too fails with both jobs' diagnostics kept", async (t) => {
  const f = direct(t, { hangMethods: ["initialize"] });
  const watchers = [];
  const children = captureDrivers(t, (child, args) => {
    watchers.push(
      (async () => {
        const job = args[1][3],
          dir = args[1][5];
        await until(() => readDriver(dir, job)?.appServer);
        appendEvent(dir, job, { method: "fixture-before-crash" });
        appendLog(dir, job, `diagnostic ${job}\n`);
        child.kill();
        await until(() => !alive(child.pid));
      })(),
    );
  });
  const result = await f.invoke([...LAUNCH.slice(0, -2), "--wait-ms", "8000", "--keep-state"]);
  await Promise.all(watchers);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(delivered(result.stdout).footer.status, "failed");
  assert.equal(children.length, 2);
  const run = f.metadata();
  assert.equal(run.retriedJobs.length, 1);
  for (const id of [run.jobId, run.retriedJobs[0].jobId]) {
    assert.equal(readTurn(path.join(f.state, run.runKey), id).status, "failed");
    const audit = path.join(f.resultsDir, "audit", run.runKey, `worker-death-${id}.turn.json`);
    const text = fs.readFileSync(audit, "utf8");
    assert.ok(text.includes(id));
    assert.equal(text.includes("The exact original prompt"), false);
    for (const tail of ["events.jsonl", "driver.log"])
      assert.ok(
        fs.existsSync(path.join(f.resultsDir, "audit", run.runKey, `worker-death-${id}.${tail}`)),
      );
  }
  assert.equal(
    f.events().some((e) => e.method === "turn/start"),
    false,
  );
});

test("aborting a waiter leaves its detached driver alive and permits recovery", async (t) => {
  const f = direct(t, { status: "running" }),
    controller = new AbortController();
  const pending = f.invoke([...LAUNCH.slice(0, -2), "--wait"], { signal: controller.signal });
  await until(() => f.events().some((e) => e.method === "turn/start"));
  const run = f.metadata();
  controller.abort(new Error("test waiter interruption"));
  const stopped = await pending;
  assert.equal(stopped.code, 1, stopped.stderr);
  assert.match(stopped.stderr, /aborted|test waiter interruption/);
  assert.equal(alive(run.worker.pid), true);
  assert.equal(readTurn(path.join(f.state, run.runKey), run.jobId), null);
  f.configure({ status: "completed" });
  assert.equal((await f.invoke(["--run", run.runKey, "--wait-ms", "8000"])).code, 0);
  assert.equal(f.events().filter((e) => e.method === "turn/start").length, 1);
});

test("uncertain recovery refuses multiple candidate jobs and suggests inspection without redispatch", async (t) => {
  const f = direct(t);
  await f.invoke([...LAUNCH.slice(0, -2), "--detach"]);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  await until(() => readTurn(stateDir, run.jobId));
  createJob(stateDir);
  run.jobId = null;
  delete run.worker;
  fs.writeFileSync(path.join(stateDir, "run.json"), JSON.stringify(run));
  const refused = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /2 candidates.*inspect with --inspect/);
  assert.doesNotMatch(refused.stderr, /Recover with:.*--attach/);
  assert.equal(f.events().filter((e) => e.method === "turn/start").length, 1);
  assert.equal(f.metadata().jobId, null);
});

test("failed retry with unknown job discovery retains its reservation for recovery", async (t) => {
  const f = fixture(t),
    stateDir = path.join(f.state, "a".repeat(32));
  fs.mkdirSync(stateDir);
  const jobId = createJob(stateDir),
    run = { runKey: "a".repeat(32), jobId, cwd: f.work, codex: {} };
  const readdir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (dir, ...args) => {
    if (dir === path.join(stateDir, "jobs")) throw new Error("job discovery unavailable");
    return readdir(dir, ...args);
  });
  await assert.rejects(
    retryJob(run, "worker-died", { stateDir, parentEnv: f.env, save() {}, warn() {} }),
    /Codex executable changed/,
  );
  t.mock.restoreAll();
  assert.equal(run.jobId, null);
  assert.deepEqual(run.retriedJobs, [{ jobId, reason: "worker-died" }]);
  assert.deepEqual(f.events(), []);
});

test("failed terminal settlement on --run retains state and later recovers without another submission", async (t) => {
  const f = direct(t);
  await f.invoke([...LAUNCH.slice(0, -2), "--wait-ms", "8000", "--keep-state"]);
  const run = f.metadata(),
    dir = path.join(f.state, run.runKey);
  const id = createJob(dir, {
    pid: run.worker.pid,
    processStart: run.worker.processStart,
    phase: "starting",
  });
  run.jobId = id;
  delete run.worker;
  delete run.result;
  run.retriedJobs = [{ jobId: "task-given-up", reason: "worker-died" }];
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
  const link = fs.linkSync,
    rename = fs.renameSync;
  t.mock.method(fs, "linkSync", (from, to, ...args) => {
    if (to === path.join(dir, "jobs", id, "turn.json"))
      throw new Error("terminal publication unavailable");
    return link(from, to, ...args);
  });
  t.mock.method(fs, "renameSync", (from, to, ...args) => {
    if (to === path.join(dir, "jobs", id, "turn.json"))
      throw new Error("terminal publication unavailable");
    return rename(from, to, ...args);
  });
  const refused = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
  t.mock.restoreAll();
  assert.equal(refused.code, 1, refused.stderr);
  assert.equal(f.metadata().result, undefined);
  assert.equal(readTurn(dir, id), null);
  const result = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(delivered(result.stdout).footer.status, "failed");
  assert.equal(f.events().filter((e) => e.method === "turn/start").length, 1);
});

test("a lost finished launch is adopted and delivered without a second dispatch", async (t) => {
  const f = direct(t);
  await f.invoke([...LAUNCH.slice(0, -2), "--detach"]);
  const run = f.metadata(),
    dir = path.join(f.state, run.runKey);
  await until(() => readTurn(dir, run.jobId));
  run.jobId = null;
  delete run.worker;
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
  const result = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(delivered(result.stdout).footer.status, "completed");
  assert.equal(f.events().filter((e) => e.method === "turn/start").length, 1);
});

test("an uncertain continued launch recovers only this turn and records its driver before delivery", async (t) => {
  const f = direct(t);
  await f.invoke([...LAUNCH.slice(0, -2), "--wait-ms", "8000", "--keep-state", "--keep-prompt"]);
  f.configure({ status: "running" });
  await f.invoke(["--continue", f.runs()[0], "--prompt-file", "prompt.md", "--detach"]);
  const run = f.metadata(),
    dir = path.join(f.state, run.runKey),
    id = run.jobId;
  await until(() => readDriver(dir, id)?.turnId);
  run.jobId = null;
  run.continuing = true;
  delete run.worker;
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
  assert.equal((await f.invoke(["--run", run.runKey, "--wait-ms", "0"])).code, 3);
  assert.equal(f.metadata().jobId, id);
  assert.equal(f.metadata().worker.jobId, id);
  assert.equal(f.metadata().continuing, undefined);
  assert.equal(f.metadata().dormant, undefined);
  assert.notEqual(id, run.turns[0].jobId);
  f.configure({ status: "completed" });
  assert.equal((await f.invoke(["--run", run.runKey, "--wait-ms", "8000"])).code, 0);
  assert.equal(f.events().filter((e) => e.method === "turn/start").length, 2);
});

for (const mode of ["--run", "--cancel", "--close"])
  test(`${mode} settles a dead undispatched driver without killing or retrying an already used retry`, async (t) => {
    const f = direct(t);
    await f.invoke([...LAUNCH.slice(0, -2), "--wait-ms", "8000", "--keep-state"]);
    const run = f.metadata(),
      dir = path.join(f.state, run.runKey);
    const id = createJob(dir, {
      pid: run.worker.pid,
      processStart: run.worker.processStart,
      phase: "starting",
    });
    appendLog(dir, id, "dead driver diagnostic\n");
    run.jobId = id;
    run.worker.jobId = id;
    delete run.result;
    run.retriedJobs = [{ jobId: "task-given-up", reason: "worker-died" }];
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
    const result = await f.invoke(
      [
        mode,
        run.runKey,
        ...(mode === "--close" ? ["--force"] : mode === "--run" ? ["--wait-ms", "0"] : []),
      ],
      {
        processes: {
          probe: { start: () => assert.fail("dead PID needs no identity query") },
          stop: () => assert.fail("a dead driver is never stopped"),
        },
      },
    );
    assert.equal(result.code, mode === "--close" ? 0 : 2, result.stderr);
    if (mode !== "--close") assert.equal(delivered(result.stdout).footer.status, "failed");
    assert.ok(
      fs.existsSync(path.join(f.resultsDir, "audit", run.runKey, `worker-death-${id}.turn.json`)),
    );
    assert.equal(f.events().filter((e) => e.method === "turn/start").length, 1);
  });
