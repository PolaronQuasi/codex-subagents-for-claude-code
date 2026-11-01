import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import test from "node:test";
import { runProcess } from "../src/index.mjs";
import {
  openStartReader,
  ownerAlive,
  processStart,
  startReader,
} from "../src/shared/process-identity.mjs";

import { JOB, LAUNCH, fixture } from "./support/runner-fixture.mjs";
import { isAlive, retire } from "./support/processes.mjs";

import { EXIT } from "../src/shared/errors.mjs";
import { PS_COMMAND_LINE } from "../src/shared/constants.mjs";
import { fixture as direct } from "./support/codex-fixture.mjs";
import { createJob, readDriver, readTurn, writeDriver } from "../src/state/job-store.mjs";
import { inspectAppServer, inspectDriver } from "../src/codex/driver-client.mjs";
import { until } from "./support/driver-evidence.mjs";
import { delivered } from "./support/capture.mjs";

const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

// A live process that is not the job's worker, as a reused PID would be.
async function bystander(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => child.once("spawn", resolve).once("error", reject));
  return child.pid;
}

const deadPid = async () =>
  Number(
    (await runProcess(process.execPath, ["-e", "console.log(process.pid)"], { timeoutMs: 5000 }))
      .stdout,
  );

// The job file and the plugin's list both name pid as the running worker,
// which started at startedAt.
function plantWorker(f, key, pid, startedAt) {
  const file = path.join(f.state, key, "state", "workspace-hash", "jobs", `${JOB}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...record, status: "running", pid, startedAt }));
  f.configure({ progress: { pid, startedAt } });
  return file;
}

// Linux dates a process from btime, which moves with wall-clock steps, so there
// only the runner's recorded identity tells a reused PID: record that the
// runner first saw another process under pid.
function plantReusedIdentity(f, key, pid) {
  if (process.platform !== "linux") return;
  const file = path.join(f.state, key, "run.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const worker = { jobId: JOB, pid, processStart: "an earlier process" };
  fs.writeFileSync(file, JSON.stringify({ ...record, worker }));
}

test("start times convert to epoch milliseconds on each platform", async () => {
  const { startTimeMs } = await import("../src/shared/process-identity.mjs");
  const at = Date.UTC(2026, 9, 27, 10, 15, 32);
  const ticks = String(BigInt(at) * 10000n + 621355968000000000n);
  assert.equal(startTimeMs(ticks, "win32"), at);
  assert.equal(startTimeMs("Tue Oct  6 09:05:07 2026", "darwin"), +new Date(2026, 9, 6, 9, 5, 7));
  assert.equal(
    startTimeMs("Mon Oct 27 10:15:32 2026", "darwin"),
    +new Date(2026, 9, 27, 10, 15, 32),
  );
  for (const [value, platform] of [
    ["not ticks", "win32"],
    ["lundi 27 octobre 2026", "darwin"],
    [null, "win32"],
  ])
    assert.equal(startTimeMs(value, platform), null, `${platform} ${value}`);
  const own = processStart(process.pid);
  if (own === null) return; // the OS refused the query; PID-only checks remain
  const startedAt = startTimeMs(own);
  const expected = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(startedAt - expected) < 10_000, `${startedAt} vs ${expected}`);
});

test("the fixture teardown kills a leftover process only while its start time proves it is the same one", async (t) => {
  const spawnIdle = async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve, reject) => child.once("spawn", resolve).once("error", reject));
    t.after(() => child.kill());
    return child;
  };
  const kept = await spawnIdle();
  const start = processStart(kept.pid);
  if (start === null) {
    t.skip("the OS reports no process start time here");
    return;
  }
  // A start time that differs is another process holding the PID: left alone,
  // and reported once its grace has passed too. This is the warning
  // "fixture process N did not end and could not be identified" that every
  // run used to print: this test's own process, which it then retires.
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.equal(
    await retire(
      { pid: kept.pid, start: "an earlier process" },
      { waitMs: 100, graceMs: 100, warn },
    ),
    "unproved",
  );
  assert.ok(isAlive(kept.pid), "a PID that cannot be proved is never killed");
  assert.deepEqual(warnings, [
    `fixture process ${kept.pid} did not end and could not be identified; left alone`,
  ]);
  // The same start time: the leftover is the disposable process, so it goes.
  const exited = new Promise((resolve) => kept.once("exit", resolve));
  assert.equal(await retire({ pid: kept.pid, start }, { waitMs: 100, warn }), "killed");
  await exited;
  assert.equal(isAlive(kept.pid), false);
  assert.equal(warnings.length, 1, "nothing more to report");
});

test("the fixture teardown waits out a leftover it cannot identify, and counts one that ends then as ended, without a warning", async (t) => {
  // A process that outlives the first wait and ends on its own a moment later.
  const late = spawn(process.execPath, ["-e", "setTimeout(() => {}, 800)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => late.once("spawn", resolve).once("error", reject));
  t.after(() => late.kill());
  const warnings = [];
  const outcome = await retire(
    { pid: late.pid, start: "an earlier process" },
    { waitMs: 100, graceMs: 10_000, warn: (message) => warnings.push(message) },
  );
  assert.equal(outcome, "ended");
  assert.deepEqual(warnings, [], "an ended process is no leftover");
  assert.equal(isAlive(late.pid), false);
});

test("a request claim whose owner PID was reused is not waited for", async (t) => {
  const f = fixture(t, { status: "running" });
  const launch = (id) => [...LAUNCH, "--request-id", id, "--keep-prompt"];
  assert.equal((await f.invoke(launch("reused-claim"))).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  const jobId = f.metadata(key).jobId;
  const claim = path.join(f.state, "requests", "reused-claim.lock", "owner.json");
  const owner = JSON.parse(fs.readFileSync(claim, "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.processStart, processStart(process.pid), "claims record the start time");
  if (owner.processStart === null) {
    t.skip("the OS reports no process start time here");
    return;
  }
  // The claimant's PID now belongs to another process (this one, with another start time).
  fs.writeFileSync(claim, JSON.stringify({ ...owner, processStart: "an earlier process" }));
  const record = path.join(f.state, key, "run.json");
  const saved = JSON.parse(fs.readFileSync(record, "utf8"));
  // A claimant that recorded its run but not yet its job: the repeat takes the run over.
  fs.writeFileSync(record, JSON.stringify({ ...saved, jobId: null }));
  const attached = await f.invoke(launch("reused-claim"));
  assert.equal(attached.code, EXIT.STILL_RUNNING, attached.stderr);
  assert.match(attached.stdout, new RegExp(`^STILL RUNNING: Codex job ${jobId}\\. `));
  assert.match(attached.stderr, /attaching instead of launching/);
  assert.equal(f.metadata(key).jobId, jobId, "the job was identified");
  // One that never recorded its run is reported at once instead of waited for.
  fs.rmSync(record);
  const refused = await f.invoke(launch("reused-claim"));
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(
    refused.stderr,
    new RegExp(
      `request reused-claim was claimed by process ${process.pid}, which ended before it recorded its run`,
    ),
  );
  assert.equal(f.events().filter((e) => e.command === "task").length, 1, "nothing relaunched");
  assert.equal(ownerAlive({ pid: process.pid }), true, "a claim without a start time is PID-only");
});

test("a launch's start-time reader answers as processStart does, by PID, and a closed or probe-only reader asks the probe", async (t) => {
  const live = await bystander(t);
  const dead = await deadPid();
  const reader = openStartReader();
  // Asked together and in any order, each answer belongs to its own PID.
  const asked = [live, dead, process.ppid, 0, live];
  const answers = await Promise.all(asked.map((pid) => reader.start(pid)));
  assert.deepEqual(
    answers,
    asked.map((pid) => processStart(pid)),
    "the ticks a one-shot query reads, null for a dead PID",
  );
  assert.equal(typeof answers[0], "string");
  assert.equal(answers[1], null);
  reader.close();
  assert.equal(await reader.start(live), processStart(live), "a closed reader asks processStart");
  const calls = [];
  const probeOnly = startReader({
    start: (pid) => {
      calls.push(pid);
      return `start-of-${pid}`;
    },
  });
  assert.equal(await probeOnly.start(live), `start-of-${live}`);
  probeOnly.close();
  assert.deepEqual(calls, [live]);
});
for (const mode of ["--run", "--cancel", "--close"])
  test(`a reused driver PID on ${mode} leaves the unrelated process alone and preserves diagnostics`, async (t) => {
    const f = direct(t);
    await f.invoke([...LAUNCH.slice(0, -2), "--wait-ms", "8000", "--keep-state"]);
    const run = f.metadata(),
      dir = path.join(f.state, run.runKey);
    const other = f.spawnServer();
    const birth = await until(() => processStart(other.pid));
    const id = createJob(dir, {
      pid: other.pid,
      processStart: "previous birth",
      phase: "starting",
    });
    run.jobId = id;
    run.worker = { jobId: id, pid: other.pid, processStart: "previous birth" };
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
          probe: {
            start: (pid) => {
              assert.equal(pid, other.pid);
              return birth;
            },
          },
          stop: () => assert.fail("a reused PID must never be stopped"),
        },
      },
    );
    if (process.platform === "darwin") {
      assert.equal(result.code, mode === "--run" ? 3 : 1, result.stderr);
      assert.ok(fs.existsSync(dir), "coarse macOS identities remain uncertain");
    } else {
      assert.equal(result.code, mode === "--close" ? 0 : 2, result.stderr);
      if (mode !== "--close") assert.equal(delivered(result.stdout).footer.status, "failed");
      assert.ok(
        fs.existsSync(path.join(f.resultsDir, "audit", run.runKey, `worker-death-${id}.turn.json`)),
      );
    }
    assert.equal(isAlive(other.pid), true);
    assert.equal(
      f.events().some((e) => e.method === "turn/interrupt"),
      false,
    );
  });

test("a disposable driver and its fake app-server end once their control file is gone", async (t) => {
  const f = direct(t, { status: "running" });
  await f.invoke([...LAUNCH.slice(0, -2), "--detach"]);
  const run = f.metadata(),
    dir = path.join(f.state, run.runKey);
  await until(() => readDriver(dir, run.jobId)?.turnId);
  const driver = readDriver(dir, run.jobId);
  assert.equal(driver.pid, run.worker.pid);
  assert.equal(driver.processStart, processStart(driver.pid));
  fs.rmSync(f.workerControl);
  await until(() => !isAlive(driver.pid) && !isAlive(driver.appServer.pid));
  assert.equal(readTurn(dir, run.jobId), null, "a crash is not immutable terminal evidence");
  const recovered = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
  assert.equal(recovered.code, EXIT.NOT_COMPLETED, recovered.stderr);
  assert.equal(delivered(recovered.stdout).footer.status, "failed");
  assert.equal(f.events().filter((event) => event.method === "turn/start").length, 1);
});

test("a wait uses its given process probe for the driver without rewriting its birth identity", async (t) => {
  const f = direct(t, { status: "running" });
  await f.invoke([...LAUNCH.slice(0, -2), "--detach"]);
  const run = f.metadata(),
    asked = [];
  const result = await f.invoke(["--run", run.runKey, "--wait-ms", "0"], {
    processes: {
      probe: {
        start: (pid) => {
          asked.push(pid);
          return run.worker.processStart;
        },
      },
      stop: () => assert.fail("active wait stops nothing"),
    },
  });
  assert.equal(result.code, 3, result.stderr);
  assert.ok(asked.includes(run.worker.pid));
  assert.deepEqual(f.metadata().worker, run.worker);
});

// a probe that answers as macOS's does, whatever the host: ps's lstart
// is a local time, so a changed start time alone proves nothing there.
const macProbe = (start, commandLine) => ({
  probe: { platform: "darwin", start, ...(commandLine ? { commandLine } : {}) },
  stop: () => assert.fail("a PID that is not proved ours is never stopped"),
});
const driverLine = (jobId) =>
  `/usr/local/bin/node /opt/csfcc/src/codex/driver.mjs run --job-id ${jobId} --state-dir /s`;
const APP_SERVER_LINES = [
  "/opt/homebrew/bin/codex app-server --listen stdio://",
  "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js app-server --listen stdio:// --disable plugins",
  "/opt/homebrew/Caskroom/codex/0.166.0/codex-aarch64-apple-darwin app-server --listen stdio://",
];

test("on macOS a changed start time is another process only when the command line under it is not ours", async (t) => {
  const pid = await bystander(t);
  const lines = [];
  const asked = (line) =>
    macProbe(
      () => "current birth",
      (at, start) => {
        lines.push([at, start]);
        return line;
      },
    );
  const driver = { jobId: "task-darwin-0001", pid, processStart: "previous birth" };
  assert.equal(inspectDriver(driver, { processes: asked("/usr/sbin/unrelated -d") }), "reused");
  assert.deepEqual(lines, [[pid, "current birth"]], "the line is read under the current start");
  assert.equal(inspectDriver(driver, { processes: asked(driverLine(driver.jobId)) }), "unknown");
  assert.equal(inspectDriver(driver, { processes: asked(null) }), "unknown");
  assert.equal(inspectDriver(driver, { processes: asked("") }), "unknown");
  assert.equal(
    inspectDriver(driver, { processes: macProbe(() => "current birth") }),
    "unknown",
    "a probe that cannot read command lines proves nothing",
  );
  for (const platform of ["win32", "linux"])
    assert.equal(
      inspectDriver(driver, {
        processes: { probe: { platform, start: () => "current birth" } },
      }),
      "reused",
      `${platform} start times never change`,
    );
  const server = { pid, processStart: "previous birth" };
  for (const line of APP_SERVER_LINES)
    assert.equal(inspectAppServer(server, { processes: asked(line) }), "unknown", line);
  for (const line of ["/Applications/Other.app/Contents/MacOS/Other", "codex exec --listen x"])
    assert.equal(inspectAppServer(server, { processes: asked(line) }), "reused", line);
  assert.equal(
    inspectDriver(server, { processes: asked("/usr/sbin/unrelated -d") }),
    "unknown",
    "a record without a job has no driver line to compare",
  );
});

// BSD ps, which macOS's derives from, cuts its one column to 79
// characters when no stdio is a terminal (spawnSync pipes all three) unless -w
// is given twice. A macOS probe answering as that ps would to the arguments.
const bsdPs = (args, line) =>
  args.includes("-ww") || args.filter((arg) => arg === "-w").length > 1 ? line : line.slice(0, 79);

test("on macOS ps is asked for the whole command line, so a cut line never makes a live driver or app-server reused", async (t) => {
  const pid = await bystander(t);
  const jobId = "0123456789abcdef".repeat(2);
  const driver = { jobId, pid, processStart: "previous birth" };
  const server = { pid, processStart: "previous birth" };
  const node = "/opt/homebrew/Cellar/node@22/22.11.0";
  const lines = {
    driver: `${node}/bin/node /private/var/csfcc/.claude/codex-subagents-for-claude-code-state/runtime/1.0.0-0123456789ab/src/codex/driver.mjs run --job-id ${jobId}`,
    server: `${node}/bin/node ${node}/lib/node_modules/@openai/codex/bin/codex.js app-server --listen stdio://`,
  };
  const ps = (args, line) =>
    macProbe(
      () => "current birth",
      (at) => bsdPs([...args, String(at)], line),
    );
  assert.equal(inspectDriver(driver, { processes: ps(PS_COMMAND_LINE, lines.driver) }), "unknown");
  assert.equal(
    inspectAppServer(server, { processes: ps(PS_COMMAND_LINE, lines.server) }),
    "unknown",
  );
  // The control: cut to 79 columns, as ps without -ww prints them, both lines
  // lose what marks them as ours and would read as another process.
  const cut = [...PS_COMMAND_LINE].filter((arg) => arg !== "-ww");
  assert.equal(inspectDriver(driver, { processes: ps(cut, lines.driver) }), "reused");
  assert.equal(inspectAppServer(server, { processes: ps(cut, lines.server) }), "reused");
  // The runner's own ps call passes exactly those arguments.
  assert.match(
    fs.readFileSync(new URL("../src/shared/process-identity.mjs", import.meta.url), "utf8"),
    /spawnSync\("ps", \[\.\.\.PS_COMMAND_LINE, String\(pid\)\]/,
  );
});

