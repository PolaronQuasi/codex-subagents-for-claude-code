import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fixture } from "./support/codex-fixture.mjs";
import { JsonlRpc } from "../src/codex/rpc.mjs";
import { answerServerRequest } from "../src/codex/policy.mjs";
import { selectCodex } from "../src/codex/cli.mjs";
import {
  RPC,
  NOTIFICATION,
  SERVER_REQUEST,
  TURN_STATUS,
  CODEX_COMMAND,
  CODEX_VERSION_RANGE,
  CODEX_ITEM,
  CODEX_PHASE,
} from "../src/shared/constants.mjs";

async function connect(t, f) {
  const child = f.spawnServer();
  const notifications = [],
    requests = [];
  const peer = new JsonlRpc(child.stdout, child.stdin, {
    requestMs: 2000,
    onNotification: (method, params) => notifications.push({ method, params }),
    onRequest: (method) => {
      requests.push(method);
      return answerServerRequest(method).reply;
    },
  });
  t.after(() => peer.close());
  await peer.request(RPC.INITIALIZE, {});
  await peer.notify(RPC.INITIALIZED, {});
  const thread = await peer.request(RPC.THREAD_START, { cwd: f.work });
  const complete = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const event = notifications.find((event) => event.method === NOTIFICATION.TURN_COMPLETED);
      if (event) return event.params;
      await delay(10);
    }
    assert.fail("fake did not finish its turn");
  };
  return { child, peer, notifications, requests, threadId: thread.thread.id, complete };
}

test("fake codex answers version and app-server help without a session", async (t) => {
  const f = fixture(t);
  const version = await f.codex([CODEX_COMMAND.VERSION]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), `codex-cli ${CODEX_VERSION_RANGE.min}`);
  const help = await f.codex([CODEX_COMMAND.APP_SERVER, CODEX_COMMAND.HELP]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--listen stdio:\/\//);
  assert.deepEqual(f.events(), []);
});

test("a parent explicit CLI path cannot escape the fixture executable", async (t) => {
  const name = "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH";
  const previous = process.env[name];
  try {
    process.env[name] = "must-never-be-launched";
    const f = fixture(t);
    assert.equal((await selectCodex(f.env, f.work)).path, f.executable);
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("live fake RPC requests survive concurrent control-file reconfiguration", async (t) => {
  const f = fixture(t),
    c = await connect(t, f),
    pending = [];
  for (let n = 0; n < 50; n++) {
    pending.push(
      c.peer.request(RPC.ACCOUNT_READ, {}, { timeoutMs: 5000 }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    );
    await delay(0);
    f.configure({ controlCanary: `${n}:` + "x".repeat(256 * 1024) });
  }
  const results = await Promise.all(pending);
  assert.equal(results.length, 50);
  assert.ok(
    results.every((result) => result.value?.account?.type === "chatgpt"),
    results
      .filter((result) => result.error)
      .map((result) => result.error.message)
      .join("\n"),
  );
  c.child.stdin.end();
});

for (const status of [TURN_STATUS.COMPLETED, TURN_STATUS.FAILED, TURN_STATUS.INTERRUPTED])
  test(`fake codex emits ${status}, Unicode final text, file changes, usage and retry evidence`, async (t) => {
    const f = fixture(t, {
      status,
      touchedFiles: ["src/日本語.mjs"],
      errors: [
        { message: "retry", willRetry: true },
        { message: "fatal", willRetry: false },
        { message: "missing retry flag" },
      ],
    });
    const c = await connect(t, f);
    const turn = await c.peer.request(RPC.TURN_START, {
      threadId: c.threadId,
      input: [],
      clientUserMessageId: "job-1",
    });
    const finished = await c.complete();
    assert.equal(finished.turn.id, turn.turn.id);
    assert.equal(finished.turn.status, status);
    const items = c.notifications
      .filter((event) => event.method === NOTIFICATION.ITEM_COMPLETED)
      .map((event) => event.params.item);
    assert.equal(items[0].phase, CODEX_PHASE.FINAL_ANSWER);
    assert.equal(items[1].type, CODEX_ITEM.FILE_CHANGE);
    assert.ok(c.notifications.some((event) => event.method === NOTIFICATION.TOKEN_USAGE_UPDATED));
    assert.deepEqual(
      c.notifications
        .filter((event) => event.method === NOTIFICATION.ERROR)
        .map((event) => event.params.willRetry),
      [true, false, undefined],
    );
    assert.ok((await c.peer.request(RPC.RATE_LIMITS_READ, null)).rateLimits);
    await c.peer.request(RPC.THREAD_RESUME, { threadId: c.threadId });
    assert.equal(
      f.events().filter((event) => event.direction === "in" && event.method === RPC.TURN_START)
        .length,
      1,
    );
    c.child.stdin.end();
  });

test("fake codex dispatches all ten server requests and records exactly one reply each", async (t) => {
  const f = fixture(t, { serverRequests: true });
  const c = await connect(t, f);
  await c.peer.request(RPC.TURN_START, { threadId: c.threadId });
  await c.complete();
  assert.deepEqual(c.requests.sort(), Object.values(SERVER_REQUEST).sort());
  const answers = f
    .events()
    .filter(
      (event) =>
        event.direction === "in" && typeof event.id === "string" && event.id.startsWith("server-"),
    );
  assert.equal(answers.length, 10);
  c.child.stdin.end();
});

test("fake codex interrupts a hanging turn and handles a hanging method", async (t) => {
  const f = fixture(t, { hangTurn: true, hangMethods: [RPC.RATE_LIMITS_READ] });
  const c = await connect(t, f);
  const { turn } = await c.peer.request(RPC.TURN_START, { threadId: c.threadId });
  await assert.rejects(c.peer.request(RPC.RATE_LIMITS_READ, null, { timeoutMs: 20 }), /timed out/);
  await c.peer.request(RPC.TURN_INTERRUPT, { threadId: c.threadId, turnId: turn.id });
  assert.equal((await c.complete()).turn.status, TURN_STATUS.INTERRUPTED);
  c.child.stdin.end();
});

test("fake codex supports slow start, crashes and an EOF-ignoring lifetime", async (t) => {
  const blockedStartup = fixture(t, { startDelayMs: 20_000 });
  blockedStartup.spawnServer();
  const slow = fixture(t, { startDelayMs: 30, exitOnStdinClose: false });
  const c = await connect(t, slow);
  c.child.stdin.end();
  await delay(40);
  assert.equal(c.child.exitCode, null, "EOF-ignoring fake waits for its private control file");
  const crash = fixture(t, { exitOnMethods: [RPC.TURN_START] });
  const broken = await connect(t, crash);
  await assert.rejects(
    broken.peer.request(RPC.TURN_START, { threadId: broken.threadId }),
    /input ended/,
  );
});
