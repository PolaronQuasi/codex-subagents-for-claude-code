import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../src/cli/options.mjs";
import { applyDirectives } from "../src/cli/task-input.mjs";
import { loadOutputSchema } from "../src/shared/output-schema.mjs";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";

// Schema assertions need a completed fake turn, independently of runner speed.
const args = [...LAUNCH.slice(0, -2), "--wait-ms", "60000", "--keep-state", "--keep-prompt"];
const starts = (f) => f.events().filter((e) => e.direction === "in" && e.method === "turn/start");
const schema = {
  type: "object",
  properties: { pass: { type: "boolean" } },
  required: ["pass"],
  additionalProperties: false,
};

test("schema snapshots are bounded JSON objects; reject invalid paths and mode combinations", async (t) => {
  const f = fixture(t);
  const file = path.join(f.work, "schema.json");
  for (const text of ["bad", "null", "[]", '"text"', " ".repeat(65537)]) {
    fs.writeFileSync(file, text);
    assert.throws(() => loadOutputSchema(file), /output-schema/);
  }
  assert.throws(() => parseArgs([...args, "--output-schema", "schema.json"]), /absolute/);
  assert.throws(() => applyDirectives({}, { "output-schema": "schema.json" }), /absolute/);
  assert.throws(
    () => applyDirectives({}, { close: "a".repeat(32), "output-schema": file }),
    /combined/,
  );
  fs.writeFileSync(file, JSON.stringify(schema));
  const result = await f.invoke([...args, "--review", "custom", "--output-schema", file]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not supported with native review/);
  assert.equal(starts(f).length, 0);
});

test("schema reaches the wire, survives source deletion, writes durable JSON and fences retries", async (t) => {
  const f = fixture(t, { result: '{"pass":false}' });
  const file = path.join(f.work, "schema.json");
  fs.writeFileSync(file, JSON.stringify(schema));
  const launch = [...args, "--output-schema", file, "--request-id", "schema-first"];
  const first = await f.invoke(launch);
  assert.equal(first.code, 0, first.stderr + "\n" + first.stdout);
  assert.deepEqual(starts(f)[0].params.outputSchema, schema);
  const key = f.runs()[0];
  const record = () => JSON.parse(fs.readFileSync(path.join(f.state, key, "run.json")));
  assert.equal(record().result.schema, "valid");
  assert.deepEqual(JSON.parse(fs.readFileSync(record().result.jsonFile)), { pass: false });
  assert.match(first.stdout, /schema=valid/);
  fs.writeFileSync(file, '{"type":"string"}');
  assert.equal((await f.invoke(launch)).code, 1);
  assert.equal(starts(f).length, 1);
  fs.unlinkSync(file);
  assert.equal((await f.invoke(["--run", key])).code, 0);
  const second = await f.invoke([
    "--continue",
    key,
    "--prompt-file",
    "prompt.md",
    "--keep-prompt",
    "--wait-ms",
    "60000",
  ]);
  assert.equal(second.code, 0, second.stderr + "\n" + second.stdout);
  assert.equal(Object.hasOwn(starts(f)[1].params, "outputSchema"), false);
  assert.equal(record().turns[0].outputSchema.type, "object");
});

test("invalid structured output preserves completed status and has no JSON sidecar", async (t) => {
  const f = fixture(t, { result: '```json\n{"pass":false}\n```' });
  const file = path.join(f.work, "schema.json");
  fs.writeFileSync(file, JSON.stringify(schema));
  const result = await f.invoke([...args, "--output-schema", file]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /status=completed/);
  assert.match(result.stdout, /schema=invalid json=-/);
  assert.equal(
    fs.readdirSync(f.resultsDir).some((name) => name.endsWith(".result.json")),
    false,
  );
});
