// The runtime snapshot (src/shared/runtime-release.mjs) and --prepare: an
// immutable copy of a release under <state>/runtime/, which the plugin's
// forwarders and skill run instead of the plugin's replaceable cache folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RUNNER_VERSION, parseArgs, runProcess } from "../src/index.mjs";
import {
  ensureRuntime,
  RELEASE_ROOT,
  runtimeFiles,
  runtimeId,
  runtimeSnapshots,
} from "../src/shared/runtime-release.mjs";
import { CODES, EXIT } from "../src/shared/errors.mjs";
import { SCRIPT } from "./support/cli-adapter.mjs";
import { TEXT, fixture } from "./support/codex-fixture.mjs";

const scratch = (t, prefix = "codex-subagents-for-claude-code-runtime-") => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
};
const readOnly = (file) => (fs.statSync(file).mode & 0o222) === 0;
// A release folder as a plugin's cache holds one: the entry beside src/ and the legal files.
function releaseCopy(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "run-codex-task.mjs"));
  fs.cpSync(path.join(RELEASE_ROOT, "src"), path.join(root, "src"), { recursive: true });
  for (const name of ["LICENSE", "NOTICE"])
    fs.copyFileSync(path.join(RELEASE_ROOT, name), path.join(root, name));
  return path.join(root, "run-codex-task.mjs");
}

test("a runtime snapshot holds the entry, every module and the legal files, read-only, and is named after the version and their digest", (t) => {
  const stateBase = scratch(t);
  const made = ensureRuntime({ stateBase, entry: SCRIPT, version: RUNNER_VERSION });
  const files = runtimeFiles(RELEASE_ROOT, SCRIPT);
  assert.equal(made.created, true);
  assert.equal(made.id, runtimeId(files, RUNNER_VERSION));
  assert.match(made.id, /^\d+\.\d+\.\d+-[0-9a-f]{12}$/);
  assert.equal(made.dir, path.join(stateBase, "runtime", made.id));
  assert.equal(made.runner, path.join(made.dir, "run-codex-task.mjs"));
  for (const name of [
    "run-codex-task.mjs",
    "src/index.mjs",
    "src/shared/runtime-release.mjs",
    "LICENSE",
    "NOTICE",
  ])
    assert.ok(files.has(name), name);
  assert.ok(![...files.keys()].some((name) => /^(?:test|tools|claude|docs)\//.test(name)));
  for (const [name, bytes] of files) {
    const file = path.join(made.dir, name);
    assert.deepEqual(fs.readFileSync(file), bytes, name);
    assert.ok(readOnly(file), `${name} is read-only`);
  }
  const again = ensureRuntime({ stateBase, entry: SCRIPT, version: RUNNER_VERSION });
  assert.deepEqual(again, { ...made, created: false });
  assert.deepEqual(runtimeSnapshots(stateBase), [made.id]);
  assert.deepEqual(fs.readdirSync(path.join(stateBase, "runtime")), [made.id], "no staging left");
});

test("releases coexist: a changed release gets its own snapshot, the old one keeps its bytes, and a snapshot with other bytes is refused, never overwritten", (t) => {
  const root = scratch(t);
  const stateBase = path.join(root, "state"),
    release = path.join(root, "release");
  const entry = releaseCopy(release);
  const first = ensureRuntime({ stateBase, entry, version: "9.9.9", root: release });
  const version = path.join(release, "src", "version.mjs");
  const before = fs.readFileSync(version);
  fs.appendFileSync(version, "// the next release\n");
  const second = ensureRuntime({ stateBase, entry, version: "9.9.9", root: release });
  assert.notEqual(second.id, first.id);
  assert.deepEqual(runtimeSnapshots(stateBase), [first.id, second.id].sort());
  assert.deepEqual(fs.readFileSync(path.join(first.dir, "src", "version.mjs")), before);
  // A running driver's files never change: a snapshot edited since is refused as it is.
  fs.writeFileSync(version, before);
  const edited = path.join(first.dir, "src", "roles.mjs");
  fs.chmodSync(edited, 0o644);
  fs.appendFileSync(edited, "// edited\n");
  const altered = fs.readFileSync(edited);
  assert.throws(
    () => ensureRuntime({ stateBase, entry, version: "9.9.9", root: release }),
    (error) =>
      error.code === CODES.RUNTIME_CONFLICT &&
      error.message.includes(first.dir) &&
      /never overwritten/.test(error.message),
  );
  assert.deepEqual(fs.readFileSync(edited), altered);
  // Made writable but unchanged, a snapshot is reused and read-only again.
  fs.writeFileSync(edited, fs.readFileSync(path.join(release, "src", "roles.mjs")));
  assert.equal(ensureRuntime({ stateBase, entry, version: "9.9.9", root: release }).created, false);
  assert.ok(readOnly(edited));
  // A link where a module can be is never followed.
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(release, "src", "index.mjs"), path.join(release, "src", "linked.mjs"));
    assert.throws(() => runtimeFiles(release, entry), /src\/linked\.mjs is no regular file/);
  }
});

