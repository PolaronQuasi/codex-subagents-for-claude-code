import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./support/codex-fixture.mjs";
import { gitInit } from "./support/git-repos.mjs";
import { sink } from "./support/capture.mjs";
import { workspace } from "./support/workspace-fixture.mjs";
import { batch, readBatch } from "../src/maintenance/batch.mjs";
import { claimRequest } from "../src/state/state.mjs";
import { createRecord } from "../src/state/run-store.mjs";
import { validateRun } from "../src/state/run-record.mjs";
import { DRIVER_PROTOCOL_VERSION, RUN_RECORD_VERSION } from "../src/shared/constants.mjs";
import { until } from "./support/driver-evidence.mjs";
import { alive } from "../src/shared/io.mjs";
import { readDriver, readTurn, writeDriver } from "../src/state/job-store.mjs";

async function isolatedBatch(t, id, count = 2) {
  const f = workspace(t);
  await gitInit(f.work);
  const promptFile = path.join(f.work, "prompt.md");
  fs.writeFileSync(promptFile, "compare this task\n");
  const recipe = path.join(f.root, `${id}.json`);
  fs.writeFileSync(
    recipe,
    JSON.stringify({
      version: 1,
      requestId: id,
      cwd: f.work,
      promptFile,
      concurrency: 1,
      models: Array.from({ length: count }, (_, index) => ({
        model: index % 2 ? "gpt-6-astra" : "gpt-6.1-sol",
        effort: "low",
      })),
    }),
  );
  const calls = [];
  const invoke = async (args, io) => {
    calls.push(args);
    io.onOutcome?.({ kind: "failed", reason: "simulated launch interruption" });
    return 1;
  };
  const run = async (options) => {
    const output = sink();
    const code = await batch(options, {
      stateBase: f.state,
      resultsDir: f.resultsDir,
      parentEnv: process.env,
      cwd: f.work,
      stdout: output.stream,
      commandMs: 10_000,
      warn: async () => {},
      invoke,
    });
    return { code, output: JSON.parse(output.text()) };
  };
  const first = await run({ mode: "batch", batch: recipe, "wait-ms": 0 });
  const manifest = path.join(f.resultsDir, "batches", id, "manifest.json");
  return { ...f, stateBase: f.state, calls, first, manifest, run };
}

test("batch pins a common commit, retains independent children and replays without model calls", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  const recipe = path.join(f.root, "batch.json");
  fs.writeFileSync(
    recipe,
    JSON.stringify({
      version: 1,
      requestId: "compare",
      cwd: f.work,
      promptFile: path.join(f.work, "prompt.md"),
      concurrency: 1,
      models: [
        { model: "gpt-6.1-sol", effort: "low" },
        { model: "gpt-6-astra", effort: "low" },
      ],
    }),
  );
  const first = await f.invoke(["--batch", recipe, "--wait-ms", "30000"]);
  assert.equal(first.code, 0, first.stderr);
  const record = readBatch("compare", { stateBase: f.state, resultsDir: f.resultsDir });
  assert.equal(new Set(record.children.map((c) => c.runKey)).size, 2);
  for (const child of record.children) {
    assert.equal(child.status, "completed");
    assert.equal(f.metadata(child.runKey).worktree.startCommit, record.commit);
  }
  assert.equal(fs.existsSync(path.join(f.work, "prompt.md")), false);
  const calls = f.events().filter((e) => e.direction === "in" && e.method === "turn/start").length;
  assert.equal(calls, 2);
  const second = await f.invoke(["--batch", recipe, "--wait-ms", "0"]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(
    f.events().filter((e) => e.direction === "in" && e.method === "turn/start").length,
    calls,
  );
  // A child continued independently cannot be adopted as the original batch turn.
  const prompt = path.join(f.root, "follow.txt");
  fs.writeFileSync(prompt, "another task");
  const continued = await f.invoke([
    "--continue",
    record.children[0].runKey,
    "--prompt-file",
    prompt,
    "--wait-ms",
    "10000",
  ]);
  assert.equal(continued.code, 0, continued.stderr);
  record.children[0].status = "running";
  fs.writeFileSync(
    path.join(f.resultsDir, "batches", "compare", "manifest.json"),
    JSON.stringify(record),
  );
  const changed = await f.invoke(["--batch-run", "compare", "--wait-ms", "0"]);
  assert.equal(changed.code, 3, changed.stderr);
  assert.match(JSON.parse(changed.stdout).children[0].error, /ownership/);
  assert.equal(
    f.events().filter((e) => e.direction === "in" && e.method === "turn/start").length,
    calls + 1,
  );
});

