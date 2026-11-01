import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireWriterLock,
  claimRequest,
  parseArgs,
  workspaceId,
  acquireLock,
} from "../src/index.mjs";

import { sink, delivered, sha256 } from "./support/capture.mjs";
import { SCRIPT } from "./support/cli-adapter.mjs";
import { KEY, TEXT, LAUNCH, ORIGINAL, fixture, launchWith } from "./support/runner-fixture.mjs";
import { fixture as directFixture } from "./support/codex-fixture.mjs";
import { until } from "./support/driver-evidence.mjs";
import { EXIT } from "../src/shared/errors.mjs";

test("run orchestration accepts frozen options and preserves route across repeated requests", async (t) => {
  const f = fixture(t, { status: "running" });
  const { runCommand } = await import("../src/run/runner.mjs");
  const { environmentPaths } = await import("../src/cli/options.mjs");
  const options = Object.freeze(
    parseArgs([...LAUNCH, "--request-id", "immutable-route", "--keep-prompt"]),
  );
  const out = sink(),
    diagnostics = [];
  const invoke = () =>
    runCommand(options, {
      parentEnv: f.env,
      cwd: f.work,
      stdout: out.stream,
      script: SCRIPT,
      paths: environmentPaths(f.env),
      warn: (message) => diagnostics.push(message),
    });
  assert.equal(await invoke(), 3);
  assert.equal(await invoke(), 3);
  await until(() => f.events().some((event) => event.command === "task"));
  assert.equal(options.mode, "launch");
  assert.equal(options.key, undefined);
  assert.equal(f.events().filter((event) => event.command === "task").length, 1);
  assert.ok(diagnostics.some((message) => message.includes("attaching instead of launching")));
});

test("writer and request publication failures release guards and retain recoverable ownerless folders", (t) => {
  const f = fixture(t);
  const folder = path.join(f.state, "writers", `${workspaceId(f.work)}.lock`);
  const claim = path.join(f.state, "requests", "publish-fault.lock");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", function (from, to, ...rest) {
    if ([folder, claim].includes(path.dirname(to)))
      throw Object.assign(new Error("publish failed"), { code: "EIO" });
    return rename.call(this, from, to, ...rest);
  });
  assert.throws(() => acquireWriterLock(f.state, f.work, KEY), /publish failed/);
  assert.throws(() => claimRequest(f.state, "publish-fault", KEY, "digest"), /publish failed/);
  t.mock.restoreAll();
  for (const dir of [folder, claim]) {
    assert.ok(fs.existsSync(dir));
    assert.equal(fs.existsSync(`${dir}.recovery`), false);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(dir, old, old);
  }
  acquireWriterLock(f.state, f.work, KEY);
  assert.equal(claimRequest(f.state, "publish-fault", KEY, "digest").claimed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "owner.json"))).runKey, KEY);
  assert.equal(JSON.parse(fs.readFileSync(path.join(claim, "owner.json"))).promptSha256, "digest");
});

test("keep-state retains the run, continue adds a turn on the same thread, close tears it down", async (t) => {
  const f = fixture(t, { storedJob: { threadId: "thread-abc" } });
  const first = await f.invoke([...LAUNCH, "--keep-state"]);
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  const key = f.runs()[0];
  assert.equal(f.metadata(key).keepState, true);
  assert.equal(delivered(first.stdout).footer.keep, "yes");
  assert.match(
    first.stderr,
    new RegExp(
      `State kept at .*Continue: node '[^']*' --continue ${key} --prompt-file FILE  Close: node '[^']*' --close ${key}`,
    ),
  );
  assert.equal(
    f.events().some((e) => e.command === "cleanup"),
    false,
  );
  fs.writeFileSync(path.join(f.other, "second.md"), "second prompt");
  const second = await f.invoke(
    ["--continue", key, "--prompt-file", "second.md", "--wait-ms", "0"],
    { cwd: f.other },
  );
  assert.equal(second.code, EXIT.COMPLETED, second.stderr);
  const launches = f.events().filter((e) => e.command === "task");
  assert.equal(launches.length, 2);
  assert.deepEqual([launches[0].resume, launches[1].resume], [false, true]);
  assert.equal(launches[1].prompt, "second prompt");
  assert.equal(launches[1].sessionId, launches[0].sessionId, "the same Codex thread is resumed");
  assert.equal(launches[1].sessionId, launches[0].sessionId);
  assert.equal(
    fs.realpathSync.native(launches[1].cwd),
    fs.realpathSync.native(f.work),
    "the workspace stays pinned",
  );
  assert.ok(launches[1].args.includes("gpt-6.1-sol") && launches[1].args.includes("xhigh"));
  assert.equal(launches[1].args.includes("--write"), false);
  assert.equal(
    fs.existsSync(path.join(f.other, "second.md")),
    false,
    "the continued prompt is removed after a confirmed launch",
  );
  const run = f.metadata(key);
  assert.notEqual(run.jobId, run.turns[0].jobId);
  assert.equal(run.turns.length, 1);
  assert.deepEqual(
    [run.turns[0].jobId, run.turns[0].result.status, run.turns[0].result.threadId],
    [run.turns[0].jobId, "completed", "thread-abc"],
  );
  assert.equal(run.keepState, true);
  const footer = delivered(second.stdout).footer;
  assert.deepEqual(
    [footer.turn, footer.job, footer.keep, footer.thread],
    [2, run.jobId, "yes", "thread-abc"],
  );
  for (const name of ["turn-1-prompt.txt", "turn-1-result.txt", "prompt.txt", "result.txt"])
    assert.ok(fs.existsSync(path.join(f.state, key, name)), name);
  assert.equal(
    fs.readFileSync(path.join(f.state, key, "turn-1-prompt.txt"), "utf8"),
    "The exact original prompt: λ.\n",
  );
  assert.equal(f.results().length, 2);
  assert.equal(
    f.events().some((e) => e.command === "cleanup"),
    false,
  );
  const closed = await f.invoke(["--close", key], { cwd: f.other });
  assert.equal(closed.code, EXIT.COMPLETED, closed.stderr);
  assert.match(closed.stderr, /closed; its state was removed/);
  assert.deepEqual(f.runs(), []);
  assert.equal(fs.realpathSync.native(f.events().at(-1).cwd), fs.realpathSync.native(f.work));
  assert.deepEqual(f.runs(), []);
  assert.equal(f.results().length, 2, "durable copies outlive the run");
});

