import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyDirectives, parseArgs, parseTaskFile, ROLES, RUNNER_VERSION } from "../src/index.mjs";

import { delivered } from "./support/capture.mjs";
import { KEY, LAUNCH, fixture } from "./support/runner-fixture.mjs";
import { EXIT } from "../src/shared/errors.mjs";

test("role defaults and explicit overrides agree for CLI and task-file launches", async (t) => {
  const f = fixture(t);
  const { prepareTask } = await import("../src/cli/task-input.mjs");
  for (const role of Object.keys(ROLES)) {
    for (const override of [
      [],
      ["--effort", "low"],
      ["--model", "custom-model", "--effort", "high"],
    ]) {
      fs.writeFileSync(path.join(f.work, "task.md"), "task body");
      const cli = parseArgs(["--role", role, "--prompt-file", "prompt.md", ...override]);
      const task = parseArgs(["--role", role, "--task-file", "task.md", ...override]);
      prepareTask(task, f.work);
      assert.deepEqual([task.model, task.effort], [cli.model, cli.effort], role);
    }
    fs.writeFileSync(path.join(f.work, "task.md"), `continue: ${KEY}\nnext`);
    const continued = parseArgs(["--role", role, "--task-file", "task.md"]);
    prepareTask(continued, f.work);
    assert.deepEqual([continued.model, continued.effort], [ROLES[role].model, undefined]);
  }
});

