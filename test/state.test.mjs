import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireLock,
  acquireWriterLock,
  claimRequest,
  runProcess,
  workspaceId,
} from "../src/index.mjs";

import { delivered } from "./support/capture.mjs";
import { gitInit } from "./support/git-repos.mjs";
import { KEY, TEXT, LAUNCH, fixture } from "./support/runner-fixture.mjs";
import { workspace } from "./support/workspace-fixture.mjs";
import { CODES, ERRNO, EXIT } from "../src/shared/errors.mjs";
import { GUARD_RETRIES } from "../src/shared/constants.mjs";
import {
  holdGuard,
  markRequestClaimPossibleLive,
  releaseRequestClaim,
  requestClaimStatus,
} from "../src/state/state.mjs";

test("request claim cleanup is cancellation-independent and bounded", async (t) => {
  const f = workspace(t);
  const requestId = "bounded-cleanup";
  claimRequest(f.state, requestId, KEY, "d".repeat(64));
  const claim = path.join(f.state, "requests", `${requestId}.lock`);
  const releaseBusy = holdGuard(`${claim}.recovery`, "test holds claim cleanup");
  const controller = new AbortController();
  controller.abort();
  let sleeps = 0;
  const timing = {
    sleep: async (_ms, signal) => {
      assert.equal(signal, undefined, "cleanup does not inherit the aborted command signal");
      sleeps++;
    },
  };
  assert.equal(
    await releaseRequestClaim(f.state, requestId, KEY, {
      signal: controller.signal,
      timing,
    }),
    false,
  );
  assert.equal(sleeps, GUARD_RETRIES, "cleanup stops after the guard retry budget");
  assert.equal(fs.existsSync(claim), true);
  releaseBusy();
  assert.equal(
    await releaseRequestClaim(f.state, requestId, KEY, {
      signal: controller.signal,
      timing,
    }),
    true,
  );
  assert.equal(fs.existsSync(claim), false);
});

test("only a dead claim with exact undispatched evidence is reclaimed", (t) => {
  const f = workspace(t);
  const requestId = "undispatched-proof";
  const digest = "e".repeat(64);
  claimRequest(f.state, requestId, KEY, digest);
  const claim = path.join(f.state, "requests", `${requestId}.lock`);
  const ownerFile = path.join(claim, "owner.json");
  assert.equal(
    requestClaimStatus(f.state, requestId).state,
    "possible-live",
    "a live launcher can still advance past the dispatch gate",
  );
  assert.equal(
    claimRequest(f.state, requestId, "b".repeat(32), digest).claimed,
    false,
    "a live claimant is not replaced",
  );

  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  const dead = { ...owner, pid: 2147483647, processStart: null };
  delete dead.launchState;
  fs.writeFileSync(ownerFile, JSON.stringify(dead));
  assert.equal(requestClaimStatus(f.state, requestId).state, "possible-live");
  assert.equal(
    claimRequest(f.state, requestId, "b".repeat(32), digest).claimed,
    false,
    "death without durable undispatched evidence is insufficient",
  );
  fs.writeFileSync(
    ownerFile,
    JSON.stringify({
      ...dead,
      launchState: "undispatched",
      digestVersion: owner.digestVersion + 1,
    }),
  );
  assert.equal(requestClaimStatus(f.state, requestId).state, "possible-live");
  assert.equal(
    claimRequest(f.state, requestId, "b".repeat(32), digest).claimed,
    false,
    "an inexact digest version is not undispatched evidence",
  );
  fs.writeFileSync(ownerFile, JSON.stringify({ ...dead, launchState: "undispatched" }));
  assert.equal(requestClaimStatus(f.state, requestId).state, "undispatched");
  assert.equal(
    claimRequest(f.state, requestId, "b".repeat(32), digest).claimed,
    true,
    "matching evidence permits the dead claim to be reclaimed",
  );
});

