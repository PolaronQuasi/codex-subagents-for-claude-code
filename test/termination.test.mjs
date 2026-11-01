// codex-subagents-for-claude-code owns every termination: the plugin never kills a process by PID
// on its behalf, and the runner stops only the processes it identified.
import assert from "node:assert/strict";

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ERRNO } from "../src/shared/errors.mjs";
import { STOP_OUTCOME, STOP_PROGRESS_WORDS } from "../src/shared/constants.mjs";
import { processStart, workerCommandPattern } from "../src/shared/process-identity.mjs";
import {
  IDENTIFIED,
  PROCEED,
  PROGRESS,
  STOP_INTERRUPTED,
  driveStop,
  spawnWindowsStop,
  stopProcessTree,
} from "../src/shared/process-stop.mjs";

import { alive, zombie } from "../src/shared/io.mjs";

import { JOB } from "./support/runner-fixture.mjs";
import { isAlive, retire } from "./support/processes.mjs";

const jobFile = (f, key) =>
  path.join(f.state, key, "state", "workspace-hash", "jobs", `${JOB}.json`);
const commands = (f) => f.events().map((event) => event.command);

// A disposable process tree for the stop itself: a root whose command line
// looks like the plugin's worker for jobId, with one child of its own.
async function disposableTree(t, jobId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagents-for-claude-code-stop "));
  const script = path.join(dir, "driver.mjs");
  const childFile = path.join(dir, "child.pid");
  const run = path.join(dir, "run");
  const tree = [];
  t.after(async () => {
    fs.rmSync(run, { force: true });
    for (const entry of tree) await retire(entry);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  fs.writeFileSync(run, "");
  fs.writeFileSync(
    script,
    [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      "const [, , , , , , , childFile, run] = process.argv;",
      'if (childFile !== "-") {',
      '  const child = spawn(process.execPath, [process.argv[1], "run", "--job-id", "child", "--state-dir", "x", "-", run], { stdio: "ignore", windowsHide: true });',
      '  child.once("spawn", () => fs.writeFileSync(childFile, String(child.pid) + "\\n"));',
      "}",
      "setInterval(() => { if (!fs.existsSync(run)) process.exit(0); }, 50);",
      "",
    ].join("\n"),
  );
  const root = spawn(
    process.execPath,
    [script, "run", "--job-id", jobId, "--state-dir", dir, childFile, run],
    { stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" },
  );
  await new Promise((resolve, reject) => root.once("spawn", resolve).once("error", reject));
  tree.push({ pid: root.pid, start: processStart(root.pid) });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let text = "";
    try {
      text = fs.readFileSync(childFile, "utf8");
    } catch (error) {
      if (error.code !== ERRNO.ENOENT) throw error;
    }
    const child = Number(text);
    // The newline marks a completed write; a partial number may name a
    // completely unrelated process and must never reach identity or cleanup.
    if (/^[1-9]\d*\n$/.test(text) && Number.isSafeInteger(child)) {
      tree.push({ pid: child, start: processStart(child) });
      return { root: root.pid, child, start: tree[0].start };
    }
    assert.ok(
      root.exitCode === null && root.signalCode === null,
      "fixture root exited before publishing its child PID",
    );
    await delay(20);
  }
  assert.fail("fixture did not publish a complete child PID within 10 seconds");
}

test("the stop fixture waits for a complete child PID before checking process identity", async (t) => {
  const readFileSync = fs.readFileSync;
  let reads = 0;
  const mocked = t.mock.method(fs, "readFileSync", function (...args) {
    const value = readFileSync.apply(this, args);
    if (path.basename(String(args[0])) === "child.pid" && /^\d+\n?$/.test(value)) {
      reads++;
      // Opening a PID file creates it before its bytes are fully written.
      if (reads === 1) return "";
      if (reads === 2) return value.slice(0, 1);
    }
    return value;
  });
  let tree;
  try {
    tree = await disposableTree(t, "task-pid-ready");
  } finally {
    mocked.mock.restore();
  }
  assert.ok(Number.isSafeInteger(tree.child) && tree.child > 0, "a valid child PID");
  assert.ok(reads >= 3, "empty and partial PID reads were retried");
  assert.ok(isAlive(tree.root) && isAlive(tree.child), "the fixture owns two live processes");
});

test("an identity-bound stop leaves a process with another start time or command line alone, and stops the tree of the one identified", async (t) => {
  const tree = await disposableTree(t, "task-stop-1");
  if (tree.start === null) {
    t.skip("the OS reports no process start time here");
    return;
  }
  const other = await stopProcessTree({
    pid: tree.root,
    start: process.platform === "win32" ? String(BigInt(tree.start) + 1n) : `${tree.start}0`,
  });
  assert.equal(other.state, STOP_OUTCOME.REUSED, "another start time is another process");
  const wrongJob = await stopProcessTree({
    pid: tree.root,
    start: tree.start,
    pattern: workerCommandPattern("task-other"),
  });
  assert.equal(wrongJob.state, STOP_OUTCOME.REUSED, "another job's command line");
  assert.ok(isAlive(tree.root) && isAlive(tree.child), "nothing was killed");
  let interrupted = 0;
  const stop = await stopProcessTree({
    pid: tree.root,
    start: tree.start,
    pattern: workerCommandPattern("task-stop-1"),
    interrupt: async () => {
      interrupted++;
      assert.ok(isAlive(tree.root), "the interrupt comes before the kill");
      return "interrupted";
    },
  });
  assert.deepEqual(
    [stop.state, stop.interrupted, interrupted],
    [STOP_OUTCOME.STOPPED, "interrupted", 1],
  );
  const deadline = Date.now() + 5000;
  while ((isAlive(tree.root) || isAlive(tree.child)) && Date.now() < deadline) await delay(20);
  assert.deepEqual([isAlive(tree.root), isAlive(tree.child)], [false, false], "root and child");
  assert.equal(
    (await stopProcessTree({ pid: tree.root, start: tree.start })).state,
    STOP_OUTCOME.GONE,
  );
});

test("on Linux a zombie, which signals still reach, is no live process", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the runner reads a process's state from /proc on Linux only");
    return;
  }
  // sh starts a child that exits at once, then becomes a sleep that never
  // reaps it: the child stays a zombie, as in a container whose first process
  // reaps nothing.
  const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => parent.kill());
  const pid = Number(String(await new Promise((resolve) => parent.stdout.once("data", resolve))));
  const state = () => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    } catch {
      return null;
    }
  };
  const deadline = Date.now() + 5000;
  while (state() !== "Z" && Date.now() < deadline) await delay(20);
  assert.equal(state(), "Z", "the child has exited and nobody reaped it");
  assert.doesNotThrow(() => process.kill(pid, 0), "signals still reach it");
  assert.equal(alive(pid), false);
  assert.equal(isAlive(pid), false);
});