test("arguments fail before discovery and cannot silently change invocation mode", () => {
  for (const args of [
    [],
    ["--no-such-flag"],
    ["--model"],
    ["--model", " "],
    ["--attach", "task-example"],
    ["--run", "../escape"],
    ["--run", KEY, "--attach", "--evil"],
    [...LAUNCH, "--write", "--write"],
    [...LAUNCH, "--model", "other"],
    [...LAUNCH, "--run", KEY],
    ["--help", "--write"],
    ["--run", "a".repeat(32), "--wait-ms", "NaN"],
    ["--run", "a".repeat(32), "--wait-ms", "-1"],
    ["--run", "a".repeat(32), "--command-timeout-ms", "0"],
    ["--run", "a".repeat(32), "--wait-ms", "86400001"],
    ["--model", "model;echo", "--effort", "xhigh", "--prompt-file", "x"],
    ["--model", "model", "--effort", "typo", "--prompt-file", "x"],
    ["--list", "--write"],
    ["--list", "--run", KEY],
    ["--cancel", KEY, "--model", "x"],
    ["--close", KEY, "--prompt-file", "x"],
    ["--close", KEY, "--keep-state"],
    ["--continue", KEY],
    ["--continue", KEY, "--prompt-file", "f", "--cwd", "d"],
    ["--continue", KEY, "--prompt-file", "f", "--effort", "typo"],
    ["--continue", "zz", "--prompt-file", "f"],
    ["--run", KEY, "--cancel", KEY],
    ["--cancel", KEY, "--close", KEY],
    ["--close", KEY, "--attach", "task-example"],
    ["--list", "--quiet"],
    ["--help", "--max-stdout-lines", "1"],
    [...LAUNCH, "--scratch-workspace", "--cwd", "x"],
    ["--continue", KEY, "--prompt-file", "f", "--scratch-workspace"],
    ["--run", KEY, "--scratch-workspace"],
    [...LAUNCH, "--max-stdout-lines", "-1"],
    [...LAUNCH, "--max-stdout-lines", "1000001"],
    [...LAUNCH, "--max-stdout-lines", "ten"],
    ["--doctor", "--quiet"],
    ["--task-file", "t", "--role", "nope"],
    ["--task-file", "t", "--role", "gpt-6-1-sol", "--write"],
    ["--task-file", "t", "--role", "gpt-6-1-sol", "--prompt-file", "p"],
    ["--task-file", "t", "--role", "gpt-6-1-sol", "--run", KEY],
    ["--task-file", "t", "--role", "gpt-6-1-sol", "--request-id", "r"],
    ["--task-file", "t", "--model", "m", "--prompt-file", "p"],
    [...LAUNCH, "--request-id", "bad id"],
    [...LAUNCH, "--request-id", "-x"],
    [...LAUNCH, "--max-stdout-bytes", "x"],
    ["--continue", KEY, "--prompt-file", "f", "--role", "gpt-6-1-sol"],
    ["--run", KEY, "--role", "gpt-6-1-sol"],
    ["--run", KEY, "--task-file", "t"],
    [...LAUNCH, "--write", "--worktree", "--scratch-workspace"],
    ["--continue", KEY, "--prompt-file", "f", "--worktree"],
    ["--run", KEY, "--worktree"],
    ["--task-file", "t", "--role", "gpt-6-1-sol", "--worktree"],
  ]) {
    assert.throws(() => parseArgs(args), args.join(" "));
  }
  assert.equal(parseArgs([...LAUNCH, "--write", "--worktree"]).worktree, true);
  assert.deepEqual(
    ((o) => [o.worktree, o.write])(applyDirectives({ write: false }, { cwd: "worktree" })),
    [true, false],
    "a worktree without write: yes is a read-only snapshot",
  );
  assert.equal(applyDirectives({ write: false }, { cwd: "worktree", write: "yes" }).worktree, true);
  const elsewhere = applyDirectives(
    { write: false },
    { cwd: path.join(os.tmpdir(), "repo"), worktree: "yes", write: "yes" },
  );
  assert.deepEqual([elsewhere.worktree, elsewhere.cwd], [true, path.join(os.tmpdir(), "repo")]);
  assert.deepEqual(
    ((o) => [o.worktree, o.write])(applyDirectives({ write: false }, { worktree: "yes" })),
    [true, false],
  );
  assert.throws(
    () => applyDirectives({ write: false }, { cwd: "none", worktree: "yes", write: "yes" }),
    /cannot be combined/,
  );
  assert.throws(
    () => applyDirectives({ write: false }, { continue: KEY, worktree: "yes", write: "yes" }),
    /cannot be combined with continue/,
  );
  assert.equal(
    applyDirectives({ write: false, worktree: false }, { worktree: "no", write: "yes" }).worktree,
    false,
  );
  assert.throws(
    () => parseArgs(["--no-such-flag"]),
    new RegExp(`runner ${RUNNER_VERSION.replace(/\\./g, "\\\\.")}; see --help`),
  );
  const task = parseArgs([
    "--task-file",
    "t.md",
    "--role",
    "gpt-6-1-sol",
    "--quiet",
    "--max-stdout-lines",
    "300",
    "--max-stdout-bytes",
    "65536",
  ]);
  assert.deepEqual(
    [task.mode, task.role, task.quiet, task["max-stdout-lines"], task["max-stdout-bytes"]],
    ["task", "gpt-6-1-sol", true, 300, 65536],
  );
  assert.equal(parseArgs(["--task-file", "t.md", "--model", "m", "--effort", "low"]).mode, "task");
  const byRole = parseArgs(["--role", "gpt-5-6-sol", "--prompt-file", "p"]);
  assert.deepEqual([byRole.mode, byRole.model, byRole.effort], ["launch", "gpt-5.6-sol", "xhigh"]);
  assert.equal(
    parseArgs(["--role", "gpt-5-6-sol", "--effort", "low", "--prompt-file", "p"]).effort,
    "low",
  );
  assert.equal(parseArgs(["--doctor"]).mode, "doctor");
  assert.equal(parseArgs([...LAUNCH, "--request-id", "req.1_a-b"])["request-id"], "req.1_a-b");
  assert.equal(parseArgs(LAUNCH).quiet, undefined);
  assert.equal(parseArgs(LAUNCH)["max-stdout-lines"], undefined);
  assert.equal(parseArgs([...LAUNCH, "--quiet"]).quiet, true);
  assert.equal(parseArgs([...LAUNCH, "--scratch-workspace"])["scratch-workspace"], true);
  assert.equal(
    parseArgs(["--run", KEY, "--quiet", "--max-stdout-lines", "0"])["max-stdout-lines"],
    0,
  );
  assert.equal(parseArgs(["--cancel", KEY, "--quiet", "--max-stdout-lines", "40"]).mode, "cancel");
  assert.equal(
    parseArgs(["--continue", KEY, "--prompt-file", "f", "--max-stdout-lines", "300"])[
      "max-stdout-lines"
    ],
    300,
  );
  assert.equal(parseArgs(LAUNCH)["wait-ms"], 0);
  assert.equal(parseArgs(LAUNCH).write, false);
  assert.equal(parseArgs(LAUNCH).mode, "launch");
  assert.equal(parseArgs([...LAUNCH, "--keep-state"])["keep-state"], true);
  assert.equal(parseArgs(["--run", "a".repeat(32)]).run, "a".repeat(32));
  assert.deepEqual(
    [parseArgs(["--run", "a".repeat(32)]).mode, parseArgs(["--run", "a".repeat(32)]).key],
    ["attach", "a".repeat(32)],
  );
  assert.equal(parseArgs(["--list"]).mode, "list");
  assert.deepEqual(
    [parseArgs(["--cancel", KEY]).mode, parseArgs(["--cancel", KEY]).key],
    ["cancel", KEY],
  );
  assert.equal(parseArgs(["--close", KEY, "--wait-ms", "0"]).mode, "close");
  const next = parseArgs([
    "--continue",
    KEY,
    "--prompt-file",
    "f",
    "--write",
    "--model",
    "gpt-5.6-sol",
    "--effort",
    "high",
    "--keep-state",
  ]);
  assert.deepEqual(
    [next.mode, next.key, next.write, next.model, next.effort],
    ["continue", KEY, true, "gpt-5.6-sol", "high"],
  );
});

