import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { gitEnvironment } from "./support/git-environment.mjs";
import {
  commitWorktree,
  createWorktree,
  removeWorktree,
  requireWorktreeSnapshot,
  workspaceGit,
} from "../src/shared/workspace.mjs";
import { recordArtifact, readArtifact } from "../src/state/artifact-store.mjs";
import { integrateArtifact } from "../src/maintenance/artifacts.mjs";
import { acquireWriterLock } from "../src/state/state.mjs";
import { RUN_RECORD_VERSION } from "../src/shared/constants.mjs";

const KEY = "a".repeat(32);
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
function git(cwd, ...args) {
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
    { cwd, encoding: "utf8", env: gitEnvironment(), windowsHide: true },
  );
  if (result.error || result.status !== 0)
    throw new Error(`fixture git ${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

function fixture(t, { sha256 = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csfcc-git-security-"));
  const base = path.join(root, "repo"),
    state = path.join(root, "state"),
    stateDir = path.join(state, KEY),
    cwd = path.join(stateDir, "worktree"),
    resultsDir = path.join(root, "results");
  for (const dir of [base, stateDir, resultsDir]) fs.mkdirSync(dir, { recursive: true });
  t.after(() => {
    const target = fs.realpathSync.native(root);
    assert.equal(
      path.dirname(target).toLowerCase(),
      fs.realpathSync.native(os.tmpdir()).toLowerCase(),
    );
    assert.ok(path.basename(target).startsWith("csfcc-git-security-"));
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  git(base, "init", "-q", "-b", "main", ...(sha256 ? ["--object-format=sha256"] : []));
  for (const [key, value] of [
    ["user.name", "fixture"],
    ["user.email", "fixture@localhost"],
    ["commit.gpgsign", "false"],
    ["core.longpaths", "true"],
  ])
    git(base, "config", key, value);
  fs.writeFileSync(path.join(base, "README.md"), "base\n");
  git(base, "add", "README.md");
  git(base, "commit", "-qm", "base");
  const run = {
    runKey: KEY,
    cwd,
    worktree: { base, branch: "csfcc/" + "a".repeat(20), startRef: "HEAD" },
  };
  return { root, base, state, stateDir, cwd, resultsDir, run };
}

async function makeArtifact(f, text = "artifact\n") {
  await createWorktree(f.run, f.cwd, {});
  fs.writeFileSync(path.join(f.cwd, "result.txt"), text);
  return seal(f, await commitWorktree(f.run, "fixture"));
}

async function seal(f, commit) {
  fs.mkdirSync(path.join(f.resultsDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(f.resultsDir, "answer.md"), "answer\n");
  f.run.sealed = true;
  f.run.jobId = "task-fixture-001";
  f.run.result = {
    commit,
    resultFile: path.join(f.resultsDir, "answer.md"),
    sha256: "b".repeat(64),
    status: "completed",
  };
  const context = { stateDir: f.stateDir, stateBase: f.state, resultsDir: f.resultsDir };
  await recordArtifact(f.run, context);
  return { context, receipt: readArtifact(KEY, context) };
}

test("runner Git disables hooks, fsmonitor and repository-configured signing", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.base, ".husky"));
  fs.writeFileSync(
    path.join(f.base, ".husky", "post-checkout"),
    "#!/bin/sh\necho bad > ../checkout-hook\n",
    { mode: 0o755 },
  );
  git(f.base, "add", ".husky/post-checkout");
  git(f.base, "commit", "-qm", "hook fixture");
  git(f.base, "config", "core.hooksPath", ".husky");
  git(f.base, "config", "core.fsmonitor", "./monitor.sh");
  git(f.base, "config", "commit.gpgsign", "true");
  git(f.base, "config", "tag.gpgsign", "true");
  git(f.base, "config", "gpg.program", "./sign.sh");
  git(f.base, "config", "merge.verifysignatures", "true");
  git(f.base, "config", "submodule.recurse", "true");
  await createWorktree(f.run, f.cwd, {});
  assert.equal(fs.existsSync(path.join(f.stateDir, "checkout-hook")), false);
  fs.writeFileSync(
    path.join(f.cwd, ".husky", "pre-commit"),
    "#!/bin/sh\necho bad > ../commit-hook\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(f.cwd, ".husky", "post-merge"),
    "#!/bin/sh\necho bad > ../merge-hook\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(f.cwd, "monitor.sh"),
    "#!/bin/sh\necho bad > ../monitor-hook\nprintf '0\\0'\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(f.cwd, "sign.sh"),
    "#!/bin/sh\necho bad > ../signing-helper\nexit 1\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(f.cwd, "result.txt"), "artifact\n");
  const commit = await commitWorktree(f.run, "fixture");
  assert.equal(fs.existsSync(path.join(f.stateDir, "commit-hook")), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "monitor-hook")), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, "signing-helper")), false);
  assert.equal(git(f.base, "config", "--bool", "commit.gpgsign"), "true");
  assert.equal(await workspaceGit(["config", "--bool", "tag.gpgsign"], f.base), "false");
  assert.equal(await workspaceGit(["config", "--bool", "merge.verifysignatures"], f.base), "false");
  assert.equal(await workspaceGit(["config", "--bool", "submodule.recurse"], f.base), "false");
  const { receipt, context } = await seal(f, commit);
  await integrateArtifact(receipt, f.base, context);
  assert.equal(fs.existsSync(path.join(f.root, "merge-hook")), false);
  assert.equal(fs.existsSync(path.join(f.root, "monitor-hook")), false);
  assert.equal(git(f.base, "config", "--bool", "merge.verifysignatures"), "true");
  assert.equal(git(f.base, "config", "--bool", "submodule.recurse"), "true");
});

test("runner diffs disable external and text-conversion helpers even when requested", async (t) => {
  const f = fixture(t);
  await createWorktree(f.run, f.cwd, {});
  git(f.base, "config", "diff.demo.command", "sh ./diff-helper.sh");
  git(f.base, "config", "diff.demo.textconv", "sh ./diff-helper.sh");
  fs.writeFileSync(path.join(f.cwd, ".gitattributes"), "README.md diff=demo\n");
  fs.writeFileSync(path.join(f.cwd, "diff-helper.sh"), "echo bad > ../diff-helper-marker\ncat\n");
  fs.writeFileSync(path.join(f.cwd, "README.md"), "modified\n");
  await workspaceGit(["diff", "--ext-diff", "HEAD", "--", "README.md"], f.cwd);
  await workspaceGit(["diff", "--textconv", "HEAD", "--", "README.md"], f.cwd);
  assert.equal(fs.existsSync(path.join(f.stateDir, "diff-helper-marker")), false);
});

test("applicable clean filters are refused before a worktree-written script runs", async (t) => {
  const f = fixture(t);
  git(f.base, "config", "filter.demo.clean", "sh ./filter.sh");
  await createWorktree(f.run, f.cwd, {});
  fs.writeFileSync(path.join(f.cwd, ".gitattributes"), "*.txt filter=demo\n");
  fs.writeFileSync(path.join(f.cwd, "filter.sh"), "echo bad > ../filter-marker\ncat\n");
  fs.writeFileSync(path.join(f.cwd, "result.txt"), "output\n");
  await assert.rejects(commitWorktree(f.run, "fixture"), /external Git filter/);
  assert.equal(fs.existsSync(path.join(f.stateDir, "filter-marker")), false);
});

test("incoming smudge filters are refused before integration changes the target", async (t) => {
  const f = fixture(t);
  await createWorktree(f.run, f.cwd, {});
  fs.writeFileSync(path.join(f.cwd, ".gitattributes"), "payload.dat filter=demo\n");
  fs.writeFileSync(path.join(f.cwd, "filter.sh"), "echo bad > ../filter-marker\ncat\n");
  fs.writeFileSync(path.join(f.cwd, "payload.dat"), "payload\n");
  const { receipt, context } = await seal(f, await commitWorktree(f.run, "fixture"));
  git(f.base, "config", "filter.demo.smudge", "sh ./filter.sh");
  const before = git(f.base, "rev-parse", "HEAD");
  await assert.rejects(integrateArtifact(receipt, f.base, context), /external Git filter/);
  assert.equal(git(f.base, "rev-parse", "HEAD"), before);
  assert.equal(fs.existsSync(path.join(f.root, "filter-marker")), false);
  assert.equal(readArtifact(KEY, context).integration, undefined);
});

test("unconfigured mixed-case attributes and unused configured filters remain usable", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.base, ".GiTaTtRiBuTeS"), "*.txt filter=unconfigured\n");
  git(f.base, "add", ".GiTaTtRiBuTeS");
  git(f.base, "commit", "-qm", "attributes");
  git(f.base, "config", "filter.other.clean", "cat");
  f.run.worktree.branch = null;
  await createWorktree(f.run, f.cwd, {});
  assert.equal(fs.existsSync(path.join(f.cwd, ".GiTaTtRiBuTeS")), true);
});

test("integration preserves ignored files that collide with incoming tracked files", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.base, ".gitignore"), "*.cache\n");
  git(f.base, "add", ".gitignore");
  git(f.base, "commit", "-qm", "ignore fixture");
  await createWorktree(f.run, f.cwd, {});
  fs.writeFileSync(path.join(f.cwd, "important.cache"), "artifact\n");
  git(f.cwd, "add", "-f", "important.cache");
  const { receipt, context } = await seal(f, await commitWorktree(f.run, "fixture"));
  fs.writeFileSync(path.join(f.base, "important.cache"), "local data\n");
  await assert.rejects(integrateArtifact(receipt, f.base, context));
  assert.equal(fs.readFileSync(path.join(f.base, "important.cache"), "utf8"), "local data\n");
});

test("snapshot and removal retain ignored files and hidden index changes", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.base, ".gitignore"), "*.cache\n");
  git(f.base, "add", ".gitignore");
  git(f.base, "commit", "-qm", "ignore fixture");
  await createWorktree(f.run, f.cwd, {});
  f.run.result = { commit: f.run.worktree.startCommit };
  fs.writeFileSync(path.join(f.cwd, "important.cache"), "local ignored data\n");
  await assert.rejects(requireWorktreeSnapshot(f.run), /changed after delivery/);
  await assert.rejects(removeWorktree(f.run, { stateDir: f.stateDir }), /changed after delivery/);
  assert.equal(
    fs.readFileSync(path.join(f.cwd, "important.cache"), "utf8"),
    "local ignored data\n",
  );
  fs.unlinkSync(path.join(f.cwd, "important.cache"));
  git(f.cwd, "update-index", "--assume-unchanged", "README.md");
  fs.writeFileSync(path.join(f.cwd, "README.md"), "hidden edit\n");
  await assert.rejects(requireWorktreeSnapshot(f.run), /assume-unchanged/);
  await assert.rejects(removeWorktree(f.run, { stateDir: f.stateDir }), /assume-unchanged/);
  assert.equal(fs.readFileSync(path.join(f.cwd, "README.md"), "utf8"), "hidden edit\n");
  git(f.cwd, "update-index", "--no-assume-unchanged", "README.md");
  fs.writeFileSync(path.join(f.cwd, "README.md"), "base\n");
  git(f.cwd, "update-index", "--skip-worktree", "README.md");
  fs.writeFileSync(path.join(f.cwd, "README.md"), "skip-worktree edit\n");
  await assert.rejects(requireWorktreeSnapshot(f.run), /skip-worktree/);
  await assert.rejects(removeWorktree(f.run, { stateDir: f.stateDir }), /skip-worktree/);
  assert.equal(fs.readFileSync(path.join(f.cwd, "README.md"), "utf8"), "skip-worktree edit\n");
});

for (const missing of ["link", "directory"]) {
  test(
    "cleanup through an aliased parent forgets only its worktree after losing the " + missing,
    async (t) => {
      const f = fixture(t);
      const alias = path.join(f.root, "state-alias");
      fs.symlinkSync(f.state, alias, process.platform === "win32" ? "junction" : "dir");
      const stateDir = path.join(alias, KEY);
      const cwd = path.join(stateDir, "worktree");
      const run = { ...f.run, cwd };
      await createWorktree(run, cwd, {});
      // The same leaf name in a different parent must never be selected.
      const stale = path.join(f.root, "unrelated", "worktree");
      git(f.base, "worktree", "add", "--detach", stale);
      fs.rmSync(stale, { recursive: true });
      if (missing === "link") fs.unlinkSync(path.join(cwd, ".git"));
      else fs.rmSync(cwd, { recursive: true });
      await removeWorktree(run, { stateDir });
      assert.equal(fs.existsSync(cwd), false);
      const entries = git(f.base, "worktree", "list", "--porcelain");
      assert.equal(entries.includes(KEY), false, "owned worktree registration removed");
      assert.ok(entries.includes("unrelated/worktree"), "unrelated stale registration retained");
      assert.equal(git(f.base, "rev-parse", run.worktree.branch), run.worktree.startCommit);
    },
  );
}

test("settled verifier-style cleanup accepts a full snapshot with sparse checkout configured", async (t) => {
  const f = fixture(t);
  git(f.base, "config", "core.sparseCheckout", "true");
  const snapshot = path.join(f.stateDir, "snapshot");
  await workspaceGit(
    [
      "-c",
      "core.sparseCheckout=false",
      "-c",
      "core.sparseCheckoutCone=false",
      "worktree",
      "add",
      "--detach",
      snapshot,
      "HEAD",
    ],
    f.base,
  );
  assert.equal(fs.readFileSync(path.join(snapshot, "README.md"), "utf8"), "base\n");
  fs.writeFileSync(path.join(snapshot, "generated.txt"), "verification output\n");
  await removeWorktree({ cwd: snapshot, worktree: { base: f.base } }, { stateDir: f.stateDir });
  assert.equal(fs.existsSync(snapshot), false);
});

test("explicit dirty-submodule detection remains enabled with recursion disabled", async (t) => {
  const f = fixture(t);
  const child = path.join(f.root, "submodule-source");
  fs.mkdirSync(child);
  git(child, "init", "-q", "-b", "main");
  git(child, "config", "user.name", "fixture");
  git(child, "config", "user.email", "fixture@localhost");
  fs.writeFileSync(path.join(child, "README.md"), "submodule base\n");
  git(child, "add", "README.md");
  git(child, "commit", "-qm", "base");
  git(f.base, "-c", "protocol.file.allow=always", "submodule", "add", child, "sub");
  git(f.base, "commit", "-qm", "add submodule");
  git(f.base, "config", "submodule.recurse", "true");
  await createWorktree(f.run, f.cwd, {});
  git(f.cwd, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
  const changed = path.join(f.cwd, "sub", "README.md");
  fs.writeFileSync(changed, "uncommitted submodule data\n");
  await assert.rejects(commitWorktree(f.run, "fixture"), /unstaged changes.*dirty submodules/);
  assert.equal(fs.readFileSync(changed, "utf8"), "uncommitted submodule data\n");
});

test("delivery refuses a switched worktree before touching the unrelated branch", async (t) => {
  const f = fixture(t);
  git(f.base, "branch", "valuable");
  const before = git(f.base, "rev-parse", "refs/heads/valuable");
  await createWorktree(f.run, f.cwd, {});
  git(f.cwd, "switch", "-q", "valuable");
  fs.writeFileSync(path.join(f.cwd, "result.txt"), "output\n");
  await assert.rejects(commitWorktree(f.run, "fixture"), /branch identity changed/);
  assert.equal(git(f.base, "rev-parse", "refs/heads/valuable"), before);
  assert.equal(fs.readFileSync(path.join(f.cwd, "result.txt"), "utf8"), "output\n");
});

test("ambiguous refs and SHA-256 repositories are refused before branch creation", async (t) => {
  const f = fixture(t);
  git(f.base, "tag", "main");
  f.run.worktree.startRef = "main";
  await assert.rejects(createWorktree(f.run, f.cwd, {}), /ambiguous worktree ref/);
  assert.equal(fs.existsSync(f.cwd), false);
  f.run.worktree.startRef = "refs/heads/main";
  await createWorktree(f.run, f.cwd, {});
  const sha = fixture(t, { sha256: true });
  await assert.rejects(
    createWorktree(sha.run, sha.cwd, {}),
    /SHA-256 repositories are unsupported/,
  );
  assert.equal(fs.existsSync(sha.cwd), false);
  assert.equal(git(sha.base, "branch", "--list", "csfcc/*"), "");
});

test("integration refuses raw divergent history even with a replacement ref", async (t) => {
  const f = fixture(t);
  await createWorktree(f.run, f.cwd, {});
  const target = git(f.base, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(f.cwd, "result.txt"), "artifact\n");
  git(f.cwd, "add", "result.txt");
  const tree = git(f.cwd, "write-tree"),
    foreign = git(f.cwd, "commit-tree", tree, "-m", "foreign");
  const original = git(f.cwd, "commit-tree", tree, "-p", foreign, "-m", "original");
  const replacement = git(f.cwd, "commit-tree", tree, "-p", target, "-m", "replacement");
  git(f.base, "replace", original, replacement);
  git(f.base, "update-ref", "refs/heads/" + f.run.worktree.branch, original);
  const { receipt, context } = await seal(f, original);
  await assert.rejects(integrateArtifact(receipt, f.base, context), /merge-base/);
  assert.equal(git(f.base, "rev-parse", "HEAD"), target);
});

test("Git grafts and existing writer locks refuse integration", async (t) => {
  const f = fixture(t);
  const { receipt, context } = await makeArtifact(f);
  fs.writeFileSync(path.join(f.base, ".git", "info", "grafts"), "# graft fixture\n");
  await assert.rejects(integrateArtifact(receipt, f.base, context), /grafts are unsupported/);
  fs.unlinkSync(path.join(f.base, ".git", "info", "grafts"));
  const owner = "b".repeat(32),
    ownerDir = path.join(f.state, owner),
    fake = path.join(f.root, "fake.exe");
  fs.mkdirSync(ownerDir);
  fs.writeFileSync(
    path.join(ownerDir, "run.json"),
    JSON.stringify({
      version: RUN_RECORD_VERSION,
      runKey: owner,
      cwd: f.base,
      codex: { path: fake, realPath: fake, version: "fake", build: "c".repeat(64) },
      driverProtocol: 1,
      jobId: null,
      write: true,
      dormant: false,
    }),
  );
  acquireWriterLock(f.state, f.base, owner);
  await assert.rejects(integrateArtifact(receipt, f.base, context), /writer lock/);
  assert.equal(git(f.base, "rev-parse", "HEAD"), receipt.base);
});

test("integration retries accept the same checkout through subdirectories and Windows casing", async (t) => {
  const f = fixture(t);
  await createWorktree(f.run, f.cwd, {});
  fs.mkdirSync(path.join(f.cwd, "nested"));
  fs.writeFileSync(path.join(f.cwd, "nested", "result.txt"), "artifact\n");
  const { receipt, context } = await seal(f, await commitWorktree(f.run, "fixture"));
  await integrateArtifact(receipt, f.base, context);
  const alias = path.join(process.platform === "win32" ? f.base.toUpperCase() : f.base, "nested");
  assert.equal((await integrateArtifact(receipt, alias, context)).integration.status, "integrated");
});
