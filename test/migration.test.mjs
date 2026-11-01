import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH, TEXT, ORIGINAL } from "./support/codex-fixture.mjs";
import { validateRun } from "../src/state/run-record.mjs";
import { acquireWriterLock, claimRequest } from "../src/state/state.mjs";
import { keepDriverDiagnostics } from "../src/shared/audit.mjs";
import { createJob, writeTurn, appendEvent, appendLog } from "../src/state/job-store.mjs";

const launch = [...LAUNCH.slice(0, -2), "--wait", "--keep-state"];
test("v2 direct records pin the CLI and omit every retired launch field", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(launch)).code, 0);
  const run = f.metadata();
  assert.equal(run.version, 2);
  assert.equal(run.driverProtocol, 1);
  for (const field of ["scriptsDir", "pluginWorkspace", "sessionId", "broker", "codexDir"]) {
    assert.equal(Object.hasOwn(run, field), false);
    assert.throws(() => validateRun({ ...run, [field]: null }, run.runKey), /invalid run/);
  }
  for (const codex of [null, { ...run.codex, build: "bad" }, { ...run.codex, path: "relative" }])
    assert.throws(() => validateRun({ ...run, codex }, run.runKey), /invalid run/);
});

test("legacy mutations refuse, observational commands and durable replay work, force close quarantines", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...launch, "--request-id", "legacy-owner"])).code, 0);
  const run = f.metadata(),
    dir = path.join(f.state, run.runKey),
    file = path.join(dir, "run.json");
  run.version = 1;
  fs.writeFileSync(file, JSON.stringify(run));
  const before = fs.readFileSync(file, "utf8"),
    events = f.events().length;
  for (const mode of ["continue", "cancel", "close", "sleep"]) {
    const args = [
      `--${mode}`,
      run.runKey,
      ...(mode === "continue" ? ["--prompt-file", "never-opened.md"] : []),
    ];
    const done = await f.invoke(args);
    assert.equal(done.code, 1, done.stderr);
    assert.match(done.stderr, /LEGACY_RUN_UNSUPPORTED/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  assert.match((await f.invoke(["--list"])).stdout, /legacy-unsupported.*driver=/);
  const report = JSON.parse((await f.invoke(["--inspect", run.runKey, "--json"])).stdout);
  assert.equal(report.record.version, 1);
  assert.match(report.recovery.close, /--force$/);
  assert.equal(report.recovery.continue, undefined);
  const replay = await f.invoke(["--run", run.runKey]);
  assert.equal(replay.code, 0, replay.stderr);
  assert.ok(replay.stdout.includes(TEXT));
  assert.equal(f.events().length, events, "no legacy command starts Codex");
  const closed = await f.invoke(["--close", run.runKey, "--force"]);
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(
    fs.readFileSync(path.join(f.state, "quarantine", run.runKey, "run.json"), "utf8"),
    before,
  );
});

test("legacy writer locks and request claims remain held", async (t) => {
  const f = fixture(t),
    key = "a".repeat(32),
    dir = path.join(f.state, key);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({ version: 1, runKey: key, cwd: f.work }),
  );
  acquireWriterLock(f.state, f.work, key);
  assert.throws(() => acquireWriterLock(f.state, f.work, "b".repeat(32)), /writ/);
  assert.equal(claimRequest(f.state, "old-claim", key, "a".repeat(64)).claimed, true);
  const next = claimRequest(f.state, "old-claim", "b".repeat(32), "a".repeat(64));
  assert.equal(next.claimed, false);
  assert.equal(next.owner.runKey, key);
});

test("session sweeps omit other legacy sessions and label matching legacy records accurately", async (t) => {
  const f = fixture(t);
  const keys = ["c".repeat(32), "d".repeat(32)];
  const before = [];
  for (const [i, key] of keys.entries()) {
    const dir = path.join(f.state, key);
    fs.mkdirSync(dir);
    const body = JSON.stringify({
      version: 1,
      runKey: key,
      cwd: f.work,
      session: i ? "other-session" : "sess-fixture",
    });
    fs.writeFileSync(path.join(dir, "run.json"), body);
    before.push(body);
  }
  for (const mode of ["close-idle", "collect-finished", "sleep-idle"]) {
    const done = await f.invoke([`--${mode}`, "--dry-run"]);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /reason=legacy-unsupported/);
    assert.ok(done.stdout.includes(keys[0]));
    assert.ok(!done.stdout.includes(keys[1]));
    assert.doesNotMatch(done.stdout, /damaged/);
  }
  const all = await f.invoke(["--close-idle", "--all-sessions", "--older-than", "1h", "--dry-run"]);
  for (const [i, key] of keys.entries()) {
    assert.ok(all.stdout.includes(key));
    assert.equal(fs.readFileSync(path.join(f.state, key, "run.json"), "utf8"), before[i]);
  }
  assert.deepEqual(f.events(), []);
});

