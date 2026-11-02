import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { workspace } from "./support/workspace-fixture.mjs";
import {
  VERIFY_DISPATCH_MS,
  VERIFY_WINDOWS_STARTUP_MS,
  VERIFY_POLL_MS,
  VERIFY_START_PHASE,
} from "../src/shared/constants.mjs";

// Load the unchanged executor with fake process/clock adapters. This
// covers the boundary deterministically on Windows too, without starting or
// signalling any process. Only import specifiers in the copied module change.
async function executor(t, { windows = false } = {}) {
  const f = workspace(t),
    runtime = path.join(f.root, "runtime");
  fs.mkdirSync(runtime);
  const sourceUrl = new URL("../src/verification/process.mjs", import.meta.url);
  let source = fs.readFileSync(sourceUrl, "utf8");
  for (const [from, to] of [
    ["../shared/constants.mjs", "./constants.mjs"],
    ["../shared/process-identity.mjs", "./fake.mjs"],
    ["node:child_process", "./fake.mjs"],
    ["node:timers/promises", "./fake.mjs"],
    ...["../shared/errors.mjs", "../shared/io.mjs", "./windows-job.mjs"].map((name) => [
      name,
      new URL(name, sourceUrl).href,
    ]),
  ])
    source = source.replaceAll(JSON.stringify(from), JSON.stringify(to));
  fs.writeFileSync(path.join(runtime, "process.mjs"), source);
  fs.writeFileSync(
    path.join(runtime, "constants.mjs"),
    `export * from ${JSON.stringify(new URL("../shared/constants.mjs", sourceUrl).href)};
export const IS_WINDOWS = ${windows};
export const IS_LINUX = false;
`,
  );
  fs.writeFileSync(
    path.join(runtime, "fake.mjs"),
    `const assert = (await import("node:assert/strict")).default;
const { EventEmitter } = await import("node:events");
const { PassThrough } = await import("node:stream");
const fs = (await import("node:fs")).default;
const crypto = await import("node:crypto");
export const state = { now: 1000, child: null, onTerminal: null, delivered: false, kills: 0, phase: null, startupMs: null, authorized: 0 };
export const processStart = () => "owned-fake-start";
export const leadsProcessGroup = () => true;
export const POWERSHELL = "unused";
export function spawn(_command, args) {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 900000001, connected: true, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    send() { this.started = true; },
    disconnect() { this.connected = false; },
    kill(signal) { return kill(-this.pid, signal); },
    unref() {},
  });
  state.child = child;
  state.spawnedAt = state.now;
  state.key = "";
  child.stdin.on("data", chunk => { state.key += chunk.toString(); });
  state.files = Object.fromEntries(["Recipe", "Ready", "Go", "Cancel", "Report", "Phase"].map(name => [name, args[args.indexOf("-" + name) + 1]]));
  if (state.phase !== null) fs.writeFileSync(args[args.indexOf("-Phase") + 1], state.phase);
  return child;
}
export function spawnSync(command) {
  assert.equal(command, "ps");
  return { status: 0, stdout: "", stderr: "" };
}
export async function setTimeout(ms) {
  state.now += ms;
  if (state.startupMs !== null && !state.delivered && state.now - state.spawnedAt >= state.startupMs) {
    if (!fs.existsSync(state.files.Ready)) {
      fs.writeFileSync(state.files.Ready, JSON.stringify({ pid: 900000002, processStart: "owned-fake-command" }));
    }
    const cancelled = fs.existsSync(state.files.Cancel);
    const authorized = fs.existsSync(state.files.Go);
    if (cancelled || authorized) {
      if (authorized) state.authorized++;
      const payload = Buffer.from(JSON.stringify({ state: cancelled ? "cancelled" : "exited", code: 0, settled: true, durationMs: ms })).toString("base64");
      const proof = crypto.createHmac("sha256", Buffer.from(state.key.trim(), "base64")).update(payload).digest("hex");
      fs.writeFileSync(state.files.Report, JSON.stringify({ payload, proof }));
      state.delivered = true;
      state.child.emit("exit", 0, null);
      state.child.emit("close");
    }
  }
  if (state.child?.started && !state.delivered) {
    state.delivered = true;
    state.child.emit("message", { kind: "exit", code: 0, signal: null });
    state.onTerminal?.();
  }
}
export function kill(pid, signal) {
  assert.equal(pid, -state.child.pid);
  assert.equal(signal, "SIGKILL");
  state.kills++;
  state.child.emit("exit", null, signal);
  state.child.emit("close");
  return true;
}
`,
  );
  const fake = await import(pathToFileURL(path.join(runtime, "fake.mjs")).href);
  t.mock.method(performance, "now", () => fake.state.now);
  t.mock.method(process, "kill", fake.kill);
  const { executeVerification } = await import(
    pathToFileURL(path.join(runtime, "process.mjs")).href
  );
  return {
    ...fake,
    directory: f.state,
    run: (timeoutMs, signal) =>
      executeVerification(
        { executable: process.execPath, args: [], env: {}, timeoutMs, maxLogBytes: 128 },
        {
          directory: f.state,
          cwd: f.work,
          signal,
          checkpoint: (value) => fake.state.onCheckpoint?.(value),
        },
      ),
  };
}

