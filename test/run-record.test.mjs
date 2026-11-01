// The run record (src/state/run-record.mjs, src/state/run-store.mjs): what a valid record is, its archived
// turns and rejection of incomplete historical shapes, and what reading a
// locked run writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { JOB, KEY, LAUNCH, fixture } from "./support/runner-fixture.mjs";
import { workspace } from "./support/workspace-fixture.mjs";
import { CODES, EXIT } from "../src/shared/errors.mjs";

test("worktree records require current reference fields and allow the unresolved commit publication phase", async (t) => {
  const f = workspace(t);
  const { validateRun } = await import("../src/state/run-record.mjs");
  const base = {
    version: 2,
    runKey: KEY,
    jobId: null,
    cwd: f.work,
    codex: {
      path: process.execPath,
      realPath: process.execPath,
      version: "0.166.0",
      build: "a".repeat(64),
    },
    driverProtocol: 1,
  };
  for (const startCommit of [null, "b".repeat(40)]) {
    const run = {
      ...base,
      worktree: { base: f.work, branch: null, startRef: "HEAD", startCommit },
    };
    assert.equal(validateRun(run, KEY), run);
  }
  for (const fields of [
    {},
    { startCommit: null },
    { startRef: "HEAD" },
    { startRef: null, startCommit: null },
    { startRef: "HEAD", startCommit: undefined },
  ])
    assert.throws(
      () => validateRun({ ...base, worktree: { base: f.work, branch: null, ...fields } }, KEY),
      /invalid run metadata; state retained/,
    );
});

test("named run validation accepts current publication phases and rejects malformed field groups", async (t) => {
  const f = workspace(t);
  const { validateRun } = await import("../src/state/run-record.mjs");
  const base = {
    version: 2,
    runKey: "a".repeat(32),
    jobId: null,
    cwd: f.work,
    codex: {
      path: process.execPath,
      realPath: process.execPath,
      version: "0.166.0",
      build: "a".repeat(64),
    },
    driverProtocol: 1,
  };
  for (const extra of [
    {},
    { requestDigest: "a".repeat(64), requestDigestVersion: 3 },
    { requestDigest: null, session: null },
    { worktree: { base: f.work, branch: null, startRef: "HEAD", startCommit: null } },
    {
      worktree: {
        base: f.work,
        branch: `codex-subagents-for-claude-code/${base.runKey}`,
        startRef: "HEAD",
        startCommit: null,
      },
    },
    { maxStdoutLines: 0, relay: false },
  ]) {
    const run = { ...base, ...extra };
    assert.equal(validateRun(run, base.runKey), run, JSON.stringify(extra));
  }
  for (const extra of [
    { requestDigest: "1234abcd" },
    { requestDigest: "a".repeat(64), requestDigestVersion: 2 },
    { write: "invalid-value" },
    { version: 3 },
    { cwd: "relative" },
    { pluginWorkspace: "relative" },
    { pluginWorkspace: 17 },
    { pluginWorkspace: f.other, scratchWorkspace: true },
    { pluginWorkspace: f.other, worktree: { base: f.work, branch: null } },
    { codexDir: undefined },
    { sessionId: "wrong" },
    { sessionId: `codex-subagents-for-claude-code-extra-${base.runKey}` },
    { sessionId: `codex-subagents-for-claude-code-${base.runKey}a` },
    { requestDigest: "bad" },
    { requestDigestVersion: 1 },
    { quiet: 1 },
    { maxStdoutBytes: -1 },
    { worktree: { base: f.work, branch: "main" } },
    {
      worktree: {
        base: f.work,
        branch: `codex-subagents-for-claude-code-extra/${base.runKey}`,
        startRef: "HEAD",
        startCommit: null,
      },
    },
    {
      worktree: {
        base: f.work,
        branch: `codex-subagents-for-claude-code/${base.runKey}a`,
        startRef: "HEAD",
        startCommit: null,
      },
    },
    { turns: [null] },
    { result: { status: "running" } },
  ]) {
    assert.throws(() => validateRun({ ...base, ...extra }, base.runKey), {
      message: "invalid run metadata; state retained for inspection",
    });
  }
});

