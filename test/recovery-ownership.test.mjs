import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./support/codex-fixture.mjs";
import { selectCodex } from "../src/codex/cli.mjs";
import { CodexSession } from "../src/codex/session.mjs";
import { stopDriver } from "../src/codex/driver-client.mjs";
import { recoverJob } from "../src/run/recovery.mjs";
import { createJob, readDriver, readTurn, writeDriver } from "../src/state/job-store.mjs";
import {
  HISTORY_MAX_BYTES,
  HISTORY_READ_MS,
  RECOVERY_MAX_PAGES,
  RPC_MAX_FRAME_BYTES,
  PLATFORM,
} from "../src/shared/constants.mjs";

const root = { pid: process.pid, start: "recovery-birth" };
const answer = (jobId, id = "target") => ({
  id,
  status: "completed",
  itemsView: "full",
  items: [
    { id: "user", type: "userMessage", clientId: jobId, content: [] },
    { id: "answer", type: "agentMessage", phase: "final_answer", text: "Recovered answer" },
  ],
});

// Only the version probe uses the native fake. Sessions, identities and stops
// are in-memory fakes; no process is signalled, including this test process.
async function harness(t) {
  const f = fixture(t);
  const codex = await selectCodex(f.env, f.work);
  const jobId = createJob(f.state, {
    pid: process.pid,
    processStart: "original-driver-birth",
    appServer: { pid: process.pid, processStart: "original-server-birth" },
    generation: "generation",
    phase: "dispatching",
    dispatching: true,
    threadId: "thread",
    turnId: "target",
    cwd: f.work,
    codex,
    model: "fixture-model",
    effort: "max",
  });
  let currentStart = root.start;
  const h = {
    f,
    jobId,
    run: { jobId },
    opened: 0,
    historyCalls: [],
    saved: () => readDriver(f.state, jobId),
    end: () => (currentStart = "reused-after-recovery"),
    page: async () => ({ data: [answer(jobId)], nextCursor: null }),
    captured: () => {},
    resumed: () => {},
  };
  h.stop = async ({ onIdentified }) => {
    await onIdentified([root]);
    h.captured();
    h.end();
    return { state: "stopped", identities: [root] };
  };
  h.context = {
    stateDir: f.state,
    parentEnv: f.env,
    processes: {
      probe: {
        // This fake models stable birth tokens and PID reuse, not ps's
        // timezone-dependent lstart. macOS's weaker evidence is tested below.
        platform: PLATFORM.LINUX,
        start: () => currentStart,
      },
      stop: (target) => h.stop(target),
    },
  };
  t.mock.method(CodexSession.prototype, "open", async function () {
    h.opened++;
    currentStart = root.start;
    this.child = {
      pid: root.pid,
      kill: () => assert.fail("fake sessions never signal a process"),
      stdin: { end() {} },
      stdout: { destroy() {} },
      stderr: { destroy() {} },
    };
    this.childStart = root.start;
    this.exit = Promise.resolve();
    this.checkpoint({ appServer: { pid: root.pid, processStart: root.start } });
    this.checkpoint({ turnId: "unrelated-history-turn", phase: "running" });
  });
  t.mock.method(CodexSession.prototype, "request", async function (method, params, timeoutMs) {
    if (method === "thread/resume") {
      h.resumed();
      return { thread: { id: "thread" } };
    }
    assert.ok(["thread/turns/list", "thread/items/list"].includes(method), method);
    h.historyCalls.push({ method, params, timeoutMs });
    return h.page(method, params, timeoutMs);
  });
  return h;
}

test("recovery persists its birth and captured tree before history and terminal settlement", async (t) => {
  const h = await harness(t);
  h.resumed = () => {
    assert.deepEqual(h.saved().appServer, { pid: root.pid, processStart: root.start });
    assert.equal(h.saved().turnId, "target", "history notifications cannot replace turn identity");
  };
  h.captured = () => {
    assert.deepEqual(h.saved().shutdownTree, [root]);
    assert.equal(h.saved().shutdownIncomplete, true);
    assert.equal(readTurn(h.f.state, h.jobId), null);
  };
  const result = await recoverJob(h.run, h.context);
  assert.equal(result.terminal.status, "completed");
  assert.equal(result.retryable, false);
  assert.equal(h.saved().shutdownIncomplete, false);
  assert.deepEqual(await stopDriver(h.run, h.context), { state: "gone" });
});

