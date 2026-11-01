import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { once } from "node:events";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import { until } from "./support/driver-evidence.mjs";
import { createJob, jobPaths, readDriver } from "../src/state/job-store.mjs";
import {
  serveIpc,
  connectIpc,
  ipcEndpoint,
  createIpcSecret,
  readIpcSecret,
  removeEndedEndpoint,
} from "../src/codex/ipc.mjs";
import { IPC_MAX_CONNECTIONS } from "../src/shared/constants.mjs";
import { JsonlRpc } from "../src/codex/rpc.mjs";

// Unix sockets live on POSIX only; Windows uses named pipes.
const PIPES = process.platform === "win32" && "Windows uses named pipes";
// A short folder under /tmp: os.tmpdir() can be too long for sockaddr_un.
function shortFolder(t, prefix) {
  const folder = fs.mkdtempSync(`/tmp/${prefix}`);
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}
// TMPDIR as a launch or a later shell sees it, for os.tmpdir() in this process.
function withTmpdir(folder, action) {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = folder;
  try {
    return action();
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

const mac = (secret, ...values) =>
  crypto.createHmac("sha256", secret).update(JSON.stringify(values)).digest("hex");
async function setup(t) {
  const f = fixture(t);
  const jobId = createJob(f.state);
  const record = {
    jobId,
    runKey: "a".repeat(32),
    generation: "b".repeat(64),
    protocol: 1,
    pid: process.pid,
    processStart: "birth",
    endpoint: ipcEndpoint(f.state, jobId),
  };
  createIpcSecret(f.state, jobId);
  const secret = readIpcSecret(f.state, jobId);
  let calls = 0;
  const server = await serveIpc(record, secret, async (method) => {
    calls++;
    return { method };
  });
  t.after(() => server.close());
  return { f, record, secret, calls: () => calls };
}
async function raw(record) {
  const socket = net.createConnection(record.endpoint);
  await once(socket, "connect");
  const frames = [];
  socket.on("data", (data) => frames.push(data.toString()));
  const rpc = new JsonlRpc(socket, socket, { requestMs: 1000 });
  return {
    socket,
    rpc,
    frames,
    close: () => {
      rpc.close();
      socket.destroy();
    },
  };
}
const identity = (r) => [r.protocol, r.runKey, r.jobId, r.generation, r.pid, r.processStart];
async function challenge(r, c) {
  const nonce = "c".repeat(64),
    scope = identity(r).slice(0, -2);
  const reply = await c.rpc.request("hello", { stage: "challenge", nonce, scope });
  return { transcript: [...identity(r), nonce, reply.nonce], scope, reply };
}

test("mutual hello signs both directions and sends no secret; control replies are signed", async (t) => {
  const f = await setup(t);
  const c = await raw(f.record);
  t.after(c.close);
  const proof = await challenge(f.record, c);
  assert.equal(proof.reply.proof, mac(f.secret, "server", proof.transcript));
  const ack = await c.rpc.request("hello", {
    stage: "prove",
    scope: proof.scope,
    proof: mac(f.secret, "client", proof.transcript),
  });
  assert.equal(ack.proof, mac(f.secret, "ack", proof.transcript));
  const payload = {},
    sequence = 1;
  const reply = await c.rpc.request("status", {
    sequence,
    payload,
    proof: mac(f.secret, "request", proof.transcript, "status", sequence, payload),
  });
  assert.equal(
    reply.proof,
    mac(f.secret, "response", proof.transcript, "status", sequence, reply.payload),
  );
  assert.equal(f.calls(), 1);
  assert.equal(c.frames.join("").includes(f.secret.toString("hex")), false);
  const stat = fs.statSync(jobPaths(f.f.state, f.record.jobId).directory);
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o700);
});

test("bad HMAC, missing hello and stale generation invoke no control handler", async (t) => {
  const f = await setup(t);
  await assert.rejects(connectIpc(f.record, crypto.randomBytes(32)), { code: "IPC_AUTH_FAILED" });
  await assert.rejects(connectIpc({ ...f.record, generation: "stale" }, f.secret), {
    code: "IPC_AUTH_FAILED",
  });
  const c = await raw(f.record);
  t.after(c.close);
  await assert.rejects(c.rpc.request("interrupt", {}));
  assert.equal(f.calls(), 0);
});

test("a hello proof cannot be replayed on a fresh connection or on the same connection", async (t) => {
  const f = await setup(t);
  const a = await raw(f.record),
    b = await raw(f.record);
  t.after(a.close);
  t.after(b.close);
  const first = await challenge(f.record, a),
    second = await challenge(f.record, b);
  assert.notEqual(first.reply.nonce, second.reply.nonce);
  const auth = {
    stage: "prove",
    scope: first.scope,
    proof: mac(f.secret, "client", first.transcript),
  };
  await a.rpc.request("hello", auth);
  await assert.rejects(b.rpc.request("hello", auth));
  await assert.rejects(a.rpc.request("hello", auth));
  assert.equal(f.calls(), 0);
});

test("sequence replay is refused before interrupt can be applied twice", async (t) => {
  const f = await setup(t),
    c = await raw(f.record);
  t.after(c.close);
  const auth = await challenge(f.record, c);
  await c.rpc.request("hello", {
    stage: "prove",
    scope: auth.scope,
    proof: mac(f.secret, "client", auth.transcript),
  });
  const frame = {
    sequence: 1,
    payload: {},
    proof: mac(f.secret, "request", auth.transcript, "interrupt", 1, {}),
  };
  await c.rpc.request("interrupt", frame);
  await assert.rejects(c.rpc.request("interrupt", frame));
  assert.equal(f.calls(), 1);
});

test("steer authentication binds its sequence payload and refuses tampering and replay", async (t) => {
  const f = await setup(t),
    c = await raw(f.record);
  t.after(c.close);
  const auth = await challenge(f.record, c);
  await c.rpc.request("hello", {
    stage: "prove",
    scope: auth.scope,
    proof: mac(f.secret, "client", auth.transcript),
  });
  const payload = { n: 1 };
  const frame = {
    sequence: 1,
    payload,
    proof: mac(f.secret, "request", auth.transcript, "steer", 1, payload),
  };
  await c.rpc.request("steer", frame);
  await assert.rejects(c.rpc.request("steer", frame));
  assert.equal(f.calls(), 1);
  const other = await raw(f.record);
  t.after(other.close);
  const next = await challenge(f.record, other);
  await other.rpc.request("hello", {
    stage: "prove",
    scope: next.scope,
    proof: mac(f.secret, "client", next.transcript),
  });
  await assert.rejects(
    other.rpc.request("steer", {
      sequence: 1,
      payload: { n: 2 },
      proof: mac(f.secret, "request", next.transcript, "steer", 1, payload),
    }),
  );
  assert.equal(f.calls(), 1);
  assert.equal(c.frames.join("").includes(f.secret.toString("hex")), false);
});

test("client refuses protocol and server identity mismatch", async (t) => {
  const f = await setup(t);
  await assert.rejects(connectIpc({ ...f.record, protocol: 2 }, f.secret), {
    code: "DRIVER_PROTOCOL_MISMATCH",
  });
  await assert.rejects(connectIpc({ ...f.record, pid: process.pid + 1 }, f.secret), {
    code: "IPC_AUTH_FAILED",
  });
});

test(
  "a state root short enough for sockaddr_un keeps the socket in its job folder",
  { skip: PIPES },
  async (t) => {
    const stateDir = path.join(shortFolder(t, "c"), "a".repeat(32));
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const jobId = createJob(stateDir);
    const endpoint = ipcEndpoint(stateDir, jobId);
    assert.equal(endpoint, path.join(jobPaths(stateDir, jobId).directory, "driver.sock"));
    assert.ok(Buffer.byteLength(endpoint) > 96, "longer than the single bound used before");
    const record = {
      jobId,
      runKey: "a".repeat(32),
      generation: "b".repeat(64),
      protocol: 1,
      pid: process.pid,
      processStart: "birth",
      endpoint,
    };
    createIpcSecret(stateDir, jobId);
    const secret = readIpcSecret(stateDir, jobId);
    const server = await serveIpc(record, secret, async (method) => ({ method }));
    t.after(() => server.close());
    const client = await connectIpc(record, secret);
    assert.deepEqual(await client.request("status"), { method: "status" });
    client.close();
  },
);

test(
  "an ended driver's temporary socket is removed by its recorded path whatever TMPDIR says now",
  { skip: PIPES },
  async (t) => {
    const f = fixture(t);
    const launched = shortFolder(t, "csfcc-a"),
      later = shortFolder(t, "csfcc-b");
    // A run's state folder is long enough to need the temporary socket.
    const stateDir = path.join(f.state, "a".repeat(32));
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const jobId = createJob(stateDir);
    const endpoint = withTmpdir(launched, () => ipcEndpoint(stateDir, jobId));
    assert.equal(path.dirname(endpoint), launched);
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once("error", reject).listen(endpoint, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const record = { jobId, ipcBound: true, endpoint };
    withTmpdir(later, () => removeEndedEndpoint(record, stateDir));
    assert.equal(fs.existsSync(endpoint), false, "a leaked socket is removed");
    assert.doesNotThrow(() => withTmpdir(later, () => removeEndedEndpoint(record, stateDir)));
    for (const other of [
      path.join(launched, "csfcc-1234.sock"),
      path.join(launched, "other.sock"),
      `csfcc-${"a".repeat(64)}.sock`,
    ])
      assert.throws(() => removeEndedEndpoint({ ...record, endpoint: other }, stateDir), {
        code: "IPC_AUTH_FAILED",
      });
    const file = path.join(launched, `csfcc-${"c".repeat(64)}.sock`);
    fs.writeFileSync(file, "");
    assert.throws(() => removeEndedEndpoint({ ...record, endpoint: file }, stateDir), {
      code: "IPC_AUTH_FAILED",
    });
    assert.equal(fs.existsSync(file), true, "only a socket is ever removed");
  },
);

test(
  "a detached run launched under one TMPDIR closes from a shell with another",
  { skip: PIPES },
  async (t) => {
    const f = fixture(t, { status: "running" });
    const launchedIn = shortFolder(t, "csfcc-l"),
      closedIn = shortFolder(t, "csfcc-m");
    const launched = await f.cli([...LAUNCH.slice(0, -2), "--detach"], {
      env: { ...f.env, TMPDIR: launchedIn },
      timeoutMs: 60_000,
    });
    assert.equal(launched.status, 0, launched.stderr);
    const run = f.metadata(),
      dir = path.join(f.state, run.runKey);
    const record = await until(
      () => readDriver(dir, run.jobId)?.ipcBound && readDriver(dir, run.jobId),
    );
    assert.equal(path.dirname(record.endpoint), launchedIn);
    const closed = await f.cli(["--close", run.runKey, "--force"], {
      env: { ...f.env, TMPDIR: closedIn },
      timeoutMs: 60_000,
    });
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(fs.readdirSync(launchedIn), [], "no socket is left behind");
  },
);

test("idle unauthenticated peers cannot fill the pool and block cancel or steer", async (t) => {
  const f = await setup(t);
  const existing = await connectIpc(f.record, f.secret);
  t.after(() => existing.close());
  const idle = [];
  t.after(() => {
    for (const socket of idle) socket.destroy();
  });
  for (let n = 0; n < IPC_MAX_CONNECTIONS; n++) {
    const socket = net.createConnection(f.record.endpoint);
    socket.on("error", () => {});
    idle.push(socket);
    await once(socket, "connect");
  }
  const client = await connectIpc(f.record, f.secret, { timeoutMs: 1000 });
  t.after(() => client.close());
  assert.deepEqual(await client.request("interrupt"), { method: "interrupt" });
  assert.deepEqual(await client.request("steer", { n: 1 }), { method: "steer" });
  assert.deepEqual(await existing.request("status"), { method: "status" });
  assert.equal(f.calls(), 3);
});

test("malformed challenge, acknowledgement and control replies give a clean authentication error", async (t) => {
  for (const stage of ["challenge", "prove", "status"]) {
    await t.test(stage, async (t) => {
      const f = fixture(t);
      const jobId = createJob(f.state);
      const record = {
        jobId,
        runKey: "a".repeat(32),
        generation: "b".repeat(64),
        protocol: 1,
        pid: process.pid,
        processStart: "birth",
        endpoint: ipcEndpoint(f.state, jobId),
      };
      const secret = crypto.randomBytes(32);
      const sockets = new Set();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        let transcript;
        const rpc = new JsonlRpc(socket, socket, {
          onRequest: async (method, params) => {
            if ((method === "hello" ? params.stage : method) === stage) return { result: null };
            if (params.stage === "challenge") {
              const nonce = "d".repeat(64);
              transcript = [...identity(record), params.nonce, nonce];
              return {
                result: {
                  nonce,
                  identity: identity(record),
                  proof: mac(secret, "server", transcript),
                },
              };
            }
            return { result: { proof: mac(secret, "ack", transcript) } };
          },
        });
        rpc.on("close", () => socket.destroy());
      });
      t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      });
      await new Promise((resolve) => server.listen(record.endpoint, resolve));
      if (stage === "status") {
        const client = await connectIpc(record, secret);
        t.after(() => client.close());
        await assert.rejects(client.request("status"), { code: "IPC_AUTH_FAILED" });
      } else await assert.rejects(connectIpc(record, secret), { code: "IPC_AUTH_FAILED" });
    });
  }
});
