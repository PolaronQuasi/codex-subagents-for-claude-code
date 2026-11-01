import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  applyDirectives,
  parseArgs,
  parseTaskFile,
  codexEnvironment,
  runProcess,
  acquireWriterLock,
  releaseWriterLock,
  workspaceId,
} from "../src/index.mjs";

import { delivered, sha256 } from "./support/capture.mjs";
import { gitOut, gitInit, prototypeBranch } from "./support/git-repos.mjs";
import { initRepository } from "./support/git-environment.mjs";
import { KEY, LAUNCH, ORIGINAL, fixture } from "./support/runner-fixture.mjs";
import { EXIT } from "../src/shared/errors.mjs";

// A scratch clone's nested folders, deeper than Windows' MAX_PATH (260).
function deepPath(folder) {
  let deep = path.join(folder, "scratch-clone");
  while (deep.length < 300) deep = path.join(deep, "nested-scratch-folder");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "deep.txt"), "deep\n");
  return path.join(deep, "deep.txt");
}

test(
  "a worktree holding a path longer than MAX_PATH closes with repository longpaths disabled",
  {
    skip: process.platform !== "win32" && "MAX_PATH is Windows' limit",
  },
  async (t) => {
    const f = fixture(t, { touchWorkspaceFile: "wt.txt", status: "running" });
    await gitInit(f.work);
    // The runner overrides this setting for its own Git processes only.
    await gitOut(["config", "core.longpaths", "false"], f.work);
    assert.equal(
      (await f.invoke([...LAUNCH, "--write", "--worktree", "--keep-state"])).code,
      EXIT.STILL_RUNNING,
    );
    const run = f.metadata();
    assert.ok(deepPath(run.cwd).length > 260);
    f.configure({ status: "completed" });
    const delivered = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
    assert.equal(delivered.code, EXIT.COMPLETED, delivered.stderr);
    const closed = await f.invoke(["--close", run.runKey]);
    assert.equal(closed.code, EXIT.COMPLETED, closed.stderr);
    assert.deepEqual(f.runs(), []);
    assert.equal(fs.existsSync(run.cwd), false);
    assert.equal((await gitOut(["worktree", "list"], f.work)).split("\n").length, 1);
    assert.equal(await gitOut(["show", `${run.worktree.branch}:wt.txt`], f.work), "fixture edit");
  },
);

test(
  "a Windows write worktree in a long repository commits and closes without changing Git settings",
  {
    skip: process.platform !== "win32" && "Windows long branch-ref paths",
  },
  async (t) => {
    const f = fixture(t, { touchWorkspaceFile: "shell-written.txt" });
    let repo = f.work;
    while (repo.length < 200) repo = path.join(repo, "long-repository-parent");
    fs.mkdirSync(repo, { recursive: true });
    fs.copyFileSync(path.join(f.work, "prompt.md"), path.join(repo, "prompt.md"));
    await gitInit(repo);
    await gitOut(["config", "core.longpaths", "false"], repo);
    const launched = await f.invoke([
      ...LAUNCH,
      "--cwd",
      repo,
      "--write",
      "--worktree",
      "--keep-state",
    ]);
    assert.equal(launched.code, EXIT.COMPLETED, launched.stderr);
    const run = f.metadata();
    assert.ok(path.join(repo, ".git", "refs", "heads", run.worktree.branch).length > 260);
    assert.notEqual(run.result.commit, run.worktree.startCommit);
    assert.equal(await gitOut(["config", "--get", "core.longpaths"], repo), "false");
    const closed = await f.invoke(["--close", run.runKey]);
    assert.equal(closed.code, EXIT.COMPLETED, closed.stderr);
    assert.equal(fs.existsSync(run.cwd), false);
    assert.equal(
      await gitOut(
        ["-c", "core.longpaths=true", "show", `${run.worktree.branch}:shell-written.txt`],
        repo,
      ),
      "fixture edit",
    );
    assert.equal((await gitOut(["worktree", "list"], repo)).split("\n").length, 1);
    assert.equal(await gitOut(["config", "--get", "core.longpaths"], repo), "false");
  },
);

test("closing a worktree run removes a junction the job left in it as a link, never through it", async (t) => {
  const f = fixture(t, { status: "running" });
  await gitInit(f.work);
  assert.equal(
    (await f.invoke([...LAUNCH, "--write", "--worktree", "--keep-state"])).code,
    EXIT.STILL_RUNNING,
  );
  const run = f.metadata();
  // A disposable stand-in for the user's repository, outside the worktree,
  // and a junction to it one folder down, as `mklink /J` would leave it.
  const outside = path.join(f.root, "user-repository");
  fs.mkdirSync(path.join(outside, "nested"), { recursive: true });
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep\n");
  fs.writeFileSync(path.join(outside, "nested", "keep.txt"), "nested\n");
  fs.mkdirSync(path.join(run.cwd, "deeper"));
  fs.symlinkSync(
    outside,
    path.join(run.cwd, "deeper", "junction"),
    process.platform === "win32" ? "junction" : "dir",
  );
  f.configure({ status: "completed" });
  const delivered = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
  assert.equal(delivered.code, EXIT.COMPLETED, delivered.stderr);
  const closed = await f.invoke(["--close", run.runKey]);
  assert.equal(closed.code, EXIT.COMPLETED, closed.stderr);
  assert.equal(fs.existsSync(run.cwd), false);
  assert.deepEqual(f.runs(), []);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep\n");
  assert.equal(fs.readFileSync(path.join(outside, "nested", "keep.txt"), "utf8"), "nested\n");
  assert.equal((await gitOut(["worktree", "list"], f.work)).split("\n").length, 1);
});