test("task files split directives from a verbatim body", () => {
  const parsed = parseTaskFile(
    Buffer.from("effort: low\r\nkeep: yes\r\n\r\nReview this: carefully.\r\nLine 2\r\n"),
  );
  assert.deepEqual(parsed, {
    directives: { effort: "low", keep: "yes" },
    body: "Review this: carefully.\r\nLine 2\r\n",
  });
  assert.deepEqual(
    parseTaskFile(Buffer.from("Summary: the task\neffort: low\n")),
    { directives: {}, body: "Summary: the task\neffort: low\n" },
    "an unknown name is text, and so is everything after it",
  );
  assert.deepEqual(parseTaskFile(Buffer.from("write: yes\nprompt-file: C:/x/y.md\n")), {
    directives: { write: "yes", "prompt-file": "C:/x/y.md" },
    body: "",
  });
  assert.deepEqual(
    parseTaskFile(Buffer.from("  effort: low\nbody")),
    { directives: {}, body: "  effort: low\nbody" },
    "directives start at column one",
  );
  for (const text of [
    "effort: low\neffort: high\nx",
    "effort:\nx",
    "cancel: zz\n",
    "keep: maybe\nx",
    "write: true\nx",
    "cwd: relative/dir\nx",
    "prompt-file: rel.md\nx",
    "effort: beyond\nx",
    "request-id: bad id\nx",
    "continue: " + KEY + "\ncancel: " + KEY + "\n",
    "continue: " + KEY + "\nkeep: yes\nx",
    "close: " + KEY + "\neffort: low\n",
  ]) {
    assert.throws(
      () => applyDirectives({}, parseTaskFile(Buffer.from(text)).directives),
      JSON.stringify(text),
    );
  }
  const launch = applyDirectives(
    { model: "m", effort: "xhigh" },
    { effort: "low", keep: "yes", write: "no", cwd: "none", "request-id": "r1" },
  );
  assert.deepEqual(
    [
      launch.mode,
      launch.model,
      launch.effort,
      launch["keep-state"],
      launch.write,
      launch["scratch-workspace"],
      launch["request-id"],
    ],
    ["launch", "m", "low", true, false, true, "r1"],
  );
  const abs = path.join(os.tmpdir(), "x");
  assert.equal(applyDirectives({}, { cwd: abs }).cwd, abs);
  assert.equal(applyDirectives({}, { "prompt-file": abs })["prompt-file"], abs);
  const next = applyDirectives({}, { continue: KEY, write: "yes", effort: "high" });
  assert.deepEqual([next.mode, next.key, next.write, next.effort], ["continue", KEY, true, "high"]);
  assert.deepEqual(
    [applyDirectives({}, { cancel: KEY }).mode, applyDirectives({}, { close: KEY }).key],
    ["cancel", KEY],
  );
});

