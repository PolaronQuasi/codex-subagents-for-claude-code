// The one-write crash windows: a launch helper still settling (P-05), ownerless
// locks and guards (P-09), a claim left by an interrupted cleanup (P-10), a
// continuation reserved but never switched (P-11), with its files copied or
// switched before its prompt was stored, and a retry whose job listing fails
// (N-06).
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CODES, EXIT } from "../src/shared/errors.mjs";
import { ORPHANED_LOCK_MS } from "../src/shared/constants.mjs";

import { acquireLock, acquireWriterLock, releaseWriterLock, workspaceId } from "../src/index.mjs";
import { delivered } from "./support/capture.mjs";
import { KEY, LAUNCH, ORIGINAL, fixture } from "./support/runner-fixture.mjs";

const aged = (dir, ms) => {
  const then = new Date(Date.now() - ms);
  fs.utimesSync(dir, then, then);
};

test("a gated launch still settling is retained before lost-job discovery", async (t) => {
  const f = fixture(t),
    key = KEY,
    stateDir = path.join(f.state, key);
  const { selectCodex } = await import("../src/codex/cli.mjs");
  const { createRecord } = await import("../src/state/run-store.mjs");
  fs.mkdirSync(stateDir);
  createRecord(
    {
      version: 2,
      runKey: key,
      cwd: f.work,
      jobId: null,
      codex: await selectCodex(f.env, f.work),
      driverProtocol: 1,
      model: "gpt-6.1-sol",
      effort: "xhigh",
      launching: { pid: process.pid, processStart: null, at: new Date().toISOString() },
    },
    stateDir,
  );
  for (const args of [
    ["--close", key],
    ["--run", key, "--wait-ms", "0"],
  ]) {
    const done = await f.invoke(args);
    assert.equal(done.code, 3, done.stderr);
    assert.match(done.stderr, /launch still settling/);
  }
  assert.deepEqual(f.events(), []);
});

test("an ownerless run lock is busy while young and reclaimed once it cannot belong to a live maker; messages name the path", async (t) => {
  const f = fixture(t);
  const lock = path.join(f.state, `${KEY}.lock`);
  fs.mkdirSync(lock);
  assert.throws(() => acquireLock(f.state, KEY), {
    code: CODES.RUN_LOCK_BUSY,
    message: `run ${KEY}'s lock ${lock} is changing hands; retry in a moment`,
  });
  aged(lock, ORPHANED_LOCK_MS + 5000);
  const release = acquireLock(f.state, KEY);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).pid, process.pid);
  release();
  assert.equal(fs.existsSync(`${lock}.recovery`), false);
});

test("an ownerless publication guard is reclaimed once old enough, and named while young", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.state, "writers"), { recursive: true });
  const guard = path.join(f.state, "writers", `${workspaceId(f.work)}.lock.recovery`);
  fs.mkdirSync(guard);
  assert.throws(() => acquireWriterLock(f.state, f.work, KEY), {
    code: CODES.GUARD_BUSY,
    message: new RegExp(`guard ${guard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} has no owner yet`),
  });
  aged(guard, ORPHANED_LOCK_MS + 5000);
  acquireWriterLock(f.state, f.work, KEY);
  assert.equal(await releaseWriterLock(f.state, f.work, KEY), true);
  assert.equal(fs.existsSync(guard), false);
});

test("a request claim left by a cleanup interrupted after removing its run is given back, from its tombstone", async (t) => {
  const f = fixture(t);
  const launch = [...LAUNCH, "--request-id", "tomb", "--keep-prompt"];
  assert.equal((await f.invoke([...launch, "--keep-state"])).code, EXIT.COMPLETED);
  const key = f.runs()[0];
  const claim = path.join(f.state, "requests", "tomb.lock");
  const owner = fs.readFileSync(path.join(claim, "owner.json"), "utf8");
  assert.equal((await f.invoke(["--close", key])).code, EXIT.COMPLETED);
  assert.equal(
    fs.existsSync(path.join(f.state, "closing", `${key}.json`)),
    false,
    "no tombstone after a whole cleanup",
  );
  // As a cleanup killed between removing the run and releasing its claim leaves them.
  fs.mkdirSync(claim, { recursive: true });
  fs.writeFileSync(path.join(claim, "owner.json"), owner);
  fs.mkdirSync(path.join(f.state, "closing"), { recursive: true });
  fs.writeFileSync(
    path.join(f.state, "closing", `${key}.json`),
    JSON.stringify({
      runKey: key,
      requestId: "tomb",
      resultFile: null,
      closedAt: new Date().toISOString(),
    }),
  );
  fs.writeFileSync(path.join(f.work, "prompt.md"), "The exact original prompt: λ.\n");
  // The copy of the delivered request is replayed; the claim no longer blocks it.
  const again = await f.invoke(launch);
  assert.equal(again.code, EXIT.COMPLETED, again.stderr);
  assert.match(
    again.stdout,
    /^codex-subagents-for-claude-code-replay: request tomb was delivered earlier; not relaunched\n/,
  );
  // A later teardown releases what is left and removes the tombstone.
  assert.equal((await f.invoke([...LAUNCH, "--keep-prompt"])).code, EXIT.COMPLETED);
  assert.equal(fs.existsSync(path.join(f.state, "closing", `${key}.json`)), false);
  assert.equal(fs.existsSync(claim), false);
});