test("Windows slow supervisor startup preserves the command's execution budget", async (t) => {
  const f = await executor(t, { windows: true });
  f.state.phase = VERIFY_START_PHASE.COMPILING;
  f.state.startupMs = VERIFY_DISPATCH_MS + 5000;
  const result = await f.run(1000);
  assert.equal(result.state, "exited", JSON.stringify(result));
  assert.equal(result.code, 0);
  assert.equal(result.settled, true);
  assert.equal(f.state.authorized, 1);
  assert.equal(f.state.kills, 0);
});

test("Windows cancellation during slow startup settles without authorizing the command", async (t) => {
  const f = await executor(t, { windows: true });
  const controller = new AbortController();
  f.state.phase = VERIFY_START_PHASE.COMPILING;
  f.state.startupMs = VERIFY_DISPATCH_MS + 5000;
  f.state.onCheckpoint = () => controller.abort();
  const result = await f.run(1000, controller.signal);
  assert.equal(result.state, "cancelled", JSON.stringify(result));
  assert.equal(result.settled, true);
  assert.equal(f.state.authorized, 0);
  assert.equal(fs.existsSync(path.join(f.directory, "go")), false);
  assert.equal(f.state.kills, 0);
});

test("Windows readiness after the startup deadline never authorizes the command", async (t) => {
  const f = await executor(t, { windows: true });
  f.state.phase = VERIFY_START_PHASE.READY;
  f.state.startupMs = VERIFY_WINDOWS_STARTUP_MS + VERIFY_POLL_MS;
  const result = await f.run(1000);
  assert.equal(result.state, "uncertain", JSON.stringify(result));
  assert.equal(result.settled, false);
  assert.match(result.error, /verification dispatch timed out/);
  assert.equal(fs.existsSync(path.join(f.directory, "ready.json")), true);
  assert.equal(fs.existsSync(path.join(f.directory, "go")), false);
  assert.equal(f.state.authorized, 0);
  assert.equal(f.state.kills, 1);
});

for (const phase of [VERIFY_START_PHASE.COMPILING, "secret recipe text", null]) {
  test(`Windows startup diagnostics retain uncertainty for phase ${phase === null ? "missing" : phase === VERIFY_START_PHASE.COMPILING ? "compiling" : "invalid"}`, async (t) => {
    const f = await executor(t, { windows: true });
    f.state.phase = phase;
    const result = await f.run(1000);
    const expected =
      phase === VERIFY_START_PHASE.COMPILING ? phase : VERIFY_START_PHASE.UNAVAILABLE;
    assert.equal(result.state, "uncertain");
    assert.equal(result.settled, false);
    assert.equal(result.error, `verification dispatch timed out (supervisor phase: ${expected})`);
    assert.ok(result.durationMs > VERIFY_WINDOWS_STARTUP_MS);
    assert.equal(fs.existsSync(path.join(f.directory, "go")), false);
    assert.equal(f.state.kills, 1, "only the owned fake supervisor is stopped");
    assert.doesNotMatch(JSON.stringify(result), /secret recipe text/);
  });
}

for (const [when, timeoutMs, expected] of [
  ["before", 26, "exited"],
  ["at", 25, "timeout"],
  ["after", 24, "timeout"],
]) {
  test(`POSIX terminal success ${when} the deadline is classified as ${expected}`, async (t) => {
    const f = await executor(t);
    const result = await f.run(timeoutMs);
    assert.equal(result.state, expected);
    assert.equal(result.code, 0);
    assert.equal(result.settled, true);
    assert.equal(result.durationMs, 25);
    assert.equal(f.state.kills, 1, "the fake group must settle before returning");
  });
}

test("POSIX cancellation takes precedence over a simultaneous late terminal success", async (t) => {
  const f = await executor(t),
    controller = new AbortController();
  f.state.onTerminal = () => controller.abort();
  const result = await f.run(24, controller.signal);
  assert.equal(result.state, "cancelled");
  assert.equal(result.settled, true);
  assert.equal(f.state.kills, 1);
});

test("POSIX deadline enforcement also accepts a zero clock origin", async (t) => {
  const f = await executor(t);
  f.state.now = 0;
  const result = await f.run(25);
  assert.equal(result.state, "timeout");
  assert.equal(result.settled, true);
  assert.equal(f.state.kills, 1);
});