test("continue refuses while the current job has no delivered result", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, EXIT.STILL_RUNNING);
  fs.writeFileSync(path.join(f.work, "second.md"), "second prompt");
  const result = await f.invoke(["--continue", f.runs()[0], "--prompt-file", "second.md"]);
  assert.equal(result.code, EXIT.FAILURE);
  assert.match(result.stderr, /no delivered and stopped result/);
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
  assert.ok(fs.existsSync(path.join(f.work, "second.md")));
  assert.equal(f.metadata().jobId, f.metadata().jobId);
});

test("continue can change model, effort and write mode for the next turn", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, EXIT.COMPLETED);
  fs.writeFileSync(path.join(f.work, "second.md"), "second prompt");
  const result = await f.invoke([
    "--continue",
    f.runs()[0],
    "--prompt-file",
    "second.md",
    "--model",
    "gpt-5.6-sol",
    "--effort",
    "high",
    "--write",
    "--wait-ms",
    "0",
  ]);
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  const launch = f.events().filter((e) => e.command === "task")[1];
  for (const arg of ["--resume", "--write", "gpt-5.6-sol", "high"])
    assert.ok(launch.args.includes(arg), arg);
  const run = f.metadata();
  assert.deepEqual([run.model, run.effort, run.write], ["gpt-5.6-sol", "high", true]);
  assert.deepEqual(
    [run.turns[0].model, run.turns[0].effort, run.turns[0].write],
    ["gpt-6.1-sol", "xhigh", false],
  );
  const footer = delivered(result.stdout).footer;
  assert.deepEqual(
    [footer.model, footer.effort, footer.mode],
    ["gpt-5.6-sol", "high", "workspace-write"],
  );
});

test("run and cancel roll back a switched turn with no driver job", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, 0);
  const { reserveTurn, switchTurn } = await import("../src/state/turn-transition.mjs");
  const { saveRun } = await import("../src/state/run-store.mjs");
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey),
    previous = structuredClone(run);
  for (const mode of ["run", "cancel"]) {
    const save = () => saveRun(run, stateDir);
    reserveTurn(run, save);
    switchTurn(
      run,
      stateDir,
      Buffer.from("never submitted"),
      { model: run.model, effort: run.effort, write: false },
      save,
    );
    const done = await f.invoke([
      `--${mode}`,
      run.runKey,
      ...(mode === "run" ? ["--wait-ms", "0"] : []),
    ]);
    assert.equal(done.code, mode === "cancel" ? 0 : 1, done.stderr);
    assert.match(done.stderr, /was not started/);
    assert.equal(f.metadata().jobId, previous.jobId);
    Object.assign(run, f.metadata());
  }
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
});

test("quiet covers launch, cancel and continue, while close still reports", async (t) => {
  const f = fixture(t, { status: "running" });
  const started = await f.invoke([...LAUNCH, "--quiet", "--keep-state"]);
  assert.equal(started.code, EXIT.STILL_RUNNING, started.stderr);
  assert.equal(started.stderr, "");
  assert.match(started.stdout, /^STILL RUNNING:/);
  const key = f.runs()[0];
  const cancelled = await f.invoke(["--cancel", key]);
  assert.equal(cancelled.code, EXIT.NOT_COMPLETED, cancelled.stderr);
  assert.equal(cancelled.stderr, "", "cancel inherits quiet");
  assert.equal(delivered(cancelled.stdout).footer.status, "cancelled");
  f.configure({ status: "completed" });
  fs.writeFileSync(path.join(f.work, "second.md"), "second prompt");
  const next = await f.invoke(["--continue", key, "--prompt-file", "second.md", "--wait-ms", "0"]);
  assert.equal(next.code, EXIT.COMPLETED, next.stderr);
  assert.equal(next.stderr, "", "continue inherits quiet");
  assert.equal(delivered(next.stdout).footer.turn, 2);
  const closed = await f.invoke(["--close", key]);
  assert.equal(closed.code, EXIT.COMPLETED, closed.stderr);
  assert.match(closed.stderr, /closed; its state was removed/);
  assert.deepEqual(f.runs(), []);
});