for (const [name, plant, line, closes] of [
  ["held by unrelated processes", "both", "/usr/sbin/unrelated -d", true],
  ["held by this job's driver line", "driver", "driver", false],
  ["held by an app-server line", "appServer", APP_SERVER_LINES[1], false],
  ["held where no command line can be read", "both", null, false],
])
  test(`on macOS a delivered kept run whose old driver PIDs are ${name} ${closes ? "closes" : "is retained"}`, async (t) => {
    const f = direct(t);
    const launched = await f.invoke([...LAUNCH.slice(0, -2), "--wait-ms", "8000", "--keep-state"]);
    assert.equal(launched.code, 0, launched.stderr);
    const run = f.metadata(),
      dir = path.join(f.state, run.runKey);
    const recorded = readDriver(dir, run.jobId);
    await until(() => !isAlive(recorded.pid) && !isAlive(recorded.appServer.pid));
    const other = await bystander(t);
    const driverPid = plant === "appServer" ? await deadPid() : other;
    const serverPid = plant === "driver" ? await deadPid() : await bystander(t);
    const previous = { processStart: "previous birth" };
    writeDriver(dir, run.jobId, {
      ...recorded,
      pid: driverPid,
      ...previous,
      appServer: { pid: serverPid, ...previous },
    });
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({ ...run, worker: { jobId: run.jobId, pid: driverPid, ...previous } }),
    );
    const result = await f.invoke(["--close", run.runKey], {
      processes: macProbe(
        (pid) => processStart(pid),
        line === null
          ? (pid) => {
              assert.ok([driverPid, serverPid].includes(pid));
              return null;
            }
          : () => (line === "driver" ? driverLine(run.jobId) : line),
      ),
    });
    assert.equal(result.code, closes ? 0 : 1, result.stderr);
    assert.equal(fs.existsSync(dir), !closes);
    if (!closes) assert.match(result.stderr, /Process exit could not be confirmed/);
    assert.equal(isAlive(other), true, "the unrelated process is left alone");
  });
