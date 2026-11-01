import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/runner-fixture.mjs";
import { createJob, readTurn, readDriver } from "../src/state/job-store.mjs";
import { stopRunDriver } from "../src/run/lifecycle.mjs";
import { writerOwners } from "../src/state/state.mjs";
import { delivered } from "./support/capture.mjs";
import { until } from "./support/driver-evidence.mjs";
import { alive } from "../src/shared/io.mjs";

test("kept turns are cold, sleep is repeatable, continuation resumes the thread and close releases claims", async (t) => {
  const f = fixture(t);
  assert.equal(
    (await f.invoke([...LAUNCH, "--keep-state", "--keep-prompt", "--request-id", "cold"])).code,
    0,
  );
  const run = f.metadata(),
    thread = run.result.threadId;
  assert.equal(run.dormant, true);
  for (let n = 0; n < 2; n++) assert.equal((await f.invoke(["--sleep", run.runKey])).code, 0);
  const next = await f.invoke([
    "--continue",
    run.runKey,
    "--prompt-file",
    "prompt.md",
    "--wait-ms",
    "8000",
  ]);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(f.metadata().result.threadId, thread);
  assert.equal((await f.invoke(["--close", run.runKey])).code, 0);
  assert.equal(fs.existsSync(path.join(f.state, "requests", "cold.lock")), false);
});

test("ordinary close retains active and undelivered work; cancel delivers a terminal record", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--keep-state", "--write"])).code, 3);
  const run = f.metadata();
  assert.equal((await f.invoke(["--close", run.runKey])).code, 1);
  assert.equal((await f.invoke(["--sleep", run.runKey])).code, 1);
  const cancelled = await f.invoke(["--cancel", run.runKey]);
  assert.equal(cancelled.code, 2, cancelled.stderr);
  assert.equal(readTurn(path.join(f.state, run.runKey), run.jobId).status, "cancelled");
  assert.equal(writerOwners(f.state).size, 0);
  assert.equal((await f.invoke(["--close", run.runKey])).code, 0);
});

test("cleanup retains an unowned job with unknown driver identity and never stops by PID", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, 0);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  createJob(stateDir, { pid: process.pid, processStart: null, phase: "dispatching" });
  let stops = 0;
  await assert.rejects(
    stopRunDriver(run, {
      stateDir,
      force: true,
      processes: {
        probe: { start: () => null },
        stop: async () => {
          stops++;
        },
      },
    }),
    /state retained/,
  );
  assert.equal(stops, 0);
  assert.equal(f.runs().length, 1);
});

test("damaged retirement observes direct job identities, even after a terminal turn", async (t) => {
  const f = fixture(t),
    key = "a".repeat(32),
    stateDir = path.join(f.state, key);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, "run.json"), "{");
  createJob(stateDir, { pid: process.pid, processStart: null });
  const result = await f.invoke(["--close", key, "--force"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /driver may still run/);
  assert.equal(fs.existsSync(stateDir), true);
});

