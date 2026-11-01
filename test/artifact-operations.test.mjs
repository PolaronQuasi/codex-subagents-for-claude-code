import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import { gitInit, gitOut } from "./support/git-repos.mjs";
import { readArtifact } from "../src/state/artifact-store.mjs";

async function launchAndCollect(f, args) {
  let result = await f.invoke(args);
  if (result.code === 3) {
    const [key] = f.runs();
    assert.ok(key, "a pending launch retains its run for collection");
    result = await f.invoke(["--run", key, "--wait-ms", "30000"]);
  }
  if (result.code !== 0 && f.runs().length) {
    const run = f.metadata();
    const dir = path.join(f.state, run.runKey, "jobs", run.jobId ?? "");
    for (const name of ["turn.json", "driver.log"])
      if (fs.existsSync(path.join(dir, name)))
        result.stderr += `\n${name}: ${fs.readFileSync(path.join(dir, name), "utf8")}`;
  }
  return result;
}

test("sealed artifacts survive close, integrate exactly once and retire recoverably", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "result.txt" });
  await gitInit(f.work);
  // The prompt input is caller-owned and outside the target checkout's index.
  await gitOut(["add", "prompt.md"], f.work);
  await gitOut(
    ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "input"],
    f.work,
  );
  const launch = await launchAndCollect(f, [
    ...LAUNCH.slice(0, -2),
    "--wait-ms",
    "10000",
    "--keep-state",
    "--keep-prompt",
    "--worktree",
    "--write",
    "--commit-subject",
    "Implement the requested result",
  ]);
  assert.equal(launch.code, 0, launch.stderr);
  const run = f.metadata();
  assert.match(run.worktree.branch, /^csfcc\/[a-f0-9]{20}$/);
  assert.match(
    await gitOut(["log", "-1", "--format=%B"], run.cwd),
    /^Implement the requested result\n\nCodex-Run: /,
  );
  const context = { stateBase: f.state, resultsDir: f.resultsDir };
  assert.equal(readArtifact(run.runKey, context).sealed, false);
  assert.equal((await f.invoke(["--integrate", run.runKey, "--target", f.work])).code, 1);
  const seal = await f.invoke(["--finalize", run.runKey]);
  assert.equal(seal.code, 0, seal.stderr);
  const follow = await f.invoke(["--continue", run.runKey, "--prompt-file", "prompt.md"]);
  assert.equal(follow.code, 1);
  assert.match(follow.stderr, /finalized/);
  const early = await f.invoke(["--discard", run.runKey]);
  assert.equal(early.code, 1);
  assert.match(early.stderr, /checked out/);
  const closed = await f.invoke(["--close", run.runKey]);
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(f.runs().length, 0);
  assert.equal(readArtifact(run.runKey, context).sealed, true);
  const integrated = await f.invoke(["--integrate", run.runKey, "--target", f.work]);
  assert.equal(integrated.code, 0, integrated.stderr);
  assert.equal(await gitOut(["rev-parse", "HEAD"], f.work), run.result.commit);
  const replay = await f.invoke(["--integrate", run.runKey, "--target", f.work]);
  assert.equal(replay.code, 0, replay.stderr);
  const retired = await f.invoke(["--discard", run.runKey]);
  assert.equal(retired.code, 0, retired.stderr);
  const receipt = readArtifact(run.runKey, context);
  assert.equal(await gitOut(["rev-parse", receipt.retired.ref], f.work), run.result.commit);
  assert.equal(
    await gitOut(
      ["for-each-ref", "--format=%(refname)", "refs/heads/" + run.worktree.branch],
      f.work,
    ),
    "",
  );
});

test("automatic cleanup seals a result; moved branch and dirty targets refuse integration", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "result.txt" });
  await gitInit(f.work);
  const launch = await launchAndCollect(f, [
    ...LAUNCH.slice(0, -2),
    "--wait-ms",
    "10000",
    "--worktree",
    "--write",
  ]);
  assert.equal(launch.code, 0, launch.stderr);
  assert.equal(f.runs().length, 0);
  const dir = path.join(f.resultsDir, "artifacts"),
    key = fs
      .readdirSync(dir)
      .find((n) => n.endsWith(".json"))
      .slice(0, -5);
  const receipt = readArtifact(key, { stateBase: f.state, resultsDir: f.resultsDir });
  assert.equal(receipt.sealed, true);
  fs.writeFileSync(path.join(f.work, "dirty.txt"), "keep me");
  const dirty = await f.invoke(["--integrate", key, "--target", f.work]);
  assert.equal(dirty.code, 1);
  assert.match(dirty.stderr, /dirty/);
  fs.unlinkSync(path.join(f.work, "dirty.txt"));
  await gitOut(
    ["update-ref", "refs/heads/" + receipt.branch, receipt.base, receipt.commit],
    f.work,
  );
  const moved = await f.invoke(["--integrate", key, "--target", f.work]);
  assert.equal(moved.code, 1);
  assert.match(moved.stderr, /moved/);
});
