import fs from "node:fs";
import path from "node:path";
import { readLimited, writeOutput } from "../shared/io.mjs";
import { ERRNO, EXIT } from "../shared/errors.mjs";
import { INSPECT_RECORD_BYTES, REQUEST_ID, RUN_KEY } from "../shared/constants.mjs";
import { validateRun } from "../state/run-record.mjs";
import { closeCommand, continueCommand, resumeCommand } from "../delivery/output.mjs";
import { auditDirectory } from "../shared/audit.mjs";
import { ownerAlive } from "../shared/process-identity.mjs";
import { runFile, readRunFile } from "../state/run-store.mjs";
import { observedJobs } from "../state/job-store.mjs";
import { createDriverClient } from "../codex/driver-client.mjs";

// A record as inspection reads it, run.json included: size-limited, and what
// cannot be read or parsed is reported, never thrown.
function readRecord(file) {
  try {
    return {
      value: JSON.parse(readLimited(file, INSPECT_RECORD_BYTES).toString("utf8")),
      error: null,
    };
  } catch (error) {
    return {
      value: null,
      error:
        error.code === ERRNO.ENOENT
          ? null
          : error instanceof SyntaxError
            ? `invalid JSON in ${file}; restore or inspect this file`
            : error.message,
    };
  }
}

function directories(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === ERRNO.ENOENT) return [];
    throw error;
  }
}

function lockRecord(dir, probe) {
  const owner = readRecord(path.join(dir, "owner.json"));
  const pid = owner.value?.pid;
  return {
    path: dir,
    present: fs.existsSync(dir),
    owner: owner.value,
    error: owner.error,
    recovery: { path: `${dir}.recovery`, present: fs.existsSync(`${dir}.recovery`) },
    pidAlive: probe && Number.isSafeInteger(pid) && pid > 0 ? ownerAlive(owner.value) : null,
  };
}

function ownedLocks(root, key, probe, knownName = null) {
  const names = new Set(
    directories(root)
      .map((name) => name.replace(/\.recovery$/, ""))
      .filter((name) => name.endsWith(".lock")),
  );
  if (knownName) names.add(knownName);
  return [...names]
    .map((name) => lockRecord(path.join(root, name), probe))
    .filter(
      (lock) => lock.owner?.runKey === key || path.basename(lock.path) === knownName || !lock.owner,
    );
}

function auditFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.endsWith(".jsonl") || entry.name.startsWith("worker-death-")),
      )
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch (error) {
    if (error.code === ERRNO.ENOENT) return [];
    throw error;
  }
}

export async function inspectRun(key, { stateBase, resultsDir, script, probe = false }) {
  if (!RUN_KEY.test(key ?? ""))
    throw new Error("--inspect needs an 8- or 32-character hexadecimal run key");
  const stateDir = path.join(stateBase, key);
  const auditDir = auditDirectory(resultsDir, key);
  if (!fs.existsSync(stateDir) && !fs.existsSync(auditDir))
    throw new Error(`unknown run ${key}; use --list to find retained runs`);
  let read;
  try {
    read = { value: readRunFile(stateDir, { maxBytes: INSPECT_RECORD_BYTES }), error: null };
  } catch (error) {
    read = {
      value: null,
      error:
        error.code === ERRNO.ENOENT
          ? null
          : error instanceof SyntaxError
            ? `invalid JSON in ${runFile(stateDir)}; restore or inspect this file`
            : error.message,
    };
  }
  let run = null,
    recordError = read.error;
  if (read.value !== null) {
    try {
      run = validateRun(read.value, key, stateDir);
    } catch (error) {
      recordError = error.message;
    }
  }
  const result = run?.result;
  const drivers = [];
  for (const job of observedJobs(stateDir)) {
    let answers = null;
    if (probe && job.driver) {
      try {
        await createDriverClient({ ...run, jobId: job.record.jobId }, { stateDir }).hello();
        answers = true;
      } catch {
        answers = false;
      }
    }
    drivers.push({
      file: job.paths?.driverFile ?? null,
      record: job.driver,
      terminal: job.turn,
      error:
        job.issue?.message ??
        job.observations?.driver.issue?.message ??
        job.observations?.turn.issue?.message ??
        null,
      pidAlive: probe && job.driver ? ownerAlive(job.driver) : null,
      answers,
    });
  }
  const commands = { runKey: key, jobId: run?.jobId ?? null };
  return {
    run: key,
    stateDir,
    probe,
    record: read.value,
    recordError,
    delivery: result
      ? {
          cachedAt: result.cachedAt ?? null,
          deliveredAt: result.deliveredAt ?? null,
          durableSavedAt: result.durableSavedAt ?? null,
          acknowledgedAt: result.acknowledgedAt ?? null,
          resultFile: result.resultFile ?? null,
        }
      : null,
    lock: lockRecord(path.join(stateBase, `${key}.lock`), probe),
    claims: ownedLocks(
      path.join(stateBase, "requests"),
      key,
      probe,
      REQUEST_ID.test(run?.requestId ?? "") ? `${run.requestId}.lock` : null,
    ),
    writers: ownedLocks(path.join(stateBase, "writers"), key, probe),
    drivers,
    worktree: run?.worktree
      ? { ...run.worktree, path: run.cwd, exists: fs.existsSync(run.cwd) }
      : null,
    recovery: !fs.existsSync(stateDir)
      ? {}
      : !run
        ? {
            close: `${closeCommand(commands, script)} --force`,
          }
        : {
            attach: resumeCommand(commands, script),
            continue: continueCommand(commands, script),
            close: closeCommand(commands, script),
          },
    audit: { directory: auditDir, files: auditFiles(auditDir) },
  };
}

export async function inspect(options, { paths, stdout, signal, commandMs, script }) {
  const report = await inspectRun(options.inspect, {
    ...paths,
    script,
    probe: Boolean(options.probe),
  });
  const text = options.json
    ? JSON.stringify(report, null, 2)
    : [
        `inspect=${report.run} probe=${report.probe ? "yes" : "no"}`,
        ...Object.entries(report)
          .filter(([key]) => !["run", "probe"].includes(key))
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`),
      ].join("\n");
  await writeOutput(stdout, `${text}\n`, { signal, timeoutMs: commandMs });
  return EXIT.COMPLETED;
}