test("archived turns match the current writer and reject incomplete historical shapes", async (t) => {
  const f = workspace(t);
  const { validateRun } = await import("../src/state/run-record.mjs");
  const base = {
    version: 2,
    runKey: "a".repeat(32),
    jobId: null,
    cwd: f.work,
    codex: {
      path: process.execPath,
      realPath: process.execPath,
      version: "0.166.0",
      build: "a".repeat(64),
    },
    driverProtocol: 1,
  };
  const result = { status: "completed", sha256: "a".repeat(64) };
  // What the current archive writes.
  const archived = { jobId: JOB, model: "gpt-6.1-sol", effort: "xhigh", write: false, result };
  const turn = (fields) => ({ ...base, turns: [{ ...archived, ...fields }] });
  for (const run of [
    turn({}),
    turn({ model: null, effort: null, write: true }),
    turn({ requestId: "rq-turn-1", requestDigest: "b".repeat(64), keepState: false }),
    turn({ keepState: null, retriedJobs: [{ jobId: "task-x", reason: "worker-died" }] }),
    turn({ result: { ...result, resultFile: path.join(f.resultsDir, "copy.md"), usage: null } }),
  ])
    assert.equal(validateRun(run, base.runKey), run, JSON.stringify(run.turns));
  for (const run of [
    { ...base, turns: [{ jobId: JOB }] },
    { ...base, turns: [{ jobId: JOB, result }] },
    turn({ model: "not a model!" }),
    turn({ model: 7 }),
    turn({ model: undefined }),
    turn({ effort: "extreme" }),
    turn({ write: "yes" }),
    turn({ result: { ...result, status: "running" } }),
    turn({ result: null }),
    turn({ result: undefined }),
    turn({ result: { ...result, resultFile: "relative/copy.md" } }),
    turn({ result: { ...result, sha256: "short" } }),
    turn({ keepState: "no" }),
    turn({ requestId: "not an id!" }),
    turn({ requestDigest: "short" }),
    turn({ retriedJobs: [{ jobId: "task-x" }] }),
    // These shapes do not satisfy the current archived-turn record.
    { ...base, turns: [{ jobId: JOB, model: "gpt-6.1-sol" }] },
    { ...base, turns: [{ jobId: JOB, result: { ...result, status: "running" } }] },
    { ...base, turns: [{ jobId: JOB, result: null }] },
    { ...base, turns: [[JOB]] },
  ])
    assert.throws(
      () => validateRun(JSON.parse(JSON.stringify(run)), base.runKey),
      { message: "invalid run metadata; state retained for inspection" },
      JSON.stringify(run.turns),
    );
});

test("a malformed archived turn is refused at load with RUN_METADATA_INVALID, not halfway through the rollback that would restore it", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, EXIT.COMPLETED);
  const key = f.runs()[0];
  const { reserveTurn, switchTurn } = await import("../src/state/turn-transition.mjs");
  const { saveRun } = await import("../src/state/run-store.mjs");
  const run = f.metadata(key),
    stateDir = path.join(f.state, key),
    save = () => saveRun(run, stateDir);
  reserveTurn(run, save);
  switchTurn(
    run,
    stateDir,
    Buffer.from("Second turn"),
    { model: run.model, effort: run.effort, write: false },
    save,
  );
  const file = path.join(f.state, key, "run.json");
  const switched = f.metadata(key);
  assert.deepEqual([switched.continuing, switched.turns.length], [true, 1]);
  // The archived turn's result is damaged: a rollback would make it the run's.
  switched.turns[0].result.status = "running";
  fs.writeFileSync(file, JSON.stringify(switched, null, 2));
  const before = fs.readFileSync(file, "utf8");
  for (const args of [
    ["--run", key, "--wait-ms", "0"],
    ["--sleep", key],
    ["--close", key],
  ]) {
    const refused = await f.invoke(args);
    assert.equal(refused.code, EXIT.FAILURE, args[0]);
    assert.match(
      refused.stderr,
      new RegExp(`run ${key} has damaged or missing run\\.json: invalid run metadata`),
      args[0],
    );
    assert.equal(fs.readFileSync(file, "utf8"), before, `${args[0]} changed nothing`);
  }
  const inspected = JSON.parse((await f.invoke(["--inspect", key, "--json"])).stdout);
  assert.equal(inspected.recordError, "invalid run metadata; state retained for inspection");
  // The forced close retires it as damaged metadata, killing nothing.
  const retired = await f.invoke(["--close", key, "--force"]);
  assert.equal(retired.code, EXIT.COMPLETED, retired.stderr);
  assert.match(retired.stderr, /Damaged run .* retired; its files are preserved/);
});

