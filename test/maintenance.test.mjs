import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH, TEXT } from "./support/runner-fixture.mjs";
import { acquireLock } from "../src/state/state.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { ROLES, environmentPaths } from "../src/cli/options.mjs";
import { until } from "./support/driver-evidence.mjs";
import {
  createJob,
  readDriver,
  writeDriver,
  readTurn,
  writeTurn,
  writeFinal,
} from "../src/state/job-store.mjs";
import { createIpcSecret, readIpcSecret, ipcEndpoint, serveIpc } from "../src/codex/ipc.mjs";
import { processStart } from "../src/shared/process-identity.mjs";
import { alive } from "../src/shared/io.mjs";
import { Writable } from "node:stream";

test("list reports delivery and driver state without RPC and filters session/activity", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, 0);
  const run = f.metadata(),
    events = f.events();
  const listed = await f.invoke(["--list", "--mine"]);
  assert.match(listed.stdout, new RegExp(`run=${run.runKey} status=completed .*driver=- `));
  assert.doesNotMatch(listed.stdout, /broker=/);
  assert.match((await f.invoke(["--list", "--active"])).stdout, /No matching retained runs/);
  assert.deepEqual(f.events(), events);
});

test("idle close skips a live waiter, dry-run preserves state and an explicit sweep closes", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, 0);
  const run = f.metadata(),
    release = acquireLock(f.state, run.runKey);
  assert.match((await f.invoke(["--close-idle"])).stdout, /waiter-pid-/);
  release();
  assert.match((await f.invoke(["--close-idle", "--dry-run"])).stdout, /would-close /);
  assert.equal(f.runs().length, 1);
  assert.match((await f.invoke(["--close-idle"])).stdout, /closed=1/);
  assert.deepEqual(f.runs(), []);
});

test("collection requires a durable copy, keeps failed delivery and later collects without printing the answer", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke()).code, 3);
  f.configure({ status: "completed" });
  const run = f.metadata();
  for (
    let n = 0;
    n < 300 && !fs.existsSync(path.join(f.state, run.runKey, "jobs", run.jobId, "turn.json"));
    n++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const env = { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: f.controlFile };
  const refused = await f.invoke(["--collect-finished"], { env });
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /failed=1/);
  assert.equal(f.runs().length, 1);
  const done = await f.invoke(["--collect-finished"]);
  assert.equal(done.code, 0, done.stdout);
  assert.match(done.stdout, /collected=1/);
  assert.equal(done.stdout.includes(TEXT.trim()), false);
  assert.deepEqual(f.runs(), []);
});

test("sleep-idle ignores a cold run and all-session sweeps require an explicit age", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, 0);
  assert.match((await f.invoke(["--sleep-idle"])).stdout, /slept=0/);
  assert.equal((await f.invoke(["--close-idle", "--all-sessions"])).code, 1);
  assert.equal((await f.invoke(["--close-idle", "--all-sessions", "--older-than", "0s"])).code, 0);
});

