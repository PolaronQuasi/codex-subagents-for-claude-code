import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../src/cli/options.mjs";
import { parseTaskFile, applyDirectives } from "../src/cli/task-input.mjs";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";

const launch = [...LAUNCH.slice(0, -2), "--wait-ms", "10000", "--keep-prompt", "--keep-state"];
const starts = (f) =>
  f.events().filter((event) => event.direction === "in" && event.method === "turn/start");

test("summary options and model/summary directives validate before launch", () => {
  for (const summary of ["auto", "concise", "detailed", "none"]) {
    assert.equal(parseArgs([...launch, "--summary", summary]).summary, summary);
    const { directives } = parseTaskFile(
      Buffer.from(`continue: ${"a".repeat(32)}\nmodel: gpt-6-astra\nsummary: ${summary}\nTask`),
    );
    const options = {};
    applyDirectives(options, directives);
    assert.equal(options.model, "gpt-6-astra");
    assert.equal(options.summary, summary);
  }
  const options = {};
  applyDirectives(options, { model: "gpt-5-6-sol" });
  assert.equal(options.model, "gpt-5.6-sol");
  assert.throws(() => parseArgs([...launch, "--summary", "all"]), /unsupported summary/);
  assert.throws(() => applyDirectives({}, { summary: "all" }), /summary needs/);
  assert.throws(() => applyDirectives({}, { model: "unsafe model" }), /model needs/);
  assert.throws(
    () => applyDirectives({}, { close: "a".repeat(32), summary: "none" }),
    /cannot be combined/,
  );
  assert.throws(() => parseArgs(["--run", "a".repeat(32), "--summary", "none"]), /cannot be used/);
});

test("summary reaches Codex, inherits on continuation, archives, and fences request retries", async (t) => {
  const f = fixture(t);
  const initial = [...launch, "--summary", "detailed", "--request-id", "summary-first"];
  let result = await f.invoke(initial);
  assert.equal(result.code, 0, result.stderr);
  const key = f.runs()[0];
  assert.equal(starts(f)[0].params.summary, "detailed");
  result = await f.invoke(initial.map((value) => (value === "detailed" ? "none" : value)));
  assert.equal(result.code, 1);
  assert.equal(
    starts(f).length,
    1,
    "different summary must never dispatch under the same request ID",
  );

  const task = path.join(f.work, "continue.md");
  fs.writeFileSync(
    task,
    `continue: ${key}\nmodel: gpt-5-6-sol\neffort: low\nsummary: concise\nrequest-id: summary-next\nNext task`,
  );
  const next = [
    "--role",
    "gpt-6-1-sol",
    "--task-file",
    task,
    "--keep-prompt",
    "--wait-ms",
    "10000",
  ];
  result = await f.invoke(next);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(starts(f)[1].params.model, "gpt-5.6-sol");
  assert.equal(starts(f)[1].params.summary, "concise");
  const record = () => JSON.parse(fs.readFileSync(path.join(f.state, key, "run.json"), "utf8"));
  assert.equal(record().turns[0].summary, "detailed");
  assert.equal(record().summary, "concise");
  assert.equal((await f.invoke(next)).code, 0);
  assert.equal(starts(f).length, 2, "same request replays without dispatch");
  fs.writeFileSync(
    task,
    fs.readFileSync(task, "utf8").replace("summary: concise", "summary: none"),
  );
  assert.equal((await f.invoke(next)).code, 1);
  assert.equal(starts(f).length, 2);

  fs.writeFileSync(path.join(f.work, "third.md"), "Third task");
  result = await f.invoke(["--continue", key, "--prompt-file", "third.md", "--wait-ms", "10000"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(starts(f)[2].params.summary, "concise");
  assert.equal(record().turns[1].summary, "concise");
});

test("omitted initial summary leaves the protocol default untouched", async (t) => {
  const f = fixture(t);
  const result = await f.invoke(launch);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(Object.hasOwn(starts(f)[0].params, "summary"), false);
});