test("batch never resends an ambiguous launch and cancellation skips undispatched children", async (t) => {
  const f = fixture(t, { status: "running" });
  await gitInit(f.work);
  const recipe = path.join(f.root, "batch.json");
  fs.writeFileSync(
    recipe,
    JSON.stringify({
      version: 1,
      requestId: "cancel-group",
      cwd: f.work,
      promptFile: path.join(f.work, "prompt.md"),
      concurrency: 1,
      models: [
        { model: "gpt-6.1-sol", effort: "low" },
        { model: "gpt-6-astra", effort: "low" },
      ],
    }),
  );
  const first = await f.invoke(["--batch", recipe, "--wait-ms", "0"]);
  assert.equal(first.code, 3, first.stderr);
  const file = path.join(f.resultsDir, "batches", "cancel-group", "manifest.json");
  const record = JSON.parse(fs.readFileSync(file));
  assert.equal(record.children[1].status, "planned");
  const cancelled = await f.invoke(["--batch-cancel", "cancel-group"]);
  assert.ok([2, 3].includes(cancelled.code), cancelled.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file)).children[1].status, "skipped");
  // Simulate an interrupted coordinator before a child identity was published.
  record.children[1].status = "launching";
  fs.writeFileSync(file, JSON.stringify(record));
  const before = f.events().filter((e) => e.direction === "in" && e.method === "turn/start").length;
  const uncertain = await f.invoke(["--batch-run", "cancel-group", "--wait-ms", "0"]);
  assert.equal(uncertain.code, 3, uncertain.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file)).children[1].status, "uncertain");
  assert.equal(
    f.events().filter((e) => e.direction === "in" && e.method === "turn/start").length,
    before,
  );
});

test("a delivered answer with unconfirmed shutdown keeps the batch slot until shutdown is proven", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  const recipe = path.join(f.root, "batch.json");
  fs.writeFileSync(
    recipe,
    JSON.stringify({
      version: 1,
      requestId: "pending-stop",
      cwd: f.work,
      promptFile: path.join(f.work, "prompt.md"),
      concurrency: 1,
      models: [
        { model: "gpt-6.1-sol", effort: "low" },
        { model: "gpt-6-astra", effort: "low" },
      ],
    }),
  );
  const first = await f.invoke(["--batch", recipe, "--wait-ms", "0"]);
  assert.equal(first.code, 3, first.stderr);
  const record = readBatch("pending-stop", { stateBase: f.state, resultsDir: f.resultsDir });
  const key = record.children[0].runKey;
  const run = f.metadata(key),
    stateDir = path.join(f.state, key);
  await until(() => readTurn(stateDir, run.jobId));
  await until(() => !alive(run.worker.pid), "driver shutdown", 15_000);
  const driver = readDriver(stateDir, run.jobId);
  await until(() => !alive(driver.appServer.pid));
  writeDriver(stateDir, run.jobId, {
    ...driver,
    shutdownIncomplete: true,
    shutdownTreeUnknown: true,
    shutdownTree: [{ pid: driver.appServer.pid, start: null }],
    shutdownCapturePending: false,
  });
  const turns = () =>
    f.events().filter((e) => e.direction === "in" && e.method === "turn/start").length;
  for (let attempt = 0; attempt < 2; attempt++) {
    const collected = await f.invoke(["--batch-run", "pending-stop", "--wait-ms", "0"]);
    assert.equal(collected.code, 3, collected.stderr);
    const saved = JSON.parse(collected.stdout);
    assert.equal(saved.children[0].status, "uncertain");
    assert.equal(saved.children[0].launchDisposition, "possible-live");
    assert.ok(fs.existsSync(saved.children[0].resultFile));
    assert.match(saved.children[0].error, new RegExp(`--close ${key} --force`));
    assert.equal(saved.children[1].status, "planned");
    assert.equal(turns(), 1, "no resubmission or launch beyond the occupied slot");
  }
  writeDriver(stateDir, run.jobId, {
    ...readDriver(stateDir, run.jobId),
    shutdownTreeUnknown: false,
  });
  const recovered = await f.invoke(["--batch-run", "pending-stop", "--wait-ms", "30000"]);
  assert.equal(recovered.code, 0, recovered.stderr);
  const completed = JSON.parse(recovered.stdout);
  assert.ok(completed.children.every((child) => child.status === "completed"));
  assert.equal(completed.children[0].error, undefined);
  assert.equal(turns(), 2);
});

test("a dead proven-undispatched child frees its slot without being resubmitted", async (t) => {
  const f = await isolatedBatch(t, "undispatched-progress");
  assert.equal(f.first.code, 3);
  let record = readBatch("undispatched-progress", f);
  assert.equal(record.children[0].status, "uncertain");
  assert.equal(record.children[0].launchDisposition, "undispatched");
  assert.equal(record.children[1].status, "planned");
  claimRequest(
    f.state,
    record.children[0].requestId,
    "c".repeat(32),
    record.children[0].requestDigest,
  );
  const ownerFile = path.join(
    f.state,
    "requests",
    `${record.children[0].requestId}.lock`,
    "owner.json",
  );
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: 2147483647, processStart: null }));
  record.children[0].status = "launching";
  delete record.children[0].launchDisposition;
  delete record.children[0].error;
  fs.writeFileSync(f.manifest, JSON.stringify(record));

  const next = await f.run({
    mode: "batch-run",
    key: "undispatched-progress",
    "wait-ms": 1000,
  });
  assert.equal(next.code, 3);
  record = readBatch("undispatched-progress", f);
  assert.deepEqual(
    f.calls.map((args) => args[args.indexOf("--request-id") + 1]),
    record.children.map((child) => child.requestId),
    "each child was attempted once",
  );
  assert.deepEqual(
    record.children.map((child) => child.launchDisposition),
    ["undispatched", "undispatched"],
  );
});

