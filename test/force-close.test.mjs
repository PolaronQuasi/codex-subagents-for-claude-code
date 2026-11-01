import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH, TEXT } from "./support/codex-fixture.mjs";
import { until } from "./support/driver-evidence.mjs";
import { alive } from "../src/shared/io.mjs";
import { readDriver, readTurn, writeDriver } from "../src/state/job-store.mjs";
import { writerOwners } from "../src/state/state.mjs";
import { processStart } from "../src/shared/process-identity.mjs";
import { gitInit } from "./support/git-repos.mjs";
import { readArtifact } from "../src/state/artifact-store.mjs";
import { readThreadOwner, rememberThread } from "../src/state/thread-owners.mjs";

async function wedged(t, extra = []) {
  const f = fixture(t);
  if (extra.includes("--worktree")) await gitInit(f.work);
  const launched = await f.invoke([...LAUNCH.slice(0, -2), "--detach", "--keep-state", ...extra]);
  assert.equal(launched.code, 0, launched.stderr);
  const run = f.metadata(),
    stateDir = path.join(f.state, run.runKey);
  await until(() => readTurn(stateDir, run.jobId));
  await until(() => !alive(run.worker.pid), "driver shutdown", 15_000);
  const driver = readDriver(stateDir, run.jobId);
  await until(() => !alive(driver.appServer.pid));
  writeDriver(stateDir, run.jobId, {
    ...driver,
    shutdownIncomplete: true,
    shutdownTree: [{ pid: driver.appServer.pid, start: null }],
    shutdownTreeUnknown: true,
    shutdownCapturePending: false,
  });
  return { ...f, run, stateDir, driver };
}

test("unknown shutdown delivers its saved answer and requires explicit forced close", async (t) => {
  const f = await wedged(t);
  const results = [];
  for (const args of [
    ["--run"],
    ["--sleep"],
    ["--close"],
    ["--close", "--force"],
    ["--close", "--force"],
  ]) {
    const result = await f.invoke([args[0], f.run.runKey, ...args.slice(1)]);
    t.diagnostic(`${args.join(" ")}: exit=${result.code}; ${result.stderr.trim()}`);
    results.push(result);
  }
  assert.equal(results[0].code, 0, results[0].stderr);
  assert.ok(results[0].stdout.includes(TEXT));
  assert.match(results[0].stderr, new RegExp(`--close ${f.run.runKey} --force`));
  assert.notEqual(results[1].code, 0);
  assert.notEqual(results[2].code, 0);
  assert.equal(results[3].code, 0, results[3].stderr);
  assert.match(results[3].stderr, /shutdown was NOT confirmed/i);
  assert.equal(results[4].code, 0, results[4].stderr);
  assert.equal(fs.existsSync(f.stateDir), false);
  const receipt = JSON.parse(
    fs.readFileSync(path.join(f.resultsDir, "audit", f.run.runKey, "forced-close.json"), "utf8"),
  );
  assert.ok(receipt.shutdownUnconfirmedAcceptedAt);
  assert.equal(receipt.reason, "unknown-process-tree");
  const context = { resultsDir: f.resultsDir, stateBase: f.state, stateDir: f.stateDir };
  const threadId = f.driver.threadId;
  const owner = readThreadOwner(f.resultsDir, threadId, f.state);
  assert.equal(owner.shutdownUnconfirmedAcceptedAt, receipt.shutdownUnconfirmedAcceptedAt);
  // Orphan archival may later update this receipt using the original run identity.
  assert.equal(rememberThread(f.run, context, { ...owner, archived: true }), true);
  assert.equal(
    readThreadOwner(f.resultsDir, threadId, f.state).shutdownUnconfirmedAcceptedAt,
    receipt.shutdownUnconfirmedAcceptedAt,
  );
  const copy = fs.readFileSync(path.join(f.resultsDir, f.results()[0]), "utf8");
  assert.ok(copy.includes(TEXT));
  assert.match(copy, /shutdown: confirmed=no accepted-at=/);
  assert.equal(
    f.events().filter((event) => event.direction === "in" && event.method === "turn/start").length,
    1,
  );
});

test("collection retains writer/request claims; a failed evidence write cannot release them", async (t) => {
  const f = await wedged(t, ["--write", "--request-id", "unknown-shutdown"]);
  const collected = await f.invoke(["--run", f.run.runKey]);
  assert.equal(collected.code, 0, collected.stderr);
  assert.equal(f.metadata().dormant, false);
  assert.equal(f.metadata().result.finalizedAt, undefined);
  assert.equal(writerOwners(f.state).size, 1);
  const claim = path.join(f.state, "requests", "unknown-shutdown.lock");
  assert.ok(fs.existsSync(claim));
  const evidence = path.join(f.resultsDir, "audit", f.run.runKey, "forced-close.json");
  fs.mkdirSync(evidence);
  const failed = await f.invoke(["--close", f.run.runKey, "--force"]);
  assert.equal(failed.code, 1);
  assert.ok(fs.existsSync(f.stateDir));
  assert.equal(writerOwners(f.state).size, 1);
  assert.ok(fs.existsSync(claim));
  fs.rmdirSync(evidence);
  const closed = await f.invoke(["--close", f.run.runKey, "--force"]);
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(writerOwners(f.state).size, 0);
  assert.equal(fs.existsSync(claim), false);
});

