import assert from "node:assert/strict";

import fs from "node:fs";

import path from "node:path";

import test from "node:test";
import { runProcess, workspaceId } from "../src/index.mjs";

import { delivered, sink } from "./support/capture.mjs";
import { SCRIPT, main } from "./support/cli-adapter.mjs";
import { TEXT, LAUNCH, ORIGINAL, fixture } from "./support/runner-fixture.mjs";
import { ERRNO, EXIT, SIGNALS } from "../src/shared/errors.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fixture as driverFixture } from "./support/codex-fixture.mjs";
import { until } from "./support/driver-evidence.mjs";
import { createJob, readDriver, readTurn, writeDriver, jobPaths } from "../src/state/job-store.mjs";
import { DRIVER_FILES, MAX_WAIT_MS } from "../src/shared/constants.mjs";

test("two simultaneous launches have isolated job state and sessions", async (t) => {
  const f = fixture(t, { status: "running" });
  fs.writeFileSync(path.join(f.work, "second.md"), "second prompt");
  const secondArgs = LAUNCH.map((value) => (value === "prompt.md" ? "second.md" : value));
  const results = await Promise.all([f.invoke(), f.invoke(secondArgs)]);
  assert.deepEqual(
    results.map((result) => result.code),
    [3, 3],
  );
  assert.equal(f.runs().length, 2);
  const launches = f.events().filter((event) => event.command === "task");
  assert.notEqual(launches[0].data, launches[1].data);
  assert.notEqual(launches[0].sessionId, launches[1].sessionId);
  assert.equal(new Set(launches.map((event) => event.prompt)).size, 2);
});

test("an unusable results directory is reported, the result is still delivered, and the run is kept as its only copy", async (t) => {
  const f = fixture(t);
  const unusable = {
    ...f.env,
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: path.join(f.root, "control.json"),
  };
  const result = await f.invoke(LAUNCH, { env: unusable });
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  assert.match(result.stderr, /Could not write the durable result copy/);
  assert.match(
    result.stderr,
    /State kept at .*: without a durable copy this run's cached result is the only one/,
  );
  const { body, footer } = delivered(result.stdout);
  assert.equal(body, TEXT);
  assert.equal(footer.file, "-");
  assert.equal(f.runs().length, 1, "a run without a durable copy is retained");
  assert.deepEqual(f.results(), []);
  const key = f.runs()[0];
  const run = f.metadata(key);
  assert.notEqual(run.keepState, true);
  assert.ok(
    run.result.cachedAt && run.result.acknowledgedAt && !run.result.durableSavedAt,
    JSON.stringify(run.result),
  );
  assert.equal(run.dormant, true, "its Codex processes are stopped, like a kept run's");
  assert.match(
    (await f.invoke(["--list"])).stdout,
    new RegExp(`^run=${key} status=completed `),
    "stdout accepted the text, so it counts as delivered",
  );
  const again = await f.invoke(f.resume(), { env: unusable });
  assert.equal(again.code, EXIT.COMPLETED, again.stderr);
  assert.equal(delivered(again.stdout).body, TEXT, "the cached result can be re-read");
  assert.equal(f.runs().length, 1);
  const closed = await f.invoke(["--close", key]);
  assert.equal(closed.code, EXIT.COMPLETED, closed.stderr);
  assert.deepEqual(f.runs(), []);
});

test("write and keep-prompt flags are explicit and preserved", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--write", "--keep-prompt"])).code, EXIT.COMPLETED);
  assert.ok(f.events()[0].args.includes("--write"));
  assert.ok(fs.existsSync(path.join(f.work, "prompt.md")));
});

test("mismatched job IDs cannot read or tear down another run", async (t) => {
  const f = fixture(t, { status: "running" });
  await f.invoke();
  const result = await f.invoke(["--run", f.runs()[0], "--attach", "wrong-job"]);
  assert.equal(result.code, EXIT.FAILURE);
  assert.match(result.stderr, /does not match/);
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
  assert.equal(f.runs().length, 1);
});