test("a live undispatched owner keeps its slot and prevents oversubscription", async (t) => {
  const f = await isolatedBatch(t, "possible-live-bound");
  const record = readBatch("possible-live-bound", f);
  record.children[0].status = "launching";
  delete record.children[0].launchDisposition;
  delete record.children[0].error;
  record.children[1].status = "planned";
  fs.writeFileSync(f.manifest, JSON.stringify(record));
  claimRequest(
    f.state,
    record.children[0].requestId,
    "d".repeat(32),
    record.children[0].requestDigest,
  );
  f.calls.length = 0;

  const next = await f.run({ mode: "batch-run", key: "possible-live-bound", "wait-ms": 0 });
  assert.equal(next.code, 3);
  const saved = readBatch("possible-live-bound", f);
  assert.equal(saved.children[0].status, "uncertain");
  assert.equal(saved.children[0].launchDisposition, "possible-live");
  assert.equal(saved.children[1].status, "planned");
  assert.deepEqual(f.calls, [], "no child was dispatched beyond the occupied slot");
});

test("batch cancellation guards every child and requires exact digest version and value", async (t) => {
  const f = await isolatedBatch(t, "cancel-owned", 3);
  const record = readBatch("cancel-owned", f);
  for (const child of record.children.slice(0, 2)) {
    child.status = "running";
    delete child.launchDisposition;
    delete child.error;
  }
  record.children[2].status = "planned";

  const versionKey = "a".repeat(32);
  claimRequest(f.state, record.children[0].requestId, versionKey, record.children[0].requestDigest);
  const versionOwner = path.join(
    f.state,
    "requests",
    `${record.children[0].requestId}.lock`,
    "owner.json",
  );
  const owner = JSON.parse(fs.readFileSync(versionOwner, "utf8"));
  fs.writeFileSync(
    versionOwner,
    JSON.stringify({ ...owner, digestVersion: owner.digestVersion + 1 }),
  );

  const digestKey = "b".repeat(32);
  claimRequest(f.state, record.children[1].requestId, digestKey, record.children[1].requestDigest);
  const stateDir = path.join(f.state, digestKey);
  const worktree = path.join(stateDir, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  const run = {
    version: RUN_RECORD_VERSION,
    runKey: digestKey,
    jobId: null,
    cwd: worktree,
    model: record.children[1].model,
    effort: record.children[1].effort,
    write: record.write,
    keepState: true,
    scratchWorkspace: false,
    turns: [],
    requestId: record.children[1].requestId,
    requestDigest: "f".repeat(64),
    requestDigestVersion: record.children[1].requestDigestVersion,
    codex: {
      path: process.execPath,
      realPath: process.execPath,
      version: "0.166.0",
      build: "c".repeat(64),
    },
    driverProtocol: DRIVER_PROTOCOL_VERSION,
    worktree: {
      base: record.cwd,
      branch: null,
      startRef: record.commit,
      startCommit: record.commit,
    },
  };
  validateRun(run, digestKey, stateDir);
  createRecord(run, stateDir);
  fs.writeFileSync(f.manifest, JSON.stringify(record));
  f.calls.length = 0;

  const cancelled = await f.run({ mode: "batch-cancel", key: "cancel-owned" });
  assert.equal(cancelled.code, 3);
  const saved = readBatch("cancel-owned", f);
  assert.equal(saved.cancelRequested, true);
  assert.equal(saved.children[2].status, "skipped", "all planned work was skipped first");
  for (const child of saved.children.slice(0, 2)) {
    assert.equal(child.status, "uncertain");
    assert.equal(child.launchDisposition, "possible-live");
    assert.match(child.error, /ownership/);
  }
  assert.deepEqual(f.calls, [], "neither foreign identity was cancelled or collected");
});

test(
  "Windows batch recipes reject ambiguous rooted cwd and prompt paths",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = workspace(t),
      recipe = path.join(f.root, "bad-path.json");
    for (const key of ["cwd", "promptFile"]) {
      fs.writeFileSync(
        recipe,
        JSON.stringify({
          version: 1,
          requestId: "bad-path",
          cwd: f.work,
          promptFile: path.join(f.work, "prompt.md"),
          models: [{ model: "gpt-6.1-sol", effort: "low" }],
          [key]: "/c/tmp/wrong-folder",
        }),
      );
      await assert.rejects(
        batch({ mode: "batch", batch: recipe }, { cwd: f.work }),
        /absolute cwd/,
      );
    }
  },
);
