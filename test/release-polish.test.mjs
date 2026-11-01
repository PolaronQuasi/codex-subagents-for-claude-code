import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { delivered } from "./support/capture.mjs";
import { gitInit, gitOut } from "./support/git-repos.mjs";
import { fixture, LAUNCH, KEY } from "./support/runner-fixture.mjs";

import { acquireLock, liveWaiter, holdGuard } from "../src/state/state.mjs";
import { ownerAlive, processStart } from "../src/shared/process-identity.mjs";
import { runProcess, sameFolder } from "../src/shared/io.mjs";
import {
  GIT_ISOLATION,
  gitEnvironment,
  PRIVATE_GLOBAL_CONFIG,
} from "./support/git-environment.mjs";
import { CODES, ERRNO, EXIT } from "../src/shared/errors.mjs";

test("git test helpers ignore inherited repository and config overrides", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  await gitInit(f.other);
  const head = await gitOut(["rev-parse", "HEAD"], f.work);
  const before = await gitOut(["config", "--local", "--list"], f.work);
  const contaminated = {
    ...process.env,
    GIT_DIR: path.join(f.work, ".git"),
    GIT_WORK_TREE: f.work,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
  };
  const alias = path.join(f.root, "other workspace alias");
  fs.symlinkSync(f.other, alias, process.platform === "win32" ? "junction" : "dir");
  const spellings = [f.other, alias];
  if (process.platform === "win32") spellings.push(f.other.toUpperCase());
  for (const cwd of spellings) {
    const result = await runProcess(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { gitOut } from ${JSON.stringify(new URL("./support/git-repos.mjs", import.meta.url).href)}; console.log(await gitOut(["rev-parse", "--show-toplevel"], process.cwd()));`,
      ],
      { env: contaminated, cwd },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    // Git may expand a Windows short name, resolve a directory alias or
    // normalize letter case. Verify the repository, not its path spelling.
    const top = result.stdout.trim();
    assert.ok(sameFolder(top, f.other), `git selected ${top}; expected ${f.other} from cwd ${cwd}`);
    assert.equal(sameFolder(top, f.work), false, "inherited repository must not be selected");
  }
  assert.equal(await gitOut(["rev-parse", "HEAD"], f.work), head);
  assert.equal(await gitOut(["config", "--local", "--list"], f.work), before);
  assert.deepEqual(gitEnvironment({ GIT_DIR: "x", git_index_file: "y", PATH: "kept" }), {
    PATH: "kept",
    ...GIT_ISOLATION,
  });
});

test("fixture repositories read a private, empty global config and no system config, and hold a local identity with signing off and no hooks path", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  // A developer's own global configuration, inherited by the test process: replaced.
  const developer = path.join(f.root, "developer.gitconfig");
  fs.writeFileSync(
    developer,
    "[core]\n\thooksPath = hooks-of-the-developer\n[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n[user]\n\tname = developer\n",
  );
  const env = gitEnvironment({ ...process.env, GIT_CONFIG_GLOBAL: developer, GIT_DIR: "x" });
  assert.equal(env.GIT_CONFIG_GLOBAL, PRIVATE_GLOBAL_CONFIG);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(fs.readFileSync(PRIVATE_GLOBAL_CONFIG, "utf8"), "");
  // The runner's own git commands read process.env, which carries the same isolation.
  assert.equal(process.env.GIT_CONFIG_GLOBAL, PRIVATE_GLOBAL_CONFIG);
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "1");
  const entries = (await gitOut(["config", "--show-origin", "--list"], f.work))
    .split("\n")
    .map((line) => line.split("\t"));
  for (const [origin, entry] of entries)
    assert.equal(origin, "file:.git/config", `${entry} comes from the repository's own config`);
  const config = Object.fromEntries(entries.map(([, entry]) => entry.split(/=(.*)/s).slice(0, 2)));
  assert.equal(config["user.name"], "fixture");
  assert.equal(config["user.email"], "fixture@localhost");
  assert.equal(config["commit.gpgsign"], "false");
  assert.equal(config["tag.gpgsign"], "false");
  assert.equal(config["core.hookspath"], undefined);
  assert.equal(await gitOut(["symbolic-ref", "HEAD"], f.work), "refs/heads/main");
});

test("unknown run actions fail clearly without creating phantom audit directories", async (t) => {
  const f = fixture(t);
  for (const mode of ["--run", "--cancel", "--close", "--sleep", "--inspect"]) {
    const result = await f.invoke([mode, KEY]);
    assert.equal(result.code, EXIT.FAILURE, mode);
    assert.match(result.stderr, /unknown run .*--list/);
    assert.doesNotMatch(result.stderr, /ENOENT|lstat|Recover with/);
  }
  assert.equal(fs.existsSync(f.resultsDir), false);
  assert.deepEqual(f.runs(), []);
});

test("missing task, prompt and workspace paths explain the input without raw errno", async (t) => {
  const f = fixture(t);
  for (const [args, expected] of [
    [
      ["--role", "gpt-6-astra", "--task-file", "absent.md"],
      /task file does not exist.*--task-file/,
    ],
    [[...LAUNCH, "--cwd", path.join(f.work, "absent")], /directory .*absent: does not exist/],
    [[...LAUNCH.slice(0, 5), "absent.md"], /prompt file does not exist.*--prompt-file/],
  ]) {
    const result = await f.invoke(args);
    assert.equal(result.code, EXIT.FAILURE, result.stderr);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /ENOENT|lstat/);
  }
});

