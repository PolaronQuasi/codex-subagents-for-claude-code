import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ProgressFold, boundedUtf8 } from "../src/codex/progress.mjs";
import { CodexSession } from "../src/codex/session.mjs";
import { jobPromptRedactor } from "../src/state/prompt-inputs.mjs";
import {
  createJob,
  jobPaths,
  writeProgress,
  readProgress,
  readDiff,
  readDriver,
} from "../src/state/job-store.mjs";
import { parseArgs } from "../src/cli/options.mjs";
import { parseTaskFile, applyDirectives } from "../src/cli/task-input.mjs";
import { acquireRunLock } from "../src/state/state.mjs";
import { fixture, LAUNCH, ORIGINAL } from "./support/codex-fixture.mjs";

const events = [
  {
    method: "turn/plan/updated",
    params: {
      plan: [
        { step: "inspect", status: "completed" },
        { step: "run the suite", status: "inProgress" },
      ],
    },
  },
  {
    method: "item/completed",
    params: {
      item: {
        type: "commandExecution",
        id: "cmd",
        command: "npm test",
        exitCode: 1,
        durationMs: 50,
        aggregatedOutput: "secret output",
      },
    },
  },
  {
    method: "item/completed",
    params: {
      item: {
        type: "fileChange",
        id: "file",
        changes: [{ path: "src/file.mjs", diff: "private item diff" }],
      },
    },
  },
  {
    method: "item/completed",
    params: { item: { type: "webSearch", id: "search", query: "protocol docs" } },
  },
  {
    method: "item/completed",
    params: {
      item: {
        type: "reasoning",
        id: "reason",
        summary: ["checking types"],
        content: ["private reasoning"],
      },
    },
  },
  {
    method: "item/completed",
    params: {
      item: {
        type: "mcpToolCall",
        id: "mcp",
        server: "docs",
        tool: "search",
        arguments: "secret args",
      },
    },
  },
  { method: "turn/diff/updated", params: { diff: "--- a/file\n+++ b/file\n+new\n" } },
];
async function until(read) {
  for (let i = 0; i < 400; i++) {
    const result = read();
    if (result) return result;
    await delay(25);
  }
  assert.fail("progress did not arrive");
}

test("progress allowlist excludes prompts, agent text, deltas, outputs and dynamic arguments", () => {
  const fold = new ProgressFold(ORIGINAL);
  for (const type of ["userMessage", "agentMessage", "dynamicToolCall"])
    assert.equal(fold.fold("item/completed", { item: { type, text: ORIGINAL } }), null);
  assert.equal(fold.fold("item/agentMessage/delta", { delta: ORIGINAL }), null);
  assert.equal(fold.fold("item/started", events[1].params), null);
  const stored = JSON.stringify(events.map(({ method, params }) => fold.fold(method, params)));
  assert.doesNotMatch(stored, /secret output|private item diff|private reasoning|secret args/);
  assert.match(stored, /npm test/);
});

test("prompt echoes and multiline prompt lines are redacted before truncation", () => {
  const fold = new ProgressFold("private-canary\nsecond-canary");
  for (const text of [
    "private-canary\nsecond-canary",
    "prefix second-canary suffix",
    "private-canary".repeat(100),
  ]) {
    assert.doesNotMatch(fold.text(text), /private-canary|second-canary/);
    assert.doesNotMatch(
      fold.fold("turn/diff/updated", { diff: text }).diff,
      /private-canary|second-canary/,
    );
  }
  fold.addPrompt("later-canary");
  assert.equal(fold.text("later-canary"), "[prompt withheld]");
});

test("escaped prompt and steer echoes are redacted; repeated short lines never rewrite the omission marker", () => {
  const prompt = 'PRIVATE-"quoted"';
  const fold = new ProgressFold(prompt);
  const escaped = JSON.stringify(prompt).slice(1, -1);
  assert.equal(fold.text(escaped), "[prompt withheld]");
  fold.addPrompt('STEER-"quoted"');
  assert.equal(fold.text(JSON.stringify('STEER-"quoted"').slice(1, -1)), "[prompt withheld]");
  assert.equal(new ProgressFold("p\n".repeat(10000)).text("p"), "[prompt withheld]");
  assert.equal(
    new ProgressFold("aa\nab").text("aab"),
    "[prompt withheld]",
    "overlapping matches are combined",
  );
  const patch = fold.fold("turn/diff/updated", { diff: `+${escaped}\n` }).diff;
  assert.equal(patch, "+[prompt withheld]\n");
});

