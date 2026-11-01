import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { delivered } from "./support/capture.mjs";
import { SCRIPT } from "./support/cli-adapter.mjs";
import { fixture, LAUNCH } from "./support/runner-fixture.mjs";
import { acquireWriterLock, holdGuard } from "../src/state/state.mjs";
import { workspaceId } from "../src/shared/workspace.mjs";
import { requireDurableDestination } from "../src/delivery/result-path.mjs";
import { ERRNO, EXIT } from "../src/shared/errors.mjs";

test("an aged live publication guard still excludes competing workspace writers", async (t) => {
  const f = fixture(t, { status: "running" });
  acquireWriterLock(f.state, f.work, "d".repeat(32));
  const lock = path.join(f.state, "writers", `${workspaceId(f.work)}.lock`);
  const ownerFile = path.join(lock, "owner.json");
  const open = fs.openSync;
  const close = fs.closeSync;
  let ownerFd;
  let armed = true;
  let competing;
  t.mock.method(fs, "openSync", function (file, ...args) {
    const fd = open.call(this, file, ...args);
    if (file === ownerFile && armed) ownerFd = fd;
    return fd;
  });
  t.mock.method(fs, "closeSync", function (fd) {
    const result = close.call(this, fd);
    if (fd === ownerFd && armed) {
      armed = false;
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(`${lock}.recovery`, old, old);
      competing = spawnSync(process.execPath, [SCRIPT, ...LAUNCH, "--write", "--keep-prompt"], {
        cwd: f.work,
        env: f.env,
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      });
    }
    return result;
  });
  const publisher = await f.invoke([...LAUNCH, "--write", "--keep-prompt"]);
  t.mock.restoreAll();
  assert.equal(competing.status, EXIT.FAILURE, competing.stderr);
  assert.match(competing.stderr, /being changed by another process/);
  assert.equal(publisher.code, EXIT.STILL_RUNNING, publisher.stderr);
  const next = await f.invoke([...LAUNCH, "--write", "--keep-prompt"]);
  assert.equal(next.code, EXIT.FAILURE, next.stderr);
  assert.equal(f.events().filter((event) => event.command === "task").length, 1);
  assert.equal(f.runs().length, 1);
});

test("publication guard release cannot remove a replacement owner's guard", (t) => {
  const f = fixture(t);
  const guard = path.join(f.state, "publication-guard");
  const release = holdGuard(guard, "busy");
  const ownerFile = path.join(guard, "owner.json");
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, token: "replacement" }));
  assert.throws(release, /ownership changed/);
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, "utf8")).token, "replacement");
});

test("job replay verifies saved job and run identities despite request-ID substrings", async (t) => {
  const f = fixture(t, { result: "FIRST JOB RESULT\n" });
  const first = await f.invoke([...LAUNCH, "--keep-prompt"]);
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  const original = delivered(first.stdout).footer;
  f.configure({ result: "SECOND JOB RESULT\n" });
  const second = await f.invoke([
    ...LAUNCH,
    "--keep-prompt",
    "--request-id",
    `trace-${original.job}-rq-followup`,
  ]);
  assert.equal(second.code, EXIT.COMPLETED, second.stderr);
  const replay = await f.invoke(["--attach", original.job, "--run", original.run]);
  assert.equal(replay.code, EXIT.COMPLETED, replay.stderr);
  const observed = delivered(replay.stdout);
  assert.equal(observed.footer.job, original.job);
  assert.equal(observed.footer.run, original.run);
  assert.match(observed.body, /FIRST JOB RESULT/);
  assert.doesNotMatch(observed.body, /SECOND JOB RESULT/);
  const mismatched = await f.invoke(["--attach", original.job, "--run", "e".repeat(32)]);
  assert.equal(mismatched.code, EXIT.FAILURE, mismatched.stderr);
  assert.doesNotMatch(mismatched.stdout, /FIRST JOB RESULT/);
});

test("replay reports the current path after moving the results directory", async (t) => {
  const f = fixture(t);
  const first = await f.invoke([...LAUNCH, "--keep-prompt", "--request-id", "move-results"]);
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  const original = delivered(first.stdout).footer;
  const moved = path.join(f.root, "relocated-results");
  fs.renameSync(f.resultsDir, moved);
  let outcome;
  const replay = await f.invoke(["--run", "rq:move-results", "--max-stdout-lines", "1"], {
    env: { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: moved },
    onOutcome: (value) => {
      outcome = value;
    },
  });
  assert.equal(replay.code, EXIT.COMPLETED, replay.stderr);
  const actual = path.join(moved, path.basename(original.file));
  assert.equal(delivered(replay.stdout).footer.file, actual);
  assert.equal(outcome.resultFile, actual);
  assert.equal(fs.existsSync(actual), true);
});