test("damaged metadata stays inspectable and force close retires it without invoking the plugin", async (t) => {
  const f = fixture(t);
  await f.invoke([...LAUNCH, "--keep-state", "--request-id", "damaged"]);
  const key = f.runs()[0];
  fs.writeFileSync(path.join(f.state, key, "run.json"), "{broken");
  const before = f.events();
  for (const mode of ["--run", "--cancel", "--sleep", "--close"]) {
    const result = await f.invoke([mode, key]);
    assert.equal(result.code, EXIT.FAILURE);
    assert.match(result.stderr, /damaged.*run.json.*--inspect.*--close.*--force/);
  }
  const inspect = await f.invoke(["--inspect", key, "--json"]);
  assert.equal(inspect.code, EXIT.COMPLETED);
  assert.ok(JSON.parse(inspect.stdout).recordError);
  assert.match((await f.invoke(["--list"])).stdout, /status=damaged-metadata.*keep=unknown/);
  assert.match(
    (await f.invoke(["--close-idle"])).stdout,
    /skipped run=.*damaged-or-missing-metadata/,
  );
  const closed = await f.invoke(["--close", key, "--force"]);
  assert.equal(closed.code, EXIT.COMPLETED, closed.stderr);
  assert.match(closed.stderr, /retired.*preserved/);
  assert.deepEqual(f.runs(), []);
  assert.deepEqual(f.events(), before);
  assert.equal(fs.readdirSync(path.join(f.state, "quarantine")).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.state, "requests")), []);
});

test("force close of damaged metadata refuses a possibly active worker", async (t) => {
  const { fixture: direct } = await import("./support/codex-fixture.mjs");
  const f = direct(t, { hangTurn: true });
  await f.invoke();
  const key = f.runs()[0];
  // The driver is detached, so the fake app-server's launch can follow the
  // waiter's exit: wait for it before taking the snapshot.
  const deadline = Date.now() + 10_000;
  while (!f.events().some((e) => e.direction === "launch") && Date.now() < deadline)
    await delay(20);
  fs.writeFileSync(path.join(f.state, key, "run.json"), "{");
  const before = f.events();
  assert.equal(before.filter((e) => e.direction === "launch").length, 1);
  const result = await f.invoke(["--close", key, "--force"]);
  assert.equal(result.code, EXIT.FAILURE);
  assert.match(result.stderr, /driver may still run/);
  assert.deepEqual(f.runs(), [key]);
  assert.deepEqual(
    f.events().filter((e) => e.direction === "launch"),
    before.filter((e) => e.direction === "launch"),
  );
});

test("an unwritable results folder reports retention in the footer and names the override", async (t) => {
  const f = fixture(t);
  const result = await f.invoke(LAUNCH, {
    env: {
      ...f.env,
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: path.join(f.root, "control.json"),
    },
  });
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  assert.equal(delivered(result.stdout).footer.keep, "yes");
  assert.equal(f.runs().length, 1);
  assert.match(
    result.stderr,
    /CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR.*occupied.*attach again/,
  );
});

