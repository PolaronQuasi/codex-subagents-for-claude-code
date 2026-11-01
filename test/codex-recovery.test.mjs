import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import { delivered } from "./support/capture.mjs";
import { selectCodex } from "../src/codex/cli.mjs";
import { recoverJob } from "../src/run/recovery.mjs";
import {
  createJob,
  readTurn,
  readFinal,
  readDriver,
  writeFinal,
  writeTurn,
  jobPaths,
  createSteer,
  writeDriver,
  appendLog,
} from "../src/state/job-store.mjs";
import { alive, runProcess } from "../src/shared/io.mjs";

async function until(read) {
  for (let n = 0; n < 400; n++) {
    const value = read();
    if (value) return value;
    await delay(25);
  }
  assert.fail("timed out");
}
const user = (clientId) => ({ type: "userMessage", id: "user", clientId, content: [] });
const agent = (text) => ({ type: "agentMessage", id: "agent", phase: "final_answer", text });
async function endedJob(t, patch = {}, history = []) {
  const f = fixture(t);
  const jobId = "task-recover-001";
  const codex = await selectCodex(f.env, f.work);
  const ended = await runProcess(process.execPath, [
    "-e",
    "process.stdout.write(String(process.pid))",
  ]);
  assert.equal(ended.status, 0);
  createJob(f.state, {
    jobId,
    pid: Number(ended.stdout),
    processStart: "ended-child",
    phase: "dispatching",
    dispatching: true,
    threadId: "kept-thread",
    cwd: f.work,
    codex,
    model: "fixture-model",
    effort: "max",
    ...patch,
  });
  fs.writeFileSync(
    f.env.FIXTURE_HISTORY,
    JSON.stringify({
      "kept-thread": { id: "kept-thread", cwd: f.work, model: "fixture-model", turns: history },
    }),
  );
  return { f, jobId, run: { jobId }, context: { stateDir: f.state, parentEnv: f.env } };
}

for (const identified of [false, true])
  test(`review recovery requires a proven turn ID (identified=${identified})`, async (t) => {
    const r = await endedJob(
      t,
      { review: "uncommitted", ...(identified ? { turnId: "review-turn" } : {}) },
      [
        {
          id: "review-turn",
          status: "completed",
          itemsView: "full",
          items: [
            { id: "review-result", type: "exitedReviewMode", review: "Reviewed from history" },
          ],
        },
      ],
    );
    const result = await recoverJob(r.run, r.context);
    assert.equal(result.retryable, false);
    assert.equal(result.terminal.status, identified ? "completed" : "failed");
    if (identified) assert.equal(readFinal(r.f.state, r.jobId), "Reviewed from history");
    else assert.equal(result.terminal.error.code, "SUBMISSION_UNCERTAIN");
    assert.equal(
      r.f.events().some((e) => ["turn/start", "review/start", "turn/steer"].includes(e.method)),
      false,
    );
  });

for (const missingSteer of [false, true])
  test(`recovery and retained diagnostics scrub steering input (missing=${missingSteer})`, async (t) => {
    const r = await endedJob(t, { generation: "generation", turnId: "turn" });
    const prompt = 'ORIGINAL-PRIVATE-"input"';
    const steer = 'STEERING-PRIVATE-"input"';
    fs.writeFileSync(path.join(r.f.state, "prompt.txt"), prompt);
    const driver = readDriver(r.f.state, r.jobId);
    const n = createSteer(r.f.state, driver, steer);
    writeDriver(r.f.state, r.jobId, {
      ...driver,
      steers: [
        {
          n,
          status: "uncertain",
          expectedTurnId: "turn",
          clientUserMessageId: `${r.jobId}/steer-${n}`,
        },
      ],
    });
    const errorText = `Rejected ${JSON.stringify(prompt)} and ${JSON.stringify(steer)}`;
    appendLog(r.f.state, r.jobId, errorText + "\n");
    r.f.configure({ rpcErrors: { "thread/resume": { code: -32001, message: errorText } } });
    if (missingSteer)
      fs.unlinkSync(path.join(jobPaths(r.f.state, r.jobId).directory, `steer-${n}.txt`));
    const key = "a".repeat(32),
      warnings = [];
    const result = await recoverJob(
      { ...r.run, runKey: key },
      { ...r.context, resultsDir: r.f.resultsDir, warn: (text) => warnings.push(text) },
    );
    assert.doesNotMatch(JSON.stringify(result), /ORIGINAL-PRIVATE|STEERING-PRIVATE/);
    const audit = path.join(r.f.resultsDir, "audit", key);
    if (missingSteer) {
      assert.equal(fs.existsSync(audit), false);
      assert.match(warnings.join(" "), /diagnostic text withheld/);
    } else {
      const saved = fs
        .readdirSync(audit)
        .map((name) => fs.readFileSync(path.join(audit, name), "utf8"))
        .join("\n");
      assert.doesNotMatch(saved, /ORIGINAL-PRIVATE|STEERING-PRIVATE/);
      assert.match(saved, /prompt omitted/);
    }
    assert.equal(
      r.f.events().some((event) => ["turn/start", "turn/steer"].includes(event.method)),
      false,
    );
  });