test("task-file mode drives continue, cancel and close through directives and rejects bad combinations", async (t) => {
  const f = fixture(t, { status: "running" });
  fs.writeFileSync(path.join(f.work, "t1.md"), "keep: yes\nfirst\n");
  assert.equal(
    (await f.invoke(["--role", "gpt-6-1-sol", "--task-file", "t1.md", "--wait-ms", "0"])).code,
    3,
  );
  const key = f.runs()[0];
  fs.writeFileSync(path.join(f.work, "t2.md"), `cancel: ${key}\n`);
  const cancelled = await f.invoke(["--role", "gpt-6-1-sol", "--task-file", "t2.md"]);
  assert.equal(cancelled.code, EXIT.NOT_COMPLETED, cancelled.stderr);
  assert.equal(delivered(cancelled.stdout).footer.status, "cancelled");
  assert.equal(
    fs.existsSync(path.join(f.work, "t2.md")),
    false,
    "lifecycle task files are consumed too",
  );
  f.configure({ status: "completed" });
  fs.writeFileSync(path.join(f.work, "t3.md"), `continue: ${key}\neffort: low\nsecond\n`);
  const next = await f.invoke(["--role", "gpt-6-1-sol", "--task-file", "t3.md", "--wait-ms", "0"]);
  assert.equal(next.code, EXIT.COMPLETED, next.stderr);
  const launches = f.events().filter((e) => e.command === "task");
  assert.deepEqual(
    [launches[1].resume, launches[1].prompt, launches[1].args.includes("low")],
    [true, "second\n", true],
  );
  assert.equal(delivered(next.stdout).footer.turn, 2);
  fs.writeFileSync(path.join(f.work, "t3b.md"), `continue: ${key}\nthird\n`);
  const third = await f.invoke([
    "--role",
    "gpt-5-6-sol",
    "--task-file",
    "t3b.md",
    "--wait-ms",
    "0",
  ]);
  assert.equal(third.code, EXIT.COMPLETED, third.stderr);
  const turn3 = f.events().filter((e) => e.command === "task")[2];
  assert.ok(
    turn3.args.includes("low") &&
      turn3.args.includes("gpt-5.6-sol") &&
      !turn3.args.includes("xhigh") &&
      !turn3.args.includes("gpt-6.1-sol"),
    "an explicit continuation role changes its model while preserving the stored effort",
  );
  assert.deepEqual(
    [
      delivered(third.stdout).footer.turn,
      delivered(third.stdout).footer.effort,
      delivered(third.stdout).footer.model,
    ],
    [3, "low", "gpt-5.6-sol"],
  );
  fs.writeFileSync(path.join(f.work, "t5.md"), `close: ${key}\nkeep: yes\n`);
  const bad = await f.invoke(["--role", "gpt-6-1-sol", "--task-file", "t5.md"]);
  assert.equal(bad.code, EXIT.FAILURE);
  assert.match(bad.stderr, /directive keep cannot be combined with close/);
  assert.ok(
    fs.existsSync(path.join(f.work, "t5.md")),
    "a rejected task file is left for inspection",
  );
  fs.writeFileSync(path.join(f.work, "t4.md"), `close: ${key}\n`);
  assert.equal(
    (await f.invoke(["--role", "gpt-6-1-sol", "--task-file", "t4.md"])).code,
    EXIT.COMPLETED,
  );
  assert.deepEqual(f.runs(), []);
  assert.equal(fs.existsSync(path.join(f.work, "t4.md")), false);
});

test("a repeated request ID attaches to the retained run, replays a finished one, and refuses a different task", async (t) => {
  const f = fixture(t, { status: "running" });
  const first = await f.invoke([...LAUNCH, "--request-id", "req-1"]);
  assert.equal(first.code, EXIT.STILL_RUNNING, first.stderr);
  const key = f.runs()[0];
  assert.equal(f.metadata(key).requestId, "req-1");
  assert.ok(
    fs.existsSync(path.join(f.state, "requests", "req-1.lock")),
    "the ID is claimed while the run is retained",
  );
  fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
  const again = await f.invoke([...LAUNCH, "--request-id", "req-1"]);
  assert.equal(again.code, EXIT.STILL_RUNNING, again.stderr);
  assert.match(again.stderr, /Request req-1 is run [0-9a-f]{32}; attaching instead of launching/);
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
  assert.deepEqual(f.runs(), [key]);
  assert.ok(
    fs.existsSync(path.join(f.work, "prompt.md")),
    "a joined request's prompt is not consumed",
  );
  fs.writeFileSync(path.join(f.work, "prompt.md"), "a different task");
  const different = await f.invoke([...LAUNCH, "--request-id", "req-1"]);
  assert.equal(different.code, EXIT.FAILURE);
  assert.match(
    different.stderr,
    /request req-1 was already used for a different task \(prompt, model, effort, write mode or workspace\); choose a new request ID/,
  );
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
  f.configure({ status: "completed" });
  fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
  const done = await f.invoke([...LAUNCH, "--request-id", "req-1"]);
  assert.equal(done.code, EXIT.COMPLETED, done.stderr);
  assert.equal(delivered(done.stdout).footer.request, "req-1");
  assert.deepEqual(f.runs(), []);
  assert.equal(
    fs.existsSync(path.join(f.state, "requests", "req-1.lock")),
    false,
    "the claim goes with the run",
  );
  assert.match(f.results()[0], /-rq-req-1-h3-[0-9a-f]{64}\.md$/);
  const replay = await f.invoke([...LAUNCH, "--request-id", "req-1"]);
  assert.equal(replay.code, EXIT.COMPLETED, replay.stderr);
  assert.match(
    replay.stdout,
    /^codex-subagents-for-claude-code-replay: request req-1 was delivered earlier; not relaunched\n/,
  );
  const shown = delivered(replay.stdout);
  assert.deepEqual(
    [
      shown.body.replace(/^codex-subagents-for-claude-code-replay: [^\n]*\n/, ""),
      shown.footer.request,
      shown.footer.omitted,
      shown.footer.job,
    ],
    [TEXT, "req-1", 0, f.metadata().jobId],
  );
  assert.equal(f.events().filter((e) => e.command === "task").length, 1, "still a single launch");
  assert.ok(
    fs.existsSync(path.join(f.work, "prompt.md")),
    "a replayed command-line prompt is not consumed",
  );
  fs.writeFileSync(path.join(f.work, "task.md"), `request-id: req-1\nkeep: no\n${ORIGINAL}`);
  const replayed = await f.invoke([
    "--role",
    "gpt-6-1-sol",
    "--task-file",
    "task.md",
    "--max-stdout-lines",
    "1",
  ]);
  assert.equal(replayed.code, EXIT.COMPLETED, replayed.stderr);
  assert.match(replayed.stdout, /^codex-subagents-for-claude-code-replay: /);
  assert.equal(
    fs.existsSync(path.join(f.work, "task.md")),
    false,
    "a replayed task file is consumed",
  );
  assert.equal(
    fs.existsSync(path.join(f.state, "requests", "req-1.lock")),
    false,
    "a replay leaves no claim behind",
  );
  fs.writeFileSync(path.join(f.work, "prompt.md"), "a different task");
  const reused = await f.invoke([...LAUNCH, "--request-id", "req-1"]);
  assert.equal(reused.code, EXIT.FAILURE);
  assert.match(reused.stderr, /already used for a different task/);
  assert.equal(fs.existsSync(path.join(f.state, "requests", "req-1.lock")), false);
  const other = await f.invoke([...LAUNCH, "--request-id", "req-2"]);
  assert.equal(other.code, EXIT.COMPLETED, other.stderr);
  assert.equal(
    f.events().filter((e) => e.command === "task").length,
    2,
    "a different request launches",
  );
});