test("a worktree whose .git link is gone is retained without --force, removed with it, and git forgets only that worktree", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  assert.equal(
    (await f.invoke([...LAUNCH, "--write", "--worktree", "--keep-state"])).code,
    EXIT.COMPLETED,
  );
  const run = f.metadata();
  // What a removal that failed part-way leaves: files, no .git link, and the
  // worktree still listed. Another worktree's stale entry stays git's own.
  fs.writeFileSync(path.join(run.cwd, "left.txt"), "left behind\n");
  if (process.platform === "win32") deepPath(run.cwd);
  fs.rmSync(path.join(run.cwd, ".git"));
  const stale = path.join(f.root, "stale-worktree");
  await gitOut(["worktree", "add", "--detach", stale], f.work);
  fs.rmSync(stale, { recursive: true, force: true });
  // A git command in the unlinked folder would find this enclosing repository.
  initRepository(f.state);
  const refused = await f.invoke(["--close", run.runKey]);
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(refused.stderr, /lost its \.git link.*--close \S+ --force/s);
  assert.equal(fs.readFileSync(path.join(run.cwd, "left.txt"), "utf8"), "left behind\n");
  assert.deepEqual(f.runs(), [run.runKey]);
  const closed = await f.invoke(["--close", run.runKey, "--force"]);
  assert.equal(closed.code, EXIT.COMPLETED, closed.stderr);
  assert.equal(fs.existsSync(path.join(f.state, run.runKey)), false);
  const listing = await gitOut(["worktree", "list", "--porcelain"], f.work);
  assert.equal(listing.includes(run.runKey), false, "the run's worktree is forgotten");
  assert.ok(listing.includes("stale-worktree"), "another stale worktree is not pruned");
  assert.match(await gitOut(["branch", "--list", run.worktree.branch], f.work), /csfcc\//);
  // Nothing was ever committed into the enclosing repository.
  await assert.rejects(gitOut(["rev-parse", "--verify", "HEAD"], f.state));
});

test("staging an edit restored to HEAD delivers the unchanged commit", async (t) => {
  const f = fixture(t, { status: "running" });
  await gitInit(f.work);
  const launched = await f.invoke([...LAUNCH, "--worktree", "--write", "--keep-state"]);
  assert.equal(launched.code, EXIT.STILL_RUNNING, launched.stderr);
  const run = f.metadata();
  const file = path.join(run.cwd, "README.md");
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, "temporary edit\n");
  await gitOut(["add", "README.md"], run.cwd);
  fs.writeFileSync(file, original);
  assert.equal(await gitOut(["status", "--porcelain"], run.cwd), "MM README.md");
  f.configure({ status: "completed" });
  const result = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  assert.equal(delivered(result.stdout).footer.commit, run.worktree.startCommit);
  assert.equal(await gitOut(["status", "--porcelain"], run.cwd), "");
  assert.equal(await gitOut(["rev-list", "--count", "HEAD"], run.cwd), "1");
});

for (const ordinaryEdit of [false, true]) {
  test(`dirty submodule content is retained (ordinary edit: ${ordinaryEdit})`, async (t) => {
    const f = fixture(t, { status: "running" });
    await gitInit(f.work);
    await gitInit(f.other);
    await gitOut(["-c", "protocol.file.allow=always", "submodule", "add", f.other, "sub"], f.work);
    await gitOut(
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@localhost",
        "commit",
        "-qm",
        "submodule",
      ],
      f.work,
    );
    assert.equal(
      (await f.invoke([...LAUNCH, "--worktree", "--write", "--keep-state"])).code,
      EXIT.STILL_RUNNING,
    );
    const run = f.metadata();
    await gitOut(["-c", "protocol.file.allow=always", "submodule", "update", "--init"], run.cwd);
    const subfile = path.join(run.cwd, "sub", "README.md");
    fs.writeFileSync(subfile, "uncommitted submodule work\n");
    if (ordinaryEdit) fs.writeFileSync(path.join(run.cwd, "README.md"), "ordinary edit\n");
    f.configure({ status: "completed" });
    const result = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
    assert.equal(result.code, EXIT.FAILURE, result.stderr);
    assert.match(result.stderr, /dirty submodules.*state retained/);
    assert.equal(result.stdout, "");
    assert.deepEqual(f.runs(), [run.runKey]);
    assert.equal(fs.readFileSync(subfile, "utf8"), "uncommitted submodule work\n");
    assert.equal(await gitOut(["rev-parse", "HEAD"], run.cwd), run.worktree.startCommit);
  });
}

