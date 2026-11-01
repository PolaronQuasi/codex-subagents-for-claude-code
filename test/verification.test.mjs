import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import { gitInit, gitOut } from "./support/git-repos.mjs";
import { posixProcessAlive } from "../src/shared/process-identity.mjs";
import { executeVerification } from "../src/verification/process.mjs";
import { readVerification } from "../src/maintenance/verification.mjs";
import { snapshotFiles, compareSnapshotFiles } from "../src/verification/files.mjs";

async function keptSnapshot(f) {
  const launched = await f.invoke([
    ...LAUNCH.slice(0, -2),
    "--wait-ms",
    "10000",
    "--worktree",
    "--keep-state",
  ]);
  // A waiter deadline never authorizes another submission of the task.
  return launched.code === 3
    ? f.invoke(["--run", f.metadata().runKey, "--wait-ms", "30000"])
    : launched;
}

test("verification runs an exact fresh snapshot once and invalidates final mutations", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  fs.writeFileSync(path.join(f.work, "math.js"), "export const sum=(a,b)=>a+b;\n");
  await gitOut(["add", "math.js"], f.work);
  await gitOut(["commit", "-qm", "second file"], f.work);
  const launched = await keptSnapshot(f);
  assert.equal(launched.code, 0, launched.stderr);
  const run = f.metadata();
  assert.equal((await f.invoke(["--finalize", run.runKey])).code, 0);
  const recipe = path.join(f.root, "verify.json"),
    context = { stateBase: f.state, resultsDir: f.resultsDir };
  const write = (code) =>
    fs.writeFileSync(
      recipe,
      JSON.stringify({
        version: 1,
        executable: process.execPath,
        args: ["-e", code],
        timeoutMs: 5000,
        maxLogBytes: 1024,
      }),
    );
  const args = (id) => [
    "--verify-artifact",
    run.runKey,
    "--attempt",
    id,
    "--recipe",
    recipe,
    "--execution-profile",
    "trusted-local",
  ];
  // Inherited sparsity must not omit part of the sealed commit being tested.
  fs.writeFileSync(path.join(f.work, ".git", "info", "sparse-checkout"), "README.md\n");
  await gitOut(["config", "core.sparseCheckout", "true"], f.work);
  write(
    'const fs=require("fs");if(fs.readFileSync("README.md","utf8")!=="base\\n"||!fs.existsSync("math.js"))process.exit(4);console.log("verified")',
  );
  const first = await f.invoke(args("clean"));
  assert.equal(first.code, 0, first.stdout + "\n" + first.stderr);
  assert.equal(
    JSON.parse(first.stdout).recipe,
    undefined,
    "stdout must not echo private recipe values",
  );
  const receipt = readVerification(run.runKey, "clean", context);
  assert.equal(receipt.outcome, "exit-0");
  assert.equal(receipt.commit, run.result.commit);
  assert.equal(receipt.execution.settled, true);
  assert.notEqual(receipt.snapshot, run.cwd);
  assert.equal(receipt.cleanup.state, "removed");
  assert.equal(fs.existsSync(receipt.snapshot), false);
  assert.ok(
    !(await gitOut(["worktree", "list", "--porcelain"], f.work)).includes(
      receipt.snapshot.replaceAll("\\", "/"),
    ),
  );
  assert.match(fs.readFileSync(receipt.execution.logs.stdout.file, "utf8"), /verified/);
  const replay = await f.invoke(args("clean"));
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).replayed, true);
  // A crash receipt cannot authorize a second execution of this attempt.
  const file = path.join(f.resultsDir, "verifications", run.runKey, "clean.json");
  fs.writeFileSync(file, JSON.stringify({ ...receipt, outcome: "running" }));
  const interrupted = await f.invoke(args("clean"));
  assert.equal(interrupted.code, 2, interrupted.stderr);
  assert.equal(JSON.parse(interrupted.stdout).outcome, "uncertain");
  assert.equal(JSON.parse(interrupted.stdout).replayed, true);
  write('require("fs").writeFileSync("README.md","changed")');
  const changed = await f.invoke(args("changes"));
  assert.equal(changed.code, 2, changed.stderr);
  assert.equal(readVerification(run.runKey, "changes", context).outcome, "invalidated");
  assert.equal(readVerification(run.runKey, "changes", context).cleanup.state, "removed");
  assert.equal(fs.readFileSync(path.join(run.cwd, "README.md"), "utf8"), "base\n");
  write("process.exit(7)");
  const failed = await f.invoke(args("nonzero"));
  assert.equal(failed.code, 2, failed.stderr);
  assert.equal(readVerification(run.runKey, "nonzero", context).execution.code, 7);
  assert.equal(readVerification(run.runKey, "nonzero", context).cleanup.state, "removed");
  write(
    'require("child_process").execFileSync("git",["update-index","--skip-worktree","README.md"]);require("fs").writeFileSync("README.md","tampered")',
  );
  const hidden = await f.invoke(args("hidden-change"));
  assert.equal(hidden.code, 2, hidden.stdout + hidden.stderr);
  const hiddenReceipt = readVerification(run.runKey, "hidden-change", context);
  assert.equal(hiddenReceipt.outcome, "invalidated");
  assert.ok(hiddenReceipt.mutations.includes("changed: README.md"));
  assert.equal(hiddenReceipt.cleanup.state, "removed");
  write(
    'const fs=require("fs"),fd=fs.openSync(".git","r+");fs.ftruncateSync(fd);fs.writeSync(fd,"gitdir: /not-the-snapshot\\n");fs.closeSync(fd)',
  );
  const changedIdentity = await f.invoke(args("identity-change"));
  assert.equal(changedIdentity.code, 2, changedIdentity.stdout + changedIdentity.stderr);
  const identityReceipt = readVerification(run.runKey, "identity-change", context);
  assert.equal(identityReceipt.outcome, "invalidated", JSON.stringify(identityReceipt));
  assert.equal(identityReceipt.cleanup.state, "retained");
  assert.equal(fs.existsSync(identityReceipt.snapshot), true);
});