test("a macOS recovery probe requires command evidence before adopting a changed PID", async (t) => {
  const h = await harness(t);
  h.context.processes.probe.platform = PLATFORM.DARWIN;
  await assert.rejects(recoverJob(h.run, h.context), { code: "WORKER_UNCONFIRMED" });
  assert.equal(h.opened, 0);
  h.context.processes.probe.commandLine = () => "unrelated fixture process";
  assert.equal((await recoverJob(h.run, h.context)).terminal.status, "completed");
  assert.equal(h.opened, 1);
});

test("failed recovery shutdown retains owned processes and blocks settlement and successor lookup", async (t) => {
  const h = await harness(t);
  const stopped = h.stop;
  h.stop = async ({ onIdentified }) => {
    await onIdentified([root]);
    return { state: "alive", identities: [root], detail: "fake tree remains alive" };
  };
  await assert.rejects(recoverJob(h.run, h.context), { code: "STOP_INCOMPLETE" });
  assert.equal(readTurn(h.f.state, h.jobId), null);
  assert.deepEqual(h.saved().appServer, { pid: root.pid, processStart: root.start });
  assert.equal(h.saved().shutdownIncomplete, true);
  assert.deepEqual(h.saved().shutdownTree, [root]);
  await assert.rejects(stopDriver(h.run, h.context), { code: "STOP_INCOMPLETE" });
  await assert.rejects(recoverJob(h.run, h.context), { code: "STOP_INCOMPLETE" });
  assert.equal(h.opened, 1, "pending ownership cannot be replaced by another recovery server");
  h.end();
  h.stop = stopped;
  const recovered = await recoverJob(h.run, h.context);
  assert.equal(recovered.terminal.status, "completed");
  assert.equal(h.opened, 2);
  assert.equal(h.saved().shutdownIncomplete, false);
});

test("lost recovery stop reply retains captured evidence even without a named error", async (t) => {
  const h = await harness(t);
  h.stop = async ({ onIdentified }) => {
    await onIdentified([root]);
    throw new Error("fake stop reply lost");
  };
  await assert.rejects(recoverJob(h.run, h.context), { code: "STOP_INCOMPLETE" });
  assert.equal(readTurn(h.f.state, h.jobId), null);
  assert.equal(h.saved().shutdownIncomplete, true);
  assert.deepEqual(h.saved().shutdownTree, [root]);
});

test("a successor cannot resume history while an interrupted recoverer's saved server is live", async (t) => {
  const h = await harness(t);
  let now = 0;
  h.context.timing = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  writeDriver(h.f.state, h.jobId, {
    ...h.saved(),
    appServer: { pid: root.pid, processStart: root.start },
  });
  await assert.rejects(recoverJob(h.run, h.context), { code: "WORKER_UNCONFIRMED" });
  assert.equal(h.opened, 0);
  assert.equal(readTurn(h.f.state, h.jobId), null);
  h.end();
  assert.equal((await recoverJob(h.run, h.context)).terminal.status, "completed");
  assert.equal(h.opened, 1);
});

test("recovery preserves an earlier uncaptured tree instead of clearing it with a new session", async (t) => {
  const h = await harness(t);
  writeDriver(h.f.state, h.jobId, {
    ...h.saved(),
    shutdownIncomplete: true,
    shutdownTree: [{ pid: process.pid, start: "ended-tree" }],
    shutdownTreeUnknown: true,
    shutdownCapturePending: false,
  });
  await assert.rejects(recoverJob(h.run, h.context), { code: "STOP_INCOMPLETE" });
  assert.equal(h.opened, 0);
  assert.equal(h.saved().shutdownTreeUnknown, true);
  assert.equal(readTurn(h.f.state, h.jobId), null);
});