for (const preexisting of [false, true]) {
  test(`uncertain branch creation preserves an existing ref (preexisting=${preexisting})`, async (t) => {
    const f = fixture(t);
    await gitInit(f.work);
    const branch = `codex-subagents-for-claude-code/${KEY}`;
    if (preexisting) await gitOut(["branch", branch, "HEAD"], f.work);
    // Only this copied module sees the lost-response injection. Git itself
    // creates a real disposable branch before its response is discarded.
    const runtime = path.join(f.root, "runtime");
    fs.mkdirSync(runtime);
    fs.copyFileSync(
      new URL("../src/shared/workspace.mjs", import.meta.url),
      path.join(runtime, "workspace.mjs"),
    );
    for (const name of ["constants.mjs", "errors.mjs", "commit-message.mjs", "git-security.mjs"])
      fs.writeFileSync(
        path.join(runtime, name),
        `export * from ${JSON.stringify(new URL(`../src/shared/${name}`, import.meta.url).href)};`,
      );
    const io = JSON.stringify(new URL("../src/shared/io.mjs", import.meta.url).href);
    fs.writeFileSync(
      path.join(runtime, "io.mjs"),
      `
export * from ${io};
import { runProcess as original } from ${io};
export async function runProcess(command, args, options) {
  const result = await original(command, args, options);
  return command === "git" && args.includes("branch") && result.status === 0
    ? { ...result, error: new Error("injected lost branch response") } : result;
}`,
    );
    const { createWorktree } = await import(
      pathToFileURL(path.join(runtime, "workspace.mjs")).href
    );
    const run = { worktree: { base: f.work, branch, startRef: "HEAD" } };
    const workspace = path.join(f.root, "not-created");
    await assert.rejects(
      createWorktree(run, workspace, {}),
      (error) =>
        error.worktreeRecoveryRequired === true &&
        /branch creation was not confirmed/.test(error.message),
    );
    assert.equal(await gitOut(["rev-parse", branch], f.work), run.worktree.startCommit);
    assert.equal(fs.existsSync(workspace), false);
    assert.equal((await gitOut(["worktree", "list"], f.work)).split("\n").length, 1);
  });
}

// Inject a lost response after the worktree was actually registered. This
// exercises rollback without relying on a repository hook being executed.
for (const kind of ["pristine-write", "pristine-read", "dirty", "advanced", "locked"]) {
  test("registered worktree rollback preserves uncertain " + kind + " state", async (t) => {
    const f = fixture(t);
    await gitInit(f.work);
    const runtime = path.join(f.root, "rollback-runtime");
    const workspace = path.join(f.root, "rollback-worktree");
    fs.mkdirSync(runtime);
    fs.copyFileSync(
      new URL("../src/shared/workspace.mjs", import.meta.url),
      path.join(runtime, "workspace.mjs"),
    );
    for (const name of ["constants.mjs", "errors.mjs", "commit-message.mjs", "git-security.mjs"])
      fs.writeFileSync(
        path.join(runtime, name),
        "export * from " +
          JSON.stringify(new URL("../src/shared/" + name, import.meta.url).href) +
          ";",
      );
    const io = JSON.stringify(new URL("../src/shared/io.mjs", import.meta.url).href);
    const source = [
      "export * from " + io + ";",
      "import { runProcess as original } from " + io + ";",
      'import fs from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      "const workspace = " + JSON.stringify(workspace) + ";",
      "const base = " + JSON.stringify(f.work) + ";",
      "const kind = " + JSON.stringify(kind) + ";",
      "export async function runProcess(command, args, options) {",
      "  const result = await original(command, args, options);",
      '  if (command === "git" && args.includes("worktree") && args.includes("add") && result.status === 0) {',
      '    if (kind === "dirty") fs.writeFileSync(workspace + "/recovery.txt", "preserve me");',
      '    if (kind === "advanced" || kind === "locked") {',
      '      const argv = kind === "advanced" ? ["-C", workspace, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "-qm", "intervening"] : ["-C", base, "worktree", "lock", workspace];',
      '      const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";',
      '      const result = spawnSync(bash, ["--noprofile", "--norc", "-c", ' +
        JSON.stringify('unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR\nexec git "$@"') +
        ', "git", ...argv], {cwd: base, env: options.env, encoding: "utf8", windowsHide: true});',
      "      if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);",
      "    }",
      '    return { ...result, error: new Error("injected lost worktree-add response") };',
      "  }",
      "  return result;",
      "}",
    ].join("\n");
    fs.writeFileSync(path.join(runtime, "io.mjs"), source);
    const { createWorktree } = await import(
      pathToFileURL(path.join(runtime, "workspace.mjs")).href
    );
    const branch = kind === "pristine-read" ? null : "csfcc/" + KEY.slice(0, 20);
    const run = { worktree: { base: f.work, branch, startRef: "HEAD" } };
    let failure;
    try {
      await createWorktree(run, workspace, {});
    } catch (error) {
      failure = error;
    }
    assert.match(failure?.message ?? "", /injected lost worktree-add response/);
    if (kind.startsWith("pristine")) {
      assert.equal(failure.worktreeRecoveryRequired, undefined);
      assert.equal(fs.existsSync(workspace), false);
      if (branch) assert.equal(await gitOut(["branch", "--list", branch], f.work), "");
    } else {
      assert.equal(failure.worktreeRecoveryRequired, true);
      assert.equal(fs.existsSync(workspace), true);
      assert.match(await gitOut(["branch", "--list", branch], f.work), /csfcc/);
      if (kind === "dirty")
        assert.equal(fs.readFileSync(path.join(workspace, "recovery.txt"), "utf8"), "preserve me");
      if (kind === "advanced")
        assert.notEqual(await gitOut(["rev-parse", branch], f.work), run.worktree.startCommit);
      if (kind === "locked") await gitOut(["worktree", "unlock", workspace], f.work);
    }
  });
}