test("verification file comparison includes ignored files and refuses link traversal", async (t) => {
  const f = fixture(t),
    outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "valuable"), "preserve");
  fs.writeFileSync(path.join(f.work, ".gitignore"), "ignored\n");
  fs.writeFileSync(path.join(f.work, "tracked"), "before");
  const before = await snapshotFiles(f.work);
  fs.writeFileSync(path.join(f.work, "ignored"), "output");
  fs.writeFileSync(path.join(f.work, "tracked"), "after");
  fs.symlinkSync(
    outside,
    path.join(f.work, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const after = await snapshotFiles(f.work),
    diff = compareSnapshotFiles(before, after);
  assert.ok(diff.mutations.includes("added: ignored"));
  assert.ok(diff.mutations.includes("changed: tracked"));
  assert.deepEqual(after.files.get("linked"), { type: "unsafe" });
  assert.equal(after.files.has("linked/valuable"), false);
  fs.unlinkSync(path.join(f.work, "linked"));
  assert.equal(fs.readFileSync(path.join(outside, "valuable"), "utf8"), "preserve");
});

test(
  "verification Windows environment overrides are case insensitive and deadlines cannot pass",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fixture(t);
    const directory = path.join(f.root, "env-case");
    fs.mkdirSync(directory);
    const recipe = {
      executable: process.execPath,
      args: ["-e", 'if(process.env.TEMP!=="recipe-value")process.exit(7)'],
      env: { temp: "recipe-value" },
      timeoutMs: 5000,
      maxLogBytes: 128,
    };
    const result = await executeVerification(recipe, { directory, cwd: f.work, checkpoint() {} });
    assert.equal(result.state, "exited", JSON.stringify(result));
    assert.equal(result.code, 0);
    await assert.rejects(
      executeVerification(
        { ...recipe, env: { TEMP: "a", temp: "b" } },
        { directory, cwd: f.work, checkpoint() {} },
      ),
      /conflicting/,
    );
    const second = path.join(f.root, "short-timeout");
    fs.mkdirSync(second);
    const timed = await executeVerification(
      {
        ...recipe,
        args: ["-e", "const start=performance.now();while(performance.now()-start<5){}"],
        env: {},
        timeoutMs: 1,
      },
      { directory: second, cwd: f.work, checkpoint() {} },
    );
    assert.equal(timed.state, "timeout", JSON.stringify(timed));
    assert.equal(timed.settled, true);
  },
);

test("verification preserves Unicode argv and working directory", async (t) => {
  const f = fixture(t),
    directory = path.join(f.root, "verification-caf\u00e9");
  fs.mkdirSync(directory);
  const result = await executeVerification(
    {
      executable: process.execPath,
      args: [
        "-e",
        'if(process.argv[1]!=="caf\u00e9"||!process.cwd().endsWith("caf\u00e9"))process.exit(8);console.log(process.argv[1])',
        "caf\u00e9",
      ],
      env: {},
      timeoutMs: 5000,
      maxLogBytes: 1024,
    },
    { directory, cwd: directory, checkpoint() {} },
  );
  assert.equal(result.state, "exited", JSON.stringify(result));
  assert.equal(result.code, 0);
  assert.equal(result.settled, true);
  assert.equal(fs.readFileSync(result.logs.stdout.file, "utf8").trim(), "caf\u00e9");
});

