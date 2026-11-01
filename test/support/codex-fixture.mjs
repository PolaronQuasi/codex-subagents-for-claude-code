import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { gitEnvironment } from "./git-environment.mjs";
import { writeNativeCodex } from "./native-codex.mjs";
import { sink } from "./capture.mjs";
import { SCRIPT, main } from "./cli-adapter.mjs";
import { runProcess, alive, atomicWrite } from "../../src/shared/io.mjs";
import { processStart } from "../../src/shared/process-identity.mjs";
import {
  IS_WINDOWS,
  CODEX_COMMAND,
  CODEX_ENV,
  DRIVER_EXIT_MS,
  DRIVER_POLL_MS,
} from "../../src/shared/constants.mjs";

export const JOB = "task-fixture-001";
export const KEY = "a".repeat(32);
export const TEXT = "A complete result: λ, 日本語, 🚀.\n";
export const ORIGINAL = "The exact original prompt: λ.\n";
export const LAUNCH = [
  "--model",
  "gpt-6.1-sol",
  "--effort",
  "xhigh",
  "--prompt-file",
  "prompt.md",
  "--wait-ms",
  "0",
];
export const launchWith = (model = "gpt-6.1-sol", effort = "xhigh", extra = []) => [
  "--model",
  model,
  "--effort",
  effort,
  "--prompt-file",
  "prompt.md",
  "--wait-ms",
  "0",
  ...extra,
];
const ENTRY = fileURLToPath(new URL("../fixtures/codex/codex.mjs", import.meta.url));