test("two simultaneous launches with one request ID produce a single job", async (t) => {
  const f = fixture(t, { status: "running" });
  fs.writeFileSync(path.join(f.work, "second.md"), ORIGINAL);
  const secondArgs = LAUNCH.map((value) => (value === "prompt.md" ? "second.md" : value));
  const results = await Promise.all([
    f.invoke([...LAUNCH, "--request-id", "same"]),
    f.invoke([...secondArgs, "--request-id", "same"]),
  ]);
  assert.equal(
    f.events().filter((e) => e.command === "task").length,
    1,
    results.map((r) => r.stderr).join("\n"),
  );
  assert.equal(f.runs().length, 1);
  // The race is never an error: both wait like any waiter, and the budget of 0 ends with exit 3.
  assert.deepEqual(
    results.map((r) => r.code),
    [3, 3],
    results.map((r) => r.stderr).join("\n"),
  );
  for (const r of results)
    assert.match(r.stdout, /^STILL RUNNING: .* Wait again with: node .* --run [0-9a-f]{32}\n/);
  assert.ok(fs.existsSync(path.join(f.state, "requests", "same.lock")));
});

test("three simultaneous launches with one request ID run one job and all print its result", async (t) => {
  // A slow launch answer keeps the claimant's record without a job for a while.
  const f = fixture(t, { launchDelayMs: 1500 });
  const files = [1, 2, 3].map((n) => {
    const file = path.join(f.work, `same-${n}.md`);
    fs.writeFileSync(file, "request-id: same-three\neffort: low\n\nThe same task.\n");
    return file;
  });
  const launches = await Promise.all(
    files.map((file) =>
      f.cli(["--model", "gpt-6.1-sol", "--effort", "xhigh", "--task-file", file, "--wait"], {
        timeoutMs: 60_000,
      }),
    ),
  );
  for (const launch of launches) {
    assert.equal(launch.status, EXIT.COMPLETED, launch.stderr);
    const { body, footer } = delivered(
      launch.stdout.replace(/^codex-subagents-for-claude-code-replay: .*\n/, ""),
    );
    assert.deepEqual([body, footer.job, footer.request], [TEXT, f.metadata().jobId, "same-three"]);
  }
  assert.equal(f.events().filter((e) => e.command === "task").length, 1, "one job");
  assert.deepEqual(f.runs(), []);
});

test("a request-ID run without a durable copy is kept so a repeat attaches instead of relaunching", async (t) => {
  const f = fixture(t);
  const env = {
    ...f.env,
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: path.join(f.root, "control.json"),
  };
  const first = await f.invoke([...LAUNCH, "--request-id", "nocopy"], { env });
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  assert.match(
    first.stderr,
    /State kept .*: without a durable copy this run's cached result is the only one, and it keeps request nocopy deduplicated/,
  );
  assert.equal(f.runs().length, 1);
  assert.ok(fs.existsSync(path.join(f.state, "requests", "nocopy.lock")));
  assert.equal(
    f.events().some((e) => e.command === "cleanup"),
    false,
  );
  fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
  const again = await f.invoke([...LAUNCH, "--request-id", "nocopy"], { env });
  assert.equal(again.code, EXIT.COMPLETED, again.stderr);
  assert.equal(delivered(again.stdout).body, TEXT);
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
  assert.equal((await f.invoke(["--close", f.runs()[0]], { env })).code, EXIT.COMPLETED);
  assert.deepEqual(f.runs(), []);
  assert.equal(fs.existsSync(path.join(f.state, "requests", "nocopy.lock")), false);
});

test("continuing archives by copying, so an interruption never strands the recorded result", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, EXIT.COMPLETED);
  const key = f.runs()[0];
  f.configure({ status: "running" });
  fs.writeFileSync(path.join(f.work, "second.md"), "second");
  assert.equal(
    (await f.invoke(["--continue", key, "--prompt-file", "second.md", "--wait-ms", "0"])).code,
    3,
  );
  for (const name of ["turn-1-prompt.txt", "turn-1-result.txt", "result.txt", "prompt.txt"])
    assert.ok(fs.existsSync(path.join(f.state, key, name)), name);
  assert.equal(fs.readFileSync(path.join(f.state, key, "turn-1-prompt.txt"), "utf8"), ORIGINAL);
  assert.equal(fs.readFileSync(path.join(f.state, key, "prompt.txt"), "utf8"), "second");
  assert.equal(f.metadata(key).result, undefined);
  assert.equal(
    f.metadata(key).continuing,
    undefined,
    "the reservation ends when the turn launches",
  );
  f.configure({ status: "completed" });
  assert.equal((await f.invoke(["--run", key, "--wait-ms", "0"])).code, EXIT.COMPLETED);
  assert.equal((await f.invoke(["--close", key])).code, EXIT.COMPLETED);
});

test("replay compares the full prompt digest, so a colliding prefix is not enough", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.work, "prompt.md"), "review-task-44695");
  assert.equal((await f.invoke([...LAUNCH, "--request-id", "same"])).code, EXIT.COMPLETED);
  assert.match(f.results()[0], /-rq-same-h3-[0-9a-f]{64}\.md$/);
  fs.writeFileSync(path.join(f.work, "prompt.md"), "review-task-52227");
  const other = await f.invoke([...LAUNCH, "--request-id", "same"]);
  assert.equal(other.code, EXIT.FAILURE);
  assert.match(other.stderr, /request same was already used for a different task/);
  assert.equal(f.events().filter((e) => e.command === "task").length, 1);
  fs.writeFileSync(path.join(f.work, "prompt.md"), "review-task-44695");
  const replay = await f.invoke([...LAUNCH, "--request-id", "same"]);
  assert.equal(replay.code, EXIT.COMPLETED, replay.stderr);
  assert.match(replay.stdout, /^codex-subagents-for-claude-code-replay: /);
});