test("a durable possible-live claim is never reclaimed as undispatched", async (t) => {
  const f = workspace(t);
  const requestId = "possible-live-proof";
  const digest = "f".repeat(64);
  claimRequest(f.state, requestId, KEY, digest);
  assert.equal(await markRequestClaimPossibleLive(f.state, requestId, KEY, digest), true);
  assert.equal(requestClaimStatus(f.state, requestId).state, "possible-live");
  const ownerFile = path.join(f.state, "requests", `${requestId}.lock`, "owner.json");
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: 2147483647, processStart: null }));
  assert.equal(
    claimRequest(f.state, requestId, "b".repeat(32), digest).claimed,
    false,
    "a dead possible-live owner remains reserved",
  );
});

test("unknown and terminal job records both retain writer exclusion until settlement", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--write"])).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  const jobFile = path.join(f.state, key, "jobs", f.metadata().jobId, "turn.json");
  fs.writeFileSync(
    jobFile,
    JSON.stringify({ version: 1, jobId: f.metadata().jobId, status: "paused" }),
  );
  fs.writeFileSync(path.join(f.work, "prompt.md"), "second writer\n");
  const refused = await f.invoke([...LAUNCH, "--write"]);
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(refused.stderr, /is being written by run/);
  assert.equal(f.runs().length, 1, "the refused launch left nothing behind");
  fs.writeFileSync(
    jobFile,
    JSON.stringify({ version: 1, jobId: f.metadata().jobId, status: "completed" }),
  );
  const stillRefused = await f.invoke([...LAUNCH, "--write"]);
  assert.equal(stillRefused.code, EXIT.FAILURE, stillRefused.stderr);
  assert.equal(f.runs().length, 1, "terminal evidence alone does not free the workspace");
});

test("an active lock makes another attach wait within its budget, and lifecycle actions refuse, without changing the first owner", async (t) => {
  const f = fixture(t, { status: "running" });
  await f.invoke();
  const key = f.runs()[0];
  const release = acquireLock(f.state, key);
  try {
    const result = await f.invoke(f.resume());
    assert.equal(result.code, EXIT.STILL_RUNNING, result.stderr);
    assert.match(
      result.stdout,
      /^STILL RUNNING: Codex job task-[0-9a-f]+ is being delivered by another waiter \(PID \d+\)/,
    );
    const close = await f.invoke(["--close", key]);
    assert.equal(close.code, EXIT.FAILURE);
    assert.match(close.stderr, /already being handled/);
  } finally {
    release();
  }
  assert.equal((await f.invoke(f.resume())).code, EXIT.STILL_RUNNING);
});

test("lock errors carry stable codes and preserve their exact diagnostic text", async (t) => {
  const f = workspace(t);
  const release = acquireLock(f.state, KEY);
  try {
    assert.throws(
      () => acquireLock(f.state, KEY),
      (error) => {
        assert.equal(error.code, CODES.RUN_LOCK_HELD);
        assert.equal(error.pid, process.pid);
        assert.equal(error.message, `run ${KEY} is already being handled by PID ${process.pid}`);
        return true;
      },
    );
    // A recovery guard is named only once its recorded process is gone, or,
    // without a record, once it is no longer young.
    const recovery = path.join(f.state, `${KEY}.lock.recovery`);
    fs.mkdirSync(recovery);
    assert.throws(() => acquireLock(f.state, KEY), {
      code: CODES.RUN_LOCK_BUSY,
      message: `run ${KEY}'s lock ${recovery} is changing hands; retry in a moment`,
    });
    fs.writeFileSync(path.join(recovery, "owner"), String(process.pid));
    assert.throws(() => acquireLock(f.state, KEY), { code: CODES.RUN_LOCK_BUSY });
    const gone = Number(
      (await runProcess(process.execPath, ["-e", "console.log(process.pid)"], { timeoutMs: 5000 }))
        .stdout,
    );
    fs.writeFileSync(path.join(recovery, "owner"), String(gone));
    assert.throws(() => acquireLock(f.state, KEY), {
      code: CODES.RUN_LOCK_RECOVERY_STALE,
      message: `lock recovery of run ${KEY} was interrupted (its process ${gone} is no longer running); if no waiter owns the run, remove ${recovery} and retry`,
    });
    fs.rmSync(path.join(recovery, "owner"));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(recovery, old, old);
    assert.throws(() => acquireLock(f.state, KEY), {
      code: CODES.RUN_LOCK_RECOVERY_STALE,
      message: `lock recovery of run ${KEY} was interrupted; if no waiter owns the run, remove ${recovery} and retry`,
    });
    fs.rmdirSync(recovery);
  } finally {
    release();
  }
  const { holdGuard, holdGuardPatiently } = await import("../src/state/state.mjs");
  const guard = path.join(f.state, "guard");
  holdGuard(guard, "custom diagnostic");
  assert.throws(() => holdGuard(guard, "custom diagnostic"), {
    code: CODES.GUARD_BUSY,
    message: "custom diagnostic",
  });
  const accidental = new Error("busy");
  t.mock.method(fs, "mkdirSync", () => {
    throw accidental;
  });
  await assert.rejects(holdGuardPatiently(guard, "busy"), (error) => error === accidental);
  assert.throws(
    () => claimRequest(f.state, "id", KEY, "digest"),
    (error) => error === accidental,
  );
});