export function fixture(t, initial = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-direct-test "));
  const work = path.join(root, "workspace with spaces"),
    other = path.join(root, "other workspace");
  const state = path.join(root, "state"),
    resultsDir = path.join(root, "results"),
    bin = path.join(root, "bin");
  for (const dir of [work, other, state, bin]) fs.mkdirSync(dir);
  const controlFile = path.join(root, "control.json"),
    eventsFile = path.join(root, "events.jsonl");
  const workerControl = path.join(root, "running");
  fs.writeFileSync(workerControl, "");
  fs.writeFileSync(path.join(work, "prompt.md"), ORIGINAL);
  const env = {
    ...Object.fromEntries(
      Object.entries(gitEnvironment())
        .map(([name, value]) => [name.toUpperCase() === "PATH" ? "PATH" : name, value])
        .filter(
          ([name]) =>
            !name.toUpperCase().startsWith("CODEX_SUBAGENTS_FOR_CLAUDE_CODE_") &&
            ![
              "CLAUDE_PLUGIN_ROOT",
              "CODEX_HOME",
              "CLAUDE_CODE_SESSION_ID",
              "CLAUDE_CODE_HOST_SESSION_ID",
            ].includes(name.toUpperCase()) &&
            !name.toUpperCase().startsWith("FIXTURE_") &&
            !name.toUpperCase().startsWith("CODEX_FIXTURE_"),
        ),
    ),
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR: state,
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: resultsDir,
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_DIR: bin,
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: path.join(root, "agents"),
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: path.join(root, "skill"),
    CLAUDE_CODE_SESSION_ID: "sess-fixture",
    CLAUDE_CODE_HOST_SESSION_ID: "local_fixture",
    CODEX_HOME: path.join(root, "codex-home"),
    CODEX_FIXTURE_NODE: process.execPath,
    CODEX_FIXTURE_ENTRY: ENTRY,
    FIXTURE_CONTROL: controlFile,
    FIXTURE_EVENTS: eventsFile,
    FIXTURE_HISTORY: path.join(root, "history.json"),
    FIXTURE_WORKER_CONTROL: workerControl,
  };
  const executable = path.join(bin, IS_WINDOWS ? "codex.exe" : "codex");
  // An inherited explicit real CLI path must never outrank this fake's bin.
  env[CODEX_ENV.PATH] = executable;
  writeNativeCodex(executable);
  let config = { result: TEXT, ...initial };
  const configure = (patch) => {
    config = { ...config, ...patch };
    atomicWrite(controlFile, JSON.stringify(config));
  };
  configure({});
  const children = new Set();
  const knownDrivers = new Map();
  const rememberDrivers = () => {
    for (const key of fs.readdirSync(state).filter((name) => /^[0-9a-f]{32}$/.test(name))) {
      const jobs = path.join(state, key, "jobs");
      if (!fs.existsSync(jobs)) continue;
      for (const job of fs.readdirSync(jobs)) {
        try {
          const record = JSON.parse(fs.readFileSync(path.join(jobs, job, "driver.json"), "utf8"));
          knownDrivers.set(job, record);
        } catch {
          /* A damaged record is an intentional input. */
        }
      }
    }
  };
  const spawnServer = (options = {}) => {
    const child = spawn(
      process.execPath,
      [ENTRY, CODEX_COMMAND.APP_SERVER, CODEX_COMMAND.LISTEN, CODEX_COMMAND.STDIO],
      { cwd: work, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...options },
    );
    children.add(child);
    return child;
  };
  t.after(async () => {
    fs.rmSync(workerControl, { force: true });
    for (const child of children) child.stdin?.end();
    const deadline = Date.now() + DRIVER_EXIT_MS;
    while (
      [...children].some((child) => child.exitCode === null && child.signalCode === null) &&
      Date.now() < deadline
    )
      await delay(DRIVER_POLL_MS);
    const records = [...knownDrivers.values()];
    for (const folder of [
      state,
      ...fs
        .readdirSync(state)
        .filter((name) => /^[0-9a-f]{32}$/.test(name))
        .map((name) => path.join(state, name)),
    ]) {
      const jobs = path.join(folder, "jobs");
      if (!fs.existsSync(jobs)) continue;
      for (const job of fs.readdirSync(jobs)) {
        const file = path.join(jobs, job, "driver.json");
        if (fs.existsSync(file)) records.push(JSON.parse(fs.readFileSync(file, "utf8")));
      }
    }
    const owned = records
      .flatMap((record) => [record, ...(record.appServer ? [record.appServer] : [])])
      .filter((record) => {
        // Gate policy can be exercised in this test process with a fake clock.
        // It is never a detached fixture child to wait for at teardown.
        if (record.pid === process.pid) return false;
        if (!record.pid || !alive(record.pid)) return false;
        const current = processStart(record.pid);
        return current === null || current === record.processStart;
      });
    while (owned.some((record) => alive(record.pid)) && Date.now() < deadline)
      await delay(DRIVER_POLL_MS);
    assert.ok(
      owned.every((record) => !alive(record.pid)),
      "every detached fake driver exited",
    );
    assert.ok(
      [...children].every((child) => child.exitCode !== null || child.signalCode !== null),
      "every fake exited through its own control file",
    );
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codex-direct-test "));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    // A cmd shim's root may exit before its slow-starting fake observes the
    // private lifetime control. Let that control poll finish before removal.
    await delay(DRIVER_POLL_MS);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const events = () =>
    fs.existsSync(eventsFile)
      ? fs.readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
  const runs = () => fs.readdirSync(state).filter((name) => /^[0-9a-f]{32}$/.test(name));
  const metadata = (key = runs()[0]) =>
    JSON.parse(fs.readFileSync(path.join(state, key, "run.json"), "utf8"));
  const results = () =>
    fs.existsSync(resultsDir)
      ? fs.readdirSync(resultsDir).filter((name) => name.endsWith(".md"))
      : [];
  const invoke = async (args = LAUNCH, options = {}) => {
    const out = sink(),
      err = sink();
    const code = await main(args, {
      env,
      cwd: work,
      stdout: out.stream,
      stderr: err.stream,
      backend: "driver",
      ...options,
      onOutcome(value) {
        rememberDrivers();
        options.onOutcome?.(value);
      },
    });
    rememberDrivers();
    return { code, stdout: out.text(), stderr: err.text() };
  };
  const cli = (args = LAUNCH, options = {}) =>
    runProcess(process.execPath, [SCRIPT, ...args], { env, cwd: work, ...options });
  const codex = (args, options = {}) =>
    runProcess(process.execPath, [ENTRY, ...args], { env, cwd: work, ...options });
  const resume = (extra = []) => ["--attach", JOB, "--run", runs()[0], "--wait-ms", "0", ...extra];
  return {
    root,
    work,
    other,
    state,
    resultsDir,
    bin,
    executable,
    env,
    controlFile,
    workerControl,
    configure,
    events,
    runs,
    metadata,
    results,
    invoke,
    cli,
    codex,
    spawnServer,
    trackChild: (child) => children.add(child),
    resume,
  };
}