test("task-file mode applies directives in code: role, effort, keep, write, cwd none, and consumes the file", async (t) => {
  const f = fixture(t);
  const task = path.join(f.work, "task.md");
  fs.writeFileSync(task, "effort: low\nkeep: yes\nwrite: yes\ncwd: none\n\nThe task: compute.\n");
  const result = await f.invoke([
    "--role",
    "gpt-6-1-sol",
    "--task-file",
    "task.md",
    "--wait-ms",
    "0",
    "--quiet",
  ]);
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  const launch = f.events()[0];
  assert.equal(launch.prompt, "The task: compute.\n");
  for (const arg of ["gpt-6.1-sol", "low", "--write"]) assert.ok(launch.args.includes(arg), arg);
  const key = f.runs()[0];
  const run = f.metadata(key);
  assert.deepEqual(
    [run.model, run.effort, run.write, run.keepState, run.scratchWorkspace, run.quiet],
    ["gpt-6.1-sol", "low", true, true, true, true],
  );
  assert.equal(launch.cwd, path.join(f.state, key, "workspace"));
  assert.equal(fs.existsSync(task), false, "the task file is consumed after a confirmed launch");
  assert.deepEqual(
    [delivered(result.stdout).footer.keep, delivered(result.stdout).footer.effort],
    ["yes", "low"],
  );
  assert.equal((await f.invoke(["--close", key])).code, EXIT.COMPLETED);
});

test("task-file mode: a prompt-file directive sends that file and keeps it, refuses text beside it, and a cwd directive pins the workspace", async (t) => {
  const f = fixture(t);
  const brief = path.join(f.other, "brief.md");
  fs.writeFileSync(brief, "The brief: λ\n");
  const task = path.join(f.work, "task.md");
  fs.writeFileSync(task, `prompt-file: ${brief}\ncwd: ${f.other}\ntext that would be ignored\n`);
  const refused = await f.invoke(["--role", "gpt-5-6-sol", "--task-file", "task.md"]);
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(
    refused.stderr,
    /has a prompt-file: directive and task text too, and the text would be ignored/,
  );
  assert.deepEqual(f.events(), [], "nothing was launched");
  fs.writeFileSync(task, `prompt-file: ${brief}\ncwd: ${f.other}\n\n  \n`);
  const result = await f.invoke(["--role", "gpt-5-6-sol", "--task-file", "task.md"]);
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  const launch = f.events()[0];
  assert.deepEqual(
    [launch.prompt, fs.realpathSync.native(launch.cwd), launch.args.includes("gpt-5.6-sol")],
    ["The brief: λ\n", fs.realpathSync.native(f.other), true],
  );
  assert.ok(fs.existsSync(brief), "prompt-file directive files are kept");
  assert.equal(fs.existsSync(task), false);
  assert.deepEqual(f.runs(), []);
});

test("wait, detach and relay parse strictly", () => {
  const launch = ["--role", "gpt-6-1-sol", "--prompt-file", "p"];
  assert.equal(parseArgs([...launch, "--wait"])["wait-ms"], Infinity);
  assert.equal(parseArgs(["--run", KEY, "--wait"])["wait-ms"], Infinity);
  const detached = parseArgs([...launch, "--detach", "--relay"]);
  assert.deepEqual([detached.mode, detached.detach, detached.relay], ["launch", true, true]);
  assert.equal(parseArgs(["--continue", KEY, "--prompt-file", "f", "--detach"]).mode, "continue");
  const task = parseArgs([
    "--task-file",
    "t.md",
    "--role",
    "gpt-6-1-sol",
    "--quiet",
    "--relay",
    "--wait",
    "--max-stdout-bytes",
    "28000",
  ]);
  assert.deepEqual([task.mode, task.relay, task["wait-ms"]], ["task", true, Infinity]);
  assert.equal(
    parseArgs(launch).relay,
    undefined,
    "relay is only set when given, so an attach keeps the recorded value",
  );
  for (const args of [
    [...launch, "--wait", "--wait-ms", "5"],
    [...launch, "--detach", "--wait"],
    [...launch, "--detach", "--wait-ms", "0"],
    ["--run", KEY, "--detach"],
    ["--attach", "task-example", "--run", KEY, "--detach"],
    ["--cancel", KEY, "--detach"],
    ["--close", KEY, "--detach"],
    ["--list", "--relay"],
    ["--help", "--wait"],
    ["--doctor", "--detach"],
    [...launch, "--relay", "--relay"],
  ]) {
    assert.throws(() => parseArgs(args), args.join(" "));
  }
});

