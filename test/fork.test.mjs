import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH, ORIGINAL } from "./support/codex-fixture.mjs";
import { gitInit } from "./support/git-repos.mjs";
import { jobPromptRedactor } from "../src/state/prompt-inputs.mjs";
import { reserveTurn, switchTurn, rollBackTurnRecord } from "../src/state/turn-transition.mjs";
import { saveRun } from "../src/state/run-store.mjs";
const args = [...LAUNCH.slice(0, -2), "--wait-ms", "30000", "--keep-state", "--keep-prompt"];
const sent = (f, m) => f.events().filter((e) => e.direction === "in" && e.method === m);
const record = (f, k) => JSON.parse(fs.readFileSync(path.join(f.state, k, "run.json")));

test("fork creates context without a model turn, replays its claim, continues at local turn one and closes independently", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(args)).code, 0);
  const parent = f.runs()[0];
  const fork = ["--fork", parent, "--request-id", "fork-once"];
  const r = await f.invoke(fork);
  assert.equal(r.code, 0, r.stderr);
  const child = f.runs().find((k) => k !== parent);
  assert.match(r.stdout, /No model turn sent/);
  assert.equal(sent(f, "turn/start").length, 1);
  assert.equal(record(f, child).jobId, null);
  assert.notEqual(record(f, child).contextThreadId, record(f, parent).result.threadId);
  assert.equal((await f.invoke(fork)).code, 0);
  assert.equal(sent(f, "thread/fork").length, 1);
  assert.equal((await f.invoke(["--run", child])).code, 0);
  const transcript = await f.invoke(["--transcript", child, "--json"]);
  assert.equal(transcript.code, 0, transcript.stderr);
  assert.equal(JSON.parse(transcript.stdout).turns.length, 1);
  const scrubber = jobPromptRedactor(path.join(f.state, child), { forkRedaction: true });
  assert.doesNotMatch(scrubber.redact(ORIGINAL), /exact original prompt/);
  const next = await f.invoke([
    "--continue",
    child,
    "--prompt-file",
    "prompt.md",
    "--keep-prompt",
    "--wait-ms",
    "30000",
  ]);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, / turn=1 /);
  assert.equal(record(f, child).turns.length, 0);
  assert.equal(sent(f, "turn/start")[1].params.threadId, record(f, child).contextThreadId);
  assert.equal((await f.invoke(["--close", child])).code, 0);
  assert.ok(fs.existsSync(path.join(f.state, parent)));
});

test("worktree fork starts at a delivered commit with a fresh branch and no writer lock", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "changed.txt" });
  await gitInit(f.work);
  assert.equal((await f.invoke([...args, "--worktree", "--write"])).code, 0);
  const parent = f.runs()[0];
  const r = await f.invoke(["--fork", parent]);
  assert.equal(r.code, 0, r.stderr);
  const child = f.runs().find((k) => k !== parent),
    a = record(f, parent),
    b = record(f, child);
  assert.notEqual(a.cwd, b.cwd);
  assert.notEqual(a.worktree.branch, b.worktree.branch);
  assert.equal(b.worktree.startCommit, a.result.commit);
  assert.equal(fs.readFileSync(path.join(b.cwd, "changed.txt"), "utf8"), "fixture edit\n");
  assert.equal(fs.existsSync(path.join(f.state, "writers")), false);
  assert.equal((await f.invoke(["--close", child])).code, 0);
  assert.ok(fs.existsSync(a.cwd));
});

test("fork refuses shared writers and never repeats an uncertain fork", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...args, "--write"])).code, 0);
  const writer = f.runs()[0];
  assert.match((await f.invoke(["--fork", writer])).stderr, /shared-checkout write/);
  assert.equal((await f.invoke(args)).code, 0);
  const parent = f.runs().find((k) => k !== writer);
  f.configure({ exitAfterFork: true });
  const argsFork = ["--fork", parent, "--request-id", "uncertain-fork"];
  const first = await f.invoke(argsFork);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /not confirmed/);
  const second = await f.invoke(argsFork);
  assert.equal(second.code, 1);
  assert.equal(sent(f, "thread/fork").length, 1);
  const child = f.runs().find((k) => k !== writer && k !== parent);
  const follow = await f.invoke(["--continue", child, "--prompt-file", "prompt.md"]);
  assert.match(follow.stderr, /unconfirmed/);
  assert.equal(sent(f, "turn/start").length, 2);
});

test("fresh scratch fork keeps redaction after parent close and a never-started first turn rolls back", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "parent.txt" });
  assert.equal((await f.invoke([...args, "--scratch-workspace", "--write"])).code, 0);
  const parent = f.runs()[0];
  assert.equal((await f.invoke(["--fork", parent])).code, 0);
  const child = f.runs().find((k) => k !== parent),
    seed = record(f, child),
    dir = path.join(f.state, child);
  assert.equal(fs.existsSync(path.join(seed.cwd, "parent.txt")), false);
  assert.equal((await f.invoke(["--close", parent])).code, 0);
  const redactor = jobPromptRedactor(dir, { forkRedaction: true });
  assert.doesNotMatch(redactor.redact(ORIGINAL), /exact original prompt/);
  const save = () => saveRun(seed, dir);
  reserveTurn(seed, save);
  switchTurn(
    seed,
    dir,
    "pending",
    {
      model: seed.model,
      effort: "low",
      write: false,
      requestId: "new",
      requestDigest: "f".repeat(64),
    },
    save,
  );
  const blocked = await f.invoke(["--continue", child, "--prompt-file", "prompt.md"]);
  assert.match(blocked.stderr, /first turn is reserved/);
  assert.ok(rollBackTurnRecord(seed, dir, save));
  assert.equal(seed.effort, "xhigh");
  assert.equal(seed.write, true);
  assert.equal(seed.turns.length, 0);
  assert.equal(seed.turnRequestId, undefined);
  assert.equal((await f.invoke(["--run", child])).code, 0);
  assert.match((await f.invoke(["--list"])).stdout, /fork-ready/);
  assert.equal((await f.invoke(["--close", child])).code, 0);
});