test("rolling progress refuses linked leaves and never imports their source bytes", (t) => {
  const f = fixture(t),
    job = createJob(f.state, {}),
    paths = jobPaths(f.state, job);
  const source = path.join(f.work, "prompt.md");
  fs.linkSync(source, paths.progressFile);
  assert.throws(
    () => writeProgress(f.state, job, { entry: { command: "safe" } }),
    /unlinked regular/,
  );
  assert.equal(fs.readFileSync(source, "utf8"), ORIGINAL);
});

test("UTF-8 truncation, progress rotation and latest diff obey byte bounds", (t) => {
  const f = fixture(t),
    job = createJob(f.state, {}),
    fold = new ProgressFold("private");
  assert.equal(boundedUtf8("🚀🚀", 5), "🚀");
  for (let n = 0; n < 220; n++)
    writeProgress(
      f.state,
      job,
      fold.fold("item/completed", {
        item: { type: "reasoning", summary: [String(n) + "🚀".repeat(500)] },
      }),
    );
  const rows = readProgress(f.state, job);
  assert.ok(rows.length < 220 && rows.length > 0);
  assert.match(rows.at(-1).summary[0], /^219/);
  assert.ok(Buffer.byteLength(rows.at(-1).summary[0]) <= 384);
  const paths = jobPaths(f.state, job);
  assert.ok(fs.statSync(paths.progressFile).size <= 64 * 1024);
  writeProgress(f.state, job, fold.fold("turn/diff/updated", { diff: "🚀".repeat(100000) }));
  assert.ok(fs.statSync(paths.diffFile).size <= 256 * 1024);
  assert.doesNotMatch(readDiff(f.state, job), /\uFFFD/);
  writeProgress(f.state, job, fold.fold("turn/diff/updated", { diff: "latest\n" }));
  assert.equal(readDiff(f.state, job), "latest\n");
});

test("progress requires this active thread and turn; late notifications cannot change it", () => {
  const written = [];
  const session = new CodexSession({}, { progress: (value) => written.push(value) });
  session.threadId = "thread";
  session.turnId = "turn";
  session.progressFold = new ProgressFold("prompt");
  for (const ids of [
    { threadId: "other", turnId: "turn" },
    { threadId: "thread", turnId: "old" },
    {},
  ])
    session.notification("turn/diff/updated", { ...ids, diff: "wrong" });
  assert.equal(written.length, 0);
  session.notification("turn/diff/updated", { threadId: "thread", turnId: "turn", diff: "right" });
  assert.equal(written.length, 1);
  session.terminal = { id: "turn" };
  session.notification("turn/diff/updated", { threadId: "thread", turnId: "turn", diff: "late" });
  assert.equal(written.length, 1);
});

test("progress directive is validated; diff is only a run observation", () => {
  const options = {};
  applyDirectives(options, parseTaskFile(Buffer.from("progress: off\nhello")).directives);
  assert.equal(options.progress, "off");
  assert.throws(() => applyDirectives({}, { progress: "maybe" }), /on or off/);
  assert.throws(
    () => applyDirectives({}, { close: "a".repeat(32), progress: "off" }),
    /cannot be combined/,
  );
  assert.throws(() => parseArgs(["--diff"]), /--run/);
  assert.throws(() => parseArgs(["--run", "a".repeat(32), "--diff", "--wait"]), /does not wait/);
});

test("a progress write failure is checkpointed and logged without payloads or changing terminal delivery", () => {
  const checkpoints = [],
    logs = [];
  const session = new CodexSession(
    {},
    {
      progress: () => {
        throw new Error("PRIVATE-WRITE-ERROR");
      },
      checkpoint: (value) => checkpoints.push(value),
      log: (value) => logs.push(value),
    },
  );
  session.threadId = "thread";
  session.turnId = "turn";
  session.progressFold = new ProgressFold("PRIVATE-PROMPT");
  for (let i = 0; i < 2; i++)
    session.notification("turn/diff/updated", {
      threadId: "thread",
      turnId: "turn",
      diff: "PRIVATE-PROMPT",
    });
  assert.deepEqual(checkpoints, [{ progressWriteFailed: true }]);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs.join(), /PRIVATE/);
  session.notification("turn/completed", {
    threadId: "thread",
    turn: {
      id: "turn",
      status: "completed",
      items: [{ id: "answer", type: "agentMessage", phase: "final_answer", text: "done" }],
    },
  });
  const result = session.result(session.terminal);
  assert.equal(result.status, "completed");
  assert.equal(result.progressWriteFailed, true);
  assert.equal(result.text, "done");
});

