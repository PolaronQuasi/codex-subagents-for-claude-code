import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
const args = [...LAUNCH.slice(0, -2), "--wait-ms", "10000", "--keep-state", "--keep-prompt"];
const calls = (f, method) => f.events().filter((e) => e.direction === "in" && e.method === method);

test("bundle writes only a fresh private destination and does not load or dispatch a thread", async (t) => {
  const f = fixture(t);
  const launched = await f.invoke(args);
  assert.equal(launched.code, 0, launched.stderr);
  const key = f.runs()[0];
  const result = await f.invoke(["--bundle", key]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /contains|contain/);
  assert.equal(calls(f, "feedback/save").length, 1);
  const sent = calls(f, "feedback/save")[0].params;
  assert.equal(sent.includeLogs, true);
  assert.ok(sent.savePath.startsWith(f.resultsDir));
  assert.equal(fs.readFileSync(sent.savePath, "utf8"), "PK fixture diagnostic bundle");
  assert.equal(calls(f, "thread/resume").length, 0);
  assert.equal(calls(f, "turn/start").length, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.state, key, "run.json"))).maintenanceWorker,
    undefined,
  );
  const again = await f.invoke(["--bundle", key]);
  assert.equal(again.code, 0, again.stderr);
  assert.notEqual(calls(f, "feedback/save")[1].params.savePath, sent.savePath);
});

test("bundle requires an idle known run and fails closed on mismatched or disconnected replies", async (t) => {
  const f = fixture(t);
  assert.match((await f.invoke(["--bundle", "a".repeat(32)])).stderr, /unknown run/);
  assert.equal((await f.invoke(args)).code, 0);
  const key = f.runs()[0];
  f.configure({ responses: { "feedback/save": { savedPath: f.work, threadId: "other" } } });
  const failed = await f.invoke(["--bundle", key]);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /not retried/);
  assert.equal(calls(f, "feedback/save").length, 1);
  const file = path.join(f.state, key, "run.json");
  const record = JSON.parse(fs.readFileSync(file));
  record.dormant = false;
  fs.writeFileSync(file, JSON.stringify(record));
  assert.match((await f.invoke(["--bundle", key])).stderr, /sleeping run/);
  assert.equal(calls(f, "feedback/save").length, 1);
});
