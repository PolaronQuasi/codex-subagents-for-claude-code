import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./support/codex-fixture.mjs";
import { selectCodex } from "../src/codex/cli.mjs";
import { CodexSession, foldItems } from "../src/codex/session.mjs";
import { spawnDriver, createDriverClient, stopDriver } from "../src/codex/driver-client.mjs";
import { runDriver } from "../src/codex/driver.mjs";
import {
  createJob,
  jobPaths,
  readDriver,
  readTurn,
  readFinal,
  writeCancelIntent,
} from "../src/state/job-store.mjs";
import { atomicWrite, alive } from "../src/shared/io.mjs";
import { processStart } from "../src/shared/process-identity.mjs";
import { PROCESSES } from "../src/shared/process-stop.mjs";
import { runProcess } from "../src/shared/io.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { SERVER_REQUEST, RPC, IS_WINDOWS } from "../src/shared/constants.mjs";
import { parseTaskFile, applyDirectives } from "../src/cli/task-input.mjs";
import { captureDrivers } from "./support/driver-evidence.mjs";
import { cancelJob } from "../src/run/cancel.mjs";
import { recoverJob } from "../src/run/recovery.mjs";

export async function until(read, message = "condition") {
  for (let n = 0; n < 300; n++) {
    const value = read();
    if (value) return value;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${message}`);
}
const input = "Unicode prompt canary: λ 日本語 🚀\n";
async function launch(t, f, options = {}) {
  fs.writeFileSync(path.join(f.state, "prompt.txt"), input);
  const launched = await spawnDriver(
    {
      runKey: "a".repeat(32),
      cwd: f.work,
      codex: await selectCodex(f.env, f.work),
      model: "fixture-model",
      effort: "max",
      mcp: "inherit",
      ...options.plan,
    },
    {
      stateDir: f.state,
      env: f.env,
      ...options,
    },
  );
  f.trackChild(launched.child);
  return { ...launched, run: { jobId: launched.jobId, worker: launched.worker } };
}

test("driver identity is recorded at birth, gate opens after save, and dispatch is durable before the request", async (t) => {
  const f = fixture(t);
  let saved = false;
  const d = await launch(t, f, {
    openGate: false,
    onIdentity(worker, record) {
      assert.equal(processStart(worker.pid), worker.processStart);
      assert.equal(record.pid, worker.pid);
      assert.deepEqual(f.events(), []);
      saved = true;
    },
  });
  await delay(300);
  assert.equal(saved, true);
  assert.deepEqual(f.events(), [], "no Codex process before the gate");
  const record = readDriver(f.state, d.jobId);
  atomicWrite(
    path.join(jobPaths(f.state, d.jobId).directory, "gate.json"),
    JSON.stringify({ ...d.worker, generation: record.generation }),
  );
  const turn = await until(() => readTurn(f.state, d.jobId), "terminal");
  assert.equal(turn.status, "completed");
  assert.equal(
    readFinal(f.state, d.jobId, { sha256: turn.finalSha256 }),
    "A complete result: λ, 日本語, 🚀.\n",
  );
  const sent = f.events().filter((e) => e.direction === "in");
  assert.equal(
    sent.find((e) => e.method === "initialize").params.capabilities.experimentalApi,
    false,
  );
  assert.equal(
    sent.find((e) => e.method === "initialize").params.capabilities.requestAttestation,
    false,
  );
  assert.ok(sent.find((e) => e.method === "initialized"));
  assert.equal(sent.find((e) => e.method === "turn/start").params.clientUserMessageId, d.jobId);
  assert.equal(sent.find((e) => e.method === "turn/start").params.effort, "max");
  assert.equal(sent.find((e) => e.method === "turn/start").params.input[0].text, input);
  assert.equal(readDriver(f.state, d.jobId).dispatching, true);
  assert.equal(
    fs.readFileSync(jobPaths(f.state, d.jobId).eventsFile, "utf8").includes(input.trim()),
    false,
  );
  await until(() => !alive(d.worker.pid), "driver exit");
});

test("an ungated driver expires without starting Codex", async (t) => {
  const f = fixture(t);
  const id = createJob(f.state, { phase: "gated" });
  let now = 0;
  await runDriver(f.state, id, {
    gateMs: 10,
    timing: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  });
  assert.equal(readTurn(f.state, id).status, "failed");
  assert.match(readTurn(f.state, id).error.message, /gate expired/);
  assert.deepEqual(f.events(), []);
});

test("an OS-refused driver spawn publishes a failed terminal result without starting Codex", async (t) => {
  const f = fixture(t);
  await assert.rejects(launch(t, f, { plan: { cwd: path.join(f.root, "missing cwd") } }), /ENOENT/);
  const [jobId] = fs.readdirSync(path.join(f.state, "jobs"));
  const turn = readTurn(f.state, jobId);
  assert.equal(turn.status, "failed");
  assert.match(turn.error.message, /Driver did not start.*ENOENT/s);
  assert.equal(readDriver(f.state, jobId).pid, undefined);
  assert.deepEqual(await stopDriver({ jobId }, { stateDir: f.state }), { state: "gone" });
  assert.deepEqual(f.events(), []);
});

test("failed driver identity publication never opens the gate or dispatches twice", async (t) => {
  const f = fixture(t),
    children = captureDrivers(t);
  let worker;
  await assert.rejects(
    launch(t, f, {
      onIdentity(value) {
        worker = value;
        throw new Error("identity publication refused");
      },
    }),
    /identity publication refused/,
  );
  f.trackChild(children[0]);
  const gate = path.join(jobPaths(f.state, worker.jobId).directory, "gate.json");
  try {
    assert.equal(fs.existsSync(gate), false);
    assert.equal(children.length, 1);
    assert.deepEqual(f.events(), []);
  } finally {
    // Admit this test's held gated child once to let it finish through its
    // fake; never leave a fifteen-second gate sleeper for fixture teardown.
    atomicWrite(
      gate,
      JSON.stringify({ ...worker, generation: readDriver(f.state, worker.jobId).generation }),
    );
    await until(() => readTurn(f.state, worker.jobId));
    await until(() => children[0].exitCode !== null || children[0].signalCode !== null);
  }
  assert.equal(f.events().filter((e) => e.method === "turn/start").length, 1);
});

test("driver gate refuses missing, invalid and mismatched admissions without starting Codex", async (t) => {
  for (const body of [null, "{", "{}"]) {
    const f = fixture(t);
    const id = createJob(f.state, { phase: "gated", generation: "expected" });
    if (body !== null)
      fs.writeFileSync(path.join(jobPaths(f.state, id).directory, "gate.json"), body);
    let now = 0;
    await runDriver(f.state, id, {
      gateMs: 1,
      timing: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    assert.equal(readTurn(f.state, id).status, "failed");
    assert.deepEqual(f.events(), []);
  }
});

test("IPC interrupt sends turn/interrupt, persists intent and leaves usage unknown", async (t) => {
  const f = fixture(t, { hangTurn: true });
  const d = await launch(t, f);
  await until(() => readDriver(f.state, d.jobId)?.turnId);
  const c = createDriverClient(d.run, { stateDir: f.state });
  assert.equal((await c.hello()).phase, "running");
  await c.interrupt();
  const turn = await until(() => readTurn(f.state, d.jobId));
  assert.equal(turn.status, "cancelled");
  assert.equal(turn.tokenUsage, null);
  assert.ok(readDriver(f.state, d.jobId).cancelRequestedAt);
  assert.equal(
    f.events().filter((e) => e.direction === "in" && e.method === "turn/interrupt").length,
    1,
  );
});

test("cancel intent arriving after IPC binds is re-read before dispatch and stale generations are ignored", async (t) => {
  for (const stale of [false, true]) {
    const f = fixture(t, { pausedMethods: ["thread/start"] });
    const d = await launch(t, f);
    await until(() => f.events().some((event) => event.method === "thread/start"));
    assert.equal(readDriver(f.state, d.jobId).ipcBound, true);
    writeCancelIntent(
      f.state,
      d.jobId,
      stale ? "old-generation" : readDriver(f.state, d.jobId).generation,
    );
    f.configure({ pausedMethods: [] });
    const turn = await until(() => readTurn(f.state, d.jobId));
    assert.equal(turn.status, stale ? "completed" : "cancelled");
    assert.equal(Boolean(readDriver(f.state, d.jobId).dispatching), stale);
    assert.equal(f.events().filter((event) => event.method === "turn/start").length, stale ? 1 : 0);
    await until(() => !alive(d.worker.pid));
  }
});

test("shutdown is bounded, closes stdin and leaves both owned processes gone", async (t) => {
  const f = fixture(t, { hangTurn: true });
  const d = await launch(t, f);
  await until(() => readDriver(f.state, d.jobId)?.turnId);
  const childPid = readDriver(f.state, d.jobId).appServer.pid;
  await stopDriver(d.run, { stateDir: f.state });
  assert.equal(alive(d.worker.pid), false);
  await until(() => !alive(childPid));
});

test("post-dispatch app-server crash preserves uncertainty until history reconciliation", async (t) => {
  const f = fixture(t, { exitAfterTurnStart: true });
  const d = await launch(t, f);
  await until(() => !alive(d.worker.pid));
  assert.equal(readTurn(f.state, d.jobId), null);
  const { terminal: turn } = await recoverJob(d.run, {
    stateDir: f.state,
    parentEnv: f.env,
    lookup: async () => null,
  });
  assert.equal(turn.status, "failed");
  assert.equal(turn.error.code, "SUBMISSION_UNCERTAIN");
  assert.equal(turn.tokenUsage, null);
});

test("a conflicting turn/completed summary fails promptly and a later cancel preserves the failure", async (t) => {
  for (const item of [
    { type: "agentMessage", id: "agent-fixture", phase: "final_answer", text: "Changed summary" },
    { type: "fileChange", id: "files-fixture", status: "completed", changes: [] },
  ]) {
    const f = fixture(t, { touchedFiles: ["fixture.txt"], completedItems: [item] });
    const d = await launch(t, f);
    const turn = await until(() => readTurn(f.state, d.jobId), "failed summary publication");
    assert.equal(turn.status, "failed");
    assert.equal(turn.error.code, "CODEX_RPC_ERROR");
    assert.match(turn.error.message, /Inconsistent completed item/);
    assert.deepEqual(await cancelJob(d.run, { stateDir: f.state, parentEnv: f.env }), turn);
    await until(() => !alive(d.worker.pid), "failed driver exit");
    assert.equal(
      f.events().some((event) => event.method === "turn/interrupt"),
      false,
    );
  }
});

test("driver crash has no fabricated cancellation, and EOF ends the fake child", async (t) => {
  const f = fixture(t, { hangTurn: true });
  const d = await launch(t, f);
  await until(() => readDriver(f.state, d.jobId)?.turnId);
  const app = readDriver(f.state, d.jobId).appServer;
  d.child.kill(); // ChildProcess held since birth; never a bare PID.
  await until(() => !alive(d.worker.pid));
  await until(() => !alive(app.pid));
  assert.equal(readTurn(f.state, d.jobId), null);
});

for (const method of Object.values(SERVER_REQUEST))
  test(`session answers server request ${method} once`, async (t) => {
    const f = fixture(t, { serverRequests: [method], turnDelayMs: 100 });
    const session = new CodexSession(
      {
        jobId: "task-fixture-001",
        cwd: f.work,
        codex: await selectCodex(f.env, f.work),
        model: "fixture-model",
        effort: "max",
      },
      { env: f.env, spawnChild: () => f.spawnServer() },
    );
    const result = await session.run(input);
    await session.close();
    const answers = f.events().filter((e) => e.direction === "in" && e.id === "server-1");
    assert.equal(answers.length, 1);
    if (method === "item/tool/requestUserInput") {
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "INTERACTION_REQUIRED");
      assert.ok(f.events().some((e) => e.method === "turn/interrupt"));
    }
    if (method === "account/chatgptAuthTokens/refresh")
      assert.equal(result.error.code, "CODEX_AUTH_REQUIRED");
    if (method === "attestation/generate") assert.equal(result.error.code, "CODEX_UNSUPPORTED");
  });

test("session folds full final items, touched paths and process usage, preferring pushed rate limits", async (t) => {
  const usage = {
    last: { inputTokens: 3 },
    total: { inputTokens: 19, outputTokens: 5, totalTokens: 24 },
  };
  const f = fixture(t, {
    tokenUsage: usage,
    touchedFiles: ["a", "a", "日本語"],
    rateLimits: { primary: { usedPercent: 82, windowDurationMins: 10080 } },
  });
  const checkpoints = [];
  const s = new CodexSession(
    {
      jobId: "task-fixture-001",
      cwd: f.work,
      codex: await selectCodex(f.env, f.work),
      model: "fixture-model",
      effort: "max",
      threadId: "kept-thread",
    },
    {
      env: f.env,
      spawnChild: () => f.spawnServer(),
      checkpoint: (p) => {
        checkpoints.push(p);
        if (p.dispatching)
          assert.equal(
            f.events().some((e) => e.method === RPC.TURN_START),
            false,
          );
      },
    },
  );
  const result = await s.run(input);
  await s.close();
  assert.equal(result.status, "completed");
  assert.deepEqual(result.tokenUsage, usage);
  assert.deepEqual(result.touchedFiles, ["a", "日本語"]);
  assert.equal(result.rateLimits.primary.usedPercent, 82);
  assert.equal(
    f.events().some((e) => e.method === RPC.RATE_LIMITS_READ),
    false,
  );
  assert.equal(f.events().find((e) => e.method === RPC.THREAD_RESUME).params.excludeTurns, true);
});

test("missing pushed limits fall back to the read", async (t) => {
  const f = fixture(t, { omitRateLimitsUpdate: true });
  const d = await launch(t, f);
  await until(() => readTurn(f.state, d.jobId));
  assert.equal(f.events().filter((e) => e.method === RPC.RATE_LIMITS_READ).length, 1);
  assert.equal(f.events().find((e) => e.method === RPC.RATE_LIMITS_READ).params, null);
});

test("rate-limit fallback uses the short probe bound and late shutdown preserves completed or cancelled status", async (t) => {
  for (const cancel of [false, true]) {
    const f = fixture(t, {
      hangTurn: cancel,
      omitRateLimitsUpdate: true,
      hangMethods: ["account/rateLimits/read"],
    });
    const session = new CodexSession(
      {
        jobId: "task-fixture-001",
        cwd: f.work,
        codex: await selectCodex(f.env, f.work),
        model: "fixture-model",
        effort: "max",
      },
      { env: f.env, spawnChild: () => f.spawnServer() },
    );
    const request = session.request.bind(session),
      notification = session.notification.bind(session);
    let probes = 0;
    t.mock.method(session, "request", (method, params, timeoutMs) => {
      if (method === "account/rateLimits/read") {
        probes++;
        assert.equal(
          timeoutMs,
          5000,
          "accounting uses the probe bound, never the general RPC bound",
        );
        // Exercise a genuinely unanswered RPC with a scaled test deadline.
        return request(method, params, 25);
      }
      return request(method, params, timeoutMs);
    });
    t.mock.method(session, "notification", (method, params) => {
      notification(method, params);
      if (method === "turn/completed")
        session.fail(
          Object.assign(new Error("Driver shutdown was requested."), { code: "CODEX_RPC_ERROR" }),
        );
    });
    const pending = session.run(input);
    if (cancel) {
      await until(() => session.turnId);
      await session.interrupt({ cancel: true });
    }
    const result = await pending;
    await session.close();
    assert.equal(result.status, cancel ? "cancelled" : "completed");
    assert.equal(result.error, null);
    assert.equal(result.rateLimits, null);
    assert.equal(probes, cancel ? 0 : 1);
    assert.equal(
      f.events().filter((event) => event.method === "account/rateLimits/read").length,
      probes,
    );
  }
});

test("write readiness sends the schema's null params without touching a real sandbox", async (t) => {
  const f = fixture(t);
  const d = await launch(t, f, { plan: { write: true } });
  assert.equal((await until(() => readTurn(f.state, d.jobId))).status, "completed");
  const readiness = f.events().find((e) => e.method === RPC.WINDOWS_SANDBOX_READINESS);
  if (IS_WINDOWS) assert.equal(readiness.params, null);
  else assert.equal(readiness, undefined);
});

test("mcp off discovers exact names just before launch and supplies all four opt-outs", async (t) => {
  const f = fixture(t, { mcpServers: ["qdrant", "node_repl"] });
  const d = await launch(t, f, { plan: { mcp: "off" } });
  assert.equal((await until(() => readTurn(f.state, d.jobId))).status, "completed");
  const args = f.events().find((e) => e.direction === "launch").args;
  for (const flag of [
    "plugins",
    "apps",
    "hooks",
    "notify=[]",
    'otel.exporter="none"',
    'otel.metrics_exporter="none"',
    'otel.trace_exporter="none"',
    "mcp_servers.qdrant.enabled=false",
    "mcp_servers.node_repl.enabled=false",
  ])
    assert.ok(args.includes(flag), `${flag} in ${JSON.stringify(args)}`);
});

test("mcp off discovers names after disabling plugins and preserves explicit user servers", async (t) => {
  const f = fixture(t, {
    mcpServers: ["user_server", "shared_name"],
    pluginMcpServers: ["plugin_only", "shared_name"],
  });
  const inherited = await f.codex(["mcp", "list", "--json"]);
  assert.ok(JSON.parse(inherited.stdout).some((server) => server.name === "plugin_only"));
  const d = await launch(t, f, { plan: { mcp: "off" } });
  const turn = await until(() => readTurn(f.state, d.jobId));
  assert.equal(turn.status, "completed", JSON.stringify(turn.error));
  const args = f.events().find((event) => event.direction === "launch").args;
  assert.ok(args.includes("mcp_servers.user_server.enabled=false"));
  assert.ok(args.includes("mcp_servers.shared_name.enabled=false"));
  assert.equal(args.includes("mcp_servers.plugin_only.enabled=false"), false);
});

test("final phase wins over null phase; commentary alone supplies no final", () => {
  assert.deepEqual(foldItems([{ type: "agentMessage", text: "comment", phase: "commentary" }]), {
    text: null,
    touchedFiles: [],
  });
  assert.equal(
    foldItems([
      { type: "agentMessage", text: "final", phase: "final_answer" },
      { type: "agentMessage", text: "null", phase: null },
    ]).text,
    "final",
  );
});

test("waiter exits while its gated detached driver finishes independently", async (t) => {
  const f = fixture(t, { turnDelayMs: 1500 });
  fs.writeFileSync(path.join(f.state, "prompt.txt"), input);
  const file = path.join(f.root, "waiter-plan.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      stateDir: f.state,
      plan: {
        runKey: "a".repeat(32),
        cwd: f.work,
        codex: await selectCodex(f.env, f.work),
        model: "fixture-model",
        effort: "max",
      },
    }),
  );
  const result = await runProcess(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/codex/waiter.mjs", import.meta.url))],
    { env: { ...f.env, FIXTURE_PLAN_FILE: file }, timeoutMs: 10_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const d = JSON.parse(result.stdout);
  assert.equal(readTurn(f.state, d.jobId), null);
  assert.equal((await until(() => readTurn(f.state, d.jobId))).status, "completed");
  await until(() => !alive(d.worker.pid));
});

test("abrupt waiter death also leaves the detached driver to finish and drain its child", async (t) => {
  const f = fixture(t, { turnDelayMs: 1500 });
  fs.writeFileSync(path.join(f.state, "prompt.txt"), input);
  const file = path.join(f.root, "waiter-plan.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      stateDir: f.state,
      plan: {
        runKey: "a".repeat(32),
        cwd: f.work,
        codex: await selectCodex(f.env, f.work),
        model: "fixture-model",
        effort: "max",
      },
    }),
  );
  const waiter = spawn(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/codex/waiter.mjs", import.meta.url))],
    {
      env: { ...f.env, FIXTURE_PLAN_FILE: file, FIXTURE_WAITER_HANG: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  f.trackChild(waiter);
  try {
    const receipt = await new Promise((resolve, reject) => {
      waiter.once("error", reject);
      waiter.stdout.once("data", (chunk) => resolve(JSON.parse(chunk)));
    });
    waiter.kill(); // This test's held parent handle, never a PID stop.
    await until(() => !alive(waiter.pid));
    assert.equal((await until(() => readTurn(f.state, receipt.jobId))).status, "completed");
    await until(() => !alive(receipt.worker.pid));
    assert.equal(alive(readDriver(f.state, receipt.jobId).appServer.pid), false);
  } finally {
    if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill();
  }
});

test("session shutdown captures the owned tree before EOF can orphan its descendants", async (t) => {
  const f = fixture(t, { exitOnStdinClose: false });
  let clock = 0,
    eofAt,
    handle,
    stopped = false;
  const session = new CodexSession(
    {
      jobId: "task-fixture-001",
      cwd: f.work,
      codex: await selectCodex(f.env, f.work),
      model: "fixture-model",
      effort: "max",
    },
    {
      env: f.env,
      spawnChild: () => {
        handle = f.spawnServer();
        return handle;
      },
      timing: {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          await delay(1);
        },
      },
      processes: {
        probe: PROCESSES.probe,
        stop: async (target) => {
          assert.equal(target.pid, handle.pid);
          assert.equal(target.start, processStart(handle.pid));
          assert.equal(handle.stdin.writableEnded, false);
          stopped = true;
          handle.kill();
          return { state: "stopped" };
        },
      },
    },
  );
  assert.equal((await session.run(input)).status, "completed");
  eofAt = clock;
  await session.close();
  assert.equal(stopped, true);
});

test("mcp directive accepts off and inherit and refuses misspelling or an invalid value", () => {
  const parsed = parseTaskFile(Buffer.from("mcp: off\n\nPrompt\n"));
  assert.equal(parsed.body, "Prompt\n");
  const options = {};
  applyDirectives(options, parsed.directives);
  assert.equal(options.mcp, "off");
  assert.throws(() => applyDirectives({}, { mcp: "false" }), /mcp needs/);
  assert.throws(() => parseTaskFile(Buffer.from("Mcp: off\nPrompt")), /lowercase/);
});
