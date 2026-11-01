// Regression coverage for lifecycle and retry ownership boundaries.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import { until, captureDrivers } from "./support/driver-evidence.mjs";
import { readDriver, readTurn } from "../src/state/job-store.mjs";
import { saveRun } from "../src/state/run-store.mjs";
import { acquireWriterLock } from "../src/state/state.mjs";
import { retryJob } from "../src/run/launch.mjs";
import { alive } from "../src/shared/io.mjs";
import { gitInit } from "./support/git-repos.mjs";
const args = [...LAUNCH.slice(0, -2), "--wait-ms", "10000", "--keep-state", "--keep-prompt"];
const follow = (k) => [
  "--continue",
  k,
  "--prompt-file",
  "prompt.md",
  "--keep-prompt",
  "--wait-ms",
  "10000",
];
const requests = (f, m) => f.events().filter((e) => e.direction === "in" && e.method === m);

test("explicit historical fork after revert uses that turn's delivered commit", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "first.txt" });
  await gitInit(f.work);
  const first = await f.invoke([...args, "--write", "--worktree"]);
  assert.equal(first.code, 0, first.stderr);
  const key = f.runs()[0],
    c1 = f.metadata(key).result.commit;
  f.configure({ touchWorkspaceFile: "second.txt" });
  const next = await f.invoke([...follow(key), "--write"]);
  assert.equal(next.code, 0, next.stderr);
  const c2 = f.metadata(key).result.commit;
  assert.notEqual(c1, c2);
  const reverted = await f.invoke(["--revert", key, "--before-turn", "2"]);
  assert.equal(reverted.code, 0, reverted.stderr);
  const forked = await f.invoke(["--fork", key, "--at", "1"]);
  assert.equal(forked.code, 0, forked.stderr);
  const child = f.runs().find((k) => k !== key),
    run = f.metadata(child);
  assert.equal(run.worktree.startCommit, c1);
  assert.notEqual(run.worktree.startCommit, c2);
  assert.equal(fs.existsSync(path.join(run.cwd, "second.txt")), false);
});

test("terminal evidence cannot free the writer lock while its owned worker is live", async (t) => {
  const f = fixture(t, { status: "running" });
  const launched = await f.invoke([
    ...LAUNCH.slice(0, -2),
    "--keep-state",
    "--keep-prompt",
    "--write",
    "--detach",
  ]);
  assert.equal(launched.code, 0, launched.stderr);
  const r = f.metadata();
  await until(() => readDriver(path.join(f.state, r.runKey), r.jobId)?.turnId);
  assert.equal(alive(r.worker.pid), true);
  const target = path.join(f.state, r.runKey, "jobs", r.jobId, "turn.json");
  fs.writeFileSync(target, JSON.stringify({ version: 1, jobId: r.jobId, status: "completed" }));
  const second = "b".repeat(32);
  assert.throws(() => acquireWriterLock(f.state, f.work, second), /being written/);
  const writerFolder = fs
    .readdirSync(path.join(f.state, "writers"))
    .find((k) => !k.endsWith(".recovery"));
  const owner = JSON.parse(
    fs.readFileSync(path.join(f.state, "writers", writerFolder, "owner.json"), "utf8"),
  );
  assert.equal(owner.runKey, r.runKey);
  assert.equal(alive(r.worker.pid), true);
  f.configure({ status: "completed" });
});

test("new continuation refuses an undelivered or unsettled prior turn", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(args)).code, 0);
  const r = f.metadata();
  delete r.result.durableSavedAt;
  delete r.result.acknowledgedAt;
  r.dormant = false;
  saveRun(r, path.join(f.state, r.runKey));
  const next = await f.invoke(follow(r.runKey));
  assert.equal(next.code, 1, next.stderr);
  assert.match(next.stderr, /delivered and stopped/);
  assert.equal(requests(f, "turn/start").length, 1);
  assert.equal(f.metadata().result.acknowledgedAt, undefined);
});

test("first fork turn retry retains its native context", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(args)).code, 0);
  const parent = f.runs()[0];
  assert.equal((await f.invoke(["--fork", parent])).code, 0);
  const child = f.runs().find((k) => k !== parent);
  const seed = f.metadata(child);
  f.configure({ hangMethods: ["initialize"] });
  const owned = captureDrivers(t);
  const launched = await f.invoke([
    "--continue",
    child,
    "--prompt-file",
    "prompt.md",
    "--keep-prompt",
    "--detach",
  ]);
  assert.equal(launched.code, 0, launched.stderr);
  const pending = f.metadata(child);
  const dir = path.join(f.state, child);
  await until(() => readDriver(dir, pending.jobId)?.appServer);
  assert.equal(owned.length, 1);
  owned[0].kill(); // Birth handle from this test only.
  await until(() => !alive(pending.worker.pid));
  f.configure({ hangMethods: [] });
  const result = await f.invoke(["--run", child, "--wait-ms", "10000"]);
  assert.equal(result.code, 0, result.stderr);
  const last = requests(f, "turn/start").at(-1);
  assert.equal(last.params.threadId, seed.contextThreadId);
  assert.equal(f.metadata(child).retriedJobs[0].reason, "worker-died");
});

test("diagnostic failure cannot disown a newly dispatched retry", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(args)).code, 0);
  const r = f.metadata();
  const given = r.jobId;
  const dir = path.join(f.state, r.runKey);
  delete r.result;
  const save = () => saveRun(r, dir);
  await assert.rejects(
    retryJob(r, "worker-died", {
      stateDir: dir,
      parentEnv: f.env,
      commandMs: 10000,
      save,
      info: async () => {
        throw new Error("diagnostic stream failed");
      },
      warn: async () => {},
      script: "runner.mjs",
    }),
    /diagnostic stream failed/,
  );
  assert.notEqual(r.jobId, given);
  const jobs = fs.readdirSync(path.join(dir, "jobs")).filter((k) => k !== given);
  assert.equal(jobs.length, 1);
  await until(() => readTurn(dir, jobs[0]));
  assert.equal(requests(f, "turn/start").length, 2);
  assert.equal(r.retriedJobs[0].jobId, given);
  assert.equal(r.jobId, jobs[0]);
  await f.invoke(["--list"]); // Record owned fixture drivers for teardown.
});