test("forced close names unreadable PIDs and never signals an unconfirmed or reused identity", async (t) => {
  const f = await wedged(t),
    child = f.spawnServer(),
    reused = f.spawnServer();
  const start = await until(() => processStart(child.pid));
  const reusedStart = await until(() => processStart(reused.pid));
  writeDriver(f.stateDir, f.run.jobId, {
    ...readDriver(f.stateDir, f.run.jobId),
    appServer: { pid: child.pid, processStart: start },
    shutdownTree: [{ pid: reused.pid, start: "different-birth" }],
  });
  let calls = 0;
  const closed = await f.invoke(["--close", f.run.runKey, "--force"], {
    processes: {
      probe: { start: (pid) => (pid === reused.pid ? reusedStart : null), commandLine: () => null },
      stop: () => {
        calls++;
        assert.fail("unconfirmed identity must not be signalled");
      },
    },
  });
  assert.equal(closed.code, 0, closed.stderr);
  assert.match(closed.stderr, new RegExp(`Unconfirmed PIDs: ${child.pid}`));
  assert.equal(calls, 0);
  assert.ok(alive(child.pid));
  assert.ok(alive(reused.pid));
});

test("forced close freshly checks the app-server and refuses a known survivor", async (t) => {
  const f = await wedged(t),
    child = f.spawnServer();
  const start = await until(() => processStart(child.pid));
  writeDriver(f.stateDir, f.run.jobId, {
    ...readDriver(f.stateDir, f.run.jobId),
    appServer: { pid: child.pid, processStart: start },
  });
  let stops = 0;
  const processes = {
    probe: { start: () => start },
    stop: async ({ pid, start: expected, onIdentified }) => {
      assert.equal(pid, child.pid);
      assert.equal(expected, start);
      stops++;
      await onIdentified([{ pid, start }]);
      return { state: "alive" };
    },
  };
  const refused = await f.invoke(["--close", f.run.runKey, "--force"], { processes });
  assert.equal(refused.code, 1, refused.stderr);
  assert.ok(stops > 0);
  assert.ok(fs.existsSync(f.stateDir));
  assert.equal(
    fs.existsSync(path.join(f.resultsDir, "audit", f.run.runKey, "forced-close.json")),
    false,
  );
  processes.stop = async ({ pid, start: expected, onIdentified }) => {
    assert.equal(pid, child.pid);
    assert.equal(expected, start);
    await onIdentified([{ pid, start }]);
    child.stdin.end();
    await until(() => !alive(child.pid));
    return { state: "stopped" };
  };
  const closed = await f.invoke(["--close", f.run.runKey, "--force"], { processes });
  assert.equal(closed.code, 0, closed.stderr);
});

test("later proven shutdown finalizes a previously collected answer before continuation", async (t) => {
  const f = await wedged(t, ["--keep-prompt"]);
  assert.equal((await f.invoke(["--run", f.run.runKey])).code, 0);
  writeDriver(f.stateDir, f.run.jobId, {
    ...readDriver(f.stateDir, f.run.jobId),
    shutdownTreeUnknown: false,
  });
  const slept = await f.invoke(["--sleep", f.run.runKey]);
  assert.equal(slept.code, 0);
  assert.match(slept.stderr, new RegExp(`--run ${f.run.runKey}`));
  assert.equal(f.metadata().result.shutdownPending, true);
  const continued = await f.invoke(["--continue", f.run.runKey, "--prompt-file", "prompt.md"]);
  assert.equal(continued.code, 1);
  assert.equal((await f.invoke(["--run", f.run.runKey])).code, 0);
  assert.ok(f.metadata().result.finalizedAt);
  assert.equal(f.metadata().result.shutdownPending, undefined);
  assert.equal((await f.invoke(["--close", f.run.runKey])).code, 0);
});

test("forced close marks a pre-existing artifact receipt without changing its commit", async (t) => {
  const f = await wedged(t, ["--worktree", "--write"]);
  writeDriver(f.stateDir, f.run.jobId, {
    ...readDriver(f.stateDir, f.run.jobId),
    shutdownTreeUnknown: false,
  });
  const collected = await f.invoke(["--run", f.run.runKey]);
  assert.equal(collected.code, 0, collected.stderr);
  const context = { stateBase: f.state, resultsDir: f.resultsDir };
  const before = readArtifact(f.run.runKey, context);
  writeDriver(f.stateDir, f.run.jobId, {
    ...readDriver(f.stateDir, f.run.jobId),
    shutdownIncomplete: true,
    shutdownTreeUnknown: true,
    shutdownTree: [{ pid: f.driver.pid, start: f.driver.processStart }],
  });
  const closed = await f.invoke(["--close", f.run.runKey, "--force"]);
  assert.equal(closed.code, 0, closed.stderr);
  const after = readArtifact(f.run.runKey, context);
  assert.equal(after.commit, before.commit);
  assert.ok(after.shutdownUnconfirmedAcceptedAt);
  assert.equal(after.sealed, true);
});