test("terminal recovery settles an older observed steer only after its driver ended", async (t) => {
  const entry = {
    n: 1,
    status: "uncertain",
    observed: true,
    expectedTurnId: "turn",
    clientUserMessageId: "task-recover-001/steer-1",
  };
  const r = await endedJob(t, { steers: [entry] });
  writeTurn(r.f.state, r.jobId, { status: "completed", turnId: "turn" });
  await recoverJob(r.run, { ...r.context, lookup: assert.fail });
  assert.equal(readDriver(r.f.state, r.jobId).steers[0].status, "accepted");
});

test("terminal recovery neither rewrites a live driver's steer nor requires readable driver metadata", async (t) => {
  const entry = { n: 1, status: "uncertain", observed: true, expectedTurnId: "turn" };
  const r = await endedJob(t, { pid: process.pid, processStart: "owner", steers: [entry] });
  writeTurn(r.f.state, r.jobId, { status: "completed", turnId: "turn" });
  const context = {
    ...r.context,
    lookup: assert.fail,
    processes: { probe: { start: () => "owner" } },
  };
  assert.equal((await recoverJob(r.run, context)).terminal.status, "completed");
  assert.equal(readDriver(r.f.state, r.jobId).steers[0].status, "uncertain");
  const file = jobPaths(r.f.state, r.jobId).driverFile;
  const before = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, "{");
    assert.equal((await recoverJob(r.run, context)).terminal.status, "completed");
  } finally {
    fs.writeFileSync(file, before); // Fixture teardown still needs its process identities.
  }
});

test("recovery adopts exactly one matching history turn across pages, hydrating unloaded items; never resends", async (t) => {
  const r = await endedJob(t, {}, [
    {
      id: "match",
      status: "completed",
      items: [user("task-recover-001"), agent("Recovered λ\n")],
      itemsView: "full",
    },
    { id: "other", status: "completed", items: [user("different")], itemsView: "full" },
  ]);
  r.f.configure({ historyPageSize: 1, historyItemsUnloaded: true });
  const result = await recoverJob(r.run, r.context);
  assert.equal(result.terminal.status, "completed");
  assert.equal(result.terminal.turnId, "match");
  assert.equal(result.terminal.tokenUsage, null, "history cannot reconstruct usage");
  assert.equal(result.retryable, false);
  assert.equal(fs.readFileSync(jobPaths(r.f.state, r.jobId).finalFile, "utf8"), "Recovered λ\n");
  const sent = r.f.events().filter((e) => e.direction === "in");
  assert.equal(sent.filter((e) => e.method === "thread/turns/list").length, 2);
  assert.equal(sent.find((e) => e.method === "thread/resume").params.excludeTurns, true);
  assert.equal(
    sent.some((e) => e.method === "thread/items/list"),
    true,
  );
  assert.equal(
    sent.some((e) => e.method === "turn/start"),
    false,
  );
});

test("recovery preserves checkpointed model observations without inventing unseen events", async (t) => {
  const modelEvents = {
    reroutes: [{ from: "fixture-model", to: "rerouted-model", reason: "highRiskCyberActivity" }],
    warnings: ["guardian-warning"],
    buffering: null,
    buffered: false,
    truncated: false,
  };
  const r = await endedJob(t, { modelEvents }, [
    {
      id: "match",
      status: "completed",
      itemsView: "full",
      items: [user("task-recover-001"), agent("Recovered\n")],
    },
  ]);
  const result = await recoverJob(r.run, r.context);
  assert.deepEqual(result.terminal.modelEvents, modelEvents);
  assert.equal(
    r.f.events().some((event) => event.direction === "in" && event.method === "turn/start"),
    false,
  );
});

