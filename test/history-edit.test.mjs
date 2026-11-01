import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import { parseArgs } from "../src/cli/options.mjs";
import { applyDirectives } from "../src/cli/task-input.mjs";
const args = [...LAUNCH.slice(0, -2), "--wait-ms", "10000", "--keep-state", "--keep-prompt"];
const follow = (key) => [
  "--continue",
  key,
  "--prompt-file",
  "prompt.md",
  "--keep-prompt",
  "--wait-ms",
  "10000",
];
const sent = (f, m) => f.events().filter((e) => e.direction === "in" && e.method === m);
const record = (f, key) => JSON.parse(fs.readFileSync(path.join(f.state, key, "run.json")));

test("compaction completes before the prompt, and retry identity prevents a second summary", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(args)).code, 0);
  const key = f.runs()[0];
  const next = [...follow(key), "--compact", "--request-id", "compact-once"];
  const r = await f.invoke(next);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /compaction: status=completed/);
  const methods = f
    .events()
    .filter((e) => e.direction === "in")
    .map((e) => e.method);
  assert.ok(methods.indexOf("thread/compact/start") < methods.lastIndexOf("turn/start"));
  assert.equal(sent(f, "turn/start").length, 2);
  assert.equal((await f.invoke(next)).code, 0);
  assert.equal(sent(f, "thread/compact/start").length, 1);
  assert.equal((await f.invoke(next.filter((a) => a !== "--compact"))).code, 1);
  assert.equal((await f.invoke(follow(key))).code, 0);
  assert.equal(sent(f, "thread/compact/start").length, 1);
  assert.equal(record(f, key).turns[1].compact, true);
});

test("an uncertain compaction never sends the prompt or repeats compaction", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(args)).code, 0);
  const key = f.runs()[0];
  f.configure({ exitAfterCompact: true });
  const next = [...follow(key), "--compact", "--request-id", "compact-uncertain"];
  const r = await f.invoke(next);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stdout, /SUBMISSION_UNCERTAIN/);
  assert.equal(sent(f, "turn/start").length, 1);
  assert.equal((await f.invoke(next)).code, 2);
  assert.equal(sent(f, "thread/compact/start").length, 1);
  assert.equal(record(f, key).result.compaction.status, "uncertain");
});

test("revert changes only persisted history and retains local deliveries and files", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(args)).code, 0);
  const key = f.runs()[0];
  assert.equal((await f.invoke(follow(key))).code, 0);
  const before = record(f, key);
  fs.writeFileSync(path.join(f.work, "keep.txt"), "keep");
  const r = await f.invoke(["--revert", key, "--before-turn", "2"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /files and commits are unchanged/);
  assert.equal(fs.readFileSync(path.join(f.work, "keep.txt"), "utf8"), "keep");
  assert.equal(record(f, key).turns.length, 1);
  assert.ok(record(f, key).result.contextRevertedAt);
  assert.equal(record(f, key).result.resultFile, before.result.resultFile);
  assert.equal(sent(f, "thread/revert").length, 1);
  assert.equal((await f.invoke(["--revert", key, "--before-turn", "2"])).code, 1);
  assert.equal(sent(f, "thread/revert").length, 1);
});

test("lost revert reply reconciles its exact prefix without ever resending the mutation", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(args)).code, 0);
  const key = f.runs()[0];
  assert.equal((await f.invoke(follow(key))).code, 0);
  f.configure({ exitAfterRevert: true });
  const revert = ["--revert", key, "--before-turn", "2"];
  const first = await f.invoke(revert);
  assert.equal(first.code, 1);
  assert.ok(record(f, key).historyOperation);
  assert.match((await f.invoke(follow(key))).stderr, /unconfirmed/);
  const second = await f.invoke(revert);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(sent(f, "thread/revert").length, 1);
  assert.equal(record(f, key).historyOperation, undefined);
  assert.equal(record(f, key).historyEdits.length, 1);
});

test("history CLI validation is explicit and compaction cannot run on a new thread", () => {
  assert.throws(() => parseArgs([...args, "--compact"]), /requires --continue/);
  assert.throws(() => applyDirectives({}, { compact: "yes" }), /requires continue/);
  assert.throws(() => parseArgs(["--revert", "a".repeat(32)]), /before-turn/);
  assert.throws(() => parseArgs(["--before-turn", "1"]), /revert only/);
});
