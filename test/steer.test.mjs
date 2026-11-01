import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexSession } from "../src/codex/session.mjs";
import { steerHandler } from "../src/codex/steer.mjs";
import { createDriverClient } from "../src/codex/driver-client.mjs";
import {
  createJob,
  readDriver,
  writeDriver,
  createSteer,
  readSteer,
  readProgress,
  jobPaths,
} from "../src/state/job-store.mjs";
import { reconcileSteers } from "../src/run/recovery.mjs";
import { parseArgs } from "../src/cli/options.mjs";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";

const text = "PRIVATE-STEER-CANARY λ 日本語 🚀";
async function until(read) {
  for (let n = 0; n < 400; n++) {
    const result = read();
    if (result) return result;
    await delay(25);
  }
  assert.fail("steer condition timed out");
}
function harness(t, request) {
  const f = fixture(t);
  const job = createJob(f.state, { generation: "generation", turnId: "turn", threadId: "thread" });
  let record = readDriver(f.state, job);
  const session = new CodexSession(record);
  session.turnId = "turn";
  session.rpc = { request };
  const checkpoint = (patch) => {
    record = writeDriver(f.state, job, { ...record, ...patch });
  };
  const handle = steerHandler({ stateDir: f.state, getRecord: () => record, checkpoint, session });
  return {
    f,
    job,
    session,
    handle,
    record: () => record,
    reserve: () => createSteer(f.state, record, text),
  };
}

test("steer is strict standalone syntax and preserves the caller's prompt file", () => {
  const key = "a".repeat(32);
  assert.equal(parseArgs(["--steer", key, "--prompt-file", "input.txt"]).mode, "steer");
  for (const extra of [[], ["--model", "anything"], ["--run", key], ["--task-file", "input.txt"]])
    assert.throws(() => parseArgs(["--steer", key, ...extra]));
});

test("an observed steer with a lost RPC reply settles accepted without resending", async (t) => {
  const f = fixture(t, { status: "running", dropSteerReply: true });
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, 3);
  const key = f.runs()[0],
    stateDir = path.join(f.state, key),
    job = f.metadata(key).jobId;
  await until(() => readDriver(stateDir, job)?.turnId);
  fs.writeFileSync(path.join(f.work, "steer.txt"), text);
  const result = await f.invoke(["--steer", key, "--prompt-file", "steer.txt"]);
  assert.equal(result.code, 0, result.stderr);
  f.configure({ status: "completed" });
  assert.equal((await f.invoke(["--run", key, "--wait-ms", "10000"])).code, 0);
  const entry = readDriver(stateDir, job).steers[0];
  assert.equal(entry.status, "accepted");
  assert.equal(entry.observed, true);
  assert.equal(
    f.events().filter((event) => event.direction === "in" && event.method === "turn/steer").length,
    1,
  );
});

test("steer checkpoints before sending; duplicates and concurrent connections never send twice", async (t) => {
  let calls = 0,
    resolve;
  const h = harness(t, async (method, params) => {
    calls++;
    assert.equal(method, "turn/steer");
    assert.equal(h.record().steers[0].status, "dispatching");
    assert.equal(params.expectedTurnId, "turn");
    assert.equal(params.clientUserMessageId, `${h.job}/steer-1`);
    assert.equal(params.input[0].text, text);
    return new Promise((done) => {
      resolve = done;
    });
  });
  const n = h.reserve(),
    first = h.handle({ n });
  const duplicate = await h.handle({ n });
  assert.equal(duplicate.status, "dispatching");
  resolve({ turnId: "turn" });
  assert.equal((await first).status, "accepted");
  assert.equal((await h.handle({ n })).status, "accepted");
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(h.record()), /PRIVATE-STEER/);
});

test("steer refuses changed, missing and completed turns without dispatch", async (t) => {
  let calls = 0;
  const h = harness(t, () => {
    calls++;
  });
  for (const state of [
    { turnId: "other" },
    { turnId: null },
    { turnId: "turn", terminal: { id: "turn" } },
  ]) {
    Object.assign(h.session, state);
    assert.equal((await h.handle({ n: h.reserve() })).status, "rejected");
  }
  assert.equal(calls, 0);
});