test("current run publication phases preserve modern delivery preferences", async (t) => {
  const f = fixture(t);
  const { deliveryPreferences } = await import("../src/state/state.mjs");
  const { validateRun } = await import("../src/state/run-record.mjs");
  /** @type {import('../src/shared/types.mjs').RunRecord} */
  const initial = {
    version: 2,
    runKey: KEY,
    jobId: null,
    cwd: f.work,
    codex: {
      path: process.execPath,
      realPath: process.execPath,
      version: "0.166.0",
      build: "a".repeat(64),
    },
    driverProtocol: 1,
  };
  assert.equal(validateRun(initial, KEY), initial);
  assert.deepEqual(deliveryPreferences(initial), {
    quiet: false,
    relay: false,
    maxLines: 0,
    maxBytes: 0,
  });
  const result = await f.invoke([
    ...LAUNCH,
    "--keep-state",
    "--quiet",
    "--relay",
    "--max-stdout-lines",
    "2",
  ]);
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  /** @type {import('../src/shared/types.mjs').RunRecord} */
  const modern = f.metadata();
  assert.equal(validateRun(modern, modern.runKey), modern);
  assert.deepEqual(deliveryPreferences(modern), {
    quiet: true,
    relay: true,
    maxLines: 2,
    maxBytes: 0,
  });
  for (const field of ["cachedAt", "durableSavedAt", "acknowledgedAt"])
    assert.ok(modern.result[field], field);
});

test("short run keys are refused and missing current records are never reconstructed", async (t) => {
  const f = fixture(t);
  const { readLockedRun } = await import("../src/state/run-record.mjs");
  assert.equal((await f.invoke(["--run", "1234abcd"])).code, EXIT.FAILURE);
  const dir = path.join(f.state, KEY);
  fs.mkdirSync(dir);
  assert.throws(() => readLockedRun({ key: KEY, attach: JOB }, { stateDir: dir }), {
    code: CODES.RUN_METADATA_INVALID,
  });
  assert.equal(fs.existsSync(path.join(dir, "run.json")), false);
});

test("reading a current locked run writes nothing and delivery overrides write only when changed", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  const dir = path.join(f.state, key);
  const { checkLockedRun, readLockedRun } = await import("../src/state/run-record.mjs");
  const { recordDeliveryOverrides, runFile } = await import("../src/state/run-store.mjs");
  const options = { key, attach: f.metadata(key).jobId };
  const bytes = fs.readFileSync(runFile(dir), "utf8");
  const again = readLockedRun(options, { stateDir: dir });
  assert.equal(fs.readFileSync(runFile(dir), "utf8"), bytes, "reading writes nothing");
  assert.equal(checkLockedRun(again, options, dir), again);
  assert.throws(
    () => checkLockedRun(again, { key, attach: "task-other" }, dir),
    /job ID does not match/,
  );
  assert.throws(() => checkLockedRun({ ...again, version: 3 }, options, dir), {
    code: CODES.RUN_METADATA_INVALID,
  });
  // A marker in the stored record shows whether the store wrote the file again.
  const marked = JSON.stringify({ ...again, marker: true }, null, 2);
  fs.writeFileSync(runFile(dir), marked);
  assert.equal(recordDeliveryOverrides(again, { quiet: undefined, relay: undefined }, dir), false);
  assert.equal(fs.readFileSync(runFile(dir), "utf8"), marked, "nothing to record, nothing written");
  assert.equal(recordDeliveryOverrides(again, { quiet: true }, dir), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(runFile(dir), "utf8")), { ...again, quiet: true });
});