test("a stale lock from an exited process can be reclaimed", async (t) => {
  const f = fixture(t, { status: "running" });
  await f.invoke();
  const child = await runProcess(process.execPath, ["-e", "console.log(process.pid)"], {
    timeoutMs: 5000,
  });
  assert.equal(child.status, 0);
  const lock = path.join(f.state, f.runs()[0] + ".lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: Number(child.stdout), token: "dead" }),
  );
  assert.equal((await f.invoke(f.resume())).code, EXIT.STILL_RUNNING);
  assert.equal(fs.existsSync(lock), false);
});

test("concurrent attaches to a run whose lock owner is dead: one delivers, the others wait and replay", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke()).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  const child = await runProcess(process.execPath, ["-e", "console.log(process.pid)"], {
    timeoutMs: 5000,
  });
  const lock = path.join(f.state, `${key}.lock`);
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: Number(child.stdout), token: "dead" }),
  );
  f.configure({ status: "completed" });
  const attaches = await Promise.all(
    Array.from({ length: 4 }, () => f.cli(["--run", key, "--wait"], { timeoutMs: 60_000 })),
  );
  const replay = `codex-subagents-for-claude-code-replay: job ${f.metadata().jobId} was delivered earlier; not relaunched\n`;
  for (const attach of attaches) {
    assert.equal(attach.status, EXIT.COMPLETED, attach.stderr);
    assert.doesNotMatch(attach.stderr, /ENOENT|lock recovery|changing hands/);
    const { body, footer } = delivered(
      attach.stdout.startsWith(replay) ? attach.stdout.slice(replay.length) : attach.stdout,
    );
    assert.deepEqual([body, footer.job, footer.status], [TEXT, f.metadata().jobId, "completed"]);
  }
  assert.equal(
    attaches.filter((attach) => !attach.stdout.startsWith(replay)).length,
    1,
    "exactly one delivers; the others replay its copy",
  );
  assert.equal(f.events().filter((e) => e.command === "task").length, 1, "one model submission");
  assert.deepEqual(f.runs(), []);
});

