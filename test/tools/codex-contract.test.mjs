import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";
import { assertSchema, generateSchema } from "../../tools/codex.contract.mjs";
import { createScratch } from "../../tools/scratch.mjs";
import { writeNativeCodex } from "../support/native-codex.mjs";

import { IS_WINDOWS } from "../support/release-fixture.mjs";

function native(directory) {
  const executable = path.join(directory, IS_WINDOWS ? "codex.exe" : "codex");
  writeNativeCodex(executable);
  return {
    path: executable,
    realPath: fs.realpathSync.native(executable),
    payloadSha256: crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex"),
  };
}

const schema = {
  definitions: {
    message: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
      additionalProperties: false,
    },
  },
  type: "object",
  required: ["method", "params"],
  properties: {
    method: { enum: ["turn/start"] },
    params: { allOf: [{ $ref: "#/definitions/message" }] },
  },
  additionalProperties: false,
};

test("contract checks nested references and new required fields, not just method names", () => {
  const request = { method: "turn/start", params: { text: "canary" } };
  assert.doesNotThrow(() => assertSchema(schema, request));
  for (const value of [
    { method: "turn/start" },
    { ...request, method: "turn/send" },
    { ...request, params: { text: 7 } },
    { ...request, params: { text: "canary", prompt: "extra" } },
  ])
    assert.throws(() => assertSchema(schema, value), /declared shape/);
  const changed = structuredClone(schema);
  changed.definitions.message.required.push("newlyRequired");
  assert.throws(() => assertSchema(changed, request), /declared shape/);
});

test("contract distinguishes nullable unions, ambiguous oneOf and bounded values", () => {
  const union = { anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 2 }] };
  for (const value of [null, "ok"]) assert.doesNotThrow(() => assertSchema(union, value));
  for (const value of [{}, "", "long"]) assert.throws(() => assertSchema(union, value));
  assert.throws(() => assertSchema({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1));
  assert.throws(() => assertSchema({ type: "integer", minimum: 1, maximum: 2 }, 3));
  assert.throws(() =>
    assertSchema({ type: "array", maxItems: 1, items: { type: "string" } }, ["a", "b"]),
  );
  assert.throws(() => assertSchema({ $ref: "https://example.invalid/schema" }, {}), /local/);
  assert.throws(() => assertSchema({ $ref: "#/missing" }, {}), /unresolved/);
  assert.throws(() => assertSchema({ $ref: "#/loop", loop: { $ref: "#/loop" } }, {}), /cyclic/);
});

test("contract honors false property and item schemas", () => {
  const forbidden = { type: "object", properties: { field: false } };
  assert.doesNotThrow(() => assertSchema(forbidden, {}));
  assert.throws(() => assertSchema(forbidden, { field: 1 }), /declared shape/);
  assert.throws(() => assertSchema({ type: "array", items: false }, [1]), /declared shape/);
  assert.doesNotThrow(() => assertSchema({ type: "array", items: false }, []));
  assert.doesNotThrow(() =>
    assertSchema({ type: "object", properties: { field: true } }, { field: 1 }),
  );
  assert.doesNotThrow(() => assertSchema({ type: "array", items: true }, [1]));
  const document = { definitions: { allow: true, forbid: false } };
  assert.doesNotThrow(() => assertSchema(document, 1, { $ref: "#/definitions/allow" }));
  assert.throws(
    () => assertSchema(document, 1, { $ref: "#/definitions/forbid" }),
    /declared shape/,
  );
});

test("schema generation uses only the explicit generate subcommand in an owned home", async (t) => {
  const scratch = createScratch("contract-command-test-");
  t.after(() => scratch.remove());
  const codex = native(scratch.directory);
  const executable = codex.realPath;
  let called = 0;
  const output = await generateSchema(codex, scratch.directory, {
    env: { ...process.env, CODEX_HOME: "must-not-use-parent-home" },
    run: async (command, args, options) => {
      called++;
      assert.equal(command, executable);
      assert.deepEqual(args.slice(-4), [
        "app-server",
        "generate-json-schema",
        "--out",
        path.join(scratch.directory, "schema"),
      ]);
      assert.deepEqual(args.slice(0, -4), [
        "--disable",
        "plugins",
        "--disable",
        "apps",
        "--disable",
        "hooks",
      ]);
      assert.equal(options.env.CODEX_HOME, path.join(scratch.directory, "home"));
      assert.equal(fs.existsSync(options.env.CODEX_HOME), true);
      assert.equal(options.cwd, scratch.directory);
      assert.equal(args.includes("--listen"), false);
      return { status: 0 };
    },
  });
  assert.equal(called, 1);
  assert.equal(output, path.join(scratch.directory, "schema"));
});

test("a failed schema generator fails the lane before runtime tests", async (t) => {
  const scratch = createScratch("contract-failed-test-");
  t.after(() => scratch.remove());
  await assert.rejects(
    generateSchema(native(scratch.directory), scratch.directory, {
      run: async () => ({ status: 1, stderr: "schema failure" }),
    }),
    /schema generation failed: schema failure/,
  );
});
