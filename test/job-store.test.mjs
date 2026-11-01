import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { workspace } from "./support/workspace-fixture.mjs";
import {
  createJob,
  jobPaths,
  writeDriver,
  writeTurn,
  writeFinal,
  readDriver,
  readTurn,
  readJob,
  readFinal,
  readEvents,
  readLog,
  jobFiles,
  jobStatus,
  appendEvent,
  appendLog,
  observedJobs,
  unownedJobs,
  settleJob,
  visitStrictly,
} from "../src/state/job-store.mjs";
import {
  JOB_FILES,
  JOB_STATUS,
  JOB_ACTIVITY,
  JOB_RECORD_VERSION,
  JOB_READ_POLICY,
  JOB_MAX_RECORD_BYTES,
  WORKER_STATE,
  DRIVER_PHASE,
  validJobId,
  IS_WINDOWS,
} from "../src/shared/constants.mjs";
import { CODES } from "../src/shared/errors.mjs";

const JOB = "job-fixture";
const strict = { policy: JOB_READ_POLICY.STRICT };
const observed = { policy: JOB_READ_POLICY.OBSERVED };
function layout(t, record = {}) {
  const f = workspace(t);
  createJob(f.state, {
    jobId: JOB,
    pid: 42,
    processStart: "birth",
    phase: DRIVER_PHASE.GATED,
    ...record,
  });
  return { ...f, paths: jobPaths(f.state, JOB) };
}
const gone = { inspect: () => WORKER_STATE.GONE };

test(
  "job writers tolerate a simultaneous polling reader and preserve whole publications on Windows",
  { timeout: 15_000 },
  async (t) => {
    const f = layout(t);
    const worker = new Worker(
      `
    const fs = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    const problems = [];
    const timer = setInterval(() => {
      for (const file of workerData) {
        try { const text = fs.readFileSync(file, 'utf8'); if (file.endsWith('.json')) JSON.parse(text); }
        catch (error) { if (error.code !== 'ENOENT') problems.push(error.message); }
      }
    }, 1);
    parentPort.on('message', () => { clearInterval(timer); parentPort.postMessage(problems); parentPort.close(); });
    parentPort.postMessage('ready');
  `,
      {
        eval: true,
        workerData: [
          f.paths.driverFile,
          f.paths.eventsFile,
          f.paths.logFile,
          f.paths.finalFile,
          f.paths.turnFile,
        ],
      },
    );
    t.after(() => worker.terminate());
    await once(worker, "message");
    const exited = once(worker, "exit");
    for (let n = 0; n < 100; n++) {
      writeDriver(f.state, JOB, { phase: DRIVER_PHASE.RUNNING, sequence: n });
      appendEvent(f.state, JOB, { n });
      appendLog(f.state, JOB, `Line ${n}\n`);
    }
    const finalSha256 = writeFinal(f.state, JOB, "Complete λ\n");
    writeTurn(f.state, JOB, { status: JOB_STATUS.COMPLETED, finalSha256 });
    const answer = once(worker, "message");
    worker.postMessage("stop");
    assert.deepEqual((await answer)[0], []);
    await exited;
    assert.equal(readFinal(f.state, JOB, { ...strict, sha256: finalSha256 }), "Complete λ\n");
  },
);

test("job store mints safe ids and owns precisely the per-job files, with atomic driver/final writers", (t) => {
  const f = layout(t);
  const id = createJob(f.state);
  assert.ok(validJobId(id));
  assert.deepEqual(
    Object.values(f.paths)
      .slice(1)
      .map((file) => path.basename(file))
      .sort(),
    [
      JOB_FILES.DRIVER,
      JOB_FILES.EVENTS,
      JOB_FILES.FINAL,
      JOB_FILES.TURN,
      JOB_FILES.LOG,
      JOB_FILES.PROGRESS,
      JOB_FILES.DIFF,
    ].sort(),
  );
  const driver = writeDriver(f.state, JOB, { turnId: "turn-1", threadId: "thread-1" });
  assert.equal(driver.version, JOB_RECORD_VERSION);
  const hash = writeFinal(f.state, JOB, "λ 日本語 🚀\n");
  assert.equal(readFinal(f.state, JOB, { ...strict, sha256: hash }), "λ 日本語 🚀\n");
  assert.equal(readFinal(f.state, JOB, { sha256: "wrong" }), null);
  assert.throws(() => readFinal(f.state, JOB, { ...strict, sha256: "wrong" }), /terminal hash/);
  assert.deepEqual(
    fs.readdirSync(f.paths.directory).sort(),
    [JOB_FILES.DRIVER, JOB_FILES.FINAL].sort(),
  );
  assert.throws(() => createJob(f.state, { jobId: JOB }), /exist/i);
});