test("detach launches without waiting, prints one receipt, a repeated request reports the same run, and --run delivers later", async (t) => {
  const f = fixture(t, { status: "running" });
  const launch = [
    "--model",
    "gpt-6.1-sol",
    "--effort",
    "xhigh",
    "--prompt-file",
    "prompt.md",
    "--request-id",
    "detach-1",
  ];
  const receipt = await f.invoke([...launch, "--detach", "--relay"]);
  assert.equal(receipt.code, EXIT.COMPLETED, receipt.stderr);
  const key = f.runs()[0];
  assert.match(
    receipt.stdout,
    new RegExp(
      `^codex-subagents-for-claude-code-launched: run=${key} turn=1 job=${f.metadata().jobId} model=gpt-6\\.1-sol effort=xhigh mode=read-only ` +
        `request=detach-1 attach=node .* --attach ${f.metadata().jobId} --run ${key}\\n$`,
    ),
  );
  assert.equal(
    fs.existsSync(path.join(f.work, "prompt.md")),
    false,
    "a confirmed launch consumes the prompt file",
  );
  assert.equal(f.metadata(key).result, undefined, "nothing was delivered yet");
  fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
  const repeat = await f.invoke([...launch, "--detach"]);
  assert.equal(repeat.code, EXIT.COMPLETED, repeat.stderr);
  assert.match(
    repeat.stdout,
    new RegExp(
      `^codex-subagents-for-claude-code-launched: run=${key} turn=1 job=${f.metadata().jobId} .* request=detach-1 existing=yes attach=node .*\\n$`,
    ),
  );
  assert.equal(
    f.events().filter((event) => event.command === "task").length,
    1,
    "the repeat launched nothing",
  );
  f.configure({ status: "failed" });
  const later = await f.invoke(["--run", key, "--wait-ms", "0"]);
  assert.equal(later.code, EXIT.COMPLETED, "relay was recorded at launch");
  assert.deepEqual(
    [delivered(later.stdout).body, delivered(later.stdout).footer.status],
    [`${TEXT.trimEnd()}\n\nCODEX_RPC_ERROR: Fixture turn failed\n`, "failed"],
  );
  assert.deepEqual(f.runs(), []);
});

test("continue --detach starts the next turn and returns its receipt; a cancel directive refuses --detach", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, EXIT.COMPLETED);
  const key = f.runs()[0];
  f.configure({ status: "running" });
  fs.writeFileSync(path.join(f.work, "next.md"), "next turn\n");
  const receipt = await f.invoke(["--continue", key, "--prompt-file", "next.md", "--detach"]);
  assert.equal(receipt.code, EXIT.COMPLETED, receipt.stderr);
  assert.match(
    receipt.stdout,
    new RegExp(
      `^codex-subagents-for-claude-code-launched: run=${key} turn=2 job=task-[0-9a-f]+ .*attach=node .* --attach task-[0-9a-f]+ --run ${key}\\n$`,
    ),
  );
  fs.writeFileSync(path.join(f.work, "t.md"), `cancel: ${key}\n`);
  const refused = await f.invoke(["--task-file", "t.md", "--role", "gpt-6-1-sol", "--detach"]);
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(refused.stderr, /--detach cannot be used with a cancel directive/);
  f.configure({ status: "completed" });
  const later = await f.invoke(["--run", key, "--wait-ms", "0"]);
  assert.equal(later.code, EXIT.COMPLETED, later.stderr);
  assert.equal(delivered(later.stdout).footer.turn, 2);
  assert.equal((await f.invoke(["--close", key])).code, EXIT.COMPLETED);
});

test("a request ID on continue makes that turn retry-safe", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, EXIT.COMPLETED);
  const key = f.runs()[0];
  fs.writeFileSync(path.join(f.work, "next.md"), "next turn\n");
  const first = await f.invoke([
    "--continue",
    key,
    "--prompt-file",
    "next.md",
    "--request-id",
    "turn-2",
    "--keep-prompt",
    "--wait-ms",
    "0",
  ]);
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  assert.equal(delivered(first.stdout).footer.turn, 2);
  const again = await f.invoke([
    "--continue",
    key,
    "--prompt-file",
    "next.md",
    "--request-id",
    "turn-2",
    "--wait-ms",
    "0",
  ]);
  assert.equal(again.code, EXIT.COMPLETED, again.stderr);
  assert.equal(delivered(again.stdout).footer.turn, 2, "the repeat re-delivers turn 2");
  assert.equal(
    f.events().filter((event) => event.command === "task").length,
    2,
    "no third turn was started",
  );
  fs.writeFileSync(path.join(f.work, "other.md"), "a different turn\n");
  const clash = await f.invoke([
    "--continue",
    key,
    "--prompt-file",
    "other.md",
    "--request-id",
    "turn-2",
  ]);
  assert.equal(clash.code, EXIT.FAILURE);
  assert.match(clash.stderr, /request turn-2 was already used for a different turn/);
  const third = await f.invoke([
    "--continue",
    key,
    "--prompt-file",
    "other.md",
    "--request-id",
    "turn-3",
    "--wait-ms",
    "0",
  ]);
  assert.equal(delivered(third.stdout).footer.turn, 3);
  fs.writeFileSync(path.join(f.work, "next.md"), "next turn\n");
  const stale = await f.invoke([
    "--continue",
    key,
    "--prompt-file",
    "next.md",
    "--request-id",
    "turn-2",
  ]);
  assert.equal(stale.code, EXIT.FAILURE);
  assert.match(
    stale.stderr,
    /request turn-2 was turn 2 of run [0-9a-f]{32}, which has later turns since/,
  );
  assert.equal((await f.invoke(["--close", key])).code, EXIT.COMPLETED);
});

