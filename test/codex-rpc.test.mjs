import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JsonlRpc } from "../src/codex/rpc.mjs";
import { CODES, RPC_ERROR } from "../src/shared/errors.mjs";

function streams(t, options = {}, output = new PassThrough()) {
  const input = new PassThrough();
  const peer = new JsonlRpc(input, output, options);
  t.after(() => {
    peer.close();
    input.destroy();
    output.destroy();
  });
  const sent = [];
  output.on("data", (data) => sent.push(JSON.parse(data)));
  const receive = (message) => input.write(`${JSON.stringify(message)}\n`);
  return { peer, input, output, sent, receive };
}

test("RPC: a server request is latched before the next notification in the same frame batch", async (t) => {
  const order = [];
  const f = streams(t, {
    onRequest: () => {
      order.push("policy");
      return { result: {} };
    },
    onNotification: () => order.push("terminal"),
  });
  f.input.write(
    JSON.stringify({ id: "request", method: "policy" }) +
      "\n" +
      JSON.stringify({ method: "terminal" }) +
      "\n",
  );
  assert.deepEqual(order, ["policy", "terminal"]);
  await delay(0);
  assert.equal(f.sent[0].id, "request");
});

test("RPC: split UTF-8 and multiple frames, with a notification before the response", async (t) => {
  const seen = [];
  const f = streams(t, { onNotification: (method, params) => seen.push([method, params]) });
  const prompt = "long 日本語 🚀".repeat(10_000);
  const answer = f.peer.request("example/start", { prompt });
  const [request] = f.sent;
  assert.equal(request.params.prompt, prompt);
  const data = Buffer.from(
    `${JSON.stringify({ method: "example/progress", params: "λ日本語🚀" })}\n${JSON.stringify({ id: request.id, result: "完了🚀" })}\n`,
  );
  for (const byte of data) f.input.write(Buffer.from([byte]));
  assert.equal(await answer, "完了🚀");
  assert.deepEqual(seen, [["example/progress", "λ日本語🚀"]]);
  assert.equal(f.peer.pending.size, 0);
});

test("RPC: concurrent replies correlate by id, including numeric zero server ids", async (t) => {
  const f = streams(t, { onRequest: async (method, params) => ({ result: { method, params } }) });
  const first = f.peer.request("one"),
    second = f.peer.request("two");
  await delay(0);
  f.receive({ id: f.sent[1].id, result: 2 });
  f.receive({ id: f.sent[0].id, result: 1 });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  f.receive({ id: 0, method: "server/call", params: { value: true } });
  await delay(0);
  assert.deepEqual(f.sent.at(-1), {
    id: 0,
    result: { method: "server/call", params: { value: true } },
  });
});

test("RPC: timeouts remove pending ids; late replies cannot settle another request", async (t) => {
  const f = streams(t);
  await assert.rejects(f.peer.request("hang", {}, { timeoutMs: 10 }), {
    code: CODES.CODEX_RPC_ERROR,
  });
  f.receive({ id: f.sent[0].id, result: "too late" });
  const next = f.peer.request("next");
  await delay(0);
  f.receive({ id: f.sent.at(-1).id, result: "next result" });
  assert.equal(await next, "next result");
});

test("RPC: remote error details and unknown server methods remain generic", async (t) => {
  const f = streams(t);
  const answer = f.peer.request("missing");
  f.receive({
    id: f.sent[0].id,
    error: {
      code: RPC_ERROR.METHOD_NOT_FOUND,
      message: "missing method",
      data: { diagnostic: true },
    },
  });
  await assert.rejects(
    answer,
    (error) => error.code === CODES.CODEX_RPC_ERROR && error.rpcError.data.diagnostic,
  );
  f.receive({ id: "remote", method: "unknown" });
  await delay(0);
  assert.equal(f.sent.at(-1).error.code, RPC_ERROR.METHOD_NOT_FOUND);
});