test("a kept worktree run whose worktree was already removed still closes", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "wt.txt" });
  await gitInit(f.work);
  assert.equal(
    (await f.invoke([...LAUNCH, "--write", "--worktree", "--keep-state"])).code,
    EXIT.COMPLETED,
  );
  const key = f.runs()[0];
  const worktree = path.join(f.state, key, "worktree");
  await gitOut(["worktree", "remove", "--force", worktree], f.work);
  assert.equal(fs.existsSync(worktree), false);
  const closed = await f.invoke(["--close", key]);
  assert.equal(closed.code, EXIT.COMPLETED, closed.stderr);
  assert.equal(f.events().at(-1).cwd, worktree);
  assert.deepEqual(f.runs(), []);
  assert.match(await gitOut(["branch", "--list", `csfcc/${key.slice(0, 20)}`], f.work), /csfcc\//);
});

test("worktree jobs run on a fresh branch from HEAD, commit their changes at delivery, and leave only the branch after cleanup", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "codex-output.txt" });
  await gitInit(f.work);
  const head = await gitOut(["rev-parse", "HEAD"], f.work);
  const result = await f.invoke([...LAUNCH, "--write", "--worktree"]);
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  const { footer } = delivered(result.stdout);
  assert.match(footer.branch, /^csfcc\/[0-9a-f]{20}$/);
  assert.match(footer.commit, /^[0-9a-f]{40}$/);
  assert.notEqual(footer.commit, head);
  const launch = f.events()[0];
  assert.ok(launch.cwd.endsWith(`${path.sep}worktree`), launch.cwd);
  assert.equal(fs.existsSync(launch.cwd), false, "the worktree folder goes with the run");
  assert.equal(await gitOut(["rev-parse", footer.branch], f.work), footer.commit);
  assert.match(
    await gitOut(["show", "--stat", "--format=%s", footer.branch], f.work),
    /codex-subagents-for-claude-code [0-9a-f]{32} turn 1: gpt-6\.1-sol xhigh[\s\S]*codex-output\.txt/,
  );
  assert.equal(
    await gitOut(["status", "--porcelain"], f.work),
    "",
    "the base checkout is untouched",
  );
  assert.equal(
    (await gitOut(["worktree", "list"], f.work)).split("\n").length,
    1,
    "no worktree left registered",
  );
  assert.deepEqual(f.runs(), []);
  const writers = path.join(f.state, "writers");
  assert.ok(
    !fs.existsSync(writers) || fs.readdirSync(writers).length === 0,
    "worktree jobs take no workspace writer lock",
  );
});

test("a worktree job started with a git hook's environment commits in its own repository and leaves the hook's alone", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "codex-output.txt" });
  await gitInit(f.work);
  const sentinel = path.join(f.root, "sentinel");
  fs.mkdirSync(sentinel);
  await gitInit(sentinel);
  const dotGit = path.join(sentinel, ".git");
  const snapshot = async () => ({
    refs: await gitOut(["for-each-ref", "--format=%(refname) %(objectname)"], sentinel),
    config: fs.readFileSync(path.join(dotGit, "config"), "utf8"),
    index: sha256(fs.readFileSync(path.join(dotGit, "index"))),
    worktrees: fs.existsSync(path.join(dotGit, "worktrees")),
  });
  const before = await snapshot();
  // What a hook of the sentinel exports, beside variables a job may need.
  const env = {
    ...f.env,
    GIT_DIR: dotGit,
    GIT_WORK_TREE: sentinel,
    GIT_INDEX_FILE: path.join(dotGit, "index"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
    GIT_AUTHOR_NAME: "kept-author",
    GIT_AUTHOR_EMAIL: "kept-author@localhost",
  };
  const result = await f.cli([...LAUNCH, "--write", "--worktree"], { env, timeoutMs: 60_000 });
  assert.equal(result.status, EXIT.COMPLETED, result.stderr);
  const { footer } = delivered(result.stdout);
  assert.match(footer.branch, /^csfcc\/[0-9a-f]{20}$/);
  assert.equal(await gitOut(["rev-parse", footer.branch], f.work), footer.commit);
  assert.match(
    await gitOut(["show", "--name-only", "--format=%an", footer.commit], f.work),
    /^kept-author\n[\s\S]*codex-output\.txt/,
    "the commit is in the job's repository, by the inherited author",
  );
  assert.deepEqual(await snapshot(), before, "the hook's repository is unchanged");
  assert.deepEqual(
    f.events().find((e) => e.command === "task").git,
    // The suite's private config selection (test/support/git-environment.mjs) is no repository-local variable.
    ["GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"],
    "the Codex job keeps git's other variables only",
  );
});