test("doctor read-only skips every write probe and leaves missing directories absent", async (t) => {
  const f = fixture(t);
  const env = {
    ...f.env,
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR: path.join(f.root, "missing-state"),
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: path.join(f.root, "missing-results"),
  };
  for (const method of [
    "mkdirSync",
    "writeFileSync",
    "appendFileSync",
    "unlinkSync",
    "renameSync",
    "rmSync",
  ])
    t.mock.method(fs, method, () => assert.fail(`unexpected write probe: ${method}`));
  let report;
  try {
    report = await f.invoke(["--doctor", "--read-only"], { env });
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(report.code, 0, report.stdout + report.stderr);
  assert.match(report.stdout, /^installation-mode=agents-override$/m);
  assert.match(report.stdout, /^agents-available=0\/8$/m);
  assert.match(report.stdout, /^agents-required=no$/m);
  assert.match(report.stdout, /^claude-agents-loaded=unverified$/m);
  assert.match(report.stdout, /^state-writable=not-tested$/m);
  assert.match(report.stdout, /^results-writable=not-tested$/m);
  assert.match(report.stdout, /^state-in-repository=not-tested$/m);
  assert.equal(fs.existsSync(env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR), false);
  assert.equal(fs.existsSync(env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR), false);
  assert.equal(
    f.events().some((e) => e.command === "task"),
    false,
  );
});

test("doctor uses the same overridden state and result paths as invocations and private agent and skill folders", async (t) => {
  const f = fixture(t);
  const agents = f.env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR;
  assert.equal(agents, path.join(f.root, "agents"));
  assert.equal(f.env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR, path.join(f.root, "skill"));
  fs.mkdirSync(agents);
  fs.mkdirSync(f.env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR);
  const roles = Object.keys(ROLES);
  fs.writeFileSync(path.join(agents, `${roles[0]}.md`), `--role ${roles[0]} --task-file x`);
  fs.writeFileSync(path.join(agents, `${roles[1]}.md`), "stale agent");
  const env = {
    ...f.env,
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR: path.join(f.root, "custom-state"),
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: path.join(f.root, "custom-results"),
  };
  const report = await f.invoke(["--doctor"], { env });
  assert.equal(report.code, 1, report.stdout);
  const fields = Object.fromEntries(
    report.stdout
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  const paths = environmentPaths(env);
  assert.equal(fields.state, paths.stateBase);
  assert.equal(fields.results, paths.resultsDir);
  assert.equal(fields["agents-dir"], agents);
  assert.equal(fields["installation-mode"], "agents-override");
  assert.equal(fields["agent-namespace"], "none");
  assert.equal(fields["agents-required"], "yes");
  assert.equal(fields["agents-available"], `1/${roles.length}`);
  assert.equal(fields["claude-agents-loaded"], "unverified");
  assert.equal(fields["results-source"], "override");
  assert.equal(fields[`agent-${roles[0]}`], "ok");
  assert.equal(fields[`agent-${roles[1]}`], "stale");
  assert.equal(fields[`agent-${roles[2]}`], "missing");
  assert.match(report.stdout, new RegExp(`problem=agent definition ${roles[2]}\\.md is missing`));
  assert.equal(fields.codex, "0.166.0");
  assert.equal(fields["codex-app-server"], "yes");
  assert.equal(fields["codex-login"], "logged-in");
  assert.deepEqual(fs.readdirSync(paths.stateBase), ["quota.json"]);
  const cached = JSON.parse(fs.readFileSync(path.join(paths.stateBase, "quota.json"), "utf8"));
  assert.equal(cached.primary, null);
  assert.equal(cached.ordinaryUsageAllowed, null);
  assert.deepEqual(fs.readdirSync(paths.resultsDir), []);
  assert.equal(
    f.events().some((e) => e.command === "task"),
    false,
  );
});

test("list reports retained runs newest first with job status, keep and lock state, without spawning anything", async (t) => {
  const f = fixture(t);
  await f.invoke([...LAUNCH, "--keep-state", "--keep-prompt"]);
  const first = f.metadata();
  await f.invoke([...LAUNCH, "--keep-state", "--keep-prompt"], {
    env: { ...f.env, CLAUDE_CODE_SESSION_ID: "other-session" },
  });
  const second = f.runs().find((key) => key !== first.runKey);
  const file = (key) => path.join(f.state, key, "run.json");
  fs.writeFileSync(
    file(first.runKey),
    JSON.stringify({ ...first, createdAt: "2026-01-01T00:00:00.000Z" }),
  );
  fs.writeFileSync(
    file(second),
    JSON.stringify({ ...f.metadata(second), createdAt: "2026-02-01T00:00:00.000Z" }),
  );
  const unlock = acquireLock(f.state, first.runKey);
  const ownerFile = path.join(f.state, `${first.runKey}.lock`, "owner.json");
  const owner = JSON.parse(fs.readFileSync(ownerFile));
  fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, processStart: "different start time" }));
  t.mock.method(childProcess, "spawn", () => assert.fail("list must spawn nothing"));
  t.mock.method(childProcess, "spawnSync", () =>
    assert.fail("list must not probe process start times"),
  );
  syncBuiltinESMExports();
  try {
    const result = await f.invoke(["--list"]);
    assert.equal(result.code, 0, result.stderr);
    const rows = result.stdout.trim().split("\n");
    assert.ok(rows[0].startsWith(`run=${second} status=completed `));
    assert.ok(rows[1].startsWith(`run=${first.runKey} status=completed `));
    const mine = await f.invoke(["--list", "--mine"]);
    assert.ok(mine.stdout.startsWith(`run=${first.runKey} `));
    assert.equal(mine.stdout.includes(second), false);
    assert.ok(rows[1].includes(`keep=yes writer=no lock=${process.pid} `), rows[1]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.writeFileSync(ownerFile, JSON.stringify(owner));
    unlock();
  }
  assert.match((await f.invoke(["--close-idle"])).stdout, /closed=1/);
  assert.deepEqual(f.runs(), [second]);
});

test("--list --active lists a cached result that reached no copy and no caller until it is delivered", async (t) => {
  const f = fixture(t);
  const env = { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: f.controlFile };
  const broken = new Writable({
    write(_chunk, _encoding, cb) {
      cb(new Error("caller disconnected"));
    },
  });
  const failed = await f.invoke([...LAUNCH, "--keep-state"], { env, stdout: broken });
  assert.equal(failed.code, 1, failed.stderr);
  const run = f.metadata();
  assert.ok(run.result.cachedAt);
  assert.equal(run.result.durableSavedAt, undefined);
  assert.equal(run.result.acknowledgedAt, undefined);
  assert.match(
    (await f.invoke(["--list", "--active"])).stdout,
    new RegExp(`run=${run.runKey} status=cached `),
  );
  assert.equal((await f.invoke(["--close", run.runKey])).code, 1);
  assert.match((await f.invoke(["--close-idle"])).stdout, /closed=0/);
  assert.equal((await f.invoke(["--run", run.runKey, "--wait-ms", "8000"])).code, 0);
  assert.match((await f.invoke(["--list", "--active"])).stdout, /No matching retained runs/);
});