test("doctor probes login using account/read without starting a thread or exposing account details", async (t) => {
  const f = fixture(t);
  for (const loggedOut of [false, true]) {
    f.configure({ loggedOut });
    const done = await f.invoke(["--doctor", "--read-only"]);
    assert.equal(done.code, loggedOut ? 1 : 0, done.stdout);
    for (const name of [
      "codex",
      "codex-path",
      "codex-app-server",
      "codex-supported",
      "codex-login",
    ])
      assert.match(done.stdout, new RegExp(`^${name}=`, "m"));
    assert.match(done.stdout, new RegExp(`codex-login=logged-${loggedOut ? "out" : "in"}`));
    assert.doesNotMatch(done.stdout + done.stderr, /must-not-print|example.invalid/);
  }
  assert.equal(f.events().filter((e) => e.method === "account/read").length, 2);
  for (const event of f.events().filter((e) => e.method === "account/read"))
    assert.deepEqual(event.params, {});
  assert.equal(
    // Doctor lists models (model/list), but never starts a thread or a turn.
    f.events().filter((e) => ["turn/start", "thread/start"].includes(e.method)).length,
    0,
  );
});

test("worker-death audit keeps terminal evidence and bounded tails without the prompt or launch secret", async (t) => {
  const f = fixture(t),
    key = "a".repeat(32),
    dir = path.join(f.state, key);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "prompt.txt"), ORIGINAL);
  const jobId = createJob(dir, { secret: "never-audit-this", request: { prompt: ORIGINAL } });
  writeTurn(dir, jobId, { status: "failed", error: { message: ORIGINAL } });
  appendEvent(dir, jobId, { method: "turn/completed" });
  appendLog(dir, jobId, `stderr: ${ORIGINAL}`);
  const audit = await keepDriverDiagnostics(
    { runKey: key, jobId },
    { stateDir: dir, resultsDir: f.resultsDir },
  );
  const names = fs.readdirSync(audit);
  assert.equal(names.length, 3);
  for (const suffix of ["turn.json", "events.jsonl", "driver.log"])
    assert.ok(names.some((n) => n.endsWith(suffix)));
  const text = names.map((n) => fs.readFileSync(path.join(audit, n), "utf8")).join("\n");
  assert.doesNotMatch(text, /The exact original prompt|never-audit-this/);
});

test("audit drops a clipped prompt line and preserves the following diagnostic tail", async (t) => {
  const f = fixture(t),
    key = "b".repeat(32),
    dir = path.join(f.state, key);
  fs.mkdirSync(dir);
  const prompt = `prompt-start-${"private-fragment-".repeat(20_000)}prompt-end`;
  fs.writeFileSync(path.join(dir, "prompt.txt"), prompt);
  const jobId = createJob(dir, {});
  writeTurn(dir, jobId, { status: "failed" });
  appendEvent(dir, jobId, { method: "error" });
  appendLog(dir, jobId, `${prompt}\nuseful diagnostic after prompt\n`);
  const audit = await keepDriverDiagnostics(
    { runKey: key, jobId },
    { stateDir: dir, resultsDir: f.resultsDir },
  );
  const log = fs.readFileSync(path.join(audit, `worker-death-${jobId}.driver.log`), "utf8");
  assert.doesNotMatch(log, /private-fragment|prompt-end/);
  assert.equal(log, "useful diagnostic after prompt\n");
});

test("audit redaction does not rescan markers and preserves valid terminal JSON", async (t) => {
  const f = fixture(t),
    key = "c".repeat(32),
    dir = path.join(f.state, key);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "prompt.txt"), 't\nt\nt\n"quoted"\n');
  const jobId = createJob(dir, {});
  writeTurn(dir, jobId, { status: "failed", error: { message: 't "quoted"' } });
  appendLog(dir, jobId, 't\n"quoted"\nuseful\n');
  const audit = await keepDriverDiagnostics(
    { runKey: key, jobId },
    { stateDir: dir, resultsDir: f.resultsDir },
  );
  const stem = path.join(audit, `worker-death-${jobId}`);
  assert.equal(
    fs.readFileSync(`${stem}.driver.log`, "utf8"),
    "<prompt omitted>\n<prompt omitted>\nuseful\n",
  );
  const turn = JSON.parse(fs.readFileSync(`${stem}.turn.json`, "utf8"));
  assert.equal(turn.status, "failed");
  assert.equal(turn.error.message, "<prompt omitted> <prompt omitted>");
});
