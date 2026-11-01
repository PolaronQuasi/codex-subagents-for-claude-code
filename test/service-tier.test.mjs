import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import { parseArgs } from "../src/cli/options.mjs";
import { applyDirectives } from "../src/cli/task-input.mjs";
const args = [...LAUNCH.slice(0, -2), "--wait-ms", "10000", "--keep-prompt", "--keep-state"];
const starts = (f) => f.events().filter((e) => e.direction === "in" && e.method === "turn/start");
const models = [
  {
    id: "gpt-6.1-sol",
    model: "gpt-6.1-sol",
    serviceTiers: [{ id: "priority" }],
    supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }],
  },
];

test("tier reaches only the selected turn and changes request identity", async (t) => {
  const f = fixture(t, { models });
  const initial = [...args, "--tier", "priority", "--request-id", "fast-once"];
  const first = await f.invoke(initial);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(starts(f)[0].params.serviceTierForTurn, "priority");
  assert.equal(starts(f)[0].params.serviceTier, undefined);
  assert.match(first.stdout, /tier: requested=priority/);
  assert.equal((await f.invoke(initial.map((v) => (v === "priority" ? "default" : v)))).code, 1);
  assert.equal(starts(f).length, 1);
  const key = f.runs()[0];
  const follow = await f.invoke([
    "--continue",
    key,
    "--prompt-file",
    "prompt.md",
    "--keep-prompt",
    "--wait-ms",
    "10000",
  ]);
  assert.equal(follow.code, 0, follow.stderr);
  assert.equal(starts(f)[1].params.serviceTierForTurn, undefined);
  const record = JSON.parse(fs.readFileSync(path.join(f.state, key, "run.json")));
  assert.equal(record.tier, undefined);
  assert.equal(record.turns[0].tier, "priority");
});

test("unoffered or unverifiable tiers fail before a thread or turn, while default is explicit standard speed", async (t) => {
  const f = fixture(t, { models });
  assert.equal((await f.invoke([...args, "--tier", "ultrafast"])).code, 2);
  assert.equal(starts(f).length, 0);
  f.configure({ rpcErrors: { "model/list": { code: -32000, message: "unavailable" } } });
  assert.equal((await f.invoke([...args, "--tier", "priority"])).code, 2);
  assert.equal(starts(f).length, 0);
  const standard = await f.invoke([...args, "--tier", "default"]);
  assert.equal(standard.code, 0, standard.stderr);
  assert.equal(starts(f)[0].params.serviceTierForTurn, "default");
});

test("tier validation rejects accidental native review or lifecycle use", () => {
  assert.throws(() => parseArgs([...args, "--tier", "FAST"]), /lowercase/);
  assert.throws(
    () => parseArgs([...args, "--tier", "priority", "--review", "custom"]),
    /native review/,
  );
  assert.throws(() => applyDirectives({}, { close: "a".repeat(32), tier: "priority" }), /combined/);
  assert.equal(parseArgs([...args, "--tier", "default"]).tier, "default");
});