test("job statuses derive from turn identity and atomic terminal evidence; unknown stays active", (t) => {
  const f = layout(t);
  assert.equal(jobStatus(f.state, JOB), JOB_STATUS.QUEUED);
  writeDriver(f.state, JOB, { turnId: "turn-1" });
  assert.equal(jobStatus(f.state, JOB), JOB_STATUS.RUNNING);
  fs.writeFileSync(f.paths.turnFile, "{");
  assert.equal(jobStatus(f.state, JOB), JOB_ACTIVITY.UNKNOWN);
  assert.throws(() => readJob(f.state, JOB, strict), { code: CODES.INVALID_JSON });
  fs.writeFileSync(
    f.paths.turnFile,
    JSON.stringify({ version: JOB_RECORD_VERSION, jobId: JOB, status: "future-status" }),
  );
  assert.equal(jobStatus(f.state, JOB), "future-status");
  assert.throws(() => writeTurn(f.state, JOB, { status: JOB_STATUS.COMPLETED }), {
    code: CODES.SUBMISSION_UNCERTAIN,
  });
  assert.equal(readTurn(f.state, JOB).status, "future-status");
});

test("job readers preserve best-effort, strict and observed policies without reconstructing bad records", (t) => {
  const f = layout(t);
  fs.writeFileSync(f.paths.driverFile, "bad JSON");
  assert.equal(readDriver(f.state, JOB), null);
  assert.throws(() => readDriver(f.state, JOB, strict), { code: CODES.INVALID_JSON });
  const seen = readDriver(f.state, JOB, observed);
  assert.equal(seen.record, null);
  assert.equal(seen.missing, false);
  assert.equal(seen.issue.code, CODES.INVALID_JSON);
  assert.equal(readTurn(f.state, JOB, observed).missing, true);
  assert.equal(readJob(f.state, JOB, observed).record.status, JOB_ACTIVITY.UNKNOWN);
  fs.writeFileSync(
    f.paths.driverFile,
    JSON.stringify({ version: JOB_RECORD_VERSION, jobId: "other" }),
  );
  assert.throws(() => readDriver(f.state, JOB, strict), /invalid record/);
  fs.writeFileSync(f.paths.driverFile, "x".repeat(JOB_MAX_RECORD_BYTES + 1));
  assert.throws(() => readDriver(f.state, JOB, strict), /limit|large|bytes/i);
  assert.equal(readDriver(f.state, "missing", strict), null);
});

test("bounded events keep whole JSONL frames and bounded logs retain valid UTF-8", (t) => {
  const f = layout(t);
  for (let n = 0; n < 8; n++) appendEvent(f.state, JOB, { n, text: "日本語" }, { maxBytes: 80 });
  const events = readEvents(f.state, JOB, strict);
  assert.equal(events.at(-1).n, 7);
  assert.ok(events.length < 8);
  assert.ok(fs.statSync(f.paths.eventsFile).size <= 80);
  appendLog(f.state, JOB, "λ日本語🚀".repeat(20), { maxBytes: 31 });
  assert.ok(fs.statSync(f.paths.logFile).size <= 31);
  assert.doesNotMatch(readLog(f.state, JOB, strict), /\uFFFD/);
  assert.throws(
    () => appendEvent(f.state, JOB, { huge: "x".repeat(90) }, { maxBytes: 80 }),
    /byte limit/,
  );
  fs.appendFileSync(f.paths.eventsFile, "{");
  assert.equal(readEvents(f.state, JOB), null);
  assert.throws(() => readEvents(f.state, JOB, strict), /truncated/);
  const exact = createJob(f.state);
  const event = { text: "日本語" };
  const cap = Buffer.byteLength(`${JSON.stringify(event)}\n`);
  appendEvent(f.state, exact, { n: 0 }, { maxBytes: cap });
  appendEvent(f.state, exact, event, { maxBytes: cap });
  assert.deepEqual(
    readEvents(f.state, exact, strict),
    [event],
    "a complete frame exactly at the cap survives trimming",
  );
  assert.throws(() => appendEvent(f.state, exact, undefined), /not JSON/);
});

test("terminal publication is immutable, first-writer-wins, and cleans its private stages", (t) => {
  const f = layout(t);
  const completed = writeTurn(f.state, JOB, { status: JOB_STATUS.COMPLETED, touchedFiles: [] });
  assert.deepEqual(writeTurn(f.state, JOB, { status: JOB_STATUS.CANCELLED }), completed);
  assert.equal(jobStatus(f.state, JOB), JOB_STATUS.COMPLETED);
  assert.equal(jobFiles(f.state, JOB).recordFile, f.paths.turnFile);
  assert.deepEqual(
    fs.readdirSync(f.paths.directory).sort(),
    [JOB_FILES.DRIVER, JOB_FILES.TURN].sort(),
  );
});

