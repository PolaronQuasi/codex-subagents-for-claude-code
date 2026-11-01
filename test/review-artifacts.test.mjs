import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import { workspace } from "./support/workspace-fixture.mjs";
import { gitInit, gitOut } from "./support/git-repos.mjs";
import {
  renderFooter,
  readDurableCopy,
  resultFileName,
  findResultsByRequestId,
} from "../src/delivery/output.mjs";
import { MAX_OUTPUT_BYTES, REQUEST_DIGEST_VERSION } from "../src/shared/constants.mjs";
import { validTurnSettings } from "../src/shared/turn-settings.mjs";
import { prepareTask } from "../src/cli/task-input.mjs";
import { plannedPluginFiles, retiredPluginFiles } from "../install.mjs";

const launch = [...LAUNCH.slice(0, -2), "--wait-ms", "10000", "--keep-state", "--keep-prompt"];

test("maximum answer plus footer remains replayable and request replay follows turn order", (t) => {
  const f = workspace(t);
  const run = {
    runKey: "a".repeat(32),
    jobId: "1".repeat(32),
    model: "gpt-6-sol",
    requestId: "ordered",
    requestDigestVersion: REQUEST_DIGEST_VERSION,
    requestDigest: "b".repeat(64),
    result: { status: "completed", deliveredAt: "2026-11-01T00:00:00Z" },
  };
  const one = path.join(f.resultsDir, resultFileName(run));
  fs.writeFileSync(one, "x".repeat(MAX_OUTPUT_BYTES) + "\n" + renderFooter(run, one));
  assert.equal(readDurableCopy(one).body.trimEnd().length, MAX_OUTPUT_BYTES);
  run.turns = [{}];
  run.jobId = "0".repeat(32);
  const two = path.join(f.resultsDir, resultFileName(run));
  fs.writeFileSync(two, "second\n" + renderFooter(run, two));
  assert.equal(findResultsByRequestId(f.resultsDir, "ordered").at(-1).file, two);
});

test("cancel and close task bodies are refused without consuming the input", (t) => {
  const f = workspace(t);
  for (const mode of ["cancel", "close"]) {
    const file = path.join(f.work, "task.md");
    fs.writeFileSync(file, mode + ": " + "a".repeat(32) + "\n\nDo more work");
    assert.throws(
      () => prepareTask({ mode: "task", "task-file": file }, f.work),
      /cannot contain a task body/,
    );
    assert.equal(fs.existsSync(file), true);
  }
});

test("current, archived and seed settings reject invalid policy values", () => {
  for (const settings of [
    { quotaFloor: -1 },
    { quotaFloor: 1.5 },
    { quotaFloor: 101 },
    { mcp: "yes" },
    { progress: "yes" },
    { review: "uncommitted", write: true },
    { tier: "priority", review: "uncommitted" },
  ])
    assert.equal(validTurnSettings(settings), false, JSON.stringify(settings));
  assert.equal(validTurnSettings({ quotaFloor: 0, mcp: "off", progress: "on" }), true);
});

test("plugin inventory identifies retired generated roles without claiming edited files", (t) => {
  const f = workspace(t);
  const old = plannedPluginFiles({
    root: f.work,
    roles: { "gpt-old": { model: "gpt-old" } },
    display: { "gpt-old": { model: "Old", alias: "old" } },
  });
  for (const { target, text } of old) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  const next = plannedPluginFiles({ root: f.work, roles: {}, display: {} });
  assert.deepEqual(
    retiredPluginFiles(next).map((x) => x.owned),
    [true],
  );
  fs.appendFileSync(path.join(f.work, "agents", "gpt-old.md"), "user edit");
  assert.deepEqual(
    retiredPluginFiles(next).map((x) => x.owned),
    [false],
  );
});

test("delivery is quiescent before stdout and close cannot silently commit a later edit", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  const stdout = new Writable({
    write(chunk, encoding, callback) {
      try {
        assert.equal(f.metadata().dormant, true);
        assert.ok(f.metadata().result.finalizedAt);
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
  const result = await f.invoke([...launch, "--worktree", "--write"], { stdout });
  assert.equal(result.code, 0, result.stderr);
  const run = f.metadata();
  const head = run.result.commit;
  fs.writeFileSync(path.join(run.cwd, "late.txt"), "late external edit");
  const close = await f.invoke(["--close", run.runKey, "--force"]);
  assert.equal(close.code, 1, close.stderr);
  assert.match(close.stderr, /changed after delivery/);
  assert.equal(await gitOut(["rev-parse", "HEAD"], run.cwd), head);
  assert.equal(fs.readFileSync(path.join(run.cwd, "late.txt"), "utf8"), "late external edit");
});

test("failed Markdown publication does not advertise a completed JSON pair", async (t) => {
  const f = fixture(t, { text: '{"ok":true}' });
  const schema = path.join(f.work, "schema.json");
  fs.writeFileSync(schema, '{"type":"object"}');
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (path.dirname(to) === f.resultsDir && to.endsWith(".md"))
      throw new Error("publication refused");
    return rename(from, to);
  });
  const result = await f.invoke([...launch, "--output-schema", schema]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.metadata().result.jsonFile, undefined);
  assert.match(result.stdout, /schema: schema=\w+ json=-/);
});
