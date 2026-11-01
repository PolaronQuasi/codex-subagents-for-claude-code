// A continued turn's transitions (src/state/turn-transition.mjs): the named states,
// and a rollback that gives back exactly the delivered run the turn left.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  confirmTurnJob,
  reserveTurn,
  rollBackTurnRecord,
  switchTurn,
  turnInTransition,
  turnReserved,
  turnSwitched,
  unreserveTurn,
} from "../src/state/turn-transition.mjs";
import { validateRun } from "../src/state/run-record.mjs";
import { workspace } from "./support/workspace-fixture.mjs";

const KEY = "e".repeat(32);
const NEXT = { model: "gpt-5.6-luna", effort: "low", write: true, requestId: undefined };
const copy = (value) => JSON.parse(JSON.stringify(value));

function delivered(t) {
  const f = workspace(t);
  const stateDir = path.join(f.state, KEY);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, "prompt.txt"), "first prompt");
  fs.writeFileSync(path.join(stateDir, "result.txt"), "first answer");
  const run = {
    version: 2,
    runKey: KEY,
    jobId: "task-first",
    cwd: f.work,
    codex: {
      path: process.execPath,
      realPath: process.execPath,
      version: "0.166.0",
      build: "b".repeat(64),
    },
    driverProtocol: 1,
    model: "gpt-6.1-sol",
    effort: "xhigh",
    write: false,
    keepState: true,
    turns: [],
    result: { status: "completed", sha256: "a".repeat(64), threadId: "thread-1" },
  };
  return { stateDir, run };
}
const turnFiles = (stateDir) => fs.readdirSync(stateDir).filter((name) => name.startsWith("turn-"));

test("a continued turn's states are named: reserved, switched, confirmed", async (t) => {
  const { stateDir, run } = delivered(t);
  const saves = [];
  const save = () => saves.push(copy(run));
  assert.deepEqual(
    [turnInTransition(run), turnReserved(run), turnSwitched(run)],
    [false, false, false],
  );
  reserveTurn(run, save);
  assert.deepEqual(
    [turnInTransition(run), turnReserved(run), turnSwitched(run)],
    [true, true, false],
  );
  unreserveTurn(run, save);
  assert.equal(turnInTransition(run), false);
  reserveTurn(run, save);
  assert.equal(switchTurn(run, stateDir, "second prompt", NEXT, save), 1);
  assert.deepEqual(
    [turnInTransition(run), turnReserved(run), turnSwitched(run)],
    [true, false, true],
  );
  assert.deepEqual(turnFiles(stateDir).sort(), ["turn-1-prompt.txt", "turn-1-result.txt"]);
  assert.equal(fs.readFileSync(path.join(stateDir, "prompt.txt"), "utf8"), "second prompt");
  assert.equal(saves.length, 4, "a save at each step, the switch's before the prompt is stored");
  assert.equal(saves.at(-1).turns.length, 1);
  run.dormant = true;
  confirmTurnJob(run, "task-second");
  assert.deepEqual([run.jobId, run.continuing, run.dormant], ["task-second", undefined, undefined]);
  assert.equal(turnInTransition(run), false);
  const confirmed = copy(run);
  assert.equal(
    validateRun(confirmed, KEY),
    confirmed,
    "the confirmed turn's record is a valid one",
  );
});

test("a turn that never started rolls back to exactly the delivered run it left, whatever that run recorded", async (t) => {
  for (const extra of [
    {},
    { keepState: false },
    { keepState: undefined },
    { model: undefined, effort: undefined },
    { turnRequestId: "rq-turn-1", turnRequestDigest: "b".repeat(64) },
    { turnRequestId: "rq-turn-1" },
    { retriedJobs: [{ jobId: "task-given-up", reason: "worker-died" }] },
    { write: true },
    { quotaFloor: 10, mcp: "inherit", progress: "off" },
    { summary: "detailed" },
    { review: "uncommitted" },
  ]) {
    const { stateDir, run } = delivered(t);
    Object.assign(run, extra);
    const before = copy(run);
    const save = () => {};
    // Switched, then rolled back.
    reserveTurn(run, save);
    switchTurn(run, stateDir, "second prompt", NEXT, save);
    Object.assign(run, { quotaFloor: 0, mcp: "off", progress: "on", summary: "none" });
    assert.deepEqual(rollBackTurnRecord(run, stateDir, save), { writer: true, reportBusy: true });
    assert.deepEqual(copy(run), before, JSON.stringify(extra));
    assert.equal(fs.readFileSync(path.join(stateDir, "prompt.txt"), "utf8"), "first prompt");
    assert.deepEqual(turnFiles(stateDir), []);
    // Reserved, its files copied, then rolled back.
    reserveTurn(run, save);
    for (const name of ["prompt.txt", "result.txt"])
      fs.copyFileSync(path.join(stateDir, name), path.join(stateDir, `turn-1-${name}`));
    assert.deepEqual(rollBackTurnRecord(run, stateDir, save), { writer: true, reportBusy: false });
    assert.deepEqual(copy(run), before, JSON.stringify(extra));
    assert.deepEqual(turnFiles(stateDir), []);
    assert.equal(rollBackTurnRecord(run, stateDir, save), null, "a delivered run is no turn");
  }
});