test("runs record the Claude session that launched them", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke()).code, EXIT.STILL_RUNNING);
  assert.deepEqual(
    [f.metadata().session, f.metadata().hostSession],
    ["sess-fixture", "local_fixture"],
  );
  assert.match((await f.invoke(["--list"])).stdout, / session=sess-fixture cwd=/);
  fs.writeFileSync(path.join(f.work, "prompt.md"), "again");
  assert.equal(
    (
      await f.invoke(LAUNCH, {
        env: { ...f.env, CLAUDE_CODE_SESSION_ID: "bad value!", CLAUDE_CODE_HOST_SESSION_ID: "" },
      })
    ).code,
    3,
  );
  assert.deepEqual(
    f
      .runs()
      .map((key) => f.metadata(key).session)
      .sort(),
    [null, "sess-fixture"].sort(),
  );
});

test("a launch that fails before writing its run record removes the run folder and gives back its lock and claim; the task file stays and a retry launches", async (t) => {
  const f = fixture(t);
  const runFolder = (dir) =>
    typeof dir === "string" &&
    path.dirname(dir) === f.state &&
    /^[0-9a-f]{32}$/.test(path.basename(dir));
  const injected = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
  const { mkdirSync, renameSync, rmSync } = fs;
  const failRecord = function (from, to, ...rest) {
    if (path.basename(to) === "run.json" && runFolder(path.dirname(to)))
      throw injected("EIO", "injected record failure");
    return renameSync.call(this, from, to, ...rest);
  };
  const failLock = function (dir, ...rest) {
    if (
      typeof dir === "string" &&
      dir.endsWith(".lock") &&
      runFolder(dir.slice(0, -".lock".length))
    )
      throw injected(ERRNO.EACCES, "injected lock failure");
    return mkdirSync.call(this, dir, ...rest);
  };
  const task = path.join(f.work, "task.md");
  // cwd: none creates the scratch workspace inside the run folder before the record is written.
  const text = "request-id: unrecorded\ncwd: none\n\nThe exact original task: λ.\n";
  const launch = ["--role", "gpt-6-1-sol", "--task-file", "task.md", "--wait-ms", "0"];
  const nothingLeft = (label) => {
    assert.deepEqual(
      fs.readdirSync(f.state).filter((name) => !runFolder(path.join(f.state, name))),
      ["requests"],
      `${label}: no run lock or guard is left`,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(f.state, "requests")),
      [],
      `${label}: the request claim is given back`,
    );
    assert.equal(fs.readFileSync(task, "utf8"), text, `${label}: the task file stays for a retry`);
  };
  // The record's rename fails once the run lock and the scratch workspace exist; the run lock cannot be taken.
  for (const [method, fake, message] of [
    ["renameSync", failRecord, /EIO: injected record failure/],
    ["mkdirSync", failLock, /EACCES: injected lock failure/],
  ]) {
    fs.writeFileSync(task, text);
    t.mock.method(fs, method, fake);
    const failed = await f.invoke(launch);
    t.mock.restoreAll();
    assert.equal(failed.code, EXIT.FAILURE, method);
    assert.match(failed.stderr, message);
    assert.doesNotMatch(failed.stderr, /State retained/);
    assert.deepEqual(f.runs(), [], `${method}: the run folder is removed`);
    nothingLeft(method);
    assert.equal(
      (await f.invoke(["--list"])).stdout,
      `No retained runs under ${f.state}.\n`,
      `${method}: nothing shows as no-metadata`,
    );
  }
  // A folder that cannot be removed either is reported beside the launch's own error.
  t.mock.method(fs, "mkdirSync", failLock);
  t.mock.method(fs, "rmSync", function (target, ...rest) {
    if (runFolder(target)) throw injected(ERRNO.EBUSY, "injected removal failure");
    return rmSync.call(this, target, ...rest);
  });
  const stuck = await f.invoke(launch);
  t.mock.restoreAll();
  assert.equal(stuck.code, EXIT.FAILURE);
  assert.match(stuck.stderr, /EACCES: injected lock failure/);
  const [left] = f.runs();
  assert.ok(left, "the folder stays when it cannot be removed");
  assert.ok(
    stuck.stderr.includes(
      `Could not remove the run folder ${path.join(f.state, left)}, which has no record: EBUSY: injected removal failure`,
    ),
    stuck.stderr,
  );
  nothingLeft("removal failure");
  fs.rmSync(path.join(f.state, left), { recursive: true });
  assert.deepEqual(f.events(), [], "nothing was launched");
  const retry = await f.invoke(launch);
  assert.equal(retry.code, EXIT.COMPLETED, retry.stderr);
  assert.equal(delivered(retry.stdout).footer.request, "unrecorded");
  assert.equal(fs.existsSync(task), false, "the retry launched and consumed the task file");
  assert.equal(f.events().filter((event) => event.command === "task").length, 1);
  assert.deepEqual(f.runs(), [], "and its delivered run was torn down");
});