test("a missing process state leaves a live process running: a second signal decides", (t) => {
  const missing = () => {
    throw Object.assign(new Error("no procfs here"), { code: ERRNO.ENOENT });
  };
  assert.equal(zombie(process.pid, missing), false, "a live PID on a host without procfs");
  const denied = () => {
    throw Object.assign(new Error("denied"), { code: ERRNO.EACCES });
  };
  assert.equal(zombie(process.pid, denied), false, "an unreadable state is no proof");
  assert.deepEqual(
    ["Z", "X", "S", "R"].map((state) => zombie(process.pid, () => state)),
    [true, true, false, false],
  );
  // Signals no longer reach a PID whose state vanished: it ended meanwhile.
  t.mock.method(process, "kill", () => {
    throw Object.assign(new Error("no such process"), { code: ERRNO.ESRCH });
  });
  assert.equal(zombie(process.pid, missing), true);
});

// The answers a Windows stop helper printed: the lines of its stdout, once it
// has exited.
async function helperAnswers(child) {
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (out += chunk));
  await new Promise((resolve) => child.once("exit", resolve));
  return out
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

test("the Windows stop kills nothing unless its caller writes proceed at the gate, and then stops the whole tree", async (t) => {
  if (process.platform !== "win32") {
    t.skip("the gate belongs to the Windows stop");
    return;
  }
  for (const [how, release] of [
    ["stdin closed at the gate", (child) => child.stdin.end()],
    ["another line at the gate", (child) => child.stdin.end("stop\n")],
    ["proceed", (child) => child.stdin.end(`${PROCEED}\n`)],
  ]) {
    const jobId = `task-gate-${how.length}`;
    const tree = await disposableTree(t, jobId);
    const child = spawnWindowsStop({
      pid: tree.root,
      start: tree.start,
      pattern: workerCommandPattern(jobId),
    });
    child.stdout.once("data", () => release(child));
    const answers = await helperAnswers(child);
    const [first] = answers,
      last = answers.at(-1);
    assert.equal(first.state, IDENTIFIED, how);
    assert.ok(first.tree.includes(tree.child), `${how}: the child is held`);
    assert.ok(
      first.identities.some(
        (target) => target.pid === tree.child && typeof target.start === "string",
      ),
    );
    if (how !== "proceed") {
      assert.equal(answers.length, 1, `${how}: no answer after the gate`);
      assert.ok(isAlive(tree.root) && isAlive(tree.child), `${how}: nothing was killed`);
      continue;
    }
    const steps = answers.slice(1, -1);
    assert.ok(steps.length >= 2, "a word after the first round and before the wait");
    assert.ok(steps.length <= STOP_PROGRESS_WORDS, "no more words than the runner takes");
    assert.ok(
      steps.every((answer) => answer.state === PROGRESS),
      JSON.stringify(steps),
    );
    assert.deepEqual([last.state, last.alive, last.failed], [STOP_OUTCOME.STOPPED, [], []]);
    assert.deepEqual([isAlive(tree.root), isAlive(tree.child)], [false, false], "root and child");
  }
});