test("task files refuse directives after a blank line and header names a letter or two off a directive", async (t) => {
  for (const [text, message] of [
    ["\nwrite: yes\n\nTask.\n", /directive write comes after a blank line/],
    ["effort: low\n\nkeep: yes\nTask.\n", /directive keep comes after a blank line/],
    ["writ: yes\n\nTask.\n", /unknown directive writ \(did you mean write\?\)/],
    ["prompt_file: C:/x.md\n\nTask.\n", /did you mean prompt-file/],
    ["efort: low\nTask.\n", /did you mean effort/],
    ["wrte: yes\nTask.\n", /did you mean write/],
    ["effort: low\nworktree_ref: main\n", /did you mean worktree-ref/],
    // The threshold follows the directive's length, and kept is a known misspelling.
    ["kept: yes\nTask.\n", /unknown directive kept \(did you mean keep\?\)/],
    ["wortre: yes\nTask.\n", /unknown directive wortre \(did you mean worktree\?\)/],
    ["worktre: yes\nTask.\n", /unknown directive worktre \(did you mean worktree\?\)/],
    // A known name in another case, with a value that directive accepts.
    ["Effort: low\nTask.\n", /: directive names are lowercase: write `effort: low`$/],
    ["EFFORT: high\nTask.\n", /write `effort: high`/],
    ["Keep: yes\r\n\r\nTask.\r\n", /write `keep: yes`/],
    ["effort: low\nCwd: none\nTask.\n", /write `cwd: none`/],
    ["effort: low\n\nWrite: yes\nTask.\n", /write `write: yes`/],
    ["\n\nContinue: rq:job-7\nTask.\n", /write `continue: rq:job-7`/],
  ]) {
    assert.throws(() => parseTaskFile(Buffer.from(text)), message, JSON.stringify(text));
  }
  for (const text of [
    "Role: reviewer\nwrite: yes\n",
    "effect: large\nTask.\n",
    "note: hi\n",
    "cmd: run tests\n",
    "cw: none\n",
    "keep in mind: a\n",
    "effort: low\n\nRole: x\n",
    "Task.\n\nwrite: yes is fine inside the text after a first line\n",
    "Write: a parser for X\n",
    "Continue: the work from yesterday.\n",
    "Effort: as much as it takes\n",
    "effort: low\n\nKeep: the tests green\n",
  ]) {
    assert.doesNotThrow(() => parseTaskFile(Buffer.from(text)), JSON.stringify(text));
  }
  assert.deepEqual(parseTaskFile(Buffer.from("Write: a parser for X\n")), {
    directives: {},
    body: "Write: a parser for X\n",
  });
  const f = fixture(t);
  fs.writeFileSync(path.join(f.work, "t.md"), "\nwrite: yes\n\nEdit files.\n");
  const refused = await f.invoke(["--task-file", "t.md", "--role", "gpt-6-1-sol"]);
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(refused.stderr, /directive write comes after a blank line/);
  assert.deepEqual(f.events(), [], "nothing was launched");
  assert.ok(fs.existsSync(path.join(f.work, "t.md")), "a refused task file stays in place");
  fs.writeFileSync(path.join(f.work, "t.md"), "Effort: low\ncwd: none\n\nReply.\n");
  const capitalised = await f.invoke(["--task-file", "t.md", "--role", "gpt-6-1-sol"]);
  assert.equal(capitalised.code, EXIT.FAILURE);
  assert.equal(
    capitalised.stderr,
    "run-codex-task: directive names are lowercase: write `effort: low`\n",
  );
  assert.deepEqual(f.events(), [], "refused before launch");
  assert.ok(fs.existsSync(path.join(f.work, "t.md")));
});