test("a launch that fails after taking its run lock gives the lock back, and the claim while no record owns it; a recorded run stays for --close", async (t) => {
  const f = fixture(t);
  const runLock = (key) => path.join(f.state, `${key}.lock`);
  const owner = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")).runKey;
    } catch {
      return null;
    }
  };
  const claimOwner = (id) => owner(path.join(f.state, "requests", `${id}.lock`, "owner.json"));
  const writerOwner = () =>
    owner(path.join(f.state, "writers", `${workspaceId(f.work)}.lock`, "owner.json"));
  // Before the record is complete: storing prompt.txt fails, so the claim is still this attempt's.
  const renameSync = fs.renameSync;
  t.mock.method(fs, "renameSync", function (from, to, ...rest) {
    if (path.basename(to) === "prompt.txt" && path.dirname(path.dirname(to)) === f.state)
      throw Object.assign(new Error("EIO: injected rename failure"), { code: "EIO" });
    return renameSync.call(this, from, to, ...rest);
  });
  const early = await f.invoke([...LAUNCH, "--request-id", "f02-early"]);
  t.mock.restoreAll();
  assert.equal(early.code, EXIT.FAILURE);
  assert.match(early.stderr, /EIO: injected rename failure/);
  const first = f.runs()[0];
  assert.equal(fs.existsSync(runLock(first)), false, "the run lock is given back");
  assert.equal(claimOwner("f02-early"), null, "so is the claim, which no recorded run owns yet");
  assert.equal(
    f.events().some((event) => event.command === "task"),
    false,
    "nothing was launched",
  );
  assert.ok(fs.existsSync(path.join(f.work, "prompt.md")), "the prompt file stays for a retry");
  assert.equal(
    (await f.invoke([...LAUNCH, "--request-id", "f02-early"])).code,
    0,
    "a retry with the same request ID launches",
  );
  assert.equal(
    (await f.invoke(["--close", first])).code,
    0,
    "this process closes the failed attempt at once",
  );
  // After the record: the first informational line fails (a closed stderr). The claim and the
  // writer lock already belong to the recorded run, which stays for --run and --close.
  fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
  const lines = [];
  let fail = true;
  const stderr = {
    once() {},
    removeListener() {},
    destroy() {},
    write(text, callback) {
      if (fail && /^run-codex-task: Run [0-9a-f]{32}; Codex /.test(text)) {
        fail = false;
        callback(new Error("stderr closed (injected)"));
        return false;
      }
      lines.push(text);
      callback();
      return true;
    },
  };
  const late = await main([...LAUNCH, "--write", "--request-id", "f02-late"], {
    env: f.env,
    cwd: f.work,
    stdout: sink().stream,
    stderr,
  });
  assert.equal(late, 1);
  assert.match(lines.join(""), /stderr closed \(injected\)/);
  const second = f.runs()[0];
  assert.equal(fs.existsSync(runLock(second)), false, "the run lock is given back");
  const run = f.metadata(second);
  assert.deepEqual([run.jobId, run.requestId], [null, "f02-late"]);
  assert.equal(fs.readFileSync(path.join(f.state, second, "prompt.txt"), "utf8"), ORIGINAL);
  assert.equal(claimOwner("f02-late"), second, "the claim stays with the recorded run");
  assert.equal(writerOwner(), second, "and so does the writer lock");
  assert.equal(
    f.events().filter((event) => event.command === "task").length,
    1,
    "only the retry above launched",
  );
  assert.match(
    (await f.invoke(["--list"])).stdout,
    new RegExp(`^run=${second} status=launching .* request=f02-late keep=no writer=yes lock=- `),
  );
  const closed = await f.invoke(["--close", second]);
  assert.equal(closed.code, EXIT.COMPLETED, closed.stderr);
  assert.deepEqual(f.runs(), []);
  assert.deepEqual([claimOwner("f02-late"), writerOwner()], [null, null], "closing releases both");
});

