import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { LAUNCH, TEXT } from "./support/codex-fixture.mjs";
import { fixture as direct } from "./support/codex-fixture.mjs";
import { delivered } from "./support/capture.mjs";
import { readTurn, readDriver } from "../src/state/job-store.mjs";
import { alive } from "../src/shared/io.mjs";

const launch = [...LAUNCH.slice(0, -2), "--wait-ms", "8000"];
const counts = {
  inputTokens: 19,
  cachedInputTokens: 3,
  outputTokens: 7,
  reasoningOutputTokens: 2,
  totalTokens: 26,
};
async function until(read) {
  for (let n = 0; n < 300; n++) {
    const result = read();
    if (result) return result;
    await delay(25);
  }
  assert.fail("timed out");
}

for (const [backend, makeFixture] of [["driver", direct]]) {
  test(`${backend}: durable copy precedes stdout, footer is byte-compatible, kept continuation and close retain their order`, async (t) => {
    const f = makeFixture(t, { tokenUsage: { last: counts, total: counts } });
    let stdout = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        const run = f.metadata();
        assert.ok(run.result.durableSavedAt);
        assert.equal(run.result.acknowledgedAt, undefined);
        assert.ok(fs.existsSync(run.result.resultFile));
        stdout += chunk.toString();
        callback();
      },
    });
    const first = await f.invoke([...launch, "--keep-state"], { stdout: stream });
    assert.equal(first.code, 0, first.stderr);
    const out = delivered(stdout);
    assert.equal(out.body, TEXT);
    assert.equal(fs.readFileSync(out.footer.file, "utf8"), stdout);
    const run = f.metadata();
    assert.equal(run.dormant, true);
    assert.ok(run.result.acknowledgedAt);
    if (backend === "driver") {
      assert.equal(out.footer.tokens, "19/3/7/2");
      assert.equal(out.footer.limit, "17%/7d");
      assert.equal(alive(run.worker.pid), false);
    }
    fs.writeFileSync(path.join(f.work, "next.md"), "Follow-up text λ");
    f.configure({
      tokenUsage: {
        last: counts,
        total: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value * 2])),
      },
    });
    const next = await f.invoke([
      "--continue",
      run.runKey,
      "--prompt-file",
      "next.md",
      "--wait-ms",
      "8000",
    ]);
    assert.equal(next.code, 0, next.stderr);
    const second = f.metadata();
    assert.equal(second.turns.length, 1);
    assert.equal(second.result.threadId, run.result.threadId);
    if (backend === "driver") {
      assert.equal(second.result.usage.threadTotal.input, 38);
      assert.equal(
        second.result.usage.turn.input,
        19,
        "native cumulative usage is subtracted once",
      );
      assert.equal(f.events().find((e) => e.method === "thread/resume").params.excludeTurns, true);
    }
    const closed = await f.invoke(["--close", run.runKey]);
    assert.equal(closed.code, 0, closed.stderr);
    assert.deepEqual(f.runs(), []);
  });

  test(`${backend}: capped stdout keeps the entire durable result and replay uses the same footer`, async (t) => {
    const f = makeFixture(t, { result: TEXT.repeat(30) });
    const first = await f.invoke([...launch, "--keep-state", "--max-stdout-lines", "2"]);
    assert.equal(first.code, 0, first.stderr);
    const out = delivered(first.stdout);
    assert.ok(Number(out.footer.omitted) > 0);
    assert.ok(fs.readFileSync(out.footer.file, "utf8").startsWith(TEXT.repeat(30)));
    assert.equal((await f.invoke(["--run", f.runs()[0], "--wait-ms", "0"])).code, 0);
  });
}

test("driver: active wait reports progress, cancel interrupts and a completed result wins a racing cancel", async (t) => {
  const f = direct(t, { hangTurn: true });
  const first = await f.invoke([...launch.slice(0, -2), "--detach"]);
  assert.equal(first.code, 0, first.stderr);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  await until(() => readDriver(stateDir, run.jobId)?.turnId);
  const active = await f.invoke(["--run", run.runKey, "--wait-ms", "0"]);
  assert.equal(active.code, 3, active.stderr);
  assert.match(active.stdout, /phase=running.*last=turn\/started/);
  const childPid = readDriver(stateDir, run.jobId).appServer.pid;
  const cancelled = await f.invoke(["--cancel", run.runKey]);
  assert.equal(cancelled.code, 2, cancelled.stderr);
  assert.equal(delivered(cancelled.stdout).footer.status, "cancelled");
  assert.equal(delivered(cancelled.stdout).footer.tokens, "-");
  assert.deepEqual(f.runs(), []);
  assert.equal(alive(run.worker.pid), false);
  assert.equal(alive(childPid), false);

  const winner = direct(t);
  assert.equal((await winner.invoke([...launch.slice(0, -2), "--detach"])).code, 0);
  const completed = winner.metadata();
  await until(() => readTurn(path.join(winner.state, completed.runKey), completed.jobId));
  const result = await winner.invoke(["--cancel", completed.runKey]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(delivered(result.stdout).footer.status, "completed");
  assert.equal(
    winner.events().some((e) => e.method === "turn/interrupt"),
    false,
  );
});

test("driver: forced close cancels a live turn, while an ordinary close retains an undelivered result", async (t) => {
  const f = direct(t, { hangTurn: true });
  await f.invoke([...launch.slice(0, -2), "--detach", "--write"]);
  const run = f.metadata();
  await until(() => readDriver(path.join(f.state, run.runKey), run.jobId)?.turnId);
  const refused = await f.invoke(["--close", run.runKey]);
  assert.equal(refused.code, 1);
  const rm = fs.rmSync;
  let cancelled = false;
  t.mock.method(fs, "rmSync", (target, ...args) => {
    if (target === path.join(f.state, run.runKey)) {
      assert.equal(readTurn(target, run.jobId).status, "cancelled");
      assert.equal(alive(run.worker.pid), false);
      cancelled = true;
    }
    return rm(target, ...args);
  });
  const closed = await f.invoke(["--close", run.runKey, "--force"]);
  t.mock.restoreAll();
  assert.equal(cancelled, true);
  assert.equal(closed.code, 0, closed.stderr);
  assert.deepEqual(f.runs(), []);
  assert.equal(alive(run.worker.pid), false);
});

test("driver: mcp task directive is applied to the actual launch", async (t) => {
  const f = direct(t, { mcpServers: ["one"] });
  fs.writeFileSync(path.join(f.work, "task.md"), "mcp: off\nkeep: yes\n\nTask λ");
  const result = await f.invoke([
    "--task-file",
    "task.md",
    "--role",
    "gpt-6-1-sol",
    "--wait-ms",
    "8000",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.metadata().mcp, "off");
  assert.ok(
    f
      .events()
      .find((e) => e.direction === "launch")
      .args.includes("mcp_servers.one.enabled=false"),
  );
});