test("git's repository-local variables are removed from git and job environments, and nothing else", async () => {
  const { localGitVariable, withoutLocalGit } = await import("../src/shared/io.mjs");
  const listed = await runProcess("git", ["rev-parse", "--local-env-vars"], {
    env: withoutLocalGit(),
    timeoutMs: 15_000,
  });
  assert.equal(listed.status, 0, listed.stderr);
  const names = listed.stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(names.includes("GIT_DIR"), names.join(" "));
  for (const name of names) assert.ok(localGitVariable(name), `${name} is removed`);
  // Older git versions, such as Debian bookworm's 2.39, also list this one.
  assert.ok(localGitVariable("GIT_INTERNAL_SUPER_PREFIX"), "the older list is covered too");
  const kept = {
    PATH: "p",
    GIT_SSH_COMMAND: "ssh -i key",
    GIT_AUTHOR_NAME: "a",
    GIT_COMMITTER_EMAIL: "c",
    GIT_TERMINAL_PROMPT: "0",
  };
  assert.deepEqual(
    withoutLocalGit({
      ...kept,
      ...Object.fromEntries(names.map((name) => [name, "x"])),
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
    }),
    kept,
  );
  assert.equal(localGitVariable("Git_Dir", "win32"), true, "Windows names ignore case");
  assert.equal(localGitVariable("git_config_key_3", "win32"), true);
  assert.equal(localGitVariable("Git_Dir", "linux"), false, "POSIX names are exact");
  const env = codexEnvironment(
    { PATH: "p", GIT_DIR: "hook", GIT_INDEX_FILE: "hook", GIT_SSH_COMMAND: "ssh" },
    null,
  );
  assert.deepEqual(
    Object.keys(env).filter((name) => name.startsWith("GIT_")),
    ["GIT_SSH_COMMAND"],
  );
});

test("worktree refs validate options and task directives before launch", () => {
  const args = [...LAUNCH, "--write", "--worktree"];
  assert.equal(parseArgs([...args, "--worktree-ref", "PROTOYPE-3"])["worktree-ref"], "PROTOYPE-3");
  for (const ref of ["-b", "--detach", "has space", "ref\nother", ""]) {
    assert.throws(() => parseArgs([...args, "--worktree-ref", ref]));
    assert.throws(() =>
      applyDirectives({}, { write: "yes", worktree: "yes", "worktree-ref": ref }),
    );
  }
  for (const invalid of [
    [...LAUNCH, "--worktree-ref", "main"],
    [...LAUNCH, "--write", "--worktree-ref", "main"],
    [...LAUNCH, "--scratch-workspace", "--worktree-ref", "main"],
    ["--role", "gpt-6-1-sol", "--task-file", "t.md", "--worktree-ref", "main"],
    ["--continue", KEY, "--prompt-file", "f", "--write", "--worktree", "--worktree-ref", "main"],
    ["--run", KEY, "--write", "--worktree", "--worktree-ref", "main"],
  ])
    assert.throws(() => parseArgs(invalid), invalid.join(" "));
  for (const directives of [
    { "worktree-ref": "main" },
    { write: "yes", worktree: "no", "worktree-ref": "main" },
    { write: "yes", cwd: "none", "worktree-ref": "main" },
    { continue: KEY, "worktree-ref": "main" },
    { cancel: KEY, "worktree-ref": "main" },
    { close: KEY, "worktree-ref": "main" },
  ])
    assert.throws(() => applyDirectives({}, directives));
  const parsed = parseTaskFile(
    Buffer.from("write: yes\ncwd: worktree\nworktree-ref: PROTOYPE-3\n\nImplement this.\n"),
  );
  const options = applyDirectives({}, parsed.directives);
  assert.equal(options.worktree, true);
  assert.equal(options["worktree-ref"], "PROTOYPE-3");
  assert.equal(parsed.body, "Implement this.\n");
});

test("a worktree starts at the requested branch without switching or copying the dirty base checkout", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "codex-output.txt" });
  await gitInit(f.work);
  const head = await gitOut(["rev-parse", "HEAD"], f.work);
  const source = await prototypeBranch(f.work);
  fs.writeFileSync(path.join(f.work, "README.md"), "local edits\n");
  fs.writeFileSync(path.join(f.work, "local-only.txt"), "uncommitted\n");
  const result = await f.invoke([
    ...LAUNCH,
    "--write",
    "--worktree",
    "--worktree-ref",
    "PROTOYPE-3",
    "--keep-state",
  ]);
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  const { footer } = delivered(result.stdout);
  const record = f.metadata(footer.run);
  assert.equal(record.worktree.startRef, "PROTOYPE-3");
  assert.equal(record.worktree.startCommit, source);
  assert.equal(await gitOut(["rev-parse", `${footer.commit}^`], f.work), source);
  assert.match(
    fs.readFileSync(path.join(record.cwd, "prototype.txt"), "utf8"),
    /^only on the prototype branch\r?\n$/,
  );
  assert.match(fs.readFileSync(path.join(record.cwd, "README.md"), "utf8"), /^base\r?\n$/);
  assert.equal(fs.existsSync(path.join(record.cwd, "local-only.txt")), false);
  assert.equal(await gitOut(["branch", "--show-current"], f.work), "main");
  assert.equal(await gitOut(["rev-parse", "HEAD"], f.work), head);
  assert.equal(await gitOut(["rev-parse", "PROTOYPE-3"], f.work), source);
  assert.equal(fs.readFileSync(path.join(f.work, "README.md"), "utf8"), "local edits\n");
  assert.equal(fs.readFileSync(path.join(f.work, "local-only.txt"), "utf8"), "uncommitted\n");
  assert.equal((await f.invoke(["--close", footer.run])).code, EXIT.COMPLETED);
  assert.equal(await gitOut(["rev-parse", footer.branch], f.work), footer.commit);
  assert.equal((await gitOut(["worktree", "list"], f.work)).split("\n").length, 1);
});

