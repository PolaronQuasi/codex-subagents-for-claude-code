import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeTurn } from "../src/state/job-store.mjs";
import { sweep } from "../src/maintenance/commands.mjs";
import { delivered, sink } from "./support/capture.mjs";
import { fixture, LAUNCH } from "./support/runner-fixture.mjs";
import { EXIT } from "../src/shared/errors.mjs";

test("structured delivery outcomes follow both durable and stdout milestones", async (t) => {
  const f = fixture(t);
  const outcomes = [];
  const done = await f.invoke([...LAUNCH, "--keep-state"], {
    onOutcome(outcome) {
      assert.ok(f.metadata().result.durableSavedAt);
      assert.ok(f.metadata().result.acknowledgedAt);
      assert.ok(fs.existsSync(outcome.resultFile));
      outcomes.push(outcome);
    },
  });
  assert.equal(done.code, EXIT.COMPLETED, done.stderr);
  assert.deepEqual(outcomes, [
    {
      kind: "delivered",
      status: "completed",
      keep: "yes",
      resultFile: delivered(done.stdout).footer.file,
    },
  ]);
});

test("structured delivery outcomes also describe durable-copy replay", async (t) => {
  const f = fixture(t);
  const args = [...LAUNCH, "--request-id", "structured-replay", "--keep-prompt"];
  const first = await f.invoke(args);
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  const outcomes = [];
  const replay = await f.invoke(args, { onOutcome: (outcome) => outcomes.push(outcome) });
  assert.equal(replay.code, EXIT.COMPLETED, replay.stderr);
  assert.deepEqual(outcomes, [
    {
      kind: "delivered",
      status: "completed",
      keep: "no",
      resultFile: delivered(first.stdout).footer.file,
    },
  ]);
  assert.equal(f.events().filter((event) => event.command === "task").length, 1);
});

test("collection uses the structured outcome and never infers success from printed footer text", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke()).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  writeTurn(path.join(f.state, key), f.metadata().jobId, {
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  const misleading = `codex-subagents-for-claude-code: status=completed run=${key} keep=yes result=wrong\n`;
  const context = {
    options: { olderThanMs: 0 },
    parentEnv: f.env,
    cwd: f.work,
    stateBase: f.state,
    commandMs: 15_000,
  };
  const output = sink();
  const code = await sweep("collect-finished", {
    ...context,
    stdout: output.stream,
    invoke: async (args, io) => {
      assert.equal(io.requireDurableCopy, true);
      io.stdout.write("x".repeat(200_000));
      io.stdout.write(`\n${misleading}`);
      io.onOutcome({
        kind: "delivered",
        status: "failed",
        keep: "no",
        resultFile: "actual copy with spaces.md",
      });
      return 2;
    },
  });
  assert.equal(code, 0);
  assert.match(output.text(), /status=failed keep=no result=actual copy with spaces.md\n/);
  assert.equal(output.text().includes("wrong"), false);
  const missing = sink();
  const failed = await sweep("collect-finished", {
    ...context,
    stdout: missing.stream,
    invoke: async (args, io) => {
      io.stdout.write(misleading);
      return 0;
    },
  });
  assert.equal(failed, 1);
  assert.match(missing.text(), /collected=0 would-collect=0 skipped=0 failed=1/);
});

test("a command that delivers nothing gives its reason through the outcome channel, and a sweep reports that reason, never what the command printed", async (t) => {
  const f = fixture(t, { status: "running" });
  const outcomes = [];
  const collect = { onOutcome: (outcome) => outcomes.push(outcome) };
  // A refusal: the reason its error line gives.
  const unknown = "0".repeat(32);
  assert.equal((await f.invoke(["--close", unknown], collect)).code, EXIT.FAILURE);
  assert.deepEqual(outcomes.splice(0), [
    { kind: "failed", reason: `unknown run ${unknown}; use --list to find retained runs` },
  ]);
  // Arguments refused before any command runs.
  assert.equal((await f.invoke(["--sleep"], collect)).code, EXIT.FAILURE);
  assert.equal(outcomes.splice(0)[0].kind, "failed");
  // A job still running: the first line of its STILL RUNNING notice.
  assert.equal((await f.invoke()).code, EXIT.STILL_RUNNING);
  const waiting = await f.invoke(f.resume(), collect);
  assert.equal(waiting.code, EXIT.STILL_RUNNING);
  assert.deepEqual(outcomes.splice(0), [
    { kind: "still-running", reason: waiting.stdout.slice(0, waiting.stdout.indexOf("\n")) },
  ]);
  assert.match(waiting.stdout, /^STILL RUNNING: Codex job task-[0-9a-f]+\. Wait again with: /);
  // The sweep's line is the outcome's reason, on one line; never a warning
  // the command printed last, nor its first line of stdout.
  const key = f.runs()[0];
  writeTurn(path.join(f.state, key), f.metadata().jobId, {
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  const context = {
    options: { olderThanMs: 0 },
    parentEnv: f.env,
    cwd: f.work,
    stateBase: f.state,
    commandMs: 15_000,
  };
  for (const [outcome, code, error] of [
    [
      { kind: "failed", reason: "the command's own\treason\nand a second line" },
      1,
      "the command's own reason",
    ],
    [
      { kind: "still-running", reason: "STILL RUNNING: Codex job x. Wait again with: y" },
      3,
      "STILL RUNNING: Codex job x. Wait again with: y",
    ],
    [null, 1, "exit 1"],
  ]) {
    const output = sink();
    const failed = await sweep("collect-finished", {
      ...context,
      stdout: output.stream,
      invoke: async (args, io) => {
        io.stdout.write("an unrelated first line\n");
        io.stderr.write("run-codex-task: a warning that came last\n");
        if (outcome) io.onOutcome(outcome);
        return code;
      },
    });
    assert.equal(failed, 1);
    assert.ok(output.text().includes(` error=${error}\n`), output.text());
  }
});
