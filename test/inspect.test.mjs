import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/runner-fixture.mjs";
import { parseArgs } from "../src/cli/options.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

test("inspection observes driver, terminal and delivery evidence without changing state or making RPC calls", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state", "--request-id", "inspect"])).code, 0);
  const run = f.metadata(),
    file = path.join(f.state, run.runKey, "run.json");
  const before = fs.readFileSync(file),
    events = f.events();
  const report = JSON.parse((await f.invoke(["--inspect", run.runKey, "--json"])).stdout);
  assert.equal(report.record.version, 2);
  assert.equal(report.drivers[0].record.jobId, run.jobId);
  assert.equal(report.drivers[0].terminal.status, "completed");
  assert.equal(report.drivers[0].pidAlive, null);
  assert.equal(report.drivers[0].answers, null);
  assert.equal(report.brokers, undefined);
  assert.equal(report.delivery.acknowledgedAt, run.result.acknowledgedAt);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(f.events(), events);
});

test("explicit inspect probe authenticates a live driver without driving the turn", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke()).code, 3);
  const run = f.metadata();
  const report = JSON.parse(
    (await f.invoke(["--inspect", run.runKey, "--json", "--probe"])).stdout,
  );
  assert.equal(report.drivers[0].pidAlive, true);
  assert.equal(report.drivers[0].answers, true);
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
});

test("damaged records and audit-only history remain inspectable", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, 0);
  const run = f.metadata(),
    file = path.join(f.state, run.runKey, "run.json");
  fs.writeFileSync(file, "{");
  const damaged = JSON.parse((await f.invoke(["--inspect", run.runKey, "--json"])).stdout);
  assert.match(damaged.recordError, /invalid JSON/);
  assert.match(damaged.recovery.close, /--force$/);
  fs.writeFileSync(file, JSON.stringify(run));
  assert.equal((await f.invoke(["--close", run.runKey])).code, 0);
  const closed = JSON.parse((await f.invoke(["--inspect", run.runKey, "--json"])).stdout);
  assert.equal(closed.record, null);
  assert.ok(closed.audit.files.length);
});

test("inspect options refuse malformed keys and unrelated action options", () => {
  for (const args of [
    ["--inspect", "short"],
    ["--inspect", "a".repeat(32), "--force"],
    ["--probe"],
  ])
    assert.throws(() => parseArgs(args));
});

test("inspect is read-only, spawns nothing and does not probe liveness by default", async (t) => {
  const f = fixture(t);
  await f.invoke([...LAUNCH, "--keep-state", "--request-id", "observe"]);
  const key = f.runs()[0];
  const snapshot = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory()
        ? snapshot(file)
        : [[file, fs.readFileSync(file).toString("base64")]];
    });
  const before = snapshot(f.root);
  for (const method of [
    "mkdirSync",
    "writeFileSync",
    "appendFileSync",
    "renameSync",
    "unlinkSync",
    "rmSync",
  ])
    t.mock.method(fs, method, () => assert.fail(`inspection attempted ${method}`));
  t.mock.method(childProcess, "spawn", () => assert.fail("inspection spawned a process"));
  t.mock.method(childProcess, "spawnSync", () => assert.fail("inspection queried an OS identity"));
  t.mock.method(process, "kill", () => assert.fail("inspection probed a PID"));
  syncBuiltinESMExports();
  try {
    const result = await f.invoke(["--inspect", key, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.lock.pidAlive, null);
    assert.ok(report.drivers.every((d) => d.pidAlive === null && d.answers === null));
    assert.deepEqual(snapshot(f.root), before);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("inspect reports milestones, missing worktrees, damaged records and closed-run audit history", async (t) => {
  const f = fixture(t);
  const launched = await f.invoke([...LAUNCH, "--keep-state"]);
  assert.equal(launched.code, 0, launched.stderr);
  const run = f.metadata(),
    dir = path.join(f.state, run.runKey),
    file = path.join(dir, "run.json");
  const missing = {
    ...run,
    cwd: path.join(dir, "worktree"),
    worktree: { base: f.work, branch: null, startRef: "HEAD", startCommit: null },
  };
  fs.writeFileSync(file, JSON.stringify(missing));
  const report = JSON.parse((await f.invoke(["--inspect", run.runKey, "--json"])).stdout);
  assert.equal(report.recordError, null);
  assert.equal(report.worktree.exists, false);
  for (const field of ["cachedAt", "durableSavedAt", "acknowledgedAt"])
    assert.equal(report.delivery[field], run.result[field]);
  fs.writeFileSync(file, "{");
  const damaged = JSON.parse((await f.invoke(["--inspect", run.runKey, "--json"])).stdout);
  assert.match(damaged.recordError, /invalid JSON/);
  fs.writeFileSync(file, JSON.stringify(run));
  assert.equal((await f.invoke(["--close", run.runKey])).code, 0);
  const closed = JSON.parse((await f.invoke(["--inspect", run.runKey, "--json"])).stdout);
  assert.equal(closed.record, null);
  assert.ok(closed.audit.files.length);
  const rows = closed.audit.files
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => fs.readFileSync(name, "utf8").trim().split("\n").map(JSON.parse));
  for (const transition of ["launch", "deliver", "close"])
    assert.ok(
      rows.some((row) => row.transition === transition),
      transition,
    );
});

test("manual diagnostic examples execute against disposable state", async (t) => {
  const f = fixture(t);
  await f.invoke([...LAUNCH, "--keep-state"]);
  const manual = fs.readFileSync(new URL("../docs/MANUAL.md", import.meta.url), "utf8");
  const section = manual.split("## List, inspection, doctor and sweeps")[1].split("\n## ")[0];
  // The manual documents option fragments, including optional switches. Run
  // the actual text both with and without those switches in private state.
  const fragments = [
    ...section.matchAll(
      /`(--(?:list|inspect|doctor|collect-finished|close-idle|sleep-idle)\b[^`]*)`/g,
    ),
  ].map((m) => m[1]);
  assert.equal(fragments.length, 6, "removing the documented examples must fail this test");
  for (const text of fragments) {
    for (const optional of [false, true]) {
      const args = (optional ? text.replaceAll(/[\[\]]/g, "") : text.replaceAll(/\[[^\]]*\]/g, ""))
        .replaceAll("KEY", f.runs()[0])
        .trim()
        .split(/\s+/);
      const result = await f.invoke(args);
      assert.equal(result.code, 0, `${text}: ${result.stdout}${result.stderr}`);
    }
  }
});
