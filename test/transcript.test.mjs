import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH, ORIGINAL } from "./support/codex-fixture.mjs";
import { parseArgs } from "../src/cli/options.mjs";
import { acquireRunLock } from "../src/state/state.mjs";
import { readTranscript } from "../src/maintenance/transcript.mjs";
import { PromptRedactor } from "../src/shared/prompt-redactor.mjs";

const launch = [...LAUNCH.slice(0, -2), "--wait-ms", "10000", "--keep-state"];
const incoming = (f, method) =>
  f.events().filter((e) => e.direction === "in" && e.method === method);
const transcript = (key, extra = []) => ["--transcript", key, "--json", ...extra];
const items = [
  { type: "userMessage", id: "user", content: [{ type: "text", text: "PRIVATE-USER" }] },
  {
    type: "commandExecution",
    id: "cmd",
    command: "node test.mjs",
    exitCode: 1,
    durationMs: 20,
    aggregatedOutput: `${ORIGINAL}\ncommand-output`,
  },
  { type: "reasoning", id: "reason", summary: ["checking paths"], content: ["PRIVATE-REASONING"] },
  { type: "fileChange", id: "files", changes: [{ path: "file.mjs", diff: "PRIVATE-DIFF" }] },
  {
    type: "mcpToolCall",
    id: "mcp",
    server: "docs",
    tool: "read",
    arguments: "PRIVATE-ARGS",
    result: "PRIVATE-RESULT",
  },
  { type: "agentMessage", id: "answer", text: "Final answer" },
];

test("transcript parses standalone options and refuses invalid turn selection", () => {
  assert.equal(parseArgs(transcript("a".repeat(32), ["--turn", "2"])).turn, 2);
  for (const value of ["0", "-1", "1.5", "10001"])
    assert.throws(() => parseArgs(transcript("a".repeat(32), ["--turn", value])), /--turn/);
  assert.throws(() => parseArgs(["--run", "a".repeat(32), "--turn", "1"]), /transcript only/);
  assert.throws(() => parseArgs([...transcript("a".repeat(32)), "--write"]), /takes only/);
});

test("transcript paginates turns and items, disables MCP on resume, and exposes only bounded selected fields", async (t) => {
  const f = fixture(t, {
    mcpServers: ["private_docs"],
    historyPageSize: 1,
    historyItemPageSize: 2,
    historyItemsUnloaded: true,
  });
  assert.equal((await f.invoke(launch)).code, 0);
  const run = f.metadata();
  const history = JSON.parse(fs.readFileSync(f.env.FIXTURE_HISTORY));
  history[run.result.threadId].turns = [
    { id: "first-turn", status: "completed", itemsView: "full", items },
    {
      id: "second-turn",
      status: "completed",
      itemsView: "full",
      items: [{ type: "webSearch", id: "search", query: "history protocol" }],
    },
  ];
  fs.writeFileSync(f.env.FIXTURE_HISTORY, JSON.stringify(history));
  const runFile = path.join(f.state, run.runKey, "run.json"),
    before = fs.readFileSync(runFile, "utf8");
  const done = await f.invoke(transcript(run.runKey));
  assert.equal(done.code, 0, done.stderr);
  const data = JSON.parse(done.stdout);
  assert.deepEqual(
    data.turns.map((row) => row.id),
    ["first-turn", "second-turn"],
  );
  assert.equal(data.truncated, false);
  assert.deepEqual(data.turns[0].items[1], {
    type: "commandExecution",
    id: "cmd",
    command: "node test.mjs",
    exitCode: 1,
    durationMs: 20,
    output: "[prompt withheld]\ncommand-output",
  });
  assert.doesNotMatch(done.stdout, /PRIVATE-|exact original prompt/);
  assert.match(done.stdout, /checking paths/);
  assert.ok(incoming(f, "thread/items/list").length > 2);
  const resume = incoming(f, "thread/resume").at(-1).params;
  assert.equal(resume.excludeTurns, true);
  assert.equal(resume.sandbox, "read-only");
  const lastLaunch = f
    .events()
    .filter((e) => e.direction === "launch")
    .at(-1);
  assert.ok(
    lastLaunch.args.includes("mcp_servers.private_docs.enabled=false"),
    JSON.stringify(lastLaunch),
  );
  assert.ok(lastLaunch.args.includes("notify=[]"));
  assert.equal(incoming(f, "turn/start").length, 1);
  assert.equal(incoming(f, "review/start").length, 0);
  assert.equal(fs.readFileSync(runFile, "utf8"), before);
  const second = await f.invoke(transcript(run.runKey, ["--turn", "2"]));
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(
    JSON.parse(second.stdout).turns.map((row) => row.number),
    [2],
  );
  const text = await f.invoke(["--transcript", run.runKey, "--turn", "1"]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /Turn 1/);
  assert.doesNotMatch(text.stdout, /Turn 2/);
});

test("transcript refuses active, locked and unsafe-resume cases before reading history", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, 3);
  const key = f.runs()[0];
  const active = await f.invoke(transcript(key));
  assert.equal(active.code, 1);
  assert.match(active.stderr, /delivered, sleeping/);
  assert.equal(incoming(f, "thread/resume").length, 0);
  f.configure({ status: "completed" });
  assert.equal((await f.invoke(["--run", key, "--wait-ms", "10000"])).code, 0);
  const lock = await acquireRunLock(key, {
    stateBase: f.state,
    deadline: Date.now(),
    mode: "attach",
  });
  try {
    assert.equal((await f.invoke(transcript(key))).code, 1);
  } finally {
    lock.releaseRunLock();
  }
  f.configure({ responses: { "thread/resume": { thread: { id: "wrong" } } } });
  const wrong = await f.invoke(transcript(key));
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /different identity or safety/);
  assert.equal(incoming(f, "thread/turns/list").length, 0);
});

test("history cursor cycles and foreign turn items fail without partial stdout or model calls", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke(launch)).code, 0);
  const run = f.metadata();
  f.configure({ responses: { "thread/turns/list": { data: [], nextCursor: "loop" } } });
  let done = await f.invoke(transcript(run.runKey));
  assert.equal(done.code, 1);
  assert.match(done.stderr, /repeated.*cursor/);
  assert.equal(done.stdout, "");
  f.configure({
    responses: {
      "thread/turns/list": {
        data: [{ id: "t", itemsView: "notLoaded", items: [] }],
        nextCursor: null,
      },
      "thread/items/list": { data: [{ turnId: "other", item: items[0] }], nextCursor: null },
    },
  });
  done = await f.invoke(transcript(run.runKey));
  assert.equal(done.code, 1);
  assert.match(done.stderr, /different turn/);
  assert.equal(done.stdout, "");
  assert.equal(incoming(f, "turn/start").length, 1);
});

test("transcript output stays valid bounded JSON and marks omitted history", async () => {
  const many = Array.from({ length: 2000 }, (_, n) => ({
    type: "agentMessage",
    id: String(n),
    text: "x".repeat(9000),
  }));
  const session = {
    request: async () => ({
      data: [{ id: "turn", status: "completed", itemsView: "full", items: many.slice(0, 1000) }],
      nextCursor: null,
    }),
  };
  const data = await readTranscript(session, "thread", { redactor: new PromptRedactor() });
  assert.equal(data.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 1024 * 1024);
  assert.ok(data.turns[0].items.length > 0 && data.turns[0].items.length < 1000);
  assert.ok(Buffer.byteLength(data.turns[0].items[0].text) <= 8192);
});