test("a continuation reserved but never switched is given back, so --sleep works", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state", "--write"])).code, EXIT.COMPLETED);
  const key = f.runs()[0];
  // As a --continue --write killed right after its reservation leaves the run.
  const file = path.join(f.state, key, "run.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), continuing: true }),
  );
  acquireWriterLock(f.state, f.work, key);
  const slept = await f.invoke(["--sleep", key]);
  assert.equal(slept.code, EXIT.COMPLETED, slept.stderr);
  assert.match(
    slept.stderr,
    /reserved for a continued turn that never started; the reservation was given back/,
  );
  assert.equal(f.metadata(key).continuing, undefined);
  assert.equal(f.metadata(key).jobId, f.metadata().jobId);
  acquireWriterLock(f.state, f.work, "b".repeat(32));
  assert.equal(await releaseWriterLock(f.state, f.work, "b".repeat(32)), true);
});

test("a continuation interrupted after its copies, or after its switch but before its prompt was stored, stays recoverable", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, EXIT.COMPLETED);
  const key = f.runs()[0];
  const stateDir = path.join(f.state, key);
  const file = path.join(stateDir, "run.json");
  const delivered1 = f.metadata(key);
  const turnFiles = () => fs.readdirSync(stateDir).filter((name) => name.startsWith("turn-"));
  // Reserved, the delivered turn's files copied (turn-1-*), the record not
  // switched: --sleep gives the reservation back and removes the copies.
  for (const name of ["prompt.txt", "result.txt"])
    fs.copyFileSync(path.join(stateDir, name), path.join(stateDir, `turn-1-${name}`));
  fs.writeFileSync(file, JSON.stringify({ ...delivered1, continuing: true }));
  const slept = await f.invoke(["--sleep", key]);
  assert.equal(slept.code, EXIT.COMPLETED, slept.stderr);
  assert.match(slept.stderr, /reservation was given back/);
  assert.deepEqual(turnFiles(), []);
  assert.deepEqual(f.metadata(key), { ...delivered1, dormant: true });
  // Switched, the next prompt never stored: a launch that failed and could
  // not list the plugin's jobs leaves the switched turn, and the prompt is put
  // back to the delivered turn's, as if the switch's next write never came.
  fs.writeFileSync(path.join(f.work, "next.md"), "Second turn.\n");
  const next = ["--continue", key, "--prompt-file", "next.md", "--wait-ms", "0"];
  const { reserveTurn, switchTurn } = await import("../src/state/turn-transition.mjs");
  const { saveRun } = await import("../src/state/run-store.mjs");
  const prepared = f.metadata(key),
    save = () => saveRun(prepared, stateDir);
  reserveTurn(prepared, save);
  switchTurn(
    prepared,
    stateDir,
    Buffer.from("Second turn.\n"),
    { model: prepared.model, effort: prepared.effort, write: false },
    save,
  );
  const switched = f.metadata(key);
  assert.deepEqual([switched.continuing, switched.jobId, switched.result], [true, null, undefined]);
  assert.equal(switched.turns.length, 1);
  fs.copyFileSync(path.join(stateDir, "turn-1-prompt.txt"), path.join(stateDir, "prompt.txt"));
  const recovered = await f.invoke(["--run", key, "--wait-ms", "0"]);
  assert.equal(recovered.code, EXIT.FAILURE);
  assert.match(recovered.stderr, new RegExp(`turn 2 of run ${key} was not started`));
  assert.deepEqual(f.metadata(key), { ...delivered1, dormant: true }, "the delivered run again");
  assert.equal(fs.readFileSync(path.join(stateDir, "prompt.txt"), "utf8"), ORIGINAL);
  assert.deepEqual(turnFiles(), []);
  const repeated = await f.invoke(next);
  assert.equal(repeated.code, EXIT.COMPLETED, repeated.stderr);
  assert.equal(delivered(repeated.stdout).footer.turn, 2);
});