test("dead-driver recovery reconciles a dispatched steer from history without sending either prompt again", async (t) => {
  const entry = {
    n: 1,
    status: "dispatching",
    expectedTurnId: "match",
    clientUserMessageId: "task-recover-001/steer-1",
  };
  const r = await endedJob(t, { steers: [entry] }, [
    {
      id: "match",
      status: "completed",
      itemsView: "full",
      items: [user("task-recover-001"), user(entry.clientUserMessageId), agent("Steered answer")],
    },
  ]);
  const result = await recoverJob(r.run, r.context);
  assert.equal(result.terminal.status, "completed");
  assert.equal(result.retryable, false);
  const saved = readDriver(r.f.state, r.jobId).steers[0];
  assert.equal(saved.status, "accepted");
  assert.equal(saved.observed, true);
  assert.equal(
    r.f
      .events()
      .some(
        (event) => event.direction === "in" && ["turn/start", "turn/steer"].includes(event.method),
      ),
    false,
  );
});

for (const [label, turns] of [
  ["no matching client id", []],
  [
    "two matching client ids",
    ["one", "two"].map((id) => ({
      id,
      status: "completed",
      items: [user("task-recover-001"), agent(id)],
      itemsView: "full",
    })),
  ],
  [
    "nonterminal match",
    [{ id: "one", status: "futureStatus", items: [user("task-recover-001")], itemsView: "full" }],
  ],
])
  test(`uncertain submission with ${label} is durable and never retried`, async (t) => {
    const r = await endedJob(t, {}, turns);
    const result = await recoverJob(r.run, r.context);
    assert.equal(result.terminal.status, "failed");
    assert.equal(result.terminal.error.code, "SUBMISSION_UNCERTAIN");
    assert.equal(result.retryable, false);
    assert.equal(
      r.f.events().some((e) => e.method === "turn/start"),
      false,
    );
  });

test("an unknown driver phase is uncertain and cannot be treated as definitely unsent", async (t) => {
  const r = await endedJob(t, { phase: "futurePhase", dispatching: false, threadId: null });
  const result = await recoverJob(r.run, r.context);
  assert.equal(result.retryable, false);
  assert.equal(result.terminal.error.code, "SUBMISSION_UNCERTAIN");
});

test("an interrupted history turn after driver death is failed, never cancelled", async (t) => {
  const r = await endedJob(t, {}, [
    { id: "crashed", status: "interrupted", items: [user("task-recover-001")], itemsView: "full" },
  ]);
  const result = await recoverJob(r.run, r.context);
  assert.equal(result.terminal.status, "failed");
  assert.equal(result.terminal.tokenUsage, null);
  assert.match(result.terminal.error.message, /Driver ended/);
  assert.equal(result.retryable, false);
});

test("only a proved undispatched dead driver permits the one retry", async (t) => {
  const r = await endedJob(t, { phase: "starting", dispatching: false, turnId: null });
  const result = await recoverJob(r.run, r.context);
  assert.equal(result.retryable, true);
  assert.equal(result.terminal.status, "failed");
  assert.deepEqual(r.f.events(), []);
  assert.equal((await recoverJob(r.run, r.context)).retryable, false);
});

test("a missing thread, history read failure or changed CLI build never grants a retry", async (t) => {
  const r = await endedJob(t, { threadId: null });
  assert.equal((await recoverJob(r.run, r.context)).terminal.error.code, "SUBMISSION_UNCERTAIN");
  const failed = await endedJob(t);
  failed.f.configure({ exitOnMethods: ["thread/turns/list"] });
  assert.equal(
    (await recoverJob(failed.run, failed.context)).terminal.error.code,
    "SUBMISSION_UNCERTAIN",
  );
  const changed = await endedJob(t);
  fs.appendFileSync(changed.f.executable, "\n");
  assert.equal(
    (await recoverJob(changed.run, changed.context)).terminal.error.code,
    "SUBMISSION_UNCERTAIN",
  );
  assert.deepEqual(changed.f.events(), []);
});