test("native stop durably captures the disposable tree before interrupt or signals", async (t) => {
  const tree = await disposableTree(t, "task-capture-1");
  const snapshots = [];
  const stopped = await stopProcessTree({
    pid: tree.root,
    start: tree.start,
    pattern: workerCommandPattern("task-capture-1"),
    onIdentified: async (targets) => {
      snapshots.push(targets);
      assert.ok(isAlive(tree.root) && isAlive(tree.child));
      assert.ok(targets.some((target) => target.pid === tree.child));
      await delay(20);
    },
    interrupt: async () => {
      assert.ok(snapshots.length);
      return null;
    },
  });
  assert.equal(stopped.state, STOP_OUTCOME.STOPPED);
  assert.equal(stopped.detail ?? null, null);
  assert.ok(snapshots.length);
});

test("native stop sends no signal when its durable capture callback fails", async (t) => {
  const tree = await disposableTree(t, "task-capture-2");
  await assert.rejects(
    stopProcessTree({
      pid: tree.root,
      start: tree.start,
      pattern: workerCommandPattern("task-capture-2"),
      onIdentified: () => {
        throw new Error("checkpoint failed");
      },
      interrupt: () => assert.fail("cannot interrupt before durable capture"),
    }),
    /checkpoint failed/,
  );
  assert.ok(isAlive(tree.root) && isAlive(tree.child));
});

