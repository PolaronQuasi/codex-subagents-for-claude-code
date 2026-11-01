import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH, ORIGINAL } from "./support/runner-fixture.mjs";
import { gitInit, gitOut } from "./support/git-repos.mjs";
import { delivered } from "./support/capture.mjs";
import { cacheChanges, readChangesPatch } from "../src/delivery/changes.mjs";
import { readTurn } from "../src/state/job-store.mjs";

test("shell-only worktree edits and model-made commits supply touched paths and a persistent Git diff", async (t) => {
  const f = fixture(t, { status: "running", touchedFiles: [] });
  await gitInit(f.work);
  assert.equal((await f.invoke([...LAUNCH, "--write", "--worktree", "--keep-state"])).code, 3);
  const run = f.metadata();
  fs.writeFileSync(path.join(run.cwd, "shell.txt"), `from a shell\n${ORIGINAL}`);
  fs.rmSync(path.join(run.cwd, "README.md"));
  await gitOut(["add", "-A"], run.cwd);
  await gitOut(
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-qm",
      "model commit",
    ],
    run.cwd,
  );
  f.configure({ status: "completed" });
  const done = await f.invoke(["--run", run.runKey, "--wait-ms", "10000"]);
  assert.equal(done.code, 0, done.stderr);
  const saved = f.metadata();
  assert.deepEqual(saved.result.touchedFiles, ["README.md", "shell.txt"]);
  assert.equal(delivered(done.stdout).footer.touched, 2);
  assert.deepEqual(readTurn(path.join(f.state, run.runKey), run.jobId).touchedFiles, []);
  const diff = await f.invoke(["--run", run.runKey, "--diff"]);
  assert.equal(diff.code, 0, diff.stderr);
  assert.match(diff.stdout, /from a shell/);
  assert.match(diff.stdout, /deleted file mode/);
  assert.doesNotMatch(diff.stdout, /exact original prompt/);
  assert.equal((await f.invoke(["--run", run.runKey, "--diff"])).stdout, diff.stdout);
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
  assert.match(fs.readFileSync(saved.result.resultFile, "utf8"), /touched=2/);
});

test("continued worktree accounting is cumulative and progress off suppresses both patch sources", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "first.txt", touchedFiles: [] });
  await gitInit(f.work);
  assert.equal(
    (await f.invoke([...LAUNCH, "--write", "--worktree", "--keep-state", "--keep-prompt"])).code,
    0,
  );
  const first = f.metadata();
  f.configure({ touchWorkspaceFile: "second.txt" });
  fs.writeFileSync(
    path.join(f.work, "next.md"),
    `continue: ${first.runKey}\nprogress: off\n\nNext task`,
  );
  const done = await f.invoke([
    "--role",
    "gpt-6-1-sol",
    "--task-file",
    "next.md",
    "--wait-ms",
    "10000",
  ]);
  assert.equal(done.code, 0, done.stderr);
  const run = f.metadata();
  assert.deepEqual(run.result.touchedFiles, ["first.txt", "second.txt"]);
  assert.equal(run.result.changes.base, first.worktree.startCommit);
  assert.equal(fs.existsSync(path.join(f.state, run.runKey, `changes-${run.jobId}.patch`)), false);
  const diff = await f.invoke(["--run", run.runKey, "--diff"]);
  assert.equal(diff.stdout, "");
  assert.match(diff.stderr, /progress is off/);
});

test("scratch shell writes are counted without following a junction; absent patches explain themselves", async (t) => {
  const f = fixture(t, { status: "running", touchedFiles: [] });
  assert.equal(
    (await f.invoke([...LAUNCH, "--write", "--scratch-workspace", "--keep-state"])).code,
    3,
  );
  const run = f.metadata();
  fs.writeFileSync(path.join(run.cwd, "shell.txt"), "content");
  fs.symlinkSync(
    f.other,
    path.join(run.cwd, "outside"),
    process.platform === "win32" ? "junction" : "dir",
  );
  fs.writeFileSync(path.join(f.other, "private.txt"), "do not enumerate");
  f.configure({ status: "completed" });
  const done = await f.invoke(["--run", run.runKey, "--wait-ms", "10000"]);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(f.metadata().result.touchedFiles, ["outside", "shell.txt"]);
  const diff = await f.invoke(["--run", run.runKey, "--diff"]);
  assert.equal(diff.code, 0);
  assert.equal(diff.stdout, "");
  assert.match(diff.stderr, /No patch recorded.*does not prove/);
});

test("Git evidence is bounded, checksummed, redacted and unavailable on publication failure", async (t) => {
  const f = fixture(t, { status: "running", touchedFiles: [] });
  await gitInit(f.work);
  assert.equal((await f.invoke([...LAUNCH, "--write", "--worktree", "--keep-state"])).code, 3);
  const initial = f.metadata();
  fs.writeFileSync(path.join(initial.cwd, "large.txt"), "🚀".repeat(100000));
  f.configure({ status: "completed" });
  assert.equal((await f.invoke(["--run", initial.runKey, "--wait-ms", "10000"])).code, 0);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  const patch = readChangesPatch(run, stateDir);
  assert.ok(Buffer.byteLength(patch) <= 256 * 1024);
  assert.doesNotMatch(patch, /\uFFFD/);
  assert.equal(run.result.changes.patch, "truncated");
  assert.match((await f.invoke(["--run", run.runKey, "--diff"])).stderr, /truncated/);
  const file = path.join(stateDir, `changes-${run.jobId}.patch`);
  fs.writeFileSync(file, "tampered");
  assert.throws(() => readChangesPatch(run, stateDir), /checksum/);
  fs.rmSync(file);
  fs.mkdirSync(file);
  const warnings = [];
  await cacheChanges(run, { stateDir, warn: (s) => warnings.push(s) });
  assert.deepEqual(run.result.touchedFiles, ["large.txt"]);
  assert.equal(run.result.changes.patch, "unavailable");
  assert.match(warnings.join(), /could not be saved/);
});

test("steer and diff unknown keys use the standard diagnostic without a Codex process", async (t) => {
  const f = fixture(t),
    key = "b".repeat(32);
  for (const args of [
    ["--run", key, "--diff"],
    ["--steer", key, "--prompt-file", "prompt.md"],
  ]) {
    const done = await f.invoke(args);
    assert.equal(done.code, 1);
    assert.match(done.stderr, new RegExp(`unknown run ${key}; use --list to find retained runs`));
    assert.equal(done.stdout, "");
  }
  assert.deepEqual(f.events(), []);
});