test("--default-keep keeps task-file launches unless the file says keep: no", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.work, "t.md"), "Do it.\n");
  assert.equal(
    (
      await f.invoke([
        "--task-file",
        "t.md",
        "--role",
        "gpt-6-1-sol",
        "--default-keep",
        "--wait-ms",
        "0",
      ])
    ).code,
    0,
  );
  const kept = f.runs()[0];
  assert.equal(f.metadata(kept).keepState, true);
  fs.writeFileSync(path.join(f.work, "t.md"), "keep: no\n\nDo it again.\n");
  assert.equal(
    (
      await f.invoke([
        "--task-file",
        "t.md",
        "--role",
        "gpt-6-1-sol",
        "--default-keep",
        "--wait-ms",
        "0",
      ])
    ).code,
    0,
  );
  assert.deepEqual(f.runs(), [kept], "keep: no wins");
  fs.writeFileSync(path.join(f.work, "t.md"), `continue: ${kept}\n\nAnd once more.\n`);
  const next = await f.invoke([
    "--task-file",
    "t.md",
    "--role",
    "gpt-6-1-sol",
    "--default-keep",
    "--wait-ms",
    "0",
  ]);
  assert.equal(next.code, EXIT.COMPLETED, next.stderr);
  assert.equal(delivered(next.stdout).footer.turn, 2);
  assert.throws(
    () => parseArgs(["--role", "gpt-6-1-sol", "--prompt-file", "p", "--default-keep"]),
    /--default-keep works with --task-file only/,
  );
  assert.equal((await f.invoke(["--close", kept])).code, EXIT.COMPLETED);
});

test("standalone modes take only their own options", () => {
  assert.deepEqual(
    ((o) => [o.mode, o.mine, o.active])(parseArgs(["--list", "--mine", "--active"])),
    ["list", true, true],
  );
  const idle = parseArgs([
    "--close-idle",
    "--older-than",
    "90m",
    "--all-sessions",
    "--dry-run",
    "--quiet",
  ]);
  assert.deepEqual(
    [idle.mode, idle.olderThanMs, idle["all-sessions"], idle["dry-run"]],
    ["close-idle", 5_400_000, true, true],
  );
  assert.equal(parseArgs(["--close-idle"]).olderThanMs, 0);
  const collect = parseArgs([
    "--collect-finished",
    "--older-than",
    "2h",
    "--all-sessions",
    "--dry-run",
  ]);
  assert.deepEqual(
    [collect.mode, collect.olderThanMs, collect["all-sessions"], collect["dry-run"]],
    ["collect-finished", 7_200_000, true, true],
  );
  assert.deepEqual(((o) => [o.mode, o.olderThanMs])(parseArgs(["--sleep-idle", "--quiet"])), [
    "sleep-idle",
    0,
  ]);
  for (const args of [
    ["--collect-finished", "--all-sessions"],
    ["--sleep-idle", "--all-sessions", "--dry-run"],
    ["--sleep-idle", "--mine"],
    ["--collect-finished", "--sleep-idle"],
    ["--collect-finished", "--close-idle"],
    ["--sleep-idle", "--run", KEY],
    ["--collect-finished", "--force"],
    ["--collect-finished", "--wait"],
    ["--sleep-idle", "--older-than", "later"],
  ]) {
    assert.throws(() => parseArgs(args), args.join(" "));
  }
  assert.equal(parseArgs(["--sleep", KEY]).mode, "sleep");
  assert.equal(parseArgs(["--run", "rq:req.1_a-b"]).key, "rq:req.1_a-b");
  for (const args of [
    ["--list", "--quiet"],
    ["--list", "--older-than", "1h"],
    ["--close-idle", "--mine"],
    ["--close-idle", "--all-sessions"],
    ["--close-idle", "--older-than", "soon"],
    ["--mine"],
    ["--dry-run"],
    ["--sleep", KEY, "--write"],
    ["--sleep", KEY, "--detach"],
    ["--run", "rq:"],
    ["--run", "rq:bad id"],
    ["--sleep", KEY, "--close", KEY],
  ]) {
    assert.throws(() => parseArgs(args), args.join(" "));
  }
});