test("worktree refs accept local remote-tracking refs, annotated tags and commit IDs", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "codex-output.txt" });
  await gitInit(f.work);
  const source = await prototypeBranch(f.work);
  await gitOut(["update-ref", "refs/remotes/origin/PROTOYPE-3", source], f.work);
  await gitOut(
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@localhost",
      "tag",
      "-a",
      "prototype-tag",
      "-m",
      "prototype",
      source,
    ],
    f.work,
  );
  for (const ref of ["origin/PROTOYPE-3", "refs/heads/PROTOYPE-3", "prototype-tag", source]) {
    fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
    const result = await f.invoke([...LAUNCH, "--write", "--worktree", "--worktree-ref", ref]);
    assert.equal(result.code, EXIT.COMPLETED, result.stderr);
    assert.equal(
      await gitOut(["rev-parse", `${delivered(result.stdout).footer.commit}^`], f.work),
      source,
      ref,
    );
    assert.deepEqual(f.runs(), []);
  }
});

test("missing and non-commit worktree refs fail without launching or leaving state, branches or claims", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  const branches = await gitOut(["branch", "--list"], f.work);
  for (const ref of ["does-not-exist", "HEAD:README.md"]) {
    const result = await f.invoke([
      ...LAUNCH,
      "--write",
      "--worktree",
      "--worktree-ref",
      ref,
      "--request-id",
      "bad-ref",
    ]);
    assert.equal(result.code, EXIT.FAILURE);
    assert.match(result.stderr, /worktree ref .* could not be resolved to a local commit/);
    assert.deepEqual(f.events(), []);
    assert.deepEqual(f.runs(), []);
    assert.equal(fs.existsSync(path.join(f.state, "requests", "bad-ref.lock")), false);
    assert.equal(await gitOut(["branch", "--list"], f.work), branches);
    assert.equal((await gitOut(["worktree", "list"], f.work)).split("\n").length, 1);
    assert.ok(fs.existsSync(path.join(f.work, "prompt.md")));
  }
});

test("request IDs for explicit worktree refs attach and replay only the same repository and ref", async (t) => {
  const f = fixture(t, { status: "running" });
  await gitInit(f.work);
  const source = await prototypeBranch(f.work);
  const args = [
    ...LAUNCH,
    "--write",
    "--worktree",
    "--worktree-ref",
    "PROTOYPE-3",
    "--request-id",
    "ref-request",
  ];
  assert.equal((await f.invoke(args)).code, EXIT.STILL_RUNNING);
  await gitOut(["branch", "-f", "PROTOYPE-3", "main"], f.work);
  fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
  assert.equal((await f.invoke(args)).code, EXIT.STILL_RUNNING, "the same request attaches");
  assert.equal(
    f.metadata().worktree.startCommit,
    source,
    "moving the ref does not change an existing request",
  );
  const otherRef = args.map((value) => (value === "PROTOYPE-3" ? "main" : value));
  const wrongRef = await f.invoke(otherRef);
  assert.equal(wrongRef.code, EXIT.FAILURE);
  assert.match(wrongRef.stderr, /already used for a different task/);
  fs.writeFileSync(path.join(f.other, "prompt.md"), ORIGINAL);
  const wrongRepo = await f.invoke([...args, "--cwd", f.other]);
  assert.equal(wrongRepo.code, EXIT.FAILURE);
  assert.match(wrongRepo.stderr, /already used for a different task/);
  assert.equal(f.events().filter((event) => event.command === "task").length, 1);
  f.configure({ status: "completed" });
  assert.equal((await f.invoke(args)).code, EXIT.COMPLETED);
  assert.deepEqual(f.runs(), []);
  const replay = await f.invoke(args);
  assert.equal(replay.code, EXIT.COMPLETED, replay.stderr);
  assert.match(replay.stdout, /^codex-subagents-for-claude-code-replay:/);
  const wrongReplay = await f.invoke(otherRef);
  assert.equal(wrongReplay.code, EXIT.FAILURE);
  assert.match(wrongReplay.stderr, /already used for a different task/);
  assert.equal(f.events().filter((event) => event.command === "task").length, 1);
});