test("fake publishes live progress and a read-only diff while another waiter owns the lock", async (t) => {
  const f = fixture(t, { status: "running", progressEvents: events });
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, 3);
  const key = f.runs()[0],
    stateDir = path.join(f.state, key),
    job = f.metadata(key).jobId;
  await until(() => readProgress(stateDir, job).length >= 6);
  const view = await f.invoke(["--run", key, "--wait-ms", "0"]);
  assert.equal(view.code, 3);
  assert.match(view.stdout, /plan=1\/2 "run the suite"/);
  assert.match(view.stdout, /cmd="npm test" exit=1/);
  const lock = await acquireRunLock(key, {
    stateBase: f.state,
    deadline: Date.now(),
    mode: "attach",
  });
  try {
    const held = await f.invoke(["--run", key, "--wait-ms", "0"]);
    assert.equal(held.code, 3);
    assert.match(held.stdout, /plan=1\/2/);
    const diff = await f.invoke(["--run", key, "--diff"]);
    assert.equal(diff.code, 3);
    assert.equal(diff.stdout, events.at(-1).params.diff);
  } finally {
    lock.releaseRunLock();
  }
  f.configure({ status: "completed" });
  const end = await f.invoke(["--run", key, "--wait-ms", "10000"]);
  assert.equal(end.code, 0, end.stderr);
  assert.equal(
    f.events().filter((e) => e.direction === "in" && e.method === "turn/start").length,
    1,
  );
});

test("progress off creates neither progress file even when fake sends progress", async (t) => {
  const f = fixture(t, { progressEvents: events });
  fs.writeFileSync(path.join(f.work, "task.md"), "progress: off\nkeep: yes\nsecret task");
  const done = await f.invoke([
    "--role",
    "gpt-6-1-sol",
    "--task-file",
    "task.md",
    "--wait-ms",
    "10000",
  ]);
  assert.equal(done.code, 0, done.stderr);
  const key = f.runs()[0],
    paths = jobPaths(path.join(f.state, key), f.metadata(key).jobId);
  assert.equal(fs.existsSync(paths.progressFile), false);
  assert.equal(fs.existsSync(paths.diffFile), false);
});

test("large prompt sets and expensive diffs withhold text within a fixed matching budget", () => {
  const many = Array.from(
    { length: 50000 },
    (_, i) => `private-line-${String(i).padStart(5, "0")}`,
  ).join("\n");
  const fold = new ProgressFold(many);
  assert.equal(fold.redactor.blocked, true);
  assert.equal(
    fold.fold("turn/diff/updated", { diff: "x".repeat(4 * 1024 * 1024) }).diff,
    "[prompt withheld]",
  );
  const bounded = new ProgressFold(
    Array.from({ length: 200 }, (_, i) => `private-${i}`).join("\n"),
  );
  assert.equal(bounded.redactor.blocked, false);
  assert.equal(
    bounded.fold("turn/diff/updated", { diff: "x".repeat(4 * 1024 * 1024) }).diff,
    "[prompt withheld]",
  );
});

test("rotation keeps the current plan while dropping older completed items", (t) => {
  const f = fixture(t),
    job = createJob(f.state, {}),
    fold = new ProgressFold("private");
  writeProgress(
    f.state,
    job,
    fold.fold("turn/plan/updated", { plan: [{ step: "current plan", status: "inProgress" }] }),
  );
  for (let i = 0; i < 8; i++)
    writeProgress(
      f.state,
      job,
      fold.fold("item/completed", {
        item: { type: "reasoning", summary: Array(32).fill(`${i}:` + "x".repeat(380)) },
      }),
    );
  const rows = readProgress(f.state, job);
  assert.equal(rows.filter((row) => row.kind === "plan").length, 1);
  assert.equal(rows.find((row) => row.kind === "plan").plan[0].step, "current plan");
  assert.match(rows.at(-1).summary[0], /^7:/);
  assert.ok(fs.statSync(jobPaths(f.state, job).progressFile).size <= 64 * 1024);
});