test("--collect-finished delivers this session's finished runs without printing them, and skips what it cannot name", async (t) => {
  const f = fixture(t, { status: "running" });
  await f.invoke([...LAUNCH, "--keep-prompt"]);
  const mine = f.metadata();
  await f.invoke([...LAUNCH, "--keep-prompt"], {
    env: { ...f.env, CLAUDE_CODE_SESSION_ID: "another-session" },
  });
  const other = f.runs().find((key) => key !== mine.runKey);
  f.configure({ status: "completed" });
  await until(() =>
    f.runs().every((key) => readTurn(path.join(f.state, key), f.metadata(key).jobId)),
  );
  const unidentified = "b".repeat(32),
    damaged = "c".repeat(32);
  fs.mkdirSync(path.join(f.state, unidentified));
  fs.writeFileSync(
    path.join(f.state, unidentified, "run.json"),
    JSON.stringify({ ...mine, runKey: unidentified, jobId: null }),
  );
  fs.mkdirSync(path.join(f.state, damaged));
  fs.writeFileSync(path.join(f.state, damaged, "run.json"), "{");
  const result = await f.invoke(["--collect-finished"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /collected=1 .*skipped=2 failed=0/);
  assert.match(result.stdout, /job-not-identified/);
  assert.match(result.stdout, /damaged-or-missing-metadata/);
  assert.equal(result.stdout.includes(TEXT.trim()), false);
  assert.deepEqual(f.runs().sort(), [other, unidentified, damaged].sort());
});

test("sleep-idle sleeps an authenticated lingering driver and skips a silent one", async (t) => {
  const f = fixture(t);
  await f.invoke([...LAUNCH, "--keep-state", "--keep-prompt"]);
  const first = f.metadata();
  await f.invoke([...LAUNCH, "--keep-state", "--keep-prompt"]);
  const second = f.metadata(f.runs().find((key) => key !== first.runKey));
  const servers = [];
  try {
    for (const [run, answers] of [
      [first, true],
      [second, false],
    ]) {
      const handle = f.spawnServer();
      const processBirth = await until(() => processStart(handle.pid));
      const dir = path.join(f.state, run.runKey);
      const id = createJob(dir, {
        pid: handle.pid,
        processStart: processBirth,
        generation: "linger",
        protocol: 1,
      });
      const record = writeDriver(dir, id, {
        ...readDriver(dir, id),
        endpoint: ipcEndpoint(dir, id),
      });
      createIpcSecret(dir, id);
      writeTurn(dir, id, {
        status: "completed",
        finalSha256: writeFinal(dir, id, "already delivered"),
      });
      run.jobId = id;
      run.worker = { jobId: id, pid: handle.pid, processStart: processBirth };
      run.dormant = false;
      fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
      if (answers)
        servers.push(
          await serveIpc(record, readIpcSecret(dir, id), async (method) => {
            if (method === "shutdown") handle.stdin.end();
            return { ok: true };
          }),
        );
    }
    const result = await f.invoke(["--sleep-idle"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /slept=1 .*skipped=1 failed=0/);
    assert.match(result.stdout, /reason=driver-not-answering/);
    assert.equal(f.metadata(first.runKey).dormant, true);
    assert.equal(alive(first.worker.pid), false);
    assert.equal(f.metadata(second.runKey).dormant, false);
    assert.equal(alive(second.worker.pid), true);
  } finally {
    for (const server of servers) await server.close();
  }
});

test("missing explicit Codex paths name their override and remedy in a complete doctor report", async (t) => {
  const f = fixture(t);
  for (const kind of ["PATH", "DIR"]) {
    const env = { ...f.env };
    delete env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH;
    env[`CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_${kind}`] = path.join(f.root, "missing-codex");
    const report = await f.invoke(["--doctor", "--read-only"], { env });
    assert.equal(report.code, 1, report.stdout + report.stderr);
    assert.match(
      report.stdout,
      new RegExp(`problem=.*CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_${kind}`),
    );
    assert.match(report.stdout, /correct or unset/i);
    assert.match(report.stdout, /^doctor=\d+ problem\(s\)$/m);
    assert.equal(
      f.events().some((e) => e.command === "task"),
      false,
    );
  }
});

test("doctor reports every invalid override, including both CLI path overrides, and finishes its report", async (t) => {
  const f = fixture(t),
    env = { ...f.env };
  const names = ["STATE_DIR", "RESULTS_DIR", "AGENTS_DIR", "CODEX_PATH", "CODEX_DIR"];
  for (const name of names) env[`CODEX_SUBAGENTS_FOR_CLAUDE_CODE_${name}`] = "relative";
  const result = await f.invoke(["--doctor", "--read-only"], { env });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  for (const name of names)
    assert.match(
      result.stdout,
      new RegExp(`^problem=CODEX_SUBAGENTS_FOR_CLAUDE_CODE_${name} must be an absolute path`, "m"),
    );
  assert.match(result.stdout, /^doctor=5 problem\(s\)$/m);
  assert.deepEqual(f.events(), []);
});
