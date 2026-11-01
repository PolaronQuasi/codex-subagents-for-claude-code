import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import { parseArgs } from "../src/cli/options.mjs";
import { acquireRunLock } from "../src/state/state.mjs";
import { rememberThread, readThreadOwner } from "../src/state/thread-owners.mjs";
import { threadName } from "../src/shared/thread-name.mjs";
import { digest } from "../src/shared/io.mjs";

const launch = [...LAUNCH.slice(0, -2), "--wait-ms", "10000", "--keep-state"];
const incoming = (f, method) =>
  f.events().filter((e) => e.direction === "in" && e.method === method);
const readHistory = (f) => JSON.parse(fs.readFileSync(f.env.FIXTURE_HISTORY));
function seed(f, entries) {
  const history = {};
  for (const [index, spec] of entries.entries()) {
    const runKey = String(index + 1).padStart(32, "0"),
      id = `thread-${index}`;
    const thread = {
      id,
      name: threadName(runKey, "gpt-6.1-sol"),
      status: { type: "idle" },
      turns: [],
      preview: "PRIVATE-PREVIEW",
      ...spec,
    };
    history[id] = thread;
    if (spec.proven !== false)
      assert.equal(
        rememberThread(
          { runKey },
          {
            stateBase: spec.stateBase ?? f.state,
            stateDir: path.join(f.state, runKey),
            resultsDir: f.resultsDir,
          },
          { threadId: id, name: thread.name },
        ),
        true,
      );
  }
  fs.writeFileSync(f.env.FIXTURE_HISTORY, JSON.stringify(history));
  return Object.values(history);
}

test("thread commands reject unrelated options", () => {
  assert.equal(parseArgs(["--list", "--codex"]).mode, "list");
  assert.equal(parseArgs(["--archive-orphans", "--dry-run"]).mode, "archive-orphans");
  for (const args of [
    ["--codex"],
    ["--list", "--codex", "--mine"],
    ["--archive-orphans", "--all-sessions"],
    ["--archive-orphans", "--write"],
  ])
    assert.throws(() => parseArgs(args));
});

test("owned thread is named before submission, kept while sleeping, then archived on close", async (t) => {
  const f = fixture(t);
  const done = await f.invoke(launch);
  assert.equal(done.code, 0, done.stderr);
  const run = f.metadata(),
    threadId = run.result.threadId;
  const methods = f
    .events()
    .filter((e) => e.direction === "in")
    .map((e) => e.method);
  assert.ok(methods.indexOf("thread/name/set") < methods.indexOf("turn/start"));
  assert.equal(incoming(f, "thread/name/set")[0].params.name, threadName(run.runKey, run.model));
  assert.equal(incoming(f, "thread/archive").length, 0);
  assert.equal(readThreadOwner(f.resultsDir, threadId, f.state).runKey, run.runKey);
  const kept = await f.invoke(["--list", "--codex"]);
  assert.equal(kept.code, 0, kept.stderr);
  assert.doesNotMatch(kept.stdout, new RegExp(threadId));
  const closed = await f.invoke(["--close", run.runKey]);
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(readHistory(f)[threadId].archived, true);
  assert.deepEqual(f.runs(), []);
  assert.equal(readThreadOwner(f.resultsDir, threadId, f.state).archived, true);
  assert.equal(incoming(f, "turn/start").length, 1);
  assert.equal(incoming(f, "thread/delete").length, 0);
});

test("archive failure allows cleanup, keeps ownership, and explicit orphan retry archives once", async (t) => {
  const f = fixture(t, {
    rpcErrors: { "thread/archive": { code: -32000, message: "PRIVATE-FAILURE" } },
  });
  const done = await f.invoke(launch.filter((a) => a !== "--keep-state"));
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stderr, /ownership receipt kept/);
  assert.doesNotMatch(done.stderr, /PRIVATE-FAILURE/);
  assert.deepEqual(f.runs(), []);
  const threadId = Object.keys(readHistory(f))[0];
  assert.equal(readThreadOwner(f.resultsDir, threadId, f.state).archived, false);
  f.configure({ rpcErrors: {} });
  const dry = await f.invoke(["--archive-orphans", "--dry-run"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /action=would-archive/);
  assert.equal(readHistory(f)[threadId].archived, undefined);
  const retry = await f.invoke(["--archive-orphans"]);
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(retry.stdout, /ownership=confirmed action=archived/);
  assert.equal(readHistory(f)[threadId].archived, true);
  assert.equal(
    (await f.invoke(["--archive-orphans"])).stdout,
    "No named orphan Codex threads found.\n",
  );
  assert.equal(incoming(f, "turn/start").length, 1);
});