test("verification cancelled before dispatch is settled without running the command", async (t) => {
  const f = fixture(t),
    controller = new AbortController();
  const directory = path.join(f.root, "pre-cancelled"),
    marker = path.join(directory, "ran");
  fs.mkdirSync(directory);
  controller.abort();
  const recipe = {
    executable: process.execPath,
    args: ["-e", 'require("fs").writeFileSync(' + JSON.stringify(marker) + ',"bad")'],
    env: {},
    timeoutMs: 5000,
    maxLogBytes: 128,
  };
  const result = await executeVerification(recipe, {
    directory,
    cwd: f.work,
    signal: controller.signal,
    checkpoint() {
      assert.fail("already cancelled");
    },
  });
  assert.equal(result.state, "cancelled");
  assert.equal(result.settled, true);
  assert.equal(fs.existsSync(marker), false);
  const second = path.join(f.root, "gate-cancelled"),
    gate = new AbortController();
  fs.mkdirSync(second);
  const afterStart = await executeVerification(recipe, {
    directory: second,
    cwd: f.work,
    signal: gate.signal,
    checkpoint() {
      gate.abort();
    },
  });
  assert.equal(afterStart.state, "cancelled", JSON.stringify(afterStart));
  assert.equal(afterStart.settled, true);
  assert.equal(fs.existsSync(marker), false);
});

test("verification bounds logs and drains descendants after the command exits or times out", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  const launched = await keptSnapshot(f);
  assert.equal(launched.code, 0, launched.stdout + launched.stderr);
  const run = f.metadata();
  assert.equal((await f.invoke(["--finalize", run.runKey])).code, 0);
  const recipe = path.join(f.root, "verify.json"),
    context = { stateBase: f.state, resultsDir: f.resultsDir };
  const command =
    'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log("child="+c.pid);process.stdout.write("x".repeat(5000));c.unref()';
  fs.writeFileSync(
    recipe,
    JSON.stringify({
      version: 1,
      executable: process.execPath,
      args: ["-e", command],
      timeoutMs: 3000,
      maxLogBytes: 128,
    }),
  );
  const args = [
    "--verify-artifact",
    run.runKey,
    "--recipe",
    recipe,
    "--execution-profile",
    "trusted-local",
  ];
  const done = await f.invoke([...args, "--attempt", "descendant"]);
  assert.equal(done.code, 0, done.stdout + "\n" + done.stderr);
  const receipt = readVerification(run.runKey, "descendant", context);
  assert.equal(receipt.execution.settled, true);
  assert.equal(receipt.execution.logs.stdout.storedBytes, 128);
  assert.equal(receipt.execution.logs.stdout.truncated, true);
  const log = fs.readFileSync(receipt.execution.logs.stdout.file, "utf8");
  const descendant = Number(/child=(\d+)/.exec(log)?.[1]);
  assert.ok(descendant > 0, log);
  assert.equal(
    posixProcessAlive(descendant),
    false,
    "ordinary descendants must be gone before exit-0",
  );
  fs.writeFileSync(
    recipe,
    JSON.stringify({
      version: 1,
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 100,
      maxLogBytes: 128,
    }),
  );
  const timed = await f.invoke([...args, "--attempt", "timeout"]);
  assert.equal(timed.code, 2, timed.stderr);
  const timeout = readVerification(run.runKey, "timeout", context);
  assert.equal(timeout.outcome, "error");
  assert.equal(timeout.execution.settled, true);
});

test("verification refuses checkout filters including mixed-case attribute paths", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  fs.writeFileSync(path.join(f.work, ".GiTaTtRiBuTeS"), "* filter=unexpected\n");
  await gitOut(["add", ".GiTaTtRiBuTeS"], f.work);
  await gitOut(
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-qm",
      "attributes",
    ],
    f.work,
  );
  const launched = await keptSnapshot(f);
  assert.equal(launched.code, 0, launched.stdout + launched.stderr);
  const run = f.metadata();
  assert.equal((await f.invoke(["--finalize", run.runKey])).code, 0);
  const recipe = path.join(f.root, "recipe.json");
  fs.writeFileSync(
    recipe,
    JSON.stringify({ version: 1, executable: process.execPath, args: ["-e", "process.exit(0)"] }),
  );
  const refused = await f.invoke([
    "--verify-artifact",
    run.runKey,
    "--attempt",
    "filters",
    "--recipe",
    recipe,
    "--execution-profile",
    "trusted-local",
  ]);
  assert.equal(refused.code, 2, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).outcome, "skipped");
  assert.match(JSON.parse(refused.stdout).error, /checkout filters/);
});