test("lost acknowledgements, mismatched replies and RPC refusals contain no prompt and are never resent", async (t) => {
  for (const kind of ["transport", "mismatch", "refusal"]) {
    let calls = 0;
    const h = harness(t, async () => {
      calls++;
      if (kind === "mismatch") return { turnId: "other" };
      throw Object.assign(
        new Error(text),
        kind === "refusal" ? { rpcError: { message: text } } : {},
      );
    });
    const n = h.reserve(),
      result = await h.handle({ n });
    assert.equal(result.status, kind === "refusal" ? "rejected" : "uncertain");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-STEER/);
    await h.handle({ n });
    assert.equal(calls, 1);
  }
});

test("steer files fence generation, hash, sequence, traversal, links and byte/count limits", async (t) => {
  let calls = 0;
  const h = harness(t, () => {
    calls++;
  });
  for (const payload of [{ n: "../prompt" }, { n: 0 }, { n: 33 }, { n: 1, text }, null])
    assert.equal((await h.handle(payload)).status, "rejected");
  const n = h.reserve();
  assert.throws(() => readSteer(h.f.state, { ...h.record(), generation: "other" }, n));
  const directory = jobPaths(h.f.state, h.job).directory;
  fs.writeFileSync(path.join(directory, "steer-1.txt"), "tampered");
  assert.equal((await h.handle({ n })).status, "rejected");
  const linked = h.reserve(),
    file = path.join(directory, `steer-${linked}.txt`);
  fs.unlinkSync(file);
  fs.linkSync(path.join(h.f.work, "prompt.md"), file);
  assert.equal((await h.handle({ n: linked })).status, "rejected");
  assert.throws(() => createSteer(h.f.state, h.record(), "x".repeat(65537)), /limit/);
  for (let i = linked; i < 32; i++) h.reserve();
  assert.throws(h.reserve, /limit/);
  assert.equal(calls, 0);
});

test("recovery reconciles dispatching and uncertain steers only by unique client ID in the expected turn", () => {
  const entry = {
    n: 1,
    status: "dispatching",
    expectedTurnId: "turn",
    clientUserMessageId: "job/steer-1",
  };
  const item = { type: "userMessage", clientId: entry.clientUserMessageId };
  assert.equal(reconcileSteers([entry], { id: "turn", items: [item] })[0].status, "accepted");
  for (const turn of [
    null,
    { id: "other", items: [item] },
    { id: "turn", items: [] },
    { id: "turn", items: [item, item] },
  ])
    assert.equal(reconcileSteers([entry], turn)[0].status, "uncertain");
});

test("fake steer lands once in the same running turn, preserves identity and redacts progress", async (t) => {
  const f = fixture(t, { status: "running", steerProgressEcho: true });
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, 3);
  const key = f.runs()[0],
    stateDir = path.join(f.state, key),
    before = f.metadata(key);
  await until(() => readDriver(stateDir, before.jobId)?.turnId);
  fs.writeFileSync(path.join(f.work, "steer.txt"), text);
  const result = await f.invoke(["--steer", key, "--prompt-file", "steer.txt"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /status=accepted/);
  assert.equal(fs.readFileSync(path.join(f.work, "steer.txt"), "utf8"), text);
  const record = await until(
    () =>
      readDriver(stateDir, before.jobId)?.steers?.[0]?.observed &&
      readDriver(stateDir, before.jobId),
  );
  assert.equal(record.steers[0].clientUserMessageId, `${before.jobId}/steer-1`);
  const repeated = await createDriverClient(before, { stateDir }).request("steer", { n: 1 });
  assert.equal(repeated.status, "accepted");
  await until(() => readProgress(stateDir, before.jobId).length);
  assert.doesNotMatch(JSON.stringify(readProgress(stateDir, before.jobId)), /PRIVATE-STEER/);
  assert.deepEqual(f.metadata(key), before, "steering never rewrites run.json");
  f.configure({ status: "completed" });
  const end = await f.invoke(["--run", key, "--wait-ms", "10000"]);
  assert.equal(end.code, 0, end.stderr);
  assert.equal(
    f.events().filter((e) => e.direction === "in" && e.method === "turn/start").length,
    1,
  );
  assert.equal(
    f.events().filter((e) => e.direction === "in" && e.method === "turn/steer").length,
    1,
  );
  assert.equal((await f.invoke(["--steer", key, "--prompt-file", "steer.txt"])).code, 1);
});