for (const name of [SIGNALS.SIGINT, SIGNALS.SIGTERM])
  test(`${name} handler returns its signal exit code and keeps recovery state`, async (t) => {
    const f = fixture(t, { status: "running" });
    const wrapper = `
    const fs = require('node:fs');
    process.argv = [process.execPath, process.env.FIXTURE_RUNNER, ...JSON.parse(process.env.FIXTURE_ARGS)];
    const timer = setInterval(() => {
      if (fs.existsSync(process.env.FIXTURE_EVENTS) && fs.readFileSync(process.env.FIXTURE_EVENTS, 'utf8').includes('"method":"turn/start"')) {
        clearInterval(timer); process.emit(process.env.FIXTURE_SIGNAL, process.env.FIXTURE_SIGNAL);
      }
    }, 20);
    import(require('node:url').pathToFileURL(process.env.FIXTURE_RUNNER).href);
  `;
    const result = await runProcess(process.execPath, ["-e", wrapper], {
      cwd: f.work,
      timeoutMs: 10_000,
      env: {
        ...f.env,
        FIXTURE_RUNNER: SCRIPT,
        FIXTURE_ARGS: JSON.stringify([...LAUNCH.slice(0, -2), "--wait"]),
        FIXTURE_SIGNAL: name,
      },
    });
    assert.equal(
      result.status,
      name === SIGNALS.SIGINT ? EXIT.SIGINT : EXIT.SIGTERM,
      result.stderr,
    );
    assert.match(result.stderr, /Recover with:/);
    assert.equal(f.runs().length, 1);
    assert.equal(
      f.events().some((e) => e.command === "cleanup"),
      false,
    );
  });

test("long Unicode prompts travel verbatim through stdin and the selected model/effort are exact", async (t) => {
  const f = fixture(t),
    prompt = "Long task λ 日本語 🚀\n".repeat(3000);
  fs.writeFileSync(path.join(f.work, "prompt.md"), prompt);
  const done = await f.invoke([...LAUNCH, "--keep-prompt"]);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(f.events()[0].prompt, prompt);
  assert.equal(f.events()[0].model, "gpt-6.1-sol");
  assert.equal(f.events()[0].effort, "xhigh");
  assert.equal(fs.readFileSync(path.join(f.work, "prompt.md"), "utf8"), prompt);
});

for (const prompt of ["", "  \n", Buffer.from([0xff]), Buffer.alloc(8 * 1024 * 1024 + 1, 65)]) {
  test(`invalid UTF-8 or empty/oversize prompt is refused (${prompt.length})`, async (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.work, "prompt.md"), prompt);
    assert.equal((await f.invoke()).code, 1);
    assert.deepEqual(f.events(), []);
    assert.deepEqual(f.runs(), []);
    assert.equal(fs.existsSync(path.join(f.work, "prompt.md")), true);
  });
}

test("a missing CLI refuses before claiming or consuming the prompt", async (t) => {
  const f = fixture(t),
    env = { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH: path.join(f.root, "absent") };
  const done = await f.invoke([...LAUNCH, "--request-id", "missing-cli"], { env });
  assert.equal(done.code, 1);
  assert.deepEqual(f.runs(), []);
  assert.equal(fs.existsSync(path.join(f.state, "requests", "missing-cli.lock")), false);
  assert.equal(fs.existsSync(path.join(f.work, "prompt.md")), true);
});

