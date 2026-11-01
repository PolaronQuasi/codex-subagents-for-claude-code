import assert from "node:assert/strict";
import test from "node:test";
import { protocolUsage, tokensField, limitField } from "../src/delivery/usage.mjs";

test("protocol usage subtracts native baselines without double-counting resumed totals", () => {
  const total = {
    inputTokens: 17,
    cachedInputTokens: 3,
    outputTokens: 5,
    reasoningOutputTokens: 2,
    totalTokens: 22,
  };
  const first = protocolUsage(
    { total },
    { primary: { usedPercent: 23, windowDurationMins: 10080 } },
  );
  assert.equal(tokensField(first), "17/3/5/2");
  assert.equal(limitField(first), "23%/7d");
  const cumulative = { ...total, inputTokens: 34, totalTokens: 39 };
  const second = protocolUsage({ last: total, total: cumulative }, null, total);
  assert.equal(second.turn.input, 17);
  assert.equal(second.turn.output, 0);
  assert.equal(second.threadTotal.input, 34);
  const missing = protocolUsage(null, null, cumulative);
  assert.equal(tokensField(missing), "-");
  assert.equal(limitField(missing), "-");
  assert.equal(missing.threadTotal, null);
});

test("inherited fork totals, absent baselines and counter resets never become new-turn charges", () => {
  const total = {
    inputTokens: 39965,
    cachedInputTokens: 20352,
    outputTokens: 32,
    reasoningOutputTokens: 0,
    totalTokens: 39997,
  };
  const base = {
    inputTokens: 26610,
    cachedInputTokens: 13184,
    outputTokens: 23,
    reasoningOutputTokens: 0,
    totalTokens: 26633,
  };
  const turn = protocolUsage({ total }, null, base).turn;
  assert.equal(turn.input, 13355);
  assert.equal(turn.cached, 7168);
  assert.equal(turn.output, 9);
  assert.equal(protocolUsage({ total }, null, null).turn.input, null);
  assert.equal(protocolUsage({ total: base }, null, total).turn.input, null);
});

test("malformed accounting does not fabricate counts and rate windows retain the public format", () => {
  assert.equal(
    tokensField(protocolUsage({ total: { inputTokens: -1, outputTokens: "8" } }, {})),
    "-/-/-/-",
  );
  for (const [minutes, label] of [
    [60, "1h"],
    [30, "30m"],
    [1440, "1d"],
  ])
    assert.equal(limitField({ limit: { usedPercent: 0, windowMinutes: minutes } }), `0%/${label}`);
});