test("concurrent publishers without hard links expose only whole files and retain the first result", async (t) => {
  const f = layout(t);
  const workers = Array.from(
    { length: 4 },
    (_, index) =>
      new Worker(
        `
    const fs = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { writeFinal, writeTurn } = await import(workerData.module);
      fs.linkSync = () => { throw Object.assign(new Error('links unsupported'), { code: 'ENOTSUP' }); };
      parentPort.once('message', () => {
        const finalSha256 = writeFinal(workerData.state, workerData.job, workerData.text);
        const turn = writeTurn(workerData.state, workerData.job, { status: 'completed', finalSha256, publisher: workerData.text });
        parentPort.postMessage(turn);
        parentPort.close();
      });
      parentPort.postMessage('ready');
    })();
  `,
        {
          eval: true,
          workerData: {
            module: new URL("../src/state/job-store.mjs", import.meta.url).href,
            state: f.state,
            job: JOB,
            text: `Publisher ${index}: ${"λ".repeat(8192)}`,
          },
        },
      ),
  );
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));
  await Promise.all(workers.map((worker) => once(worker, "message")));
  const results = workers.map((worker) => once(worker, "message"));
  for (const worker of workers) worker.postMessage("publish");
  const turns = (await Promise.all(results)).map(([turn]) => turn);
  assert.ok(turns.every((turn) => JSON.stringify(turn) === JSON.stringify(turns[0])));
  const text = readFinal(f.state, JOB, { ...strict, sha256: turns[0].finalSha256 });
  assert.match(text, /^Publisher [0-3]: λ{8192}$/u);
  assert.deepEqual(readTurn(f.state, JOB, strict), turns[0]);
  assert.ok(fs.readdirSync(f.paths.directory).every((name) => !/\.tmp$|\.publish$/.test(name)));
});

test("settlement keeps a pre-existing terminal record without asking about the driver", async (t) => {
  const f = layout(t);
  const terminal = writeTurn(f.state, JOB, {
    status: JOB_STATUS.COMPLETED,
    finalSha256: "result-hash",
  });
  fs.writeFileSync(f.paths.driverFile, "corrupt driver");
  const result = await settleJob(
    f.state,
    JOB,
    { status: JOB_STATUS.CANCELLED },
    { inspect: () => assert.fail("terminal evidence comes first") },
  );
  assert.deepEqual(result, terminal);
});

test("settlement re-reads after proof and preserves a completion written during that proof", async (t) => {
  const f = layout(t);
  const completed = { status: JOB_STATUS.COMPLETED, finalSha256: "completed-hash" };
  const result = await settleJob(
    f.state,
    JOB,
    { status: JOB_STATUS.CANCELLED },
    {
      inspect: async () => {
        writeTurn(f.state, JOB, completed);
        return WORKER_STATE.GONE;
      },
    },
  );
  assert.equal(result.status, JOB_STATUS.COMPLETED);
  assert.equal(result.finalSha256, completed.finalSha256);
});

test("settlement preserves an atomic terminal publication after its final re-read", async (t) => {
  const f = layout(t);
  const original = fs.linkSync;
  fs.linkSync = (from, to) => {
    fs.writeFileSync(
      to,
      JSON.stringify({ version: JOB_RECORD_VERSION, jobId: JOB, status: JOB_STATUS.COMPLETED }),
    );
    return original(from, to);
  };
  try {
    assert.equal(
      (await settleJob(f.state, JOB, { status: JOB_STATUS.CANCELLED }, gone)).status,
      JOB_STATUS.COMPLETED,
    );
  } finally {
    fs.linkSync = original;
  }
  assert.ok(fs.readdirSync(f.paths.directory).every((name) => !name.endsWith(".tmp")));
});

for (const state of [WORKER_STATE.WORKER, WORKER_STATE.UNKNOWN])
  test(`settlement refuses a ${state} driver and preserves its record`, async (t) => {
    const f = layout(t);
    const before = fs.readFileSync(f.paths.driverFile, "utf8");
    await assert.rejects(
      settleJob(f.state, JOB, { status: JOB_STATUS.FAILED }, { inspect: () => state }),
      {
        code: state === WORKER_STATE.WORKER ? CODES.DRIVER_STILL_RUNNING : CODES.WORKER_UNCONFIRMED,
      },
    );
    assert.equal(readTurn(f.state, JOB), null);
    assert.equal(fs.readFileSync(f.paths.driverFile, "utf8"), before);
  });