test("verification checkpoint failure never authorizes command execution", async (t) => {
  const f = fixture(t),
    directory = path.join(f.root, "verify-checkpoint"),
    marker = path.join(f.root, "should-not-exist");
  fs.mkdirSync(directory);
  const result = await executeVerification(
    {
      executable: process.execPath,
      args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'bad')"],
      env: {},
      timeoutMs: 1000,
      maxLogBytes: 128,
    },
    {
      directory,
      cwd: f.work,
      checkpoint() {
        throw new Error("durable checkpoint unavailable");
      },
    },
  );
  assert.equal(result.state, "uncertain");
  assert.equal(result.settled, false);
  assert.equal(fs.existsSync(marker), false);
});

test("verification cancellation marker failure settles through the uncertain path", async (t) => {
  const f = fixture(t),
    directory = path.join(f.root, "verify-cancel"),
    controller = new AbortController();
  fs.mkdirSync(directory);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to, ...args) => {
    if (to === path.join(directory, "cancel"))
      throw Object.assign(new Error("cancel marker unavailable"), { code: "ENOSPC" });
    return rename(from, to, ...args);
  });
  const result = await executeVerification(
    {
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      env: {},
      timeoutMs: 1000,
      maxLogBytes: 128,
    },
    {
      directory,
      cwd: f.work,
      signal: controller.signal,
      checkpoint() {
        controller.abort();
      },
    },
  );
  assert.equal(result.state, "uncertain");
  assert.equal(result.settled, false);
  assert.match(result.error, /cancel marker unavailable/);
});

test(
  "Windows completion evidence requires the supervisor authentication proof",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fixture(t),
      directory = path.join(f.root, "verify-proof");
    fs.mkdirSync(directory);
    const report = path.join(directory, "process-report.json");
    const open = fs.openSync;
    let altered = false;
    t.mock.method(fs, "openSync", (file, flags, ...args) => {
      if (file === report && flags === "r" && !altered) {
        altered = true;
        // Fault injection only: corrupt completed evidence without terminating
        // any process or executing a hostile recipe.
        fs.writeFileSync(
          report,
          JSON.stringify({
            payload: Buffer.from(
              JSON.stringify({ state: "exited", code: 0, settled: true, durationMs: 1 }),
            ).toString("base64"),
            proof: "0".repeat(64),
          }),
        );
      }
      return open(file, flags, ...args);
    });
    const result = await executeVerification(
      {
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: {},
        timeoutMs: 5000,
        maxLogBytes: 128,
      },
      { directory, cwd: f.work, checkpoint() {} },
    );
    assert.equal(altered, true, JSON.stringify(result));
    assert.equal(result.state, "uncertain");
    assert.equal(result.settled, false);
    assert.match(result.error, /completion proof is invalid/);
  },
);

test(
  "Linux unavailable supervisor identity releases IPC and never dispatches",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { default: childProcess } = await import("node:child_process");
    const { syncBuiltinESMExports } = await import("node:module");
    const f = fixture(t),
      directory = path.join(f.root, "verify-no-identity");
    fs.mkdirSync(directory);
    const spawn = childProcess.spawn,
      read = fs.readFileSync;
    let supervisor;
    t.mock.method(childProcess, "spawn", (...args) => {
      const child = spawn(...args);
      if (args[1]?.some((value) => String(value).endsWith("/posix-worker.mjs"))) supervisor = child;
      return child;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    t.mock.method(fs, "readFileSync", (file, ...args) => {
      if (supervisor && file === `/proc/${supervisor.pid}/stat`)
        throw new Error("identity lookup unavailable");
      return read(file, ...args);
    });
    const marker = path.join(directory, "ran");
    const result = await executeVerification(
      {
        executable: process.execPath,
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`],
        env: {},
        timeoutMs: 1000,
        maxLogBytes: 128,
      },
      {
        directory,
        cwd: f.work,
        checkpoint() {
          assert.fail("identity unavailable");
        },
      },
    );
    assert.equal(result.state, "uncertain");
    assert.equal(result.settled, false);
    assert.equal(supervisor.connected, false);
    assert.equal(fs.existsSync(marker), false);
    if (supervisor.exitCode === null && supervisor.signalCode === null)
      await new Promise((resolve) => supervisor.once("exit", resolve));
  },
);