test("concurrent recoverers cannot overwrite each other's process identity", async (t) => {
  const h = await harness(t);
  let entered, finish;
  const reading = new Promise((resolve) => (entered = resolve));
  const page = new Promise((resolve) => (finish = resolve));
  h.page = () => {
    entered();
    return page;
  };
  const first = recoverJob(h.run, h.context);
  await reading;
  try {
    await assert.rejects(recoverJob(h.run, h.context), { code: "GUARD_BUSY" });
    assert.equal(h.opened, 1);
  } finally {
    finish({ data: [answer(h.jobId)], nextCursor: null });
  }
  assert.equal((await first).terminal.status, "completed");
});

test("recovery shares the history page budget across turn listing and all item hydration", async (t) => {
  const h = await harness(t);
  h.page = async (method, params) =>
    method === "thread/turns/list"
      ? {
          data: Array.from({ length: RECOVERY_MAX_PAGES }, (_, i) => ({
            id: `turn-${i}`,
            status: "completed",
            itemsView: "notLoaded",
          })),
          nextCursor: null,
        }
      : {
          data: answer(h.jobId).items.map((item) => ({ turnId: params.turnId, item })),
          nextCursor: null,
        };
  const result = await recoverJob(h.run, h.context);
  assert.equal(result.terminal.error.code, "SUBMISSION_UNCERTAIN");
  assert.equal(result.retryable, false);
  assert.equal(h.historyCalls.length, RECOVERY_MAX_PAGES);
});

test("recovery refuses aggregate oversized history despite individually valid frames", async (t) => {
  const h = await harness(t);
  const text = "x".repeat(6 * 1024 * 1024);
  let bytes = 0;
  h.page = async (_method, params) => {
    const page = Number(params.cursor ?? 0);
    const turn = answer(h.jobId, `turn-${page}`);
    if (page > 0) turn.items[0].clientId = "other-job";
    turn.items[1].text = text;
    const result = { data: [turn], nextCursor: page < 2 ? String(page + 1) : null };
    const size = Buffer.byteLength(JSON.stringify(result));
    assert.ok(size < RPC_MAX_FRAME_BYTES);
    bytes += size;
    return result;
  };
  const result = await recoverJob(h.run, h.context);
  assert.ok(bytes > HISTORY_MAX_BYTES);
  assert.equal(h.historyCalls.length, 3);
  assert.equal(result.terminal.error.code, "SUBMISSION_UNCERTAIN");
  assert.equal(result.retryable, false);
});

test("recovery shares the history deadline and does not grant fresh time to every item list", async (t) => {
  const h = await harness(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  h.page = async (method) => {
    now += method === "thread/turns/list" ? HISTORY_READ_MS - 1 : 1;
    return method === "thread/turns/list"
      ? {
          data: [{ id: "target", itemsView: "notLoaded" }],
          nextCursor: null,
        }
      : { data: [], nextCursor: "more" };
  };
  const result = await recoverJob(h.run, h.context);
  assert.equal(result.terminal.error.code, "SUBMISSION_UNCERTAIN");
  assert.deepEqual(
    h.historyCalls.map((call) => call.timeoutMs),
    [HISTORY_READ_MS, 1],
  );
});

test("aborting history still closes the recovery owner and leaves submission unsettled", async (t) => {
  const h = await harness(t);
  const controller = new AbortController();
  h.page = async () => {
    controller.abort(new Error("cancel recovery wait"));
    return { data: [answer(h.jobId)], nextCursor: null };
  };
  await assert.rejects(
    recoverJob(h.run, { ...h.context, signal: controller.signal }),
    /cancel recovery wait/,
  );
  assert.equal(readTurn(h.f.state, h.jobId), null);
  assert.equal(h.saved().shutdownIncomplete, false);
  assert.deepEqual(await stopDriver(h.run, h.context), { state: "gone" });
});