test("damaged retirement preserves a recorded maintenance app-server", async (t) => {
  const f = fixture(t),
    key = "b".repeat(32),
    stateDir = path.join(f.state, key);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(
    path.join(stateDir, "run.json"),
    JSON.stringify({
      maintenanceWorker: { pid: process.pid, processStart: "unknown" },
    }),
  );
  const result = await f.invoke(["--close", key, "--force"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /recorded process may still run/);
  assert.equal(fs.existsSync(stateDir), true);
  assert.equal(fs.existsSync(path.join(f.state, "quarantine", key)), false);
});

test("cancel of a run with a delivered result only re-delivers it", async (t) => {
  const f = fixture(t);
  const first = await f.invoke([...LAUNCH, "--keep-state"]);
  const before = f.events();
  const result = await f.invoke(["--cancel", f.runs()[0]]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, first.stdout);
  assert.match(result.stderr, /already has a delivered result; nothing to cancel/);
  assert.deepEqual(f.events(), before);
  assert.equal(f.results().length, 1);
});

test("--run and --close identify a lost launch's job the same way and close refuses while it runs", async (t) => {
  const f = fixture(t, { status: "running" });
  await f.invoke([...LAUNCH, "--keep-state"]);
  const run = f.metadata(),
    file = path.join(f.state, run.runKey, "run.json");
  // Receiving turn/start precedes the detached driver's running checkpoint.
  await until(
    () => readDriver(path.join(f.state, run.runKey), run.jobId)?.phase === "running",
    "running checkpoint before losing the launch record",
  );
  const lost = { ...run, jobId: null };
  delete lost.worker;
  fs.writeFileSync(file, JSON.stringify(lost));
  const refused = await f.invoke(["--close", run.runKey]);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /still running/);
  assert.equal(f.metadata().jobId, run.jobId);
  assert.equal(f.metadata().worker, undefined, "close records the job, not a new driver birth");
  fs.writeFileSync(file, JSON.stringify(lost));
  const attached = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
  assert.equal(attached.code, 3, attached.stderr);
  assert.deepEqual(f.metadata().worker, run.worker);
  f.configure({ status: "completed" });
  const result = await f.invoke(["--run", run.runKey, "--wait-ms", "8000"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(delivered(result.stdout).footer.job, run.jobId);
  assert.equal((await f.invoke(["--sleep", run.runKey])).code, 0);
  assert.equal((await f.invoke(["--close", run.runKey])).code, 0);
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
});

test("cancel of a job whose run names no worker uses the job's recorded driver identity", async (t) => {
  const f = fixture(t, { status: "running" });
  await f.invoke([...LAUNCH, "--keep-state"]);
  const run = f.metadata(),
    file = path.join(f.state, run.runKey, "run.json");
  delete run.worker;
  fs.writeFileSync(file, JSON.stringify(run));
  const result = await f.invoke(["--cancel", run.runKey]);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(delivered(result.stdout).footer.status, "cancelled");
  assert.equal(readTurn(path.join(f.state, run.runKey), run.jobId).status, "cancelled");
  assert.equal(f.events().filter((e) => e.command === "interrupt").length, 1);
});

test("a lost continued launch is adopted as this turn, delivered and put to sleep without another dispatch", async (t) => {
  const f = fixture(t);
  await f.invoke([...LAUNCH, "--keep-state", "--keep-prompt"]);
  const previous = f.metadata();
  f.configure({ status: "running" });
  await f.invoke([
    "--continue",
    previous.runKey,
    "--prompt-file",
    "prompt.md",
    "--write",
    "--wait-ms",
    "0",
  ]);
  const run = f.metadata(),
    file = path.join(f.state, run.runKey, "run.json");
  run.jobId = null;
  delete run.worker;
  fs.writeFileSync(file, JSON.stringify(run));
  assert.equal((await f.invoke(["--close", run.runKey])).code, 1);
  assert.notEqual(f.metadata().jobId, previous.jobId);
  f.configure({ status: "completed" });
  const done = await f.invoke(["--run", run.runKey, "--wait-ms", "8000"]);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(delivered(done.stdout).footer.turn, 2);
  assert.equal(f.metadata().dormant, true);
  assert.equal(writerOwners(f.state).size, 0);
  assert.equal(f.events().filter((e) => e.command === "task").length, 2);
});

test("--sleep and delivery record one sleep audit row each, while a failed sleep records neither sleep nor dormancy", async (t) => {
  const f = fixture(t);
  await f.invoke([...LAUNCH, "--keep-state", "--quiet"]);
  const run = f.metadata(),
    dir = path.join(f.state, run.runKey);
  const audit = path.join(f.resultsDir, "audit", run.runKey);
  const sleeps = () =>
    fs
      .readdirSync(audit)
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) =>
        fs.readFileSync(path.join(audit, file), "utf8").trim().split("\n").map(JSON.parse),
      )
      .filter((row) => row.transition === "sleep").length;
  assert.equal(run.dormant, true);
  assert.equal(sleeps(), 1);
  assert.equal((await f.invoke(["--sleep", run.runKey])).code, 0);
  assert.equal(sleeps(), 2);
  run.dormant = false;
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
  createJob(dir, { pid: process.pid, processStart: null });
  const refused = await f.invoke(["--sleep", run.runKey]);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /state retained/);
  assert.equal(sleeps(), 2);
  assert.equal(f.metadata().dormant, false);
});