for (const continued of [false, true])
  test(`request IDs cannot reuse a turn with another progress policy (continue=${continued})`, async (t) => {
    const f = fixture(t, { status: continued ? "completed" : "running" });
    let key;
    if (continued) {
      assert.equal(
        (
          await f.invoke([
            ...LAUNCH.slice(0, -2),
            "--wait-ms",
            "10000",
            "--keep-state",
            "--keep-prompt",
          ])
        ).code,
        0,
      );
      key = f.runs()[0];
      f.configure({ status: "running" });
    }
    const task = path.join(f.work, "privacy.md");
    const write = (mode) =>
      fs.writeFileSync(
        task,
        `${continued ? `continue: ${key}` : "keep: yes"}\nprogress: ${mode}\nrequest-id: privacy-retry\n\nIdentical task\n`,
      );
    write("on");
    const args = [
      "--role",
      "gpt-6-1-sol",
      "--task-file",
      "privacy.md",
      "--keep-prompt",
      "--wait-ms",
      "0",
    ];
    const started = await f.invoke(args);
    assert.equal(started.code, 3, started.stderr);
    key ??= f.runs()[0];
    await until(() => readDriver(path.join(f.state, key), f.metadata(key).jobId)?.turnId);
    write("off");
    const retry = await f.invoke(args);
    assert.equal(retry.code, 1, retry.stdout);
    assert.match(retry.stderr, /different task|different turn/);
    assert.equal(
      f.events().filter((event) => event.direction === "in" && event.method === "turn/start")
        .length,
      continued ? 2 : 1,
    );
  });

test("continued progress redacts prior prompts and prior steers, including an off turn", async (t) => {
  const f = fixture(t, { status: "running" });
  fs.writeFileSync(
    path.join(f.work, "first.md"),
    "progress: off\nkeep: yes\n\nEARLIER-PRIVATE-PROMPT",
  );
  assert.equal(
    (await f.invoke(["--role", "gpt-6-1-sol", "--task-file", "first.md", "--wait-ms", "0"])).code,
    3,
  );
  const key = f.runs()[0],
    stateDir = path.join(f.state, key);
  await until(() => readDriver(stateDir, f.metadata(key).jobId)?.turnId);
  fs.writeFileSync(path.join(f.work, "steer.txt"), "EARLIER-PRIVATE-STEER");
  assert.equal((await f.invoke(["--steer", key, "--prompt-file", "steer.txt"])).code, 0);
  f.configure({ status: "completed" });
  assert.equal((await f.invoke(["--run", key, "--wait-ms", "10000"])).code, 0);
  const echo = "EARLIER-PRIVATE-PROMPT EARLIER-PRIVATE-STEER";
  f.configure({
    progressEvents: [
      {
        method: "item/completed",
        params: { item: { id: "echo", type: "commandExecution", command: echo } },
      },
      { method: "turn/diff/updated", params: { diff: echo } },
    ],
  });
  fs.writeFileSync(path.join(f.work, "next.md"), `continue: ${key}\nprogress: on\n\nLater task`);
  const next = await f.invoke([
    "--role",
    "gpt-6-1-sol",
    "--task-file",
    "next.md",
    "--wait-ms",
    "10000",
  ]);
  assert.equal(next.code, 0, next.stderr);
  const job = f.metadata(key).jobId;
  const stored = JSON.stringify(readProgress(stateDir, job)) + readDiff(stateDir, job);
  assert.doesNotMatch(stored, /EARLIER-PRIVATE/);
  assert.match(stored, /prompt withheld/);
});

test("unreadable archived inputs withhold later progress instead of exposing unknown prompts", (t) => {
  const f = fixture(t);
  const driver = { redactionHistory: [{ turn: 1, jobId: "task-missing" }] };
  const redactor = jobPromptRedactor(f.state, driver, { prompt: "current" });
  assert.equal(redactor.blocked, true);
  const fold = new ProgressFold("current", redactor);
  assert.equal(
    fold.fold("turn/diff/updated", { diff: "unknown earlier input" }).diff,
    "[prompt withheld]",
  );
});