for (const [title, bytes] of [
  ["malformed JSON", Buffer.from("{\n")],
  ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
  ["non-object envelope", Buffer.from("[]\n")],
  ["conflicting result/error", Buffer.from('{"id":1,"result":{},"error":{}}\n')],
])
  test(`RPC: ${title} closes and rejects pending requests`, async (t) => {
    const f = streams(t);
    const answer = f.peer.request("pending");
    f.input.write(bytes);
    await assert.rejects(answer, { code: CODES.CODEX_RPC_ERROR });
    assert.equal(f.peer.closed, true);
    assert.equal(f.peer.pending.size, 0);
  });

test("RPC: fragmented oversized frames fail at the byte bound before newline", async (t) => {
  const f = streams(t, { maxFrameBytes: 32 });
  f.input.write("x".repeat(20));
  f.input.write("x".repeat(13));
  assert.equal(f.peer.closed, true);
  assert.equal(f.peer.frameBytes, 0);
});

test("RPC: pending, output and concurrent server request limits are bounded", async (t) => {
  const f = streams(t, { maxPending: 1 });
  const pending = f.peer.request("pending");
  await assert.rejects(f.peer.request("overflow"), /too many pending/);
  f.peer.close();
  await assert.rejects(pending);
  const bounded = streams(t, { maxQueuedBytes: 1 });
  await assert.rejects(bounded.peer.notify("large"), /byte limit/);
  const busy = streams(t, { maxServerRequests: 1, onRequest: () => new Promise(() => {}) });
  busy.receive({ id: 0, method: "hang" });
  busy.receive({ id: 1, method: "overflow" });
  assert.equal(busy.peer.closed, true);
});

test("RPC: backpressure preserves order and does not send an expired queued request", async (t) => {
  const writes = [],
    callbacks = [];
  const output = new Writable({
    write(data, encoding, done) {
      writes.push(JSON.parse(data));
      callbacks.push(done);
    },
  });
  const f = streams(t, {}, output);
  const sent = f.peer.notify("first");
  await assert.rejects(f.peer.request("expires", {}, { timeoutMs: 10 }), /timed out/);
  callbacks.shift()();
  await sent;
  await delay(0);
  assert.deepEqual(
    writes.map((message) => message.method),
    ["first"],
  );
});

test("RPC: EOF, partial EOF, stream errors and stalled handlers clean up", async (t) => {
  for (const partial of [false, true]) {
    const f = streams(t);
    const answer = f.peer.request("pending");
    if (partial) f.input.write("{");
    f.input.end();
    await assert.rejects(answer, partial ? /truncated/ : /input ended/);
    assert.equal(f.input.listenerCount("data"), 0);
  }
  const f = streams(t, { requestMs: 10, onRequest: () => new Promise(() => {}) });
  f.receive({ id: 1, method: "hang" });
  await delay(20);
  assert.equal(f.peer.closed, true);
});

test("RPC: a failed write rejects requests and tolerates the stream's subsequent error event", async (t) => {
  const output = new Writable({
    write(data, encoding, done) {
      done(new Error("write failed"));
    },
  });
  const f = streams(t, {}, output);
  await assert.rejects(f.peer.request("pending"), { code: CODES.CODEX_RPC_ERROR });
  await delay(0);
  assert.equal(f.peer.closed, true);
  assert.equal(f.peer.pending.size, 0);
});

test("RPC: reader errors and rejected server handlers close without unhandled rejections", async (t) => {
  const f = streams(t);
  const answer = f.peer.request("pending");
  f.input.destroy(new Error("read failed"));
  await assert.rejects(answer, { code: CODES.CODEX_RPC_ERROR });
  const broken = streams(t, {
    onRequest: async () => {
      throw new Error("handler failed");
    },
  });
  broken.receive({ id: 0, method: "server/fail" });
  await delay(0);
  assert.equal(broken.peer.closed, true);
});