test("a kept worktree run reuses its worktree even if the source ref moves, and close keeps the branch", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "turn1.txt" });
  await gitInit(f.work);
  const source = await prototypeBranch(f.work);
  const first = await f.invoke([
    ...LAUNCH,
    "--write",
    "--worktree",
    "--worktree-ref",
    "PROTOYPE-3",
    "--keep-state",
  ]);
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  const key = f.runs()[0];
  const worktree = path.join(f.state, key, "worktree");
  assert.ok(fs.existsSync(path.join(worktree, "turn1.txt")));
  const commit1 = delivered(first.stdout).footer.commit;
  await gitOut(["branch", "-f", "PROTOYPE-3", "main"], f.work);
  f.configure({ touchWorkspaceFile: "turn2.txt" });
  fs.writeFileSync(path.join(f.other, "second.md"), "second");
  const second = await f.invoke(
    ["--continue", key, "--prompt-file", "second.md", "--write", "--wait-ms", "0"],
    { cwd: f.other },
  );
  assert.equal(second.code, EXIT.COMPLETED, second.stderr);
  const commit2 = delivered(second.stdout).footer.commit;
  assert.notEqual(commit2, commit1);
  assert.equal(await gitOut(["rev-parse", `${commit2}^`], f.work), commit1);
  assert.equal(f.metadata(key).worktree.startCommit, source);
  assert.equal(f.metadata(key).worktree.startRef, "PROTOYPE-3");
  assert.equal(f.events().filter((e) => e.command === "task")[1].cwd, worktree);
  assert.equal((await f.invoke(["--close", key])).code, EXIT.COMPLETED);
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(await gitOut(["rev-parse", `csfcc/${key.slice(0, 20)}`], f.work), commit2);
  assert.match(
    await gitOut(["log", "--format=%s", `csfcc/${key.slice(0, 20)}`], f.work),
    /turn 2[\s\S]*turn 1[\s\S]*base/,
  );
  assert.deepEqual(f.runs(), []);
});

test("a task file can ask for a worktree of another repository", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "elsewhere.txt" });
  await gitInit(f.other);
  const source = await prototypeBranch(f.other);
  fs.writeFileSync(
    path.join(f.work, "task.md"),
    `cwd: ${f.other}\nworktree: yes\nworktree-ref: PROTOYPE-3\nwrite: yes\nChange something.\n`,
  );
  const result = await f.invoke(["--role", "gpt-6-astra", "--task-file", "task.md"]);
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  const { footer } = delivered(result.stdout);
  assert.equal(await gitOut(["rev-parse", footer.branch], f.other), footer.commit);
  assert.equal(await gitOut(["rev-parse", `${footer.commit}^`], f.other), source);
  assert.equal(f.events().find((event) => event.command === "task").prompt, "Change something.\n");
  assert.match(
    await gitOut(["show", "--stat", "--format=", footer.branch], f.other),
    /elsewhere\.txt/,
  );
  assert.equal(await gitOut(["status", "--porcelain"], f.other), "");
  assert.deepEqual(f.runs(), []);
});

test("a worktree launch outside a git repository fails before anything is launched and leaves no state", async (t) => {
  const f = fixture(t);
  const result = await f.invoke([...LAUNCH, "--write", "--worktree", "--request-id", "wt-1"]);
  assert.equal(result.code, EXIT.FAILURE);
  assert.match(result.stderr, /worktree ref "HEAD" could not be resolved to a local commit/);
  assert.deepEqual(f.events(), []);
  assert.deepEqual(f.runs(), []);
  assert.equal(
    fs.existsSync(path.join(f.state, "requests", "wt-1.lock")),
    false,
    "the request claim is released",
  );
  assert.ok(fs.existsSync(path.join(f.work, "prompt.md")));
});

test("a read-only worktree job reads a detached snapshot, makes no branch or lock, and refuses a write continuation", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  const head = await gitOut(["rev-parse", "HEAD"], f.work);
  fs.writeFileSync(path.join(f.work, "dirty.txt"), "uncommitted\n");
  const result = await f.invoke([...LAUNCH, "--worktree", "--keep-state"]);
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  const { footer } = delivered(result.stdout);
  assert.deepEqual([footer.branch, footer.commit, footer.mode], ["-", head, "read-only"]);
  const key = f.runs()[0];
  const run = f.metadata(key);
  assert.deepEqual([run.worktree.branch, run.worktree.startCommit, run.write], [null, head, false]);
  assert.equal(
    fs.existsSync(path.join(run.cwd, "dirty.txt")),
    false,
    "the snapshot holds committed content only",
  );
  assert.equal(await gitOut(["branch", "--list", "csfcc/*"], f.work), "", "no branch was created");
  const writers = path.join(f.state, "writers");
  assert.ok(!fs.existsSync(writers) || fs.readdirSync(writers).length === 0, "no writer lock");
  fs.writeFileSync(path.join(f.other, "next.md"), "next\n");
  const refused = await f.invoke([
    "--continue",
    key,
    "--prompt-file",
    path.join(f.other, "next.md"),
    "--write",
  ]);
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(refused.stderr, /detached read-only snapshot/);
  const close = await f.invoke(["--close", key]);
  assert.equal(close.code, EXIT.COMPLETED, close.stderr);
  assert.match(close.stderr, /its snapshot was removed/);
  assert.equal(
    (await gitOut(["worktree", "list"], f.work)).split("\n").length,
    1,
    "the snapshot worktree is gone",
  );
  assert.equal(
    await gitOut(["status", "--porcelain"], f.work),
    "?? dirty.txt",
    "the base checkout is untouched",
  );
});