test("JSON-expanded prompts are refused before request claims, writer locks or fake Codex dispatch", async (t) => {
  for (const [taskFile, text] of [
    [false, "a".repeat(8 * 1024 * 1024)],
    [true, '"'.repeat(4 * 1024 * 1024)],
    [false, "\0".repeat(2 * 1024 * 1024)],
  ]) {
    const f = driverFixture(t),
      source = path.join(f.work, taskFile ? "task.md" : "prompt.md");
    const bytes = taskFile ? `request-id: wire-limit\nwrite: yes\n\n${text}` : text;
    fs.writeFileSync(source, bytes);
    const result = await f.invoke(
      taskFile
        ? ["--role", "gpt-6-1-sol", "--task-file", "task.md"]
        : [...LAUNCH, "--request-id", "wire-limit", "--write"],
    );
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Prompt exceeds the Codex RPC byte limit after JSON encoding/);
    assert.equal(fs.readFileSync(source, "utf8"), bytes);
    assert.deepEqual(f.runs(), []);
    assert.deepEqual(f.events(), []);
    for (const folder of ["requests", "writers"])
      assert.equal(fs.existsSync(path.join(f.state, folder)), false);
  }
});

test("an oversized encoded follow-up leaves its delivered turn and writer state untouched", async (t) => {
  const f = driverFixture(t);
  const first = await f.invoke([...LAUNCH.slice(0, -2), "--wait-ms", "8000", "--keep-state"]);
  assert.equal(first.code, 0, first.stderr);
  const run = f.metadata(),
    file = path.join(f.state, run.runKey, "run.json");
  const before = fs.readFileSync(file, "utf8"),
    count = f.events().length;
  fs.writeFileSync(path.join(f.work, "next.md"), "\\".repeat(4 * 1024 * 1024));
  const result = await f.invoke([
    "--continue",
    run.runKey,
    "--prompt-file",
    "next.md",
    "--request-id",
    "wire-limit",
    "--write",
  ]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /after JSON encoding/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(f.events().length, count);
  assert.equal(fs.existsSync(path.join(f.work, "next.md")), true);
  assert.equal(fs.existsSync(path.join(f.state, "writers")), false);
});

test("failed and cancelled turns retain the exit codes and relay behavior", async (t) => {
  const f = fixture(t, { status: "failed" });
  const failure = await f.invoke();
  assert.equal(failure.code, 2, failure.stderr);
  assert.equal(delivered(failure.stdout).footer.status, "failed");
  fs.writeFileSync(path.join(f.work, "prompt.md"), "cancel next");
  f.configure({ status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--relay"])).code, 3);
  const done = await f.invoke(["--cancel", f.metadata().runKey]);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(delivered(done.stdout).footer.status, "cancelled");
});

test("commentary alone cannot become a successful final answer", async (t) => {
  const f = fixture(t, { phase: "commentary" });
  const done = await f.invoke();
  assert.equal(done.code, 2);
  assert.match(done.stdout, /without a final agent message/);
});

for (const body of ["{", JSON.stringify({ version: 1, jobId: "replaced", status: "completed" })])
  test(`damaged terminal evidence refuses delivery without resubmitting (${body.slice(0, 8)})`, async (t) => {
    const f = fixture(t, { status: "running" });
    assert.equal((await f.invoke([...LAUNCH, "--write"])).code, 3);
    const run = f.metadata();
    fs.writeFileSync(path.join(f.state, run.runKey, "jobs", run.jobId, "turn.json"), body);
    const done = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
    assert.equal(done.code, 1, done.stderr);
    assert.equal(done.stdout, "");
    assert.equal(f.events().filter((e) => e.command === "task").length, 1);
    assert.equal(f.runs().length, 1);
  });

test("wait has no budget: the waiter returns only when the job ends, never with exit 3", async (t) => {
  const f = driverFixture(t, { status: "running" });
  const began = Date.now();
  let offset = 0,
    waited = false;
  const done = await f.invoke([...LAUNCH.slice(0, -2), "--wait"], {
    timing: {
      now: () => Date.now() + offset,
      async sleep(ms) {
        // Cross the caller's old wait budget once. Subsequent sleeps include
        // real time so native process shutdown keeps its normal grace period.
        if (waited) return delay(ms);
        offset = MAX_WAIT_MS + ms;
        waited = true;
        await until(() => f.events().some((e) => e.method === "turn/start"));
        f.configure({ status: "completed" });
        await until(() => readTurn(path.join(f.state, f.runs()[0]), f.metadata().jobId));
      },
    },
  });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(delivered(done.stdout).body, TEXT);
  assert.equal(waited, true);
  assert.ok(Date.now() + offset - began > MAX_WAIT_MS);
});

for (const status of ["queued", "running"])
  test(`${status} returns resumable exit 3 with the exact attach command and keeps state`, async (t) => {
    const f = driverFixture(t, { status });
    const result = await f.invoke();
    const run = f.metadata();
    assert.equal(result.code, 3, result.stderr);
    assert.equal(
      result.stdout.split("\n")[0],
      `STILL RUNNING: Codex job ${run.jobId}. Wait again with: node '${SCRIPT.replaceAll("\\", "/")}' --attach ${run.jobId} --run ${run.runKey}`,
    );
    assert.equal(fs.readFileSync(path.join(f.state, run.runKey, "prompt.txt"), "utf8"), ORIGINAL);
    assert.deepEqual(f.results(), []);
    await until(() => f.events().some((e) => e.method === "turn/start"));
    assert.equal(f.events().filter((e) => e.method === "turn/start").length, 1);
    f.configure({ status: "completed" });
    const done = await f.invoke(["--run", run.runKey, "--wait-ms", "8000"]);
    assert.equal(done.code, 0, done.stderr);
  });

test("STILL RUNNING carries the job's phase, elapsed time and last progress line", async (t) => {
  const f = driverFixture(t, { status: "running" });
  await f.invoke([...LAUNCH.slice(0, -2), "--detach"]);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  await until(() => readDriver(stateDir, run.jobId)?.turnId);
  const result = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
  assert.equal(result.code, 3);
  assert.match(
    result.stdout,
    /\ncodex-subagents-for-claude-code-progress: phase=running elapsed=\d+s last=turn\/started\n$/,
  );
});

test("terminal job wins over a stale waitTimedOut flag and an expired waiter bound", async (t) => {
  const f = driverFixture(t);
  await f.invoke([...LAUNCH.slice(0, -2), "--detach"]);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  await until(() => readTurn(stateDir, run.jobId));
  writeDriver(stateDir, run.jobId, { ...readDriver(stateDir, run.jobId), waitTimedOut: true });
  const result = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(delivered(result.stdout).body, TEXT);
});

test("a failed driver launch preserves the prompt and never retries launch", async (t) => {
  const f = driverFixture(t),
    spawn = childProcess.spawn;
  let launches = 0;
  t.mock.method(childProcess, "spawn", (...args) => {
    if (args[1]?.[0]?.endsWith("driver.mjs")) {
      launches++;
      throw new Error("injected driver launch failure");
    }
    return spawn(...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await f.invoke([
      ...LAUNCH,
      "--write",
      "--request-id",
      "failed-spawn",
      "--keep-state",
    ]);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /injected driver launch failure/);
    assert.equal(fs.readFileSync(path.join(f.work, "prompt.md"), "utf8"), ORIGINAL);
    const run = f.metadata();
    assert.match(result.stderr, new RegExp(`--run ${run.runKey}`));
    assert.equal(launches, 1);
    assert.deepEqual(f.events(), []);
    assert.ok(fs.readdirSync(path.join(f.state, "writers")).some((name) => name.endsWith(".lock")));
    const failed = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
    assert.equal(failed.code, 2, failed.stderr);
    assert.equal(delivered(failed.stdout).footer.status, "failed");
    assert.match(
      delivered(failed.stdout).body,
      /Driver did not start.*injected driver launch failure/s,
    );
    assert.equal(launches, 1);
    const closed = await f.invoke(["--close", run.runKey]);
    assert.equal(closed.code, 0, closed.stderr);
    assert.deepEqual(fs.readdirSync(path.join(f.state, "writers")), []);
    assert.equal(fs.existsSync(path.join(f.state, "requests", "failed-spawn.lock")), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("a modified original task file is not deleted; the launched copy is unchanged", async (t) => {
  const f = driverFixture(t),
    rename = fs.renameSync;
  const task = path.join(f.work, "task.md");
  fs.writeFileSync(task, "keep: yes\n\nOriginal task body\n");
  t.mock.method(fs, "renameSync", (from, to, ...rest) => {
    const result = rename(from, to, ...rest);
    if (path.basename(to) === DRIVER_FILES.GATE) fs.writeFileSync(task, "edited while launching\n");
    return result;
  });
  const result = await f.invoke([
    "--role",
    "gpt-6-1-sol",
    "--task-file",
    "task.md",
    "--wait-ms",
    "8000",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(task, "utf8"), "edited while launching\n");
  assert.equal(
    fs.readFileSync(path.join(f.state, f.runs()[0], "prompt.txt"), "utf8"),
    "Original task body\n",
  );
  assert.equal(
    f.events().find((e) => e.method === "turn/start").params.input[0].text,
    "Original task body\n",
  );
});

for (const status of ["completed", "failed", "cancelled"])
  test(`${status} result keeps its exit code even when cleanup fails`, async (t) => {
    const f = driverFixture(t, { status: status === "cancelled" ? "running" : status }),
      rm = fs.rmSync;
    let args = [...LAUNCH.slice(0, -2), "--wait-ms", "8000"];
    if (status === "cancelled") {
      await f.invoke([...LAUNCH.slice(0, -2), "--detach"]);
      const run = f.metadata();
      await until(() => readDriver(path.join(f.state, run.runKey), run.jobId)?.turnId);
      args = ["--cancel", run.runKey];
    }
    t.mock.method(fs, "rmSync", (target, ...args) => {
      if (path.dirname(target) === f.state && /^[0-9a-f]{32}$/.test(path.basename(target)))
        throw new Error("injected cleanup failure");
      return rm(target, ...args);
    });
    const result = await f.invoke(args);
    assert.equal(result.code, status === "completed" ? 0 : 2, result.stderr);
    const answer = delivered(result.stdout).body;
    assert.ok(answer.length);
    if (status === "completed") assert.equal(answer, TEXT);
    if (status === "failed")
      assert.equal(answer, `${TEXT.trimEnd()}\n\nCODEX_RPC_ERROR: Fixture turn failed\n`);
    assert.equal(delivered(result.stdout).footer.status, status);
    assert.match(result.stderr, /Cleanup incomplete/);
    const run = f.metadata();
    assert.ok(run.result.acknowledgedAt);
    // Delivery is recoverable even if the independent job evidence vanished.
    t.mock.restoreAll();
    fs.rmSync(path.join(f.state, run.runKey, "jobs"), { recursive: true });
    const replay = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
    assert.equal(delivered(replay.stdout).body, answer);
    assert.equal(replay.code, result.code);
  });

test("a hung IPC status read has a bounded file fallback and retains state", async (t) => {
  const { serveIpc, readIpcSecret, ipcEndpoint } = await import("../src/codex/ipc.mjs");
  const { createDriverClient } = await import("../src/codex/driver-client.mjs");
  const f = driverFixture(t, { status: "running" });
  await f.invoke([...LAUNCH.slice(0, -2), "--detach"]);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  await until(() => readDriver(stateDir, run.jobId)?.phase === "running");
  // Drain startup checkpoints before replacing this test's diagnostic endpoint.
  assert.equal((await createDriverClient(run, { stateDir }).status()).phase, "running");
  const record = {
    ...readDriver(stateDir, run.jobId),
    endpoint: ipcEndpoint(f.root, "task-hung-status"),
  };
  if (process.platform !== "win32")
    fs.mkdirSync(path.dirname(record.endpoint), { recursive: true });
  const server = await serveIpc(
    record,
    readIpcSecret(stateDir, run.jobId),
    () => new Promise(() => {}),
  );
  try {
    writeDriver(stateDir, run.jobId, record);
    const started = performance.now();
    const hung = assert.rejects(
      createDriverClient(run, { stateDir }).request("status", {}, 100),
      /timed out/,
    );
    const result = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
    await hung;
    assert.ok(performance.now() - started < 5000);
    assert.equal(result.code, 3, result.stderr);
    assert.equal(f.metadata().jobId, run.jobId);
    assert.equal(readTurn(stateDir, run.jobId), null);
  } finally {
    await server.close();
  }
});

for (const file of ["driver.json", "turn.json", "final.txt"])
  test(`read failure retains state without resubmitting: ${file}`, async (t) => {
    const f = driverFixture(t),
      read = fs.openSync;
    await f.invoke([...LAUNCH.slice(0, -2), "--detach"]);
    const run = f.metadata(),
      stateDir = path.join(f.state, run.runKey);
    await until(() => readTurn(stateDir, run.jobId));
    const target = path.join(jobPaths(stateDir, run.jobId).directory, file);
    t.mock.method(fs, "openSync", (name, ...args) => {
      if (name === target)
        throw Object.assign(new Error("injected read denied"), { code: "EACCES" });
      return read(name, ...args);
    });
    for (const mode of ["--run", "--cancel"]) {
      const refused = await f.invoke([
        mode,
        run.runKey,
        ...(mode === "--run" ? ["--wait-ms", "0"] : []),
      ]);
      assert.equal(refused.code, 1, refused.stderr);
      assert.equal(refused.stdout, "");
      assert.ok(refused.stderr.includes(`--run ${run.runKey}`));
    }
    t.mock.restoreAll();
    assert.ok(fs.existsSync(stateDir));
    assert.equal(f.events().filter((e) => e.method === "turn/start").length, 1);
    assert.equal((await f.invoke(["--run", run.runKey, "--wait-ms", "8000"])).code, 0);
  });

test("a completed CLI launch forwards the exact prompt and model, delivers the full output and cleans up", async (t) => {
  const text = TEXT.repeat(4000),
    f = driverFixture(t, { result: text });
  const result = await f.cli([...LAUNCH.slice(0, -2), "--wait-ms", "8000"]);
  assert.equal(result.status, 0, result.stderr);
  const shown = delivered(result.stdout);
  assert.equal(shown.body, text);
  assert.equal(fs.readFileSync(shown.footer.file, "utf8"), result.stdout);
  assert.equal(fs.existsSync(path.join(f.work, "prompt.md")), false);
  assert.deepEqual(f.runs(), []);
  const starts = f.events().filter((e) => e.method === "turn/start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.input[0].text, ORIGINAL);
  assert.equal(f.events().find((e) => e.method === "thread/start").params.model, "gpt-6.1-sol");
});

test("five concurrent fake driver launches keep exactly one submission each", async (t) => {
  const fixtures = Array.from({ length: 5 }, () => driverFixture(t));
  const results = await Promise.all(
    fixtures.map((f) => f.invoke([...LAUNCH.slice(0, -2), "--wait", "--keep-state"])),
  );
  for (let i = 0; i < fixtures.length; i++) {
    assert.equal(results[i].code, 0, results[i].stderr);
    assert.equal(fixtures[i].events().filter((e) => e.method === "turn/start").length, 1);
  }
});

for (const status of ["completed", "failed", "cancelled"])
  test(`${status} delivery preserves its exit code when stopping an independent driver fails`, async (t) => {
    const f = driverFixture(t, { status: status === "cancelled" ? "running" : status });
    let args = [
      ...LAUNCH.slice(0, -2),
      "--wait-ms",
      "8000",
      "--write",
      "--request-id",
      "cleanup-code",
    ];
    if (status === "cancelled") {
      await f.invoke([
        ...LAUNCH.slice(0, -2),
        "--detach",
        "--write",
        "--request-id",
        "cleanup-code",
      ]);
      const run = f.metadata();
      await until(() => readDriver(path.join(f.state, run.runKey), run.jobId)?.turnId);
      args = ["--cancel", run.runKey];
    }
    const result = await f.invoke(args, {
      onOutcome(value) {
        if (value.kind === "delivered")
          createJob(path.join(f.state, f.runs()[0]), { pid: process.pid, processStart: null });
      },
    });
    assert.equal(delivered(result.stdout).footer.status, status);
    assert.equal(result.code, status === "completed" ? 0 : 2, result.stderr);
    assert.equal(f.runs().length, 1);
    assert.ok(f.metadata().result.acknowledgedAt);
    assert.ok(fs.existsSync(path.join(f.state, "requests", "cleanup-code.lock", "owner.json")));
    assert.ok(fs.readdirSync(path.join(f.state, "writers")).some((name) => name.endsWith(".lock")));
    assert.match(result.stderr, /state retained/i);
  });