for (const [kind, code, cause] of [
  ["expired login", "CODEX_RPC_ERROR", /Login expired; run codex login/],
  ["changed CLI", "CODEX_UNSUPPORTED", /Codex executable changed since this run began/],
  ["MCP discovery failure", "CODEX_UNSUPPORTED", /cannot list configured MCP servers/],
])
  test(`uncertain recovery keeps the ${kind} cause in its result and audit without prompt text or resubmission`, async (t) => {
    const r = await endedJob(t, kind === "MCP discovery failure" ? { mcp: "off" } : {});
    const prompt = 'Hidden task: λ "secret"\\input\n';
    fs.writeFileSync(path.join(r.f.state, "prompt.txt"), prompt);
    if (kind === "expired login")
      r.f.configure({
        rpcErrors: {
          "thread/resume": {
            code: -32001,
            message: `Login expired; run codex login. Rejected context: ${JSON.stringify(prompt)}`,
          },
        },
      });
    if (kind === "changed CLI") fs.appendFileSync(r.f.executable, "\n");
    if (kind === "MCP discovery failure")
      r.f.configure({ mcpListFailure: "fixture configuration unavailable" });
    const runKey = "a".repeat(32);
    const result = await recoverJob(
      { ...r.run, runKey },
      {
        ...r.context,
        resultsDir: r.f.resultsDir,
        warn: (message) => assert.fail(message),
      },
    );
    assert.equal(result.terminal.status, "failed");
    assert.equal(result.terminal.error.code, "SUBMISSION_UNCERTAIN");
    assert.equal(result.retryable, false);
    const message = result.terminal.error.message;
    assert.ok(message.includes(`History lookup failed: ${code}:`), message);
    assert.match(message, cause);
    assert.equal(message.includes(prompt.trim()), false);
    assert.equal(message.includes(JSON.stringify(prompt).slice(1, -1)), false);
    if (kind === "expired login") assert.ok(message.includes("<prompt omitted>"));
    assert.equal(fs.readFileSync(jobPaths(r.f.state, r.jobId).finalFile, "utf8"), message);
    const audit = JSON.parse(
      fs.readFileSync(
        path.join(r.f.resultsDir, "audit", runKey, `worker-death-${r.jobId}.turn.json`),
        "utf8",
      ),
    );
    assert.equal(audit.error.message, message);
    assert.equal(audit.error.code, "SUBMISSION_UNCERTAIN");
    assert.equal(
      r.f.events().some((event) => event.method === "turn/start"),
      false,
    );
  });

test("history diagnostics with an unreadable saved prompt retain the code and withhold unredacted text", async (t) => {
  const r = await endedJob(t);
  r.f.configure({
    rpcErrors: {
      "thread/resume": { code: -32001, message: "Login expired; possible private context" },
    },
  });
  const result = await recoverJob(r.run, r.context);
  assert.equal(result.terminal.error.code, "SUBMISSION_UNCERTAIN");
  assert.match(result.terminal.error.message, /CODEX_RPC_ERROR: Diagnostic text withheld/);
  assert.equal(result.terminal.error.message.includes("possible private context"), false);
  assert.equal(result.retryable, false);
  assert.equal(
    r.f.events().some((event) => event.method === "turn/start"),
    false,
  );
});

test("terminal-first recovery preserves a completion racing history lookup and immutable final text", async (t) => {
  const r = await endedJob(t);
  const result = await recoverJob(r.run, {
    ...r.context,
    lookup: async () => {
      const finalSha256 = writeFinal(r.f.state, r.jobId, "Winning completion");
      writeTurn(r.f.state, r.jobId, { status: "completed", finalSha256 });
      return null;
    },
  });
  assert.equal(result.terminal.status, "completed");
  writeFinal(r.f.state, r.jobId, "Losing settlement");
  assert.equal(
    fs.readFileSync(jobPaths(r.f.state, r.jobId).finalFile, "utf8"),
    "Winning completion",
  );
});

