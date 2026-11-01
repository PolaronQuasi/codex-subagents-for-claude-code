import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { workspace } from "./support/workspace-fixture.mjs";
import { gitEnvironment } from "./support/git-environment.mjs";
import { closeRun, teardown } from "../src/run/lifecycle.mjs";
import { createWorktree, commitWorktree } from "../src/shared/workspace.mjs";
import { digest } from "../src/shared/io.mjs";
import { artifactFile, readArtifact, recordArtifact } from "../src/state/artifact-store.mjs";
import {
  finalizeArtifact,
  integrateArtifact,
  retireArtifact,
} from "../src/maintenance/artifacts.mjs";

const KEY = "a".repeat(32);
function git(cwd, ...args) {
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const result = spawnSync(
    bash,
    [
      "--noprofile",
      "--norc",
      "-c",
      'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR\nexec git "$@"',
      "git",
      ...args,
    ],
    { cwd, encoding: "utf8", windowsHide: true, env: gitEnvironment() },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// Real disposable Git artifacts, without a Codex thread or any driver process.
async function deliveredArtifact(t) {
  const f = workspace(t),
    stateDir = path.join(f.state, KEY);
  fs.mkdirSync(stateDir);
  fs.mkdirSync(path.join(f.resultsDir, "artifacts"));
  git(f.work, "init", "-q", "-b", "main");
  git(f.work, "config", "user.name", "fixture");
  git(f.work, "config", "user.email", "fixture@localhost");
  fs.writeFileSync(path.join(f.work, "base.txt"), "base\n");
  git(f.work, "add", "base.txt");
  git(f.work, "commit", "-qm", "base");
  const run = {
    runKey: KEY,
    cwd: path.join(stateDir, "worktree"),
    write: true,
    dormant: true,
    worktree: { base: f.work, branch: "csfcc/" + KEY.slice(0, 20), startRef: "HEAD" },
  };
  await createWorktree(run, run.cwd, {});
  fs.writeFileSync(path.join(run.cwd, "result.txt"), "delivered\n");
  const resultFile = path.join(f.resultsDir, "answer.md");
  fs.writeFileSync(resultFile, "answer\n");
  run.result = {
    commit: await commitWorktree(run, "fixture"),
    status: "completed",
    resultFile,
    sha256: digest("answer\n"),
    durableSavedAt: new Date().toISOString(),
    finalizedAt: new Date().toISOString(),
  };
  const context = {
    stateBase: f.state,
    stateDir,
    resultsDir: f.resultsDir,
    save: () => fs.writeFileSync(path.join(stateDir, "run.json"), JSON.stringify(run)),
    warn: async () => {},
    processes: new Proxy({}, { get: () => assert.fail("fixture has no owned processes") }),
  };
  context.save();
  await recordArtifact(run, context);
  assert.equal(readArtifact(KEY, context).sealed, false);
  return { ...f, run, context };
}

for (const removedBy of ["git", "filesystem"]) {
  test(`close seals an artifact after its checkout was removed by ${removedBy}`, async (t) => {
    const f = await deliveredArtifact(t);
    if (removedBy === "git") git(f.work, "worktree", "remove", f.run.cwd);
    else {
      assert.equal(path.dirname(path.resolve(f.run.cwd)), path.resolve(f.context.stateDir));
      assert.equal(fs.lstatSync(f.run.cwd).isSymbolicLink(), false);
      fs.rmSync(f.run.cwd, { recursive: true });
    }
    await closeRun({}, f.run, f.context);
    assert.equal(fs.existsSync(f.context.stateDir), false);
    const receipt = await finalizeArtifact(KEY, f.context);
    assert.equal(receipt.sealed, true);
    assert.equal(receipt.commit, f.run.result.commit);
    assert.equal(git(f.work, "worktree", "list", "--porcelain").includes(KEY), false);
    await integrateArtifact(receipt, f.work, f.context);
    assert.equal(git(f.work, "rev-parse", "HEAD"), receipt.commit);
    const retired = await retireArtifact(receipt, f.context);
    assert.equal(git(f.work, "rev-parse", retired.retired.ref), receipt.commit);
  });
}

test("missing-checkout close retains state when its artifact branch moved", async (t) => {
  const f = await deliveredArtifact(t);
  git(f.work, "worktree", "remove", f.run.cwd);
  git(f.work, "update-ref", "refs/heads/" + f.run.worktree.branch, f.run.worktree.startCommit);
  await assert.rejects(
    closeRun({}, f.run, f.context),
    /branch does not point at the delivered commit/,
  );
  assert.equal(fs.existsSync(f.context.stateDir), true);
  assert.equal(readArtifact(KEY, f.context).sealed, false);
  assert.equal(git(f.work, "rev-parse", f.run.worktree.branch), f.run.worktree.startCommit);
});

test("missing-checkout close retains state until its sealed receipt is durably published", async (t) => {
  const f = await deliveredArtifact(t);
  git(f.work, "worktree", "remove", f.run.cwd);
  const rename = fs.renameSync,
    file = artifactFile(f.resultsDir, KEY);
  const failure = t.mock.method(fs, "renameSync", (from, to, ...args) => {
    if (to === file) throw Object.assign(new Error("receipt publication failed"), { code: "EIO" });
    return rename(from, to, ...args);
  });
  await assert.rejects(closeRun({}, f.run, f.context), /receipt publication failed/);
  assert.equal(fs.existsSync(f.context.stateDir), true);
  assert.equal(readArtifact(KEY, f.context).sealed, false);
  failure.mock.restore();
  await closeRun({}, f.run, f.context);
  assert.equal(fs.existsSync(f.context.stateDir), false);
  assert.equal((await finalizeArtifact(KEY, f.context)).sealed, true);
});

test("cleanup of a worktree that never resolved a commit needs no repository", async (t) => {
  const f = workspace(t),
    stateDir = path.join(f.state, KEY);
  fs.mkdirSync(stateDir);
  await teardown(
    {
      runKey: KEY,
      cwd: path.join(stateDir, "worktree"),
      worktree: { base: f.work, startRef: "HEAD" },
    },
    { stateBase: f.state, stateDir, warn: async () => {} },
  );
  assert.equal(fs.existsSync(stateDir), false);
});