test("settlement rejects changed driver evidence, then settles a confirmed ended driver", async (t) => {
  const f = layout(t, { threadId: "thread-1", turnId: "turn-1" });
  await assert.rejects(
    settleJob(
      f.state,
      JOB,
      { status: JOB_STATUS.FAILED },
      {
        inspect: () => {
          writeDriver(f.state, JOB, { pid: 43, processStart: "new-birth" });
          return WORKER_STATE.GONE;
        },
      },
    ),
    { code: CODES.SUBMISSION_UNCERTAIN },
  );
  assert.equal(readTurn(f.state, JOB), null);
  const ended = await settleJob(
    f.state,
    JOB,
    { status: JOB_STATUS.FAILED, error: { code: CODES.STOP_INCOMPLETE } },
    gone,
  );
  assert.equal(ended.status, JOB_STATUS.FAILED);
  assert.ok(ended.completedAt);
});

test("unowned jobs exclude current, earlier and retried turns, and do not hide unreadable candidates", (t) => {
  const f = layout(t);
  for (const jobId of ["earlier", "retried", "lost"]) createJob(f.state, { jobId });
  const run = { jobId: JOB, turns: [{ jobId: "earlier", retriedJobs: [{ jobId: "retried" }] }] };
  assert.deepEqual(
    unownedJobs(f.state, run).map((record) => record.jobId),
    ["lost"],
  );
  assert.deepEqual(
    observedJobs(f.state).map((job) => job.record.jobId),
    ["earlier", JOB, "lost", "retried"],
  );
  fs.writeFileSync(jobPaths(f.state, "lost").driverFile, "{");
  assert.throws(() => unownedJobs(f.state, run), { code: CODES.INVALID_JSON });
});

test("strict traversal refuses a live recorded driver even with terminal output, and stops before later reads", (t) => {
  const f = layout(t);
  writeTurn(f.state, JOB, { status: JOB_STATUS.COMPLETED });
  assert.throws(() => visitStrictly(f.state, { driverAlive: () => true }), {
    code: CODES.DRIVER_STILL_RUNNING,
  });
  fs.writeFileSync(f.paths.turnFile, "{");
  assert.throws(
    () =>
      visitStrictly(f.state, {
        driverAlive: () => false,
        onDriver() {
          throw new Error("caller refused");
        },
      }),
    /caller refused/,
  );
  assert.throws(() => visitStrictly(f.state, { driverAlive: () => false }), {
    code: CODES.INVALID_JSON,
  });
  fs.unlinkSync(f.paths.turnFile);
  const seen = [];
  visitStrictly(f.state, {
    driverAlive: () => false,
    onJob: (id, record) => seen.push([id, record.status]),
  });
  assert.deepEqual(seen, [[JOB, JOB_STATUS.QUEUED]]);
});

test("job paths reject traversal and strict readers refuse directory junctions", (t) => {
  const f = layout(t);
  assert.throws(() => jobPaths(f.state, "../outside"), { code: CODES.JOB_UNIDENTIFIED });
  fs.symlinkSync(
    f.paths.directory,
    path.join(f.state, JOB_FILES.DIRECTORY, "linked"),
    IS_WINDOWS ? "junction" : "dir",
  );
  assert.throws(() => readDriver(f.state, "linked", strict), /real directory/);
  assert.throws(() => visitStrictly(f.state, { driverAlive: () => false }), /real directory/);
});

test("observed listings report malformed folder names, while strict discovery refuses them", (t) => {
  const f = layout(t);
  fs.mkdirSync(path.join(f.state, JOB_FILES.DIRECTORY, "invalid.name"));
  const damaged = observedJobs(f.state).find((job) => job.record.jobId === "invalid.name");
  assert.equal(damaged.issue.code, CODES.JOB_UNIDENTIFIED);
  assert.equal(damaged.record.status, JOB_ACTIVITY.UNKNOWN);
  assert.throws(() => unownedJobs(f.state, {}), { code: CODES.JOB_UNIDENTIFIED });
});

test("job status ignores retired state and derives status only from direct job records", (t) => {
  const f = workspace(t);
  const old = path.join(f.state, "state", "workspace", "jobs");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(
    path.join(old, `${JOB}.json`),
    JSON.stringify({ id: JOB, status: JOB_STATUS.COMPLETED }),
  );
  assert.equal(jobStatus(f.state, JOB), null);
  createJob(f.state, { jobId: JOB });
  assert.equal(jobStatus(f.state, JOB), JOB_STATUS.QUEUED);
  fs.writeFileSync(jobPaths(f.state, JOB).driverFile, "{");
  assert.equal(
    jobStatus(f.state, JOB),
    null,
    "damaged direct records never fall back to old terminal evidence",
  );
});