test("history recovery publishes immutable final text and terminal results on a filesystem without hard links", async (t) => {
  const r = await endedJob(t, {}, [
    {
      id: "match",
      status: "completed",
      items: [user("task-recover-001"), agent("Recovered without links")],
      itemsView: "full",
    },
  ]);
  const link = fs.linkSync,
    rename = fs.renameSync,
    paths = jobPaths(r.f.state, r.jobId);
  let refused = 0,
    renamed = 0;
  t.mock.method(fs, "linkSync", (from, to, ...args) => {
    if ([paths.finalFile, paths.turnFile].includes(to)) {
      refused++;
      throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" });
    }
    return link(from, to, ...args);
  });
  t.mock.method(fs, "renameSync", (from, to, ...args) => {
    if ([paths.finalFile, paths.turnFile].includes(to)) {
      renamed++;
      assert.equal(fs.existsSync(to), false, "no empty terminal placeholder is exposed");
    }
    return rename(from, to, ...args);
  });
  const result = await recoverJob(r.run, r.context);
  assert.equal(result.terminal.status, "completed");
  assert.equal(result.retryable, false);
  assert.equal(refused, 2);
  assert.equal(renamed, 2);
  assert.equal(fs.readFileSync(paths.finalFile, "utf8"), "Recovered without links");
  assert.equal(writeFinal(r.f.state, r.jobId, "Losing result"), result.terminal.finalSha256);
  assert.deepEqual(writeTurn(r.f.state, r.jobId, { status: "cancelled" }), result.terminal);
  assert.ok(fs.readdirSync(paths.directory).every((name) => !/\.tmp$|\.publish$/.test(name)));
  assert.equal(
    r.f.events().some((event) => event.method === "turn/start"),
    false,
  );
});

function captureDriver(t) {
  const spawn = childProcess.spawn;
  const children = [];
  t.mock.method(childProcess, "spawn", (...args) => {
    const child = spawn(...args);
    if (args[1]?.[0]?.endsWith("driver.mjs")) children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return children;
}

test("runner reconciles a driver crash after dispatch and never cancels or resubmits that turn", async (t) => {
  const f = fixture(t, { hangTurn: true });
  const children = captureDriver(t);
  const receipt = await f.invoke([...LAUNCH.slice(0, -2), "--detach"]);
  assert.equal(receipt.code, 0, receipt.stderr);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  await until(() => readDriver(stateDir, run.jobId)?.turnId);
  children[0].kill(); // Held handle, only the driver this test spawned.
  await until(() => !alive(run.worker.pid));
  f.configure({ hangTurn: false });
  const result = await f.invoke(["--run", run.runKey, "--wait-ms", "8000"]);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(delivered(result.stdout).footer.status, "failed");
  assert.equal(
    f.events().filter((e) => e.direction === "in" && e.method === "turn/start").length,
    1,
  );
});

test("runner retries a driver crash before dispatch once, preserving the prompt and thread safety", async (t) => {
  const f = fixture(t, { startDelayMs: 4000 });
  const children = captureDriver(t);
  const receipt = await f.invoke([...LAUNCH.slice(0, -2), "--detach", "--keep-state"]);
  assert.equal(receipt.code, 0, receipt.stderr);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  await until(() => readDriver(stateDir, run.jobId)?.appServer);
  assert.equal(readDriver(stateDir, run.jobId).dispatching, undefined);
  children[0].kill();
  await until(() => !alive(run.worker.pid));
  f.configure({ startDelayMs: 0 });
  const result = await f.invoke(["--run", run.runKey, "--wait-ms", "8000"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.metadata().retriedJobs.length, 1);
  assert.equal(
    f.events().filter((e) => e.direction === "in" && e.method === "turn/start").length,
    1,
  );
  assert.notEqual(f.metadata().jobId, run.jobId);
});

test("unknown driver identity refuses cancellation and keeps the write lock and all state", async (t) => {
  const f = fixture(t, { hangTurn: true });
  const receipt = await f.invoke([...LAUNCH.slice(0, -2), "--detach", "--write"]);
  assert.equal(receipt.code, 0, receipt.stderr);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  await until(() => readDriver(stateDir, run.jobId)?.turnId);
  const result = await f.invoke(["--cancel", run.runKey], {
    processes: {
      probe: { start: () => null },
      stop: () => assert.fail("unknown identity cannot stop"),
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exit could not be confirmed/);
  assert.equal(readTurn(stateDir, run.jobId), null);
  assert.equal(
    fs.existsSync(path.join(jobPaths(stateDir, run.jobId).directory, "cancel.json")),
    false,
  );
  assert.ok(fs.readdirSync(path.join(f.state, "writers")).some((name) => name.endsWith(".lock")));
});