for (const [recorded, override] of [
  [true, false],
  [false, false],
  [false, true],
])
  test(`a cancel before the lock keeps recorded quiet unless its command line asks for quiet (${recorded}/${override})`, async (t) => {
    const f = fixture(t, { status: "running" });
    await f.invoke([...LAUNCH, "--keep-state", ...(recorded ? ["--quiet"] : [])]);
    const run = f.metadata();
    const result = await f.invoke(["--cancel", run.runKey, ...(override ? ["--quiet"] : [])]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(delivered(result.stdout).footer.status, "cancelled");
    assert.equal(f.metadata().quiet, recorded || override);
    if (recorded || override) assert.equal(result.stderr, "");
    else assert.match(result.stderr, /ended with status cancelled/);
  });

test("attach keeps its workspace and CLI pin across an executable update without rediscovery", async (t) => {
  const f = fixture(t, { status: "running" });
  await f.invoke([...LAUNCH, "--keep-state"]);
  const run = f.metadata();
  fs.renameSync(f.executable, path.join(f.bin, "replaced-cli"));
  f.configure({ status: "completed" });
  const result = await f.invoke(["--run", run.runKey, "--wait-ms", "8000"], { cwd: f.other });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.metadata().codex, run.codex);
  assert.equal(f.metadata().cwd, run.cwd);
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
});

test("a deleted launch subdirectory still delivers and closes from independent driver state", async (t) => {
  const f = fixture(t, { status: "running" });
  const cwd = path.join(f.work, "component");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "prompt.md"), "subdirectory task");
  await f.invoke([...LAUNCH, "--keep-state", "--cwd", cwd]);
  const run = f.metadata();
  f.configure({ status: "completed" });
  await until(() => readTurn(path.join(f.state, run.runKey), run.jobId) && !alive(run.worker.pid));
  // Windows holds a live process's cwd open. Remove it after that process
  // exits, while the caller still has not delivered the result.
  await until(() => {
    try {
      fs.rmdirSync(cwd);
      return true;
    } catch (error) {
      if (error.code === "EBUSY") return false;
      throw error;
    }
  });
  assert.equal((await f.invoke(["--run", run.runKey, "--wait-ms", "8000"])).code, 0);
  assert.equal((await f.invoke(["--close", run.runKey])).code, 0);
  assert.equal(fs.existsSync(cwd), false);
});

test("close retains unknown job evidence and undelivered results; force only drops a confirmed ended result", async (t) => {
  const f = fixture(t, { status: "running" });
  await f.invoke(LAUNCH);
  const run = f.metadata(),
    dir = path.join(f.state, run.runKey);
  const turn = path.join(dir, "jobs", run.jobId, "turn.json");
  fs.writeFileSync(turn, JSON.stringify({ version: 1, jobId: run.jobId, status: "future-status" }));
  for (const extra of [[], ["--force"]]) {
    assert.equal((await f.invoke(["--close", run.runKey, ...extra])).code, 1);
    assert.ok(fs.existsSync(dir));
  }
  fs.rmSync(turn);
  f.configure({ status: "completed" });
  await until(() => readTurn(dir, run.jobId));
  const refused = await f.invoke(["--close", run.runKey]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /result was never delivered/);
  assert.equal((await f.invoke(["--close", run.runKey, "--force"])).code, 0);
});
