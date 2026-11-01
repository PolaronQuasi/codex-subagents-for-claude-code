import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAudit } from "../src/shared/audit.mjs";
import { delivered } from "./support/capture.mjs";
import { fixture, LAUNCH, KEY } from "./support/runner-fixture.mjs";
import { EXIT } from "../src/shared/errors.mjs";

function files(f, key) {
  const dir = path.join(f.resultsDir, "audit", key);
  return fs.readdirSync(dir).map((name) => path.join(dir, name));
}
const rows = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);

test("audit records only lifecycle metadata in a separate file for each invocation", async (t) => {
  const f = fixture(t, { storedJob: { threadId: "thread-test" } });
  const first = await f.invoke([...LAUNCH, "--keep-state", "--keep-prompt"]);
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  const key = f.runs()[0];
  const firstFile = files(f, key)[0];
  assert.deepEqual(
    rows(firstFile).map((row) => row.transition),
    ["launch", "sleep", "deliver"],
  );
  assert.equal((await f.invoke(f.resume())).code, EXIT.COMPLETED);
  assert.equal((await f.invoke(["--sleep", key])).code, EXIT.COMPLETED);
  assert.equal(
    (await f.invoke(["--continue", key, "--prompt-file", "prompt.md", "--wait-ms", "0"])).code,
    0,
  );
  assert.equal((await f.invoke(["--close", key])).code, EXIT.COMPLETED);
  assert.equal(files(f, key).length, 5);
  const all = files(f, key).flatMap(rows);
  assert.ok(
    all.some(
      (row) =>
        row.transition === "continue" &&
        row.turn === 2 &&
        typeof row.job === "string" &&
        row.job !== all.find((r) => r.transition === "launch").job,
    ),
  );
  assert.ok(all.some((row) => row.transition === "attach"));
  assert.ok(all.some((row) => row.transition === "close"));
  for (const row of all) {
    assert.deepEqual(Object.keys(row), [
      "transition",
      "time",
      "pid",
      "session",
      "run",
      "turn",
      "job",
    ]);
    assert.equal(row.pid, process.pid);
    assert.equal(row.session, "sess-fixture");
    assert.equal(row.run, key);
    assert.ok(Number.isFinite(Date.parse(row.time)));
  }
  assert.equal(JSON.stringify(all).includes("The exact original prompt"), false);
});

test("audit records cancel, retained errors and sweep without changing delivery", async (t) => {
  const f = fixture(t, { status: "running" });
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, EXIT.STILL_RUNNING);
  const key = f.runs()[0];
  assert.equal((await f.invoke(["--close", key])).code, EXIT.FAILURE);
  assert.equal((await f.invoke(["--cancel", key])).code, EXIT.NOT_COMPLETED);
  assert.equal((await f.invoke(["--close-idle"])).code, EXIT.COMPLETED);
  const all = files(f, key).flatMap(rows);
  assert.ok(all.some((row) => row.transition === "error" && row.job === f.metadata().jobId));
  assert.ok(all.some((row) => row.transition === "cancel"));
  assert.equal(rows(files(f, "_unassigned")[0])[0].transition, "sweep");
});

test("audit write failures warn once and preserve a successful complete delivery", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.resultsDir);
  fs.writeFileSync(path.join(f.resultsDir, "audit"), "blocked");
  const done = await f.invoke();
  assert.equal(done.code, EXIT.COMPLETED, done.stderr);
  assert.equal((done.stderr.match(/Could not write the invocation audit log/g) ?? []).length, 1);
  assert.equal(delivered(done.stdout).footer.status, "completed");
  assert.deepEqual(f.runs(), []);
  const audit = createAudit({
    resultsDir: f.resultsDir,
    warn() {
      throw new Error("broken warning sink");
    },
  });
  await assert.doesNotReject(audit.emit("deliver", { runKey: KEY, jobId: f.metadata().jobId }));
});

test("help, list, doctor and dry-run sweeps create no audit log", async (t) => {
  const f = fixture(t);
  for (const args of [["--help"], ["--list"], ["--doctor"], ["--close-idle", "--dry-run"]]) {
    assert.equal((await f.invoke(args)).code, EXIT.COMPLETED);
  }
  assert.equal(fs.existsSync(path.join(f.resultsDir, "audit")), false);
});
