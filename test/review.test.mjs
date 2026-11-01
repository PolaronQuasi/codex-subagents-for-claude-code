import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../src/cli/options.mjs";
import { parseTaskFile, applyDirectives } from "../src/cli/task-input.mjs";
import { reviewTarget } from "../src/shared/review.mjs";
import { readDriver } from "../src/state/job-store.mjs";
import { fixture, LAUNCH, TEXT } from "./support/codex-fixture.mjs";
import { protocolUsage, tokensField, quotaLine } from "../src/delivery/usage.mjs";
import { CodexSession } from "../src/codex/session.mjs";

const launch = ["--role", "gpt-6-1-sol", "--effort", "low", "--keep-state", "--wait-ms", "10000"];
const submissions = (f) =>
  f
    .events()
    .filter((e) => e.direction === "in" && ["turn/start", "review/start"].includes(e.method));

test("review options validate exclusive targets, read-only policy and structured bodies before dispatch", async (t) => {
  for (const review of ["uncommitted", "base:main", `commit:${"a".repeat(40)}`, "custom"]) {
    const options = {};
    applyDirectives(options, parseTaskFile(Buffer.from(`review: ${review}\n`)).directives);
    assert.equal(options.review, review);
    assert.ok(reviewTarget(review, "instructions").type);
  }
  for (const review of ["base:", "base:-bad", "commit:HEAD", "unknown"])
    assert.throws(() => parseArgs([...launch, "--review", review]), /review needs/);
  assert.throws(() => parseArgs([...launch, "--review", "uncommitted", "--write"]), /read-only/);
  const f = fixture(t);
  const bad = await f.invoke([...launch, "--review", "uncommitted", "--prompt-file", "prompt.md"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /cannot include task text/);
  fs.writeFileSync(path.join(f.work, "bad.md"), "review: custom\nwrite: yes\nTask");
  assert.equal((await f.invoke(["--role", "gpt-6-1-sol", "--task-file", "bad.md"])).code, 1);
  assert.deepEqual(f.runs(), []);
  assert.equal(submissions(f).length, 0);
});

test("native review uses review/start once, accepts exitedReviewMode, and does not inherit into ordinary continuation", async (t) => {
  const f = fixture(t, { reviewExitOnly: true, nestedReviewTurn: true });
  const args = [
    ...launch,
    "--review",
    "base:main",
    "--summary",
    "none",
    "--request-id",
    "review-once",
  ];
  const done = await f.invoke(args);
  assert.equal(done.code, 0, done.stderr);
  assert.ok(done.stdout.includes(TEXT));
  const run = f.metadata(),
    dir = path.join(f.state, run.runKey);
  const driver = readDriver(dir, run.jobId);
  assert.equal(driver.clientUserMessageId, null);
  assert.equal(driver.review, "base:main");
  assert.equal(driver.turnId, "turn-fixture-1");
  assert.doesNotMatch(done.stdout, /wrong nested answer/);
  const starts = submissions(f);
  assert.deepEqual(
    starts.map((e) => e.method),
    ["review/start"],
  );
  assert.deepEqual(starts[0].params, {
    threadId: run.result.threadId,
    target: { type: "baseBranch", branch: "main" },
    delivery: "inline",
  });
  const thread = f.events().find((e) => e.direction === "in" && e.method === "thread/start");
  assert.equal(thread.params.sandbox, "read-only");
  assert.equal(thread.params.approvalPolicy, "never");
  assert.deepEqual(thread.params.config, {
    review_model: "gpt-6.1-sol",
    model_reasoning_effort: "low",
    model_reasoning_summary: "none",
  });
  assert.equal((await f.invoke(args)).code, 0);
  const mismatch = await f.invoke(args.map((v) => (v === "base:main" ? "uncommitted" : v)));
  assert.equal(mismatch.code, 1);
  assert.equal(submissions(f).length, 1);
  const next = await f.invoke([
    "--continue",
    run.runKey,
    "--prompt-file",
    "prompt.md",
    "--wait-ms",
    "10000",
  ]);
  assert.equal(next.code, 0, next.stderr);
  assert.deepEqual(
    submissions(f).map((e) => e.method),
    ["review/start", "turn/start"],
  );
  assert.equal(f.metadata().review, undefined);
  assert.equal(f.metadata().turns[0].review, "base:main");
});

test("custom review sends exactly its task body; a review continuation uses the same thread", async (t) => {
  const f = fixture(t);
  assert.equal(
    (await f.invoke([...LAUNCH.slice(0, -2), "--wait-ms", "10000", "--keep-state"])).code,
    0,
  );
  const run = f.metadata();
  fs.writeFileSync(
    path.join(f.work, "review.md"),
    `continue: ${run.runKey}\nreview: custom\neffort: low\n\nInspect the failure paths.\n`,
  );
  const done = await f.invoke([
    "--role",
    "gpt-6-1-sol",
    "--task-file",
    "review.md",
    "--wait-ms",
    "10000",
  ]);
  assert.equal(done.code, 0, done.stderr);
  const sent = submissions(f).at(-1);
  assert.equal(sent.method, "review/start");
  assert.equal(sent.params.threadId, run.result.threadId);
  assert.deepEqual(sent.params.target, {
    type: "custom",
    instructions: "Inspect the failure paths.\n",
  });
});

test("a lost review dispatch with no turn identity is uncertain and is never resent", async (t) => {
  const f = fixture(t, { notificationBeforeResponse: false, exitAfterTurnStart: true });
  const args = [...launch, "--review", "uncommitted", "--request-id", "uncertain-review"];
  const done = await f.invoke(args);
  assert.equal(done.code, 2, done.stderr);
  assert.match(done.stdout, /SUBMISSION_UNCERTAIN/);
  assert.equal(f.metadata().result.error.code, "SUBMISSION_UNCERTAIN");
  assert.equal((await f.invoke(args)).code, 2);
  assert.equal(submissions(f).length, 1);
});

test("native review reports supplied cumulative usage once and keeps missing telemetry unknown", async (t) => {
  const counts = {
    inputTokens: 120,
    cachedInputTokens: 40,
    outputTokens: 30,
    reasoningOutputTokens: 10,
    totalTokens: 150,
  };
  const f = fixture(t, { tokenUsage: { total: counts, last: counts, modelContextWindow: 1000 } });
  const done = await f.invoke([...launch, "--review", "uncommitted"]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /tokens=120\/40\/30\/10/);
  assert.match(done.stdout, /context=15%/);
  assert.equal(f.metadata().result.usage.turn.total, 150);
  f.configure({
    omitUsage: true,
    resumedTokenUsage: { total: counts, last: counts, modelContextWindow: 1000 },
  });
  const missing = await f.invoke([
    "--continue",
    f.metadata().runKey,
    "--review",
    "uncommitted",
    "--wait-ms",
    "10000",
  ]);
  assert.equal(missing.code, 0, missing.stderr);
  assert.match(missing.stdout, /tokens=- /);
  assert.match(missing.stdout, /context=-/);
});

test("review usage filtering does not attribute a foreign turn or sum repeated cumulative frames", () => {
  const session = new CodexSession({ review: "uncommitted" });
  session.threadId = "thread-review";
  session.turnId = "turn-review";
  session.reviewTurnBound = true;
  session.usageBaseline = {
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 10,
    reasoningOutputTokens: 5,
    totalTokens: 110,
  };
  const counts = {
    inputTokens: 220,
    cachedInputTokens: 60,
    outputTokens: 40,
    reasoningOutputTokens: 15,
    totalTokens: 260,
  };
  const params = {
    threadId: session.threadId,
    turnId: session.turnId,
    tokenUsage: { total: counts, last: { totalTokens: 150 }, modelContextWindow: 1000 },
  };
  session.notification("thread/tokenUsage/updated", { ...params, threadId: "foreign-thread" });
  session.notification("thread/tokenUsage/updated", { ...params, turnId: "nested-unbound-turn" });
  assert.equal(session.tokenUsage, null);
  session.notification("thread/tokenUsage/updated", params);
  session.notification("thread/tokenUsage/updated", params);
  const usage = protocolUsage(session.tokenUsage, null, session.usageBaseline);
  assert.equal(tokensField(usage), "120/40/30/10");
  assert.equal(usage.turn.total, 150);
  assert.match(quotaLine(usage), /context=15%/);
});