// A stand-in for the Windows stop helper that speaks its protocol: identified,
// then, once told to proceed, a word every stepMs for rounds rounds (or one
// word and then silence for silentMs), then the answer.
function slowHelper(t, { rounds = 4, stepMs = 300, silentMs = 0 } = {}) {
  const script = [
    "const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
    `say({ state: ${JSON.stringify(IDENTIFIED)}, tree: [1] });`,
    "let input = '';",
    "process.stdin.on('data', async (chunk) => {",
    "  input += chunk;",
    "  if (!input.includes('\\n')) return;",
    `  if (input.trim() !== ${JSON.stringify(PROCEED)}) process.exit(0);`,
    `  for (let round = 1; round <= ${rounds}; round++) {`,
    `    await wait(${stepMs});`,
    `    say({ state: ${JSON.stringify(PROGRESS)}, round });`,
    `    if (${silentMs}) await wait(${silentMs});`,
    "  }",
    `  await wait(${stepMs});`,
    `  say({ state: ${JSON.stringify(STOP_OUTCOME.STOPPED)}, ended: false, tree: [1], alive: [], failed: [] });`,
    "  process.exit(0);",
    "});",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  return child;
}

test("a stop's deadline after proceed covers each step of the helper, not the whole stop", async (t) => {
  // Four rounds 300 ms apart take longer than one 700 ms deadline; each word
  // starts a new one, so the answer is the helper's.
  const slow = await driveStop(slowHelper(t), { pid: process.pid, progressMs: 700 });
  assert.deepEqual([slow.state, slow.detail, slow.tree], [STOP_OUTCOME.STOPPED, null, [1]]);
  // A helper silent for longer than the deadline is still given up on: the
  // root's own state decides, and the detail says the helper gave no answer.
  const silent = await driveStop(slowHelper(t, { rounds: 1, silentMs: 2000 }), {
    pid: process.pid,
    progressMs: 700,
  });
  assert.equal(silent.state, STOP_OUTCOME.ALIVE, "this process is the root here, and it runs");
  assert.match(silent.detail, /the stop helper gave no answer/);
});

// A regression that read progress words without end would hang the suite.
test(
  "a stop takes as many progress words as the real helper prints at most, so one that reports progress forever is given up on",
  { timeout: 60_000 },
  async (t) => {
    const options = { pid: process.pid, progressMs: 2000 };
    const full = await driveStop(
      slowHelper(t, { rounds: STOP_PROGRESS_WORDS, stepMs: 20 }),
      options,
    );
    assert.deepEqual(
      [full.state, full.detail],
      [STOP_OUTCOME.STOPPED, null],
      "the helper's answer",
    );
    // A word beyond them counts as no answer: the root's own state decides.
    const endless = await driveStop(slowHelper(t, { rounds: Infinity, stepMs: 20 }), options);
    assert.equal(endless.state, STOP_OUTCOME.ALIVE, "this process is the root here, and it runs");
    assert.equal(
      endless.detail,
      `the stop helper gave no answer after ${STOP_PROGRESS_WORDS} progress words`,
    );
  },
);

test("a stop whose caller is aborted before the kill kills nothing and says it was interrupted", async (t) => {
  const tree = await disposableTree(t, "task-abort-1");
  if (tree.start === null) {
    t.skip("the OS reports no process start time here");
    return;
  }
  const target = {
    pid: tree.root,
    start: tree.start,
    pattern: workerCommandPattern("task-abort-1"),
  };
  const before = new AbortController();
  before.abort(new Error("SIGINT"));
  const early = await stopProcessTree({ ...target, signal: before.signal });
  assert.deepEqual([early.state, early.detail], [STOP_OUTCOME.UNKNOWN, STOP_INTERRUPTED]);
  // Ctrl-C while the turn is being interrupted: the tree identified is let go.
  const during = new AbortController();
  const late = await stopProcessTree({
    ...target,
    signal: during.signal,
    interrupt: async () => {
      during.abort(new Error("SIGINT"));
      return "interrupted";
    },
  });
  assert.deepEqual(
    [late.state, late.interrupted, late.detail],
    [STOP_OUTCOME.UNKNOWN, "interrupted", STOP_INTERRUPTED],
  );
  await delay(500);
  assert.ok(isAlive(tree.root) && isAlive(tree.child), "nothing was killed");
});