test("rq:<request id> names the run that holds a request, and replays its copy once that run is gone", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--request-id", "handle-1"])).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  f.configure({ status: "completed" });
  const attached = await f.invoke(["--run", "rq:handle-1", "--wait-ms", "0"]);
  assert.equal(attached.code, EXIT.COMPLETED, attached.stderr + attached.stdout);
  assert.equal(delivered(attached.stdout).footer.run, key);
  assert.deepEqual(f.runs(), []);
  const replayed = await f.invoke(["--run", "rq:handle-1"]);
  assert.equal(replayed.code, EXIT.COMPLETED, replayed.stderr);
  assert.match(
    replayed.stdout,
    /^codex-subagents-for-claude-code-replay: request handle-1 was delivered earlier/,
  );
  const closed = await f.invoke(["--close", "rq:handle-1"]);
  assert.equal(closed.code, EXIT.FAILURE);
  assert.match(closed.stderr, /request handle-1 names no retained run; it was delivered, see /);
  assert.match(
    (await f.invoke(["--run", "rq:never-used"])).stderr,
    /request never-used names no retained run/,
  );
});

test("delivery overrides given on an attach are recorded even when the job is still running", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke()).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  assert.equal(
    (
      await f.invoke([
        "--run",
        key,
        "--quiet",
        "--relay",
        "--max-stdout-lines",
        "1",
        "--max-stdout-bytes",
        "10",
        "--wait-ms",
        "0",
      ])
    ).code,
    3,
  );
  const run = f.metadata(key);
  assert.deepEqual(
    [run.quiet, run.relay, run.maxStdoutLines, run.maxStdoutBytes],
    [true, true, 1, 10],
  );
  f.configure({ status: "failed" });
  const result = await f.invoke(f.resume());
  assert.equal(result.stderr, "", "the recorded quiet setting applies");
  assert.equal(result.code, EXIT.COMPLETED, "the recorded relay setting applies");
  const shown = delivered(result.stdout);
  assert.deepEqual(
    [shown.body, shown.footer.omitted, shown.footer.status],
    ["", 3, "failed"],
    "the recorded byte cap applies: the footer alone exceeds 10 bytes, so no text is shown",
  );
  assert.match(
    shown.notice,
    /^codex-subagents-for-claude-code-omitted: 3 lines not shown; full text in /,
  );
});

// Strict headers, read-only worktrees, version-2 request digests, rq: handles,
// patient attach, session-scoped list and close-idle, sleeping kept runs,
// --default-keep.

test("an attach waits for a live waiter within its budget, and replays the job's copy when that waiter removed the run", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke()).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  const hold = acquireLock(f.state, key); // this test process plays the other waiter
  let busy;
  try {
    busy = await f.invoke(["--run", key, "--wait-ms", "1200"]);
  } finally {
    hold();
  }
  assert.equal(busy.code, EXIT.STILL_RUNNING, busy.stderr);
  assert.match(
    busy.stdout,
    new RegExp(
      `^STILL RUNNING: Codex job ${f.metadata().jobId} is being delivered by another waiter \\(PID ${process.pid}\\)\\. ` +
        `Wait again with: node .* --attach ${f.metadata().jobId} --run ${key}\\ncodex-subagents-for-claude-code-progress: phase=other-waiter elapsed=- last=PID ${process.pid} holds this run\\n$`,
    ),
  );
  const again = acquireLock(f.state, key);
  const waiting = f.invoke(["--run", key, "--wait-ms", "8000"]);
  await delay(1500);
  fs.mkdirSync(f.resultsDir, { recursive: true });
  const copy = path.join(f.resultsDir, `20261024T000000Z-gpt-6.1-sol-${f.metadata().jobId}.md`);
  fs.writeFileSync(
    copy,
    `${TEXT}codex-subagents-for-claude-code: status=completed run=${key} turn=1 job=${f.metadata().jobId} thread=- model=gpt-6.1-sol effort=xhigh mode=read-only ` +
      `duration=1s touched=0 omitted=0 request=- branch=- commit=- keep=no tokens=- limit=- result=${copy}\n`,
  );
  fs.rmSync(path.join(f.state, key), { recursive: true, force: true });
  again();
  const result = await waiting;
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(
      `^codex-subagents-for-claude-code-replay: job ${f.metadata().jobId} was delivered earlier; not relaunched\\n`,
    ),
  );
  assert.equal(
    delivered(result.stdout).body,
    `codex-subagents-for-claude-code-replay: job ${f.metadata().jobId} was delivered earlier; not relaunched\n${TEXT}`,
  );
  assert.equal(
    fs.existsSync(path.join(f.state, `${key}.lock`)),
    false,
    "the waiter released the lock it took",
  );
  const late = await f.invoke(["--attach", f.metadata().jobId, "--run", key]);
  assert.equal(late.code, EXIT.COMPLETED, late.stderr);
  assert.match(
    late.stdout,
    /^codex-subagents-for-claude-code-replay: job /,
    "a removed run with a known job replays its copy",
  );
});

test("request digest naming keeps persisted claim fields and warning output unchanged", async (t) => {
  const f = fixture(t);
  claimRequest(f.state, "persisted-names", KEY, "f".repeat(64));
  const owner = JSON.parse(
    fs.readFileSync(path.join(f.state, "requests", "persisted-names.lock", "owner.json")),
  );
  assert.deepEqual(Object.keys(owner).sort(), [
    "createdAt",
    "digestVersion",
    "launchState",
    "pid",
    "processStart",
    "promptSha256",
    "runKey",
  ]);
  assert.equal(owner.promptSha256, "f".repeat(64));
  assert.equal(owner.launchState, "undispatched");
  const result = await f.invoke([...LAUNCH, "--quiet"], {
    env: {
      ...f.env,
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: path.join(f.root, "control.json"),
    },
  });
  assert.equal(result.code, EXIT.COMPLETED);
  // The same unwritable results root also prevents the new invocation audit.
  // Both warnings keep the established prefix; their order is not this test's contract.
  assert.match(result.stderr, /^run-codex-task: Could not write the invocation audit log:/m);
  assert.match(result.stderr, /^run-codex-task: Could not write the durable result copy:/m);
  for (const warning of result.stderr.trim().split("\n"))
    assert.match(warning, /^run-codex-task: /);
});