test("--prepare takes a known role only, and stands alone", () => {
  assert.equal(parseArgs(["--prepare", "gpt-6-astra"]).mode, "prepare");
  assert.throws(() => parseArgs(["--prepare", "gpt-0-unknown"]), /unknown role gpt-0-unknown/);
  assert.throws(
    () => parseArgs(["--prepare", "gpt-6-astra", "--quiet"]),
    /use --prepare by itself/,
  );
  assert.throws(() => parseArgs(["--prepare"]), /--prepare needs a nonempty value/);
});

test("--prepare prints the snapshot's runner and an unused task file, and a job run through that runner completes after the plugin's cache folder is deleted", async (t) => {
  const f = fixture(t);
  const cache = path.join(f.root, "plugin cache", "codex-subagents", RUNNER_VERSION);
  const entry = releaseCopy(cache);
  const env = { ...f.env, TEMP: f.root, TMP: f.root, TMPDIR: f.root };
  const prepared = await runProcess(process.execPath, [entry, "--prepare", "gpt-6-1-sol"], {
    env,
    cwd: f.work,
    timeoutMs: 30_000,
  });
  assert.equal(prepared.status, EXIT.COMPLETED, prepared.stderr);
  const lines = prepared.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2, prepared.stdout);
  const [, runner] = /^runner: (.+)$/.exec(lines[0]) ?? [];
  const [, task] = /^task-file: (.+)$/.exec(lines[1]) ?? [];
  const slashed = (file) => file.split(path.sep).join("/");
  assert.ok(runner?.startsWith(`${slashed(f.state)}/runtime/${RUNNER_VERSION}-`), runner);
  assert.ok(runner.endsWith("/run-codex-task.mjs"), runner);
  assert.match(
    task ?? "",
    new RegExp(`/codex-subagents-for-claude-code/gpt-6-1-sol-[0-9a-f]{8}\\.md$`),
  );
  assert.ok(task.startsWith(`${slashed(f.root)}/`), task);
  assert.equal(fs.existsSync(task), false, "the task file is the forwarder's to write");
  fs.writeFileSync(task, "effort: low\n\nThe task, written by the forwarder.\n");

  // The plugin updates: Claude Code replaces the cache folder under the run.
  fs.rmSync(path.join(f.root, "plugin cache"), { recursive: true, force: true });
  const launched = await runProcess(
    process.execPath,
    [runner, "--role", "gpt-6-1-sol", "--task-file", task, "--quiet", "--detach"],
    { env, cwd: f.work, timeoutMs: 60_000 },
  );
  assert.equal(launched.status, EXIT.COMPLETED, launched.stderr);
  const receipt = /attach=(.+)$/m.exec(launched.stdout)?.[1] ?? "";
  assert.ok(receipt.includes(path.resolve(runner)) || receipt.includes(runner), receipt);
  assert.ok(!receipt.includes("plugin cache"), receipt);
  const key = /run=([0-9a-f]{32})/.exec(launched.stdout)?.[1];
  const result = await runProcess(
    process.execPath,
    [runner, "--run", key, "--wait-ms", "30000", "--relay"],
    { env, cwd: f.work, timeoutMs: 60_000 },
  );
  assert.equal(result.status, EXIT.COMPLETED, result.stderr);
  assert.ok(result.stdout.includes(TEXT), result.stdout);
  assert.match(result.stdout, /^codex-subagents-for-claude-code: status=completed /m);
});

test("--prepare keeps its task folder private: made 0700, a wider own one narrowed, and a link refused without following it", async (t) => {
  const f = fixture(t);
  const env = { ...f.env, TEMP: f.root, TMP: f.root, TMPDIR: f.root };
  const prepare = () =>
    runProcess(process.execPath, [SCRIPT, "--prepare", "gpt-6-1-sol"], {
      env,
      cwd: f.work,
      timeoutMs: 30_000,
    });
  const posix = process.platform !== "win32";
  const folder = path.join(f.root, "codex-subagents-for-claude-code");
  // A link planted where the folder goes, to a disposable folder elsewhere.
  const elsewhere = path.join(f.root, "elsewhere");
  fs.mkdirSync(elsewhere);
  const elsewhereMode = fs.statSync(elsewhere).mode;
  fs.symlinkSync(elsewhere, folder, posix ? "dir" : "junction");
  const refused = await prepare();
  assert.equal(refused.status, EXIT.FAILURE, refused.stdout);
  assert.match(
    refused.stderr,
    /expected a real directory, not a link: .*codex-subagents-for-claude-code/,
  );
  assert.doesNotMatch(refused.stdout, /task-file:/);
  assert.ok(fs.lstatSync(folder).isSymbolicLink(), "the link is left in place");
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.equal(fs.statSync(elsewhere).mode, elsewhereMode, "nothing is changed through the link");
  fs.unlinkSync(folder);

  for (const before of posix ? [null, 0o755] : [null]) {
    if (before !== null) fs.chmodSync(folder, before);
    const prepared = await prepare();
    assert.equal(prepared.status, EXIT.COMPLETED, prepared.stderr);
    assert.match(prepared.stdout, /^task-file: .*\/codex-subagents-for-claude-code\/gpt-6-1-sol-/m);
    assert.ok(fs.lstatSync(folder).isDirectory() && !fs.lstatSync(folder).isSymbolicLink());
    if (posix) assert.equal(fs.statSync(folder).mode & 0o777, 0o700, `from ${before}`);
  }
});