test("a cancel, close or sleep that loses the race with a waiter's teardown is not reported as damaged", async (t) => {
  for (const mode of ["--cancel", "--close", "--sleep"]) {
    const f = fixture(t);
    assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, EXIT.COMPLETED, mode);
    const key = f.runs()[0];
    const stateDir = path.join(f.state, key);
    const lock = path.join(f.state, `${key}.lock`);
    // Another waiter is handing the run's lock over (made, not yet owned), so this
    // invocation waits a moment, and in that moment the waiter removes the run.
    fs.mkdirSync(lock);
    let clock = 0;
    const timing = {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        fs.rmSync(stateDir, { recursive: true, force: true });
        fs.rmSync(lock, { recursive: true, force: true });
      },
    };
    const result = await f.invoke([mode, key], { timing });
    assert.equal(result.code, EXIT.COMPLETED, `${mode}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /damaged|--force/, mode);
    if (mode === "--cancel") {
      assert.match(
        result.stdout,
        new RegExp(
          `^codex-subagents-for-claude-code-replay: job ${f.metadata().jobId} was delivered earlier; not relaunched\\n`,
        ),
      );
      assert.equal(delivered(result.stdout.split("\n").slice(1).join("\n")).footer.run, key);
    } else {
      assert.equal(result.stdout, "");
      assert.match(result.stderr, new RegExp(`Run ${key} was already delivered and removed`));
    }
    assert.equal(fs.existsSync(lock), false, "the lock is given back");
  }
  // Loading a run whose whole folder is gone says so; a folder without a record is damaged.
  const { readLockedRun } = await import("../src/state/run-record.mjs");
  const f = fixture(t);
  const pluginScripts = () => f.scripts;
  assert.throws(
    () => readLockedRun({ key: KEY }, { stateDir: path.join(f.state, KEY), pluginScripts }),
    { code: CODES.RUN_GONE },
  );
  fs.mkdirSync(path.join(f.state, KEY));
  assert.throws(
    () => readLockedRun({ key: KEY }, { stateDir: path.join(f.state, KEY), pluginScripts }),
    { code: CODES.RUN_METADATA_INVALID },
  );
});

test("a run lock being made or taken over is waited for, not reported as an error", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke()).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  const lock = path.join(f.state, `${key}.lock`);
  const { acquireRunLock } = await import("../src/state/state.mjs");
  // The other process finishes its step only once this attacher has found the
  // lock busy and waits (its first sleep), whatever this host's speed.
  let waits = 0;
  const take = (finish) => {
    let clock = 0;
    const timing = {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (waits++ === 0) finish();
      },
    };
    waits = 0;
    return acquireRunLock(key, { stateBase: f.state, deadline: 5000, mode: "attach", timing });
  };
  // Made but not yet owned: its maker is between the two steps.
  fs.mkdirSync(lock);
  const first = await take(() => fs.rmdirSync(lock));
  assert.equal(first.kind, "locked");
  assert.ok(waits >= 1, "it waited for the maker");
  first.releaseRunLock();
  // A stale owner whose takeover a live process is doing.
  const gone = Number(
    (await runProcess(process.execPath, ["-e", "console.log(process.pid)"], { timeoutMs: 5000 }))
      .stdout,
  );
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: gone, token: "x" }));
  fs.mkdirSync(`${lock}.recovery`);
  fs.writeFileSync(path.join(`${lock}.recovery`, "owner"), String(process.pid));
  const second = await take(() => fs.rmSync(`${lock}.recovery`, { recursive: true, force: true }));
  assert.equal(second.kind, "locked");
  assert.ok(waits >= 1, "it waited for the recovery in progress");
  second.releaseRunLock();
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(`${lock}.recovery`), false);
});

test("a takeover that loses the remade lock to another attacher is busy, not an EEXIST error", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagents-for-claude-code-takeover "));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const lock = path.join(base, `${KEY}.lock`);
  const gone = Number(
    (await runProcess(process.execPath, ["-e", "console.log(process.pid)"], { timeoutMs: 5000 }))
      .stdout,
  );
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: gone, token: "x" }));
  const rmSync = fs.rmSync;
  t.mock.method(fs, "rmSync", function (dir, ...rest) {
    const removed = rmSync.call(this, dir, ...rest);
    // Another attacher's plain mkdir wins the moment the stale lock is gone.
    if (dir === lock) fs.mkdirSync(lock);
    return removed;
  });
  assert.throws(() => acquireLock(base, KEY), { code: CODES.RUN_LOCK_BUSY });
  t.mock.restoreAll();
  assert.equal(fs.existsSync(`${lock}.recovery`), false, "the guard is given back");
  assert.ok(fs.existsSync(lock), "the other attacher's lock is left alone");
});

test("a lock-recovery guard that cannot be created reports why; only an existing one reads as recovery in progress", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagents-for-claude-code-recovery "));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const lock = path.join(base, `${KEY}.lock`);
  const recovery = `${lock}.recovery`;
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, token: "live" }),
  );
  fs.mkdirSync(recovery);
  assert.throws(() => acquireLock(base, KEY), { code: CODES.RUN_LOCK_BUSY });
  fs.rmdirSync(recovery);
  const mkdirSync = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", function (dir, ...rest) {
    if (dir === recovery)
      throw Object.assign(new Error(`EACCES: permission denied, mkdir '${dir}'`), {
        code: ERRNO.EACCES,
        syscall: "mkdir",
        path: dir,
      });
    return mkdirSync.call(this, dir, ...rest);
  });
  assert.throws(
    () => acquireLock(base, KEY),
    (error) =>
      error.code === ERRNO.EACCES && error.message.startsWith("EACCES: permission denied, mkdir"),
    "the real cause, not recovery in progress",
  );
  t.mock.restoreAll();
  assert.equal(fs.existsSync(recovery), false, "no guard is left behind");
  assert.throws(
    () => acquireLock(base, KEY),
    new RegExp(`run ${KEY} is already being handled by PID ${process.pid}`),
    "the live owner is respected as before",
  );
  assert.equal(fs.existsSync(recovery), false);
});

test("state directory junctions are rejected without touching their target", async (t) => {
  const f = fixture(t);
  const link = path.join(f.state, KEY);
  fs.writeFileSync(path.join(f.other, "keep.txt"), "keep");
  fs.symlinkSync(f.other, link, process.platform === "win32" ? "junction" : "dir");
  const result = await f.invoke(["--run", KEY]);
  assert.equal(result.code, EXIT.FAILURE);
  assert.match(result.stderr, /not a link/);
  assert.equal(fs.readFileSync(path.join(f.other, "keep.txt"), "utf8"), "keep");
  assert.equal(
    (await f.invoke(["--list"])).stdout,
    `No retained runs under ${f.state}.\n`,
    "links are not listed as runs",
  );
  fs.unlinkSync(link);
});

test("cancel reaches a running job while another process holds the run lock, and that waiter delivers", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke()).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  const release = acquireLock(f.state, key);
  let result;
  try {
    result = await f.invoke(["--cancel", key]);
  } finally {
    release();
  }
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  assert.match(
    result.stdout,
    /^CANCEL REQUESTED: Codex job task-[0-9a-f]+; the waiting process \(PID \d+\) will deliver its terminal record\.\n$/,
  );
  assert.deepEqual(
    f.events().map((e) => e.command),
    ["task", "interrupt"],
    "the driver interrupts its exact turn before the waiter delivers it",
  );
  assert.equal(f.runs().length, 1);
  const collected = await f.invoke(f.resume());
  assert.equal(collected.code, EXIT.NOT_COMPLETED, collected.stderr);
  assert.equal(delivered(collected.stdout).footer.status, "cancelled");
  assert.deepEqual(f.runs(), []);
});

test("a refused write launch leaves no run state, the record exists before the lock, and lock recovery is serialized", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--write"])).code, EXIT.STILL_RUNNING);
  const first = f.runs()[0];
  const lockDir = path.join(f.state, "writers", fs.readdirSync(path.join(f.state, "writers"))[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")).runKey, first);
  assert.ok(fs.existsSync(path.join(f.state, first, "run.json")));
  fs.writeFileSync(path.join(f.work, "second.md"), "second");
  const refused = await f.invoke([
    ...LAUNCH.map((value) => (value === "prompt.md" ? "second.md" : value)),
    "--write",
  ]);
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(refused.stderr, /is being written by run/);
  assert.deepEqual(
    fs
      .readdirSync(f.state)
      .filter((name) => name !== "writers" && name !== "requests")
      .sort(),
    [first],
    "no state or run lock left behind",
  );
  fs.mkdirSync(`${lockDir}.recovery`);
  try {
    assert.throws(
      () => acquireWriterLock(f.state, f.work, "b".repeat(32)),
      /is being changed by another process; retry in a moment/,
    );
  } finally {
    fs.rmdirSync(`${lockDir}.recovery`);
  }
});

test("request claims and writer locks are guarded from inspection through publication", async (t) => {
  const f = fixture(t);
  const requests = path.join(f.state, "requests");
  fs.mkdirSync(requests, { recursive: true });
  fs.mkdirSync(path.join(requests, "guarded.lock.recovery"));
  assert.deepEqual(
    claimRequest(f.state, "guarded", KEY, "0".repeat(64)),
    { claimed: false, owner: null },
    "a live guard means another claimant is publishing",
  );
  const blocked = await f.invoke([...LAUNCH, "--request-id", "guarded"]);
  assert.equal(blocked.code, EXIT.STILL_RUNNING, blocked.stderr);
  assert.match(
    blocked.stdout,
    /^STILL RUNNING: request guarded is being launched by another process\. /,
  );
  assert.deepEqual(f.events(), []);
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(path.join(requests, "guarded.lock.recovery"), old, old);
  // Its publisher writes the owner right after the folder, so a guard that old
  // without one was left by an interrupted publisher, never a live one.
  assert.equal(
    claimRequest(f.state, "guarded", KEY, "0".repeat(64)).claimed,
    true,
    "an old ownerless guard is reclaimed",
  );
  assert.equal(fs.existsSync(path.join(requests, "guarded.lock.recovery")), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(requests, "guarded.lock", "owner.json"), "utf8")).runKey,
    KEY,
  );
  fs.rmSync(path.join(requests, "guarded.lock"), { recursive: true, force: true });
  fs.mkdirSync(path.join(requests, "guarded.lock.recovery"));
  fs.writeFileSync(
    path.join(requests, "guarded.lock.recovery", "owner.json"),
    JSON.stringify({ pid: 2147483647, token: "dead-publisher" }),
  );
  assert.equal(
    claimRequest(f.state, "guarded", KEY, "0".repeat(64)).claimed,
    true,
    "a guard whose publisher is confirmed dead is reclaimed",
  );
  assert.equal(fs.existsSync(path.join(requests, "guarded.lock.recovery")), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(requests, "guarded.lock", "owner.json"), "utf8")).runKey,
    KEY,
  );
  fs.mkdirSync(path.join(f.state, "writers"), { recursive: true });
  const lock = path.join(f.state, "writers", `${workspaceId(f.work)}.lock`);
  fs.mkdirSync(lock);
  assert.throws(
    () => acquireWriterLock(f.state, f.work, KEY),
    /is incomplete; retry in a moment/,
    "an owner-less lock younger than a minute is not reclaimed",
  );
  fs.utimesSync(lock, old, old);
  acquireWriterLock(f.state, f.work, KEY);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).runKey,
    KEY,
    "an abandoned owner-less lock is reclaimed",
  );
  fs.writeFileSync(path.join(lock, "owner.json"), "{not json");
  assert.throws(
    () => acquireWriterLock(f.state, f.work, "b".repeat(32)),
    /unreadable writer lock owner/,
  );
});

test("writer ownership depends on settled delivery, never an advisory job-status reader", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--write"])).code, EXIT.STILL_RUNNING);
  const holder = f.runs()[0];
  const busy = new RegExp(`is being written by run ${holder}`);
  // By default the reader is the job's plugin record, which says running.
  assert.throws(() => acquireWriterLock(f.state, f.work, KEY), busy);
  const asked = [];
  const reader = (status) => (stateDir, jobId) => {
    asked.push([path.basename(stateDir), jobId]);
    return status;
  };
  for (const status of [null, "queued", "running", "a-status-this-runner-does-not-know"])
    assert.throws(
      () => acquireWriterLock(f.state, f.work, KEY, { jobStatus: reader(status) }),
      busy,
      String(status),
    );
  assert.deepEqual(asked, [], "job status cannot establish process quiescence");
  assert.throws(
    () => acquireWriterLock(f.state, f.work, KEY, { jobStatus: reader("completed") }),
    busy,
  );
  const cancelled = await f.invoke(["--cancel", holder, "--wait-ms", "10000"]);
  assert.equal(cancelled.code, EXIT.NOT_COMPLETED, cancelled.stderr);
  acquireWriterLock(f.state, f.work, KEY);
  const owner = path.join(f.state, "writers", `${workspaceId(f.work)}.lock`, "owner.json");
  assert.equal(JSON.parse(fs.readFileSync(owner, "utf8")).runKey, KEY);
});

test("a continuing run keeps its writer lock while its last result is still recorded", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--write", "--keep-state"])).code, EXIT.COMPLETED);
  const key = f.runs()[0];
  const file = path.join(f.state, key, "run.json");
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(run.result, "the run has a delivered result");
  const lock = path.join(f.state, "writers", `${workspaceId(f.work)}.lock`);
  assert.equal(fs.existsSync(lock), false, "delivery released the lock");
  // Mid-continuation: the reservation is recorded and the lock re-acquired,
  // while the previous result is still present.
  acquireWriterLock(f.state, f.work, key);
  fs.writeFileSync(file, JSON.stringify({ ...run, continuing: true }));
  const prompt = (name) => {
    fs.writeFileSync(path.join(f.work, name), name);
    return LAUNCH.map((value) => (value === "prompt.md" ? name : value));
  };
  const refused = await f.invoke([...prompt("second.md"), "--write"]);
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(refused.stderr, new RegExp(`is being written by run ${key}`));
  fs.writeFileSync(file, JSON.stringify(run));
  f.configure({ status: "running" });
  assert.equal(
    (await f.invoke([...prompt("third.md"), "--write"])).code,
    3,
    "a kept run with a delivered result and no continuation is reclaimable",
  );
  const other = f.runs().find((candidate) => candidate !== key);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).runKey, other);
  fs.writeFileSync(path.join(f.work, "fourth.md"), "fourth");
  const next = await f.invoke([
    "--continue",
    key,
    "--prompt-file",
    "fourth.md",
    "--write",
    "--wait-ms",
    "0",
  ]);
  assert.equal(next.code, EXIT.FAILURE);
  assert.match(next.stderr, new RegExp(`is being written by run ${other}`));
  assert.equal(
    f.metadata(key).continuing,
    undefined,
    "a definite refusal before launch gives the reservation back",
  );
  assert.ok(f.metadata(key).result, "the previous result is untouched");
});

test("the writer lock is keyed by the git repository root, so subdirectories share it", async (t) => {
  const f = fixture(t, { status: "running" });
  await gitInit(f.work);
  const sub = path.join(f.work, "sub");
  fs.mkdirSync(sub);
  assert.equal(workspaceId(sub), workspaceId(f.work));
  assert.notEqual(workspaceId(f.other), workspaceId(f.work));
  fs.writeFileSync(path.join(sub, "task.md"), "write: yes\nedit the sub folder\n");
  assert.equal(
    (
      await f.invoke(["--role", "gpt-6-1-sol", "--task-file", "task.md", "--wait-ms", "0"], {
        cwd: sub,
      })
    ).code,
    3,
  );
  const refused = await f.invoke([...LAUNCH, "--write"]);
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(refused.stderr, /is being written by run/);
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
});
import { readTurn } from "../src/state/job-store.mjs";

test("a cancel that cannot stop the job while a waiter holds the lock fails without touching state", async (t) => {
  const f = fixture(t, { status: "running" });
  await f.invoke([...LAUNCH, "--write"]);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  const unlock = acquireLock(f.state, run.runKey);
  const file = path.join(stateDir, "run.json"),
    before = fs.readFileSync(file);
  const ownerFile = path.join(f.state, `${run.runKey}.lock`, "owner.json"),
    owner = fs.readFileSync(ownerFile);
  try {
    const result = await f.invoke(["--cancel", run.runKey], {
      processes: {
        probe: { start: () => null },
        stop: () => assert.fail("unconfirmed PID cannot stop"),
      },
    });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /exit could not be confirmed/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readFileSync(ownerFile), owner);
    assert.equal(fs.existsSync(path.join(stateDir, "jobs", run.jobId, "cancel.json")), false);
    assert.equal(readTurn(stateDir, run.jobId), null);
  } finally {
    unlock();
  }
});