test("orphan sweep is paginated and skips foreign roots, unconfirmed, retained, locked, active and renamed threads", async (t) => {
  const f = fixture(t, { threadPageSize: 2 });
  const threads = seed(f, [
    {},
    { proven: false },
    { stateBase: f.other },
    {},
    {},
    { status: { type: "active" } },
    { name: "ordinary chat" },
  ]);
  const key = (n) => String(n + 1).padStart(32, "0");
  fs.mkdirSync(path.join(f.state, key(3)));
  const lock = await acquireRunLock(key(4), {
    stateBase: f.state,
    deadline: Date.now(),
    mode: "attach",
  });
  try {
    const listed = await f.invoke(["--list", "--codex"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.doesNotMatch(listed.stdout, /PRIVATE-PREVIEW|thread-3|thread-6/);
    const done = await f.invoke(["--archive-orphans"]);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /thread=thread-0 .*action=archived/);
    assert.match(done.stdout, /thread=thread-1 .*action=skipped-unconfirmed/);
    assert.match(done.stdout, /thread=thread-2 .*action=skipped-unconfirmed/);
    assert.match(done.stdout, /thread=thread-4 .*action=skipped-retained-or-locked/);
    assert.match(done.stdout, /thread=thread-5 .*action=skipped-active-or-changed/);
    assert.deepEqual(
      incoming(f, "thread/archive").map((e) => e.params.threadId),
      [threads[0].id],
    );
    assert.equal(incoming(f, "thread/resume").length, 0);
    assert.ok(incoming(f, "thread/list").length >= 6);
    assert.deepEqual(incoming(f, "thread/list")[0].params.sourceKinds, ["appServer"]);
  } finally {
    lock.releaseRunLock();
  }
});

test("orphan archive rechecks identity and activity and rejects an incomplete listing before mutation", async (t) => {
  const f = fixture(t);
  seed(f, [{}]);
  for (const fresh of [
    { id: "wrong" },
    { id: "thread-0", name: "changed", status: { type: "idle" } },
    {
      id: "thread-0",
      name: threadName("1".padStart(32, "0"), "gpt-6.1-sol"),
      status: { type: "active" },
    },
  ]) {
    f.configure({ responses: { "thread/read": { thread: fresh } } });
    const done = await f.invoke(["--archive-orphans"]);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /skipped-active-or-changed/);
  }
  f.configure({ responses: { "thread/list": { data: [], nextCursor: "loop" } } });
  const loop = await f.invoke(["--archive-orphans"]);
  assert.equal(loop.code, 1);
  assert.match(loop.stderr, /repeated.*cursor/);
  assert.equal(loop.stdout, "");
  assert.equal(incoming(f, "thread/archive").length, 0);
});

test("ownership receipts fail closed on mismatched roots, damaged and linked records", (t) => {
  const f = fixture(t);
  const [thread] = seed(f, [{}]);
  assert.equal(readThreadOwner(f.resultsDir, thread.id, f.other), null);
  const file = path.join(f.resultsDir, "thread-owners", `${digest(thread.id)}.json`);
  const context = {
    stateBase: f.state,
    stateDir: path.join(f.state, "1".padStart(32, "0")),
    resultsDir: f.resultsDir,
  };
  assert.equal(
    rememberThread({ runKey: "2".padStart(32, "0") }, context, { threadId: thread.id }),
    false,
  );
  fs.linkSync(file, `${file}.link`);
  assert.equal(readThreadOwner(f.resultsDir, thread.id, f.state), null);
  assert.equal(
    rememberThread({ runKey: "1".padStart(32, "0") }, context, { threadId: thread.id }),
    false,
  );
  fs.rmSync(`${file}.link`);
  fs.writeFileSync(file, "{}");
  assert.equal(readThreadOwner(f.resultsDir, thread.id, f.state), null);
});

test("name failure warns but never resubmits a successful task", async (t) => {
  const f = fixture(t, {
    rpcErrors: { "thread/name/set": { code: -32000, message: "PRIVATE-NAME-ERROR" } },
  });
  const done = await f.invoke(launch);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stderr, /could not be named/);
  assert.doesNotMatch(done.stderr, /PRIVATE-NAME-ERROR/);
  assert.equal(incoming(f, "turn/start").length, 1);
});