test("a request claim is released with its run, and a stale empty claim is reclaimed while a fresh one blocks", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--request-id", "rq-x"])).code, EXIT.COMPLETED);
  assert.equal(fs.existsSync(path.join(f.state, "requests", "rq-x.lock")), false);
  const stale = path.join(f.state, "requests", "stale.lock");
  fs.mkdirSync(stale, { recursive: true });
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(stale, old, old);
  fs.writeFileSync(path.join(f.work, "prompt.md"), "again");
  const reclaimed = await f.invoke([...LAUNCH, "--request-id", "stale"]);
  assert.equal(reclaimed.code, EXIT.COMPLETED, reclaimed.stderr);
  fs.mkdirSync(path.join(f.state, "requests", "fresh.lock"), { recursive: true });
  fs.writeFileSync(path.join(f.work, "prompt.md"), "again");
  const blocked = await f.invoke([...LAUNCH, "--request-id", "fresh"]);
  // A claim still being written is a launcher still starting: waited for, here with no budget.
  assert.equal(blocked.code, EXIT.STILL_RUNNING, blocked.stderr);
  assert.match(
    blocked.stdout,
    /^STILL RUNNING: request fresh is being launched by another process\. Wait again with: node .* --run rq:fresh\ncodex-subagents-for-claude-code-progress: phase=other-launcher /,
  );
  assert.equal(f.events().filter((e) => e.command === "task").length, 2);
  assert.ok(fs.existsSync(path.join(f.work, "prompt.md")));
});

test("request resolution releases its claim when run-directory creation fails", async (t) => {
  const f = fixture(t);
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", function (dir, ...args) {
    if (path.dirname(dir) === f.state && /^[0-9a-f]{32}$/.test(path.basename(dir)))
      throw new Error("injected run directory failure");
    return mkdir.call(this, dir, ...args);
  });
  const refused = await f.invoke([...LAUNCH, "--request-id", "creation-failure"]);
  t.mock.restoreAll();
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(refused.stderr, /injected run directory failure/);
  assert.deepEqual(f.runs(), []);
  assert.deepEqual(fs.readdirSync(path.join(f.state, "requests")), []);
  assert.deepEqual(f.events(), []);
  assert.equal(
    (await f.invoke([...LAUNCH, "--request-id", "creation-failure"])).code,
    EXIT.COMPLETED,
  );
});

test("request IDs cover full current task identity and reject obsolete digest claims and copies", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--request-id", "v2-a"])).code, EXIT.COMPLETED);
  assert.equal(
    f.results().filter((name) => name.includes("-rq-v2-a-h3-")).length,
    1,
    "version-3 copies carry -h3-",
  );
  for (const changed of [
    launchWith("gpt-5.6-sol"),
    launchWith("gpt-6.1-sol", "low"),
    launchWith("gpt-6.1-sol", "xhigh", ["--write"]),
    [...LAUNCH, "--quota-floor", "5"],
  ]) {
    fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
    const refused = await f.invoke([...changed, "--request-id", "v2-a"]);
    assert.equal(refused.code, EXIT.FAILURE, changed.join(" "));
    assert.match(refused.stderr, /request v2-a was already used for a different task/);
  }
  fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
  const replayed = await f.invoke([...LAUNCH, "--request-id", "v2-a"]);
  assert.equal(replayed.code, EXIT.COMPLETED, replayed.stderr);
  assert.match(
    replayed.stdout,
    /^codex-subagents-for-claude-code-replay: request v2-a was delivered earlier/,
  );
  // A prompt-only digest cannot prove the settings of a repeated request.
  const invalidCopy = path.join(
    f.resultsDir,
    `20261023T000000Z-gpt-6.1-sol-task-old-rq-v1-a-h${sha256(ORIGINAL)}.md`,
  );
  fs.writeFileSync(
    invalidCopy,
    `old answer\ncodex-subagents-for-claude-code: status=completed run=${"b".repeat(32)} turn=1 job=task-old thread=- model=gpt-6.1-sol effort=xhigh ` +
      `mode=read-only duration=1s touched=0 omitted=0 request=v1-a branch=- commit=- keep=no result=${invalidCopy}\n`,
  );
  fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
  const old = await f.invoke([...launchWith("gpt-5.6-sol", "low"), "--request-id", "v1-a"]);
  assert.equal(old.code, EXIT.FAILURE, old.stderr);
  assert.match(old.stderr, /unsupported digest copy/);
  // An unversioned claim cannot prove the settings either.
  f.configure({ status: "running" });
  fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
  assert.equal((await f.invoke([...LAUNCH, "--request-id", "v1-claim"])).code, EXIT.STILL_RUNNING);
  const owner = path.join(f.state, "requests", "v1-claim.lock", "owner.json");
  const claim = JSON.parse(fs.readFileSync(owner, "utf8"));
  fs.writeFileSync(
    owner,
    JSON.stringify({
      runKey: claim.runKey,
      promptSha256: sha256(ORIGINAL),
      pid: claim.pid,
      createdAt: claim.createdAt,
    }),
  );
  fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
  const attached = await f.invoke([...LAUNCH, "--request-id", "v1-claim"]);
  assert.equal(attached.code, EXIT.FAILURE, attached.stderr);
  assert.match(
    attached.stderr,
    /request v1-claim has an unsupported request digest; inspect the saved claim and result files before retrying/,
  );
  assert.equal(
    f.events().filter((event) => event.command === "task").length,
    2,
    "only two real launches",
  );
});