test("on Windows a path override needs a drive or UNC path, so a Git Bash path is refused", async (t) => {
  const { absoluteOverride } = await import("../src/shared/io.mjs");
  const env = {
    DRIVE: "C:\\work\\state",
    SLASHED: "W:/builds/state",
    UNC: "\\\\server\\share\\state",
    POSIX: "/w/builds/state",
    ROOTED: "\\builds\\state",
    RELATIVE: "state",
    EMPTY: "",
  };
  for (const name of ["DRIVE", "SLASHED", "UNC"])
    assert.equal(absoluteOverride(env, name, "win32"), path.win32.resolve(env[name]), name);
  for (const name of ["POSIX", "ROOTED", "RELATIVE", "EMPTY"])
    assert.throws(
      () => absoluteOverride(env, name, "win32"),
      {
        message: `${name} must be an absolute path: on Windows a drive or UNC path, such as D:\\codex-subagents-for-claude-code\\state or \\\\server\\share\\folder, not ${JSON.stringify(env[name])}${name === "POSIX" ? '; use "W:/builds/state" instead of the Git Bash spelling' : ""}`,
      },
      name,
    );
  assert.equal(absoluteOverride(env, "UNSET", "win32"), null);
  for (const [value, expected] of [
    ["/c/work/project with spaces", 'use "C:/work/project with spaces"'],
    ["/D/work/project", 'use "D:/work/project"'],
    ["/c", 'use "C:/"'],
    ["/c/", 'use "C:/"'],
  ])
    assert.throws(
      () => absoluteOverride({ cwd: value }, "cwd", "win32"),
      (error) => error.message.includes(expected),
    );
  assert.equal(absoluteOverride(env, "POSIX", "linux"), path.posix.resolve(env.POSIX));
  assert.throws(() => absoluteOverride(env, "RELATIVE", "linux"), {
    message: "RELATIVE must be an absolute path",
  });
  if (process.platform !== "win32") return;
  // Through the runner, for an override and for Codex's own CODEX_HOME.
  const f = fixture(t);
  for (const [name, value] of [
    ["CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR", "/w/builds/codex-state"],
    ["CODEX_HOME", "/d/codex-home"],
  ]) {
    const result = await f.invoke(["--list"], { env: { ...f.env, [name]: value } });
    assert.equal(result.code, EXIT.FAILURE, name);
    assert.match(result.stderr, new RegExp(`${name} must be an absolute path: on Windows`));
  }
  assert.equal(fs.existsSync(path.resolve("/w/builds/codex-state")), false, "nothing was created");
});

test("native absolute paths reject Windows rooted and drive-relative aliases", async () => {
  const { isAbsolutePath } = await import("../src/shared/io.mjs");
  for (const value of ["/c/Users/example", "/tmp", "\\tmp", "C:relative", "relative", ""])
    assert.equal(isAbsolutePath(value, "win32"), false, value);
  for (const value of ["C:/tmp", "C:\\tmp", "\\\\server\\share\\folder", "//server/share/folder"])
    assert.equal(isAbsolutePath(value, "win32"), true, value);
  assert.equal(isAbsolutePath("/tmp", "linux"), true);
});

test(
  "Windows task and CLI paths refuse Git Bash paths before filesystem access",
  { skip: process.platform !== "win32" },
  () => {
    for (const value of ["/c/Users/example", "/tmp", "\\tmp", "C:relative"]) {
      for (const key of ["cwd", "prompt-file", "output-schema", "commit-trailers"])
        assert.throws(() => applyDirectives({}, { [key]: value }), /absolute/);
      for (const key of ["cwd", "prompt-file", "output-schema", "commit-trailers", "task-file"])
        assert.throws(() => parseArgs([`--${key}`, value]), /drive or UNC/);
      assert.throws(() => parseArgs(["--integrate", KEY, "--target", value]), /drive or UNC/);
    }
    for (const value of ["C:/tmp", "\\\\server\\share\\folder"]) {
      for (const key of ["cwd", "prompt-file", "output-schema", "commit-trailers"])
        assert.equal(applyDirectives({}, { [key]: value })[key], value);
      assert.equal(
        parseArgs(["--model", "m", "--effort", "low", "--prompt-file", "p", "--cwd", value]).cwd,
        value,
      );
    }
    for (const key of ["cwd", "prompt-file", "output-schema", "commit-trailers"]) {
      assert.throws(
        () => applyDirectives({}, { [key]: "/c/work/project" }),
        /use "C:\/work\/project" instead of the Git Bash spelling/,
      );
      assert.throws(
        () => parseArgs([`--${key}`, "/c/work/project"]),
        /use "C:\/work\/project" instead of the Git Bash spelling/,
      );
    }
    assert.throws(() => parseArgs(["--cwd", "relative-folder"]), /drive or UNC/);
    assert.equal(
      parseArgs(["--model", "m", "--effort", "low", "--prompt-file", "relative.md"])["prompt-file"],
      "relative.md",
    );
  },
);
