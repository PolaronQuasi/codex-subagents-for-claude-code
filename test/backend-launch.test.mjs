// Shared public launch invariants exercised with each independent fake.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { LAUNCH, ORIGINAL } from "./support/codex-fixture.mjs";
import { fixture as direct } from "./support/codex-fixture.mjs";
import { readDriver } from "../src/state/job-store.mjs";

const detached = [...LAUNCH.slice(0, -2), "--detach", "--keep-prompt"];
for (const [backend, makeFixture] of [["driver", direct]]) {
  test(`${backend}: detached launch retains its exact task and reattaches a duplicate request`, async (t) => {
    const f = makeFixture(t, { status: "running", hangTurn: true });
    const first = await f.invoke([...detached, "--request-id", "launch-once"]);
    assert.equal(first.code, 0, first.stderr);
    const run = f.metadata();
    assert.ok(run.jobId);
    assert.equal(fs.readFileSync(path.join(f.state, run.runKey, "prompt.txt"), "utf8"), ORIGINAL);
    assert.match(first.stdout, /-launched: run=/);
    const second = await f.invoke([...detached, "--request-id", "launch-once"]);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(f.runs().length, 1);
    assert.equal(f.metadata().jobId, run.jobId);
    if (backend === "driver") {
      const record = readDriver(path.join(f.state, run.runKey), run.jobId);
      assert.equal(record.pid, run.worker.pid);
      assert.equal(record.processStart, run.worker.processStart);
      assert.equal(run.backend, "driver");
      assert.equal(run.version, 2);
      for (const key of ["scriptsDir", "pluginWorkspace", "sessionId", "broker"])
        assert.equal(Object.hasOwn(run, key), false);
    }
  });

  test(`${backend}: a retained write launch excludes another writer in the same workspace`, async (t) => {
    const f = makeFixture(t, { status: "running", hangTurn: true });
    assert.equal((await f.invoke([...detached, "--write"])).code, 0);
    fs.writeFileSync(path.join(f.work, "second.md"), "Another writer");
    const result = await f.invoke(
      detached.map((arg) => (arg === "prompt.md" ? "second.md" : arg)).concat("--write"),
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /writ|workspace/i);
  });
}

test("driver: injected launch works with no plugin installed and refuses a changed kept build", async (t) => {
  const f = direct(t, { hangTurn: true });
  const result = await f.invoke(detached);
  assert.equal(result.code, 0, result.stderr);

  const run = f.metadata();
  assert.equal(run.codex.version, "0.166.0");
  assert.ok(run.codex.build);
  // Refusal happens before any follow-up driver is spawned.
  const { startJob } = await import("../src/run/launch.mjs");
  fs.appendFileSync(f.executable, "\n");
  await assert.rejects(
    startJob(run, {
      resume: true,
      stateDir: path.join(f.state, run.runKey),
      parentEnv: f.env,
      commandMs: 5000,
      save() {},
      info() {},
    }),
    /changed since/,
  );
});
