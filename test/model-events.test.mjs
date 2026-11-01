import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CodexSession } from "../src/codex/session.mjs";
import { modelEvents, foldModelEvent, modelEventLine } from "../src/shared/model-events.mjs";
import { renderFooter } from "../src/delivery/output.mjs";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";

test("model events retain bounded identifiers and codes, never free-text warnings", () => {
  let state;
  for (let i = 0; i < 40; i++)
    state = foldModelEvent(state, "model/rerouted", {
      fromModel: `model-${i}`,
      toModel: `model-${i + 1}`,
      reason: "highRiskCyberActivity",
    });
  assert.equal(state.reroutes.length, 16);
  assert.equal(state.reroutes.at(-1).to, "model-40");
  assert.equal(state.truncated, true);
  for (let i = 0; i < 40; i++)
    state = foldModelEvent(state, "guardianWarning", { message: "PRIVATE_PROMPT_CANARY" });
  assert.deepEqual(state.warnings, ["guardian-warning"]);
  state = foldModelEvent(state, "model/safetyBuffering/updated", {
    showBufferingUi: true,
    reasons: ["PRIVATE_PROMPT_CANARY"],
  });
  state = foldModelEvent(state, "model/safetyBuffering/updated", { showBufferingUi: false });
  assert.equal(state.buffered, true);
  assert.equal(state.buffering, false);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_PROMPT_CANARY/);
  assert.match(
    modelEventLine(state),
    /rerouted=model-40.*buffered=yes buffering=no.*truncated=yes/,
  );
  assert.equal(
    foldModelEvent(state, "model/rerouted", { fromModel: "ok", toModel: "bad\nline" }),
    null,
  );
  assert.equal(modelEventLine({ reroutes: "bad", warnings: ["PRIVATE_PROMPT_CANARY"] }), null);
  assert.equal(modelEvents({ reroutes: [null, { from: "x", to: "y".repeat(129) }] }), null);
});

test("model events bind to the active thread/turn and freeze at terminal", () => {
  const saved = [];
  const session = new CodexSession({}, { checkpoint: (value) => saved.push(value) });
  session.threadId = "thread";
  session.turnId = "turn";
  const event = {
    threadId: "thread",
    turnId: "turn",
    fromModel: "from",
    toModel: "to",
    reason: "highRiskCyberActivity",
  };
  session.notification("model/rerouted", { ...event, threadId: "other" });
  session.notification("model/rerouted", { ...event, turnId: "other" });
  session.notification("model/rerouted", { ...event, turnId: undefined });
  session.notification("guardianWarning", { threadId: "other", message: "ignored" });
  assert.equal(session.modelEvents, undefined);
  session.notification("model/rerouted", event);
  session.notification("guardianWarning", { threadId: "thread", message: "private" });
  assert.equal(saved.length, 2);
  const before = JSON.stringify(session.modelEvents);
  session.terminal = { id: "turn", status: "completed" };
  session.notification("model/rerouted", { ...event, toModel: "late" });
  session.notification("guardianWarning", { threadId: "thread", message: "late" });
  assert.equal(JSON.stringify(session.modelEvents), before);
});

test("model and safety observations survive delivery/replay without changing the first footer line", async (t) => {
  const f = fixture(t, {
    progressEvents: [
      {
        method: "model/rerouted",
        params: {
          fromModel: "gpt-6.1-sol",
          toModel: "gpt-6-astra",
          reason: "highRiskCyberActivity",
        },
      },
      { method: "guardianWarning", params: { message: "PRIVATE_PROMPT_CANARY" } },
      { method: "autoApprovalReview/strictReviewRequired", params: { startedAtMs: 1 } },
      {
        method: "model/safetyBuffering/updated",
        params: {
          model: "gpt-6-astra",
          reasons: ["PRIVATE_PROMPT_CANARY"],
          useCases: [],
          showBufferingUi: true,
        },
      },
    ],
  });
  const result = await f.invoke([...LAUNCH.slice(0, -2), "--wait-ms", "10000", "--keep-state"]);
  assert.equal(result.code, 0, result.stderr);
  const key = f.runs()[0];
  const run = JSON.parse(fs.readFileSync(path.join(f.state, key, "run.json"), "utf8"));
  const before = renderFooter(
    { ...run, result: { ...run.result, modelEvents: undefined } },
    run.result.resultFile,
  );
  const after = renderFooter(run, run.result.resultFile);
  assert.equal(after.split("\n")[0], before.split("\n")[0]);
  assert.match(
    after,
    /model: rerouted=gpt-6-astra.*warnings=guardian-warning,strict-review-required/,
  );
  assert.doesNotMatch(JSON.stringify(run), /PRIVATE_PROMPT_CANARY/);
  assert.match(fs.readFileSync(run.result.resultFile, "utf8"), /model: rerouted=gpt-6-astra/);
  assert.match((await f.invoke(["--run", key])).stdout, /model: rerouted=gpt-6-astra/);
  assert.equal(run.model, "gpt-6.1-sol", "requested model remains the next-turn default");
  const driver = JSON.parse(
    fs.readFileSync(path.join(f.state, key, "jobs", run.jobId, "driver.json"), "utf8"),
  );
  assert.deepEqual(driver.modelEvents, run.result.modelEvents, "checkpoint survives driver loss");
  f.configure({ progressEvents: [] });
  fs.writeFileSync(path.join(f.work, "next.md"), "Next task");
  const next = await f.invoke([
    "--continue",
    key,
    "--prompt-file",
    "next.md",
    "--wait-ms",
    "10000",
  ]);
  assert.equal(next.code, 0, next.stderr);
  assert.doesNotMatch(next.stdout, /codex-subagents-for-claude-code-model:/);
});