test("doctor reports current invalid overrides and still finishes its report", async (t) => {
  const f = fixture(t);
  const env = { ...f.env };
  delete env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH;
  for (const name of ["CODEX", "STATE", "RESULTS", "AGENTS"])
    env[`CODEX_SUBAGENTS_FOR_CLAUDE_CODE_${name}_DIR`] = "relative";
  const result = await f.invoke(["--doctor", "--read-only"], { env });
  assert.equal(result.code, EXIT.FAILURE);
  for (const name of ["CODEX", "STATE", "RESULTS", "AGENTS"])
    assert.match(
      result.stdout,
      new RegExp(`problem=CODEX_SUBAGENTS_FOR_CLAUDE_CODE_${name}_DIR must be an absolute path`),
    );
  assert.match(result.stdout, /\ndoctor=\d+ problem\(s\)\n/);
  assert.equal(result.stderr, "");
  assert.deepEqual(f.events(), []);
});

test("refused write continuation gives a new-write-job remedy instead of attach", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  await f.invoke([...LAUNCH, "--worktree", "--keep-state"]);
  const key = f.runs()[0];
  fs.writeFileSync(path.join(f.work, "next.md"), "Write next");
  const result = await f.invoke(["--continue", key, "--write", "--prompt-file", "next.md"]);
  assert.equal(result.code, EXIT.FAILURE);
  assert.match(result.stderr, /Start a new job with --worktree --write/);
  assert.doesNotMatch(result.stderr, /Recover with:|--attach/);
});

test("run locks distinguish a reused live PID by start time and preserve owners with incomplete identity", async (t) => {
  const f = fixture(t);
  const start = processStart(process.pid);
  assert.ok(start, "OS reports this process's creation time");
  const release = acquireLock(f.state, KEY);
  const file = path.join(f.state, `${KEY}.lock`, "owner.json");
  const owner = JSON.parse(fs.readFileSync(file));
  assert.equal(owner.processStart, start);
  assert.equal(liveWaiter(f.state, KEY), process.pid);
  assert.equal(
    ownerAlive({ pid: process.pid }),
    true,
    "missing birth identity remains conservative",
  );
  fs.writeFileSync(file, JSON.stringify({ ...owner, processStart: "previous-process" }));
  assert.equal(liveWaiter(f.state, KEY), null);
  const takeover = acquireLock(f.state, KEY);
  assert.throws(release, /ownership changed/);
  takeover();
  assert.equal(ownerAlive({ pid: process.pid, processStart: start }), true);
});

for (const failure of ["library", "changed", "index"])
  test("damaged retirement ignores incomplete unrelated claims and resumes busy cleanup", async (t) => {
    const f = fixture(t);
    await f.invoke([...LAUNCH, "--keep-state", "--request-id", "retire"]);
    const key = f.runs()[0];
    fs.writeFileSync(path.join(f.state, key, "run.json"), "{broken");
    const unrelated = path.join(f.state, "requests", "another.lock");
    fs.mkdirSync(unrelated);
    const guard = path.join(f.state, "requests", "retire.lock.recovery");
    fs.mkdirSync(guard);
    const first = await f.invoke(["--close", key, "--force"]);
    const preserved = path.join(f.state, "quarantine", key);
    assert.equal(first.code, EXIT.FAILURE);
    assert.ok(first.stderr.includes(preserved));
    assert.match(first.stderr, /retirement cleanup incomplete.*retry --close/);
    assert.ok(fs.existsSync(path.join(preserved, "run.json")));
    fs.rmdirSync(guard);
    const retry = await f.invoke(["--close", key, "--force"]);
    assert.equal(retry.code, EXIT.COMPLETED, retry.stderr);
    assert.ok(retry.stderr.includes(preserved));
    assert.deepEqual(fs.readdirSync(path.join(f.state, "requests")), ["another.lock"]);
    assert.ok(fs.existsSync(path.join(preserved, "run.json")));
  });

test(
  "a delete-pending Windows claim guard is busy and never reclaimed",
  { skip: process.platform !== "win32" },
  (t) => {
    let removed = false;
    t.mock.method(fs, "mkdirSync", () => {
      throw Object.assign(new Error("delete pending"), { code: ERRNO.EPERM });
    });
    t.mock.method(fs, "rmSync", () => {
      removed = true;
    });
    assert.throws(() => holdGuard("fixture-guard", "busy"), { code: CODES.GUARD_BUSY });
    assert.equal(removed, false);
  },
);