for (const alias of [false, true]) {
  test(`a result destination inside run state${alias ? " through a directory link" : ""} retains the complete answer`, async (t) => {
    const answer = Array.from({ length: 30 }, (_, i) => `Important result line ${i + 1}\n`).join(
      "",
    );
    const f = fixture(t, { status: "running", result: answer });
    assert.equal((await f.invoke([...LAUNCH, "--keep-prompt"])).code, EXIT.STILL_RUNNING);
    const key = f.runs()[0];
    const dir = path.join(f.state, key);
    let nested = path.join(dir, "saved-results");
    if (alias) {
      const link = path.join(f.root, "state-alias");
      fs.symlinkSync(dir, link, process.platform === "win32" ? "junction" : "dir");
      nested = path.join(link, "saved-results");
    }
    f.configure({ status: "completed" });
    const finished = await f.invoke(["--run", key, "--max-stdout-lines", "1"], {
      env: { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: nested },
    });
    assert.equal(finished.code, EXIT.COMPLETED, finished.stderr);
    const observed = delivered(finished.stdout);
    assert.equal(observed.footer.keep, "yes");
    assert.equal(observed.footer.omitted, 0);
    assert.equal(observed.body, answer);
    assert.equal(fs.existsSync(path.join(dir, "run.json")), true);
    assert.match(finished.stderr, /inside.*cleanup/);
    const recovered = await f.invoke(["--run", key, "--max-stdout-lines", "1"]);
    assert.equal(recovered.code, EXIT.COMPLETED, recovered.stderr);
    const copy = delivered(recovered.stdout).footer.file;
    assert.equal(fs.existsSync(copy), true);
    assert.equal(fs.existsSync(path.join(dir, "run.json")), false);
  });
}

test("cleanup refuses a misplaced result inside state and a corrected destination rescues it", async (t) => {
  const f = fixture(t);
  const first = await f.invoke([...LAUNCH, "--keep-state"]);
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  const key = f.runs()[0];
  const run = f.metadata(key);
  const inside = path.join(f.state, key, "misplaced-result.md");
  fs.renameSync(run.result.resultFile, inside);
  run.result.resultFile = inside;
  fs.writeFileSync(path.join(f.state, key, "run.json"), JSON.stringify(run));
  const closed = await f.invoke(["--close", key]);
  assert.equal(closed.code, EXIT.FAILURE, closed.stderr);
  assert.match(
    closed.stderr,
    /lies inside .*, which closing removes; move that file out of it first/,
  );
  assert.equal(fs.existsSync(inside), true);
  const replay = await f.invoke(["--run", key]);
  assert.equal(replay.code, EXIT.COMPLETED, replay.stderr);
  const rescued = delivered(replay.stdout).footer.file;
  assert.equal(path.dirname(rescued), f.resultsDir);
  assert.equal((await f.invoke(["--close", key])).code, EXIT.COMPLETED);
  assert.equal(fs.existsSync(rescued), true);
});

test("delivery requiring a durable copy refuses a cleanup destination before stdout", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke(LAUNCH)).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  f.configure({ status: "completed" });
  const delivery = await f.invoke(["--run", key], {
    requireDurableCopy: true,
    env: {
      ...f.env,
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: path.join(f.state, key, "results"),
    },
  });
  assert.equal(delivery.code, EXIT.FAILURE, delivery.stderr);
  assert.equal(delivery.stdout, "");
  assert.equal(f.metadata(key).result.acknowledgedAt, undefined);
  assert.equal(f.metadata(key).result.durableSavedAt, undefined);
});

test("durable paths must also survive disposable workspaces and links that enter and leave state", (t) => {
  const f = fixture(t);
  const file = path.join(f.work, "result.md");
  assert.doesNotThrow(() => requireDurableDestination(file, { cwd: f.work }, f.state));
  assert.throws(
    () => requireDurableDestination(file, { cwd: f.work, worktree: {} }, f.state),
    /inside a cleanup tree/,
  );
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const outside = path.join(f.root, "outside-results");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.state, "out"), linkType);
  const alias = path.join(f.root, "state-alias");
  fs.symlinkSync(f.state, alias, linkType);
  assert.throws(
    () => requireDurableDestination(path.join(alias, "out", "result.md"), {}, f.state),
    /inside a cleanup tree/,
  );
  assert.doesNotThrow(() =>
    requireDurableDestination(path.join(outside, "result.md"), {}, f.state),
  );
  const indirect = path.join(f.root, "indirect-alias");
  fs.symlinkSync(path.join(f.state, "out"), indirect, linkType);
  assert.throws(
    () => requireDurableDestination(path.join(indirect, "result.md"), {}, f.state),
    /inside a cleanup tree/,
  );
});

test("cleanup protects an older turn's result reached through a file symlink", async (t) => {
  const f = fixture(t);
  const first = await f.invoke([...LAUNCH, "--keep-state"]);
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  const key = f.runs()[0];
  const run = f.metadata(key);
  const inside = path.join(f.state, key, "older-turn.md");
  fs.copyFileSync(run.result.resultFile, inside);
  const alias = path.join(f.root, "older-result.md");
  try {
    fs.symlinkSync(inside, alias, "file");
  } catch (error) {
    if (process.platform === "win32" && [ERRNO.EPERM, ERRNO.EACCES].includes(error.code)) {
      t.skip("file symlinks require Windows privileges");
      return;
    }
    throw error;
  }
  run.turns = [
    {
      jobId: f.metadata().jobId,
      model: run.model ?? null,
      effort: run.effort ?? null,
      write: Boolean(run.write),
      result: { ...run.result, resultFile: alias },
    },
  ];
  fs.writeFileSync(path.join(f.state, key, "run.json"), JSON.stringify(run));
  const closed = await f.invoke(["--close", key]);
  assert.equal(closed.code, EXIT.FAILURE, closed.stderr);
  assert.match(
    closed.stderr,
    /lies inside .*, which closing removes; move that file out of it first/,
  );
  assert.equal(fs.existsSync(inside), true);
  assert.equal(fs.existsSync(alias), true);
  assert.deepEqual(f.runs(), [key]);
});