test("an unsupported-digest durable copy refuses replay and never dispatches another task", async (t) => {
  const f = directFixture(t);
  const first = await f.invoke([
    ...LAUNCH.slice(0, -2),
    "--wait-ms",
    "8000",
    "--request-id",
    "unsupported-copy",
  ]);
  assert.equal(first.code, 0, first.stderr);
  const [current] = f.results();
  assert.match(current, /-h3-[0-9a-f]{64}\.md$/);
  const invalidCopy = current.replace(/-h3-[0-9a-f]{64}\.md$/, `-h999-${"2".repeat(64)}.md`);
  fs.renameSync(path.join(f.resultsDir, current), path.join(f.resultsDir, invalidCopy));
  const bytes = fs.readFileSync(path.join(f.resultsDir, invalidCopy), "utf8");
  fs.writeFileSync(path.join(f.work, "prompt.md"), ORIGINAL);
  const repeated = await f.invoke([...LAUNCH, "--request-id", "unsupported-copy"]);
  assert.equal(repeated.code, 1, repeated.stderr);
  assert.match(repeated.stderr, /request unsupported-copy has an unsupported digest copy/);
  assert.doesNotMatch(repeated.stderr, /different task/);
  assert.equal(fs.existsSync(path.join(f.state, "requests", "unsupported-copy.lock")), false);
  const replay = await f.invoke(["--run", "rq:unsupported-copy"]);
  assert.equal(replay.code, 1, replay.stderr);
  assert.match(replay.stderr, /unsupported digest copy/);
  assert.equal(fs.readFileSync(path.join(f.resultsDir, invalidCopy), "utf8"), bytes);
  assert.equal(f.events().filter((event) => event.method === "turn/start").length, 1);
  assert.equal(fs.readFileSync(path.join(f.work, "prompt.md"), "utf8"), ORIGINAL);
});

test("a request ID still claimed with an unsupported digest explains the format mismatch and keeps its claim and live job", async (t) => {
  const f = directFixture(t, { status: "running" });
  assert.equal(
    (
      await f.invoke([
        ...LAUNCH.slice(0, -2),
        "--detach",
        "--request-id",
        "unsupported-claim",
        "--keep-prompt",
      ])
    ).code,
    0,
  );
  const run = f.metadata(),
    ownerFile = path.join(f.state, "requests", "unsupported-claim.lock", "owner.json");
  await until(() => f.events().some((event) => event.method === "turn/start"));
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  fs.writeFileSync(
    ownerFile,
    JSON.stringify({ ...owner, digestVersion: 999, promptSha256: "2".repeat(64) }),
  );
  const before = fs.readFileSync(ownerFile, "utf8");
  const repeated = await f.invoke([...LAUNCH, "--request-id", "unsupported-claim"]);
  assert.equal(repeated.code, 1, repeated.stderr);
  assert.match(
    repeated.stderr,
    /has an unsupported request digest; inspect the saved claim and result files before retrying/,
  );
  assert.doesNotMatch(repeated.stderr, /different task/);
  assert.equal(fs.readFileSync(ownerFile, "utf8"), before);
  assert.equal(f.metadata().jobId, run.jobId);
  assert.equal(f.events().filter((event) => event.method === "turn/start").length, 1);
  f.configure({ status: "completed" });
  assert.equal((await f.invoke(["--run", run.runKey, "--wait-ms", "8000"])).code, 0);
});

test("a repeated request whose claimant is still starting is waited for, ends with exit 3 and a working attach command, and is refused only when that claimant died", async (t) => {
  const f = directFixture(t, { status: "running" });
  const args = [...LAUNCH, "--request-id", "starting", "--keep-prompt"];
  assert.equal((await f.invoke(args)).code, 3);
  await until(() => f.events().some((e) => e.method === "turn/start"));
  const run = f.metadata(),
    file = path.join(f.state, run.runKey, "run.json");
  const saved = fs.readFileSync(file);
  fs.rmSync(file);
  const waits = [];
  let clock = Date.now();
  const waiting = await f.invoke(args.slice(0, 7).concat("400", args.slice(8)), {
    timing: {
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    },
  });
  assert.equal(waiting.code, 3, waiting.stderr);
  assert.ok(waits.length);
  assert.match(
    waiting.stdout,
    new RegExp(`as run ${run.runKey}\\. Wait again with: node .* --run ${run.runKey}\\n`),
  );
  assert.match(waiting.stdout, /phase=other-launcher/);
  assert.equal(f.events().filter((e) => e.method === "turn/start").length, 1);
  const claim = path.join(f.state, "requests", "starting.lock", "owner.json");
  const owner = JSON.parse(fs.readFileSync(claim));
  fs.writeFileSync(claim, JSON.stringify({ ...owner, processStart: "a previous claimant" }));
  const refused = await f.invoke(args);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /ended before it recorded its run/);
  fs.writeFileSync(claim, JSON.stringify(owner));
  fs.writeFileSync(file, saved);
  f.configure({ status: "completed" });
  const attached = await f.invoke(["--run", run.runKey, "--wait-ms", "8000"]);
  assert.equal(attached.code, 0, attached.stderr);
  assert.equal(delivered(attached.stdout).footer.request, "starting");
});

for (const durable of [true, false])
  test(`a refused continued launch rolls back its delivered run and keep preference (durable=${durable})`, async (t) => {
    const f = fixture(t);
    const env = durable
      ? f.env
      : { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: f.controlFile };
    assert.equal(
      (await f.invoke([...LAUNCH, ...(durable ? ["--keep-state"] : [])], { env })).code,
      0,
    );
    const previous = f.metadata();
    fs.appendFileSync(f.executable, "\n");
    fs.writeFileSync(path.join(f.work, "next.md"), "unsubmitted follow-up");
    const refused = await f.invoke(
      ["--continue", previous.runKey, "--write", "--prompt-file", "next.md", "--wait-ms", "0"],
      { env },
    );
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /turn 2 .* was not started/);
    assert.deepEqual(f.metadata(), previous);
    assert.equal(fs.readFileSync(path.join(f.work, "next.md"), "utf8"), "unsubmitted follow-up");
    assert.equal(f.events().filter((e) => e.method === "turn/start").length, 1);
    assert.deepEqual(fs.readdirSync(path.join(f.state, "writers")), []);
  });