test("scratch workspace runs the job in an empty folder inside the run and resolves the prompt against the caller", async (t) => {
  const f = fixture(t, { status: "running" });
  const started = await f.invoke([...LAUNCH, "--scratch-workspace", "--keep-state"]);
  assert.equal(started.code, EXIT.STILL_RUNNING, started.stderr);
  assert.match(started.stderr, /scratch workspace/);
  const key = f.runs()[0];
  const workspace = path.join(f.state, key, "workspace");
  assert.ok(fs.statSync(workspace).isDirectory());
  assert.deepEqual(fs.readdirSync(workspace), []);
  const run = f.metadata(key);
  assert.deepEqual([run.cwd, run.scratchWorkspace], [workspace, true]);
  assert.equal(f.events()[0].cwd, workspace);
  assert.equal(f.events()[0].prompt, "The exact original prompt: λ.\n");
  assert.equal(
    fs.existsSync(path.join(f.work, "prompt.md")),
    false,
    "the caller's prompt file was consumed as usual",
  );
  assert.ok((await f.invoke(["--list"])).stdout.includes(`cwd=${workspace}`));
  f.configure({ status: "completed" });
  assert.equal((await f.invoke(["--run", key, "--wait-ms", "0"])).code, EXIT.COMPLETED);
  fs.writeFileSync(path.join(f.other, "second.md"), "second prompt");
  assert.equal(
    (
      await f.invoke(["--continue", key, "--prompt-file", "second.md", "--wait-ms", "0"], {
        cwd: f.other,
      })
    ).code,
    0,
  );
  assert.equal(f.events().filter((e) => e.command === "task")[1].cwd, workspace);
  assert.equal(f.events().at(-1).cwd, workspace);
  assert.equal((await f.invoke(["--close", key])).code, EXIT.COMPLETED);
  assert.equal(fs.existsSync(workspace), false);
  assert.deepEqual(f.runs(), []);
});

test("a contended writer release gives up after retrying instead of failing the delivery", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.state, "writers"), { recursive: true });
  acquireWriterLock(f.state, f.work, KEY);
  const lock = path.join(f.state, "writers", `${workspaceId(f.work)}.lock`);
  fs.mkdirSync(`${lock}.recovery`);
  const start = performance.now();
  assert.equal(await releaseWriterLock(f.state, f.work, KEY), false);
  assert.ok(performance.now() - start >= 1500, "it retried for a while");
  assert.ok(fs.existsSync(lock), "the lock was left alone");
  fs.rmdirSync(`${lock}.recovery`);
  assert.equal(
    await releaseWriterLock(f.state, f.work, "b".repeat(32)),
    true,
    "another run's lock is not touched",
  );
  assert.ok(fs.existsSync(lock));
  assert.equal(await releaseWriterLock(f.state, f.work, KEY), true);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(await releaseWriterLock(f.state, f.work, KEY), true, "nothing to release is fine");
});

test("a scratch workspace is refused when the state root lies inside a git repository", async (t) => {
  const f = fixture(t);
  await gitInit(f.other);
  const env = { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR: path.join(f.other, "state") };
  const result = await f.invoke([...LAUNCH, "--scratch-workspace", "--request-id", "scratch-1"], {
    env,
  });
  assert.equal(result.code, EXIT.FAILURE);
  assert.match(
    result.stderr,
    /lies inside the git repository .*; set CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR outside any repository/,
  );
  assert.deepEqual(f.events(), []);
  assert.equal(
    fs.existsSync(path.join(f.other, "state", "requests")),
    false,
    "nothing was claimed",
  );
  assert.ok(fs.existsSync(path.join(f.work, "prompt.md")));
  const report = await f.invoke(["--doctor"], {
    env: { ...env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: path.join(f.root, "no-agents") },
  });
  assert.equal(report.code, EXIT.FAILURE);
  assert.match(report.stdout, /\nstate-in-repository=yes\n/);
  assert.match(report.stdout, /\nproblem=the state root lies inside the git repository/);
});

test("a second write job on the same workspace is refused until the first delivers; read-only and scratch jobs pass", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--write"])).code, EXIT.STILL_RUNNING);
  const first = f.runs()[0];
  const firstJob = f.metadata(first).jobId;
  const prompt = (name) => {
    fs.writeFileSync(path.join(f.work, name), name);
    return LAUNCH.map((v) => (v === "prompt.md" ? name : v));
  };
  const refused = await f.invoke([...prompt("second.md"), "--write"]);
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(
    refused.stderr,
    new RegExp(`is being written by run ${first}; wait for it, or stop it with --cancel ${first}`),
  );
  assert.equal(f.runs().length, 1, "the refused launch created no state");
  assert.ok(fs.existsSync(path.join(f.work, "second.md")));
  assert.equal(
    (await f.invoke(prompt("third.md"))).code,
    EXIT.STILL_RUNNING,
    "read-only jobs are not blocked",
  );
  assert.equal(
    (await f.invoke([...prompt("fourth.md"), "--write", "--scratch-workspace"])).code,
    3,
    "scratch workspaces never collide",
  );
  assert.match((await f.invoke(["--list"])).stdout, new RegExp(`run=${first} .* writer=yes `));
  f.configure({ status: "completed" });
  assert.equal(
    (await f.invoke(["--attach", firstJob, "--run", first, "--wait-ms", "0"])).code,
    EXIT.COMPLETED,
  );
  const allowed = await f.invoke([...prompt("fifth.md"), "--write"]);
  assert.equal(allowed.code, EXIT.COMPLETED, allowed.stderr);
});
