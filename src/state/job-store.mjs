// The driver's only durable output: jobs/<jobId>/. A terminal file is published
// atomically, once. Readers never turn damaged or unknown evidence into success.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  JOB_FILES,
  DRIVER_FILES,
  JOB_STATUS,
  JOB_ACTIVITY,
  JOB_READ_POLICY,
  JOB_RECORD_VERSION,
  JOB_ID_BYTES,
  DRIVER_PHASE,
  DRIVER_GATE_MS,
  LAUNCH_SETTLE_MS,
  JOB_MAX_RECORD_BYTES,
  JOB_ATOMIC_RENAME_RETRIES,
  JOB_PUBLICATION_SUFFIX,
  ATOMIC_RENAME_RETRY_MS,
  DRIVER_TEXT,
  JOB_MAX_EVENTS_BYTES,
  JOB_MAX_LOG_BYTES,
  PROGRESS_MAX_BYTES,
  PROGRESS_KIND,
  DIFF_MAX_BYTES,
  STEER_MAX_BYTES,
  STEER_MAX_COUNT,
  STEER_FILES,
  STEER_TEXT,
  MAX_OUTPUT_BYTES,
  TERMINAL,
  WORKER_STATE,
  isGoneWorkerState,
  validJobId,
} from "../shared/constants.mjs";
import { CODES, ERRNO, RunnerError } from "../shared/errors.mjs";
import {
  atomicWrite as sharedAtomicWrite,
  readLimited,
  requireDirectory,
  alive,
  digest,
} from "../shared/io.mjs";
import {
  changedStartState,
  ownerAlive,
  processStart,
  workerCommandPattern,
} from "../shared/process-identity.mjs";
import { holdGuard } from "./guards.mjs";

const invalid = (message) => new RunnerError(CODES.INVALID_JSON, message);
// A driver and waiter can poll each other's job files much more frequently
// than run.json. Retain the same fsynced stage and rename retry algorithm,
// with a one-second bound for this store's sharing denials.
const atomicWrite = (file, data) =>
  sharedAtomicWrite(file, data, { renameRetries: JOB_ATOMIC_RENAME_RETRIES });
const jobsRoot = (stateDir) => path.join(stateDir, JOB_FILES.DIRECTORY);
export const mintJobId = () => `task-${crypto.randomBytes(JOB_ID_BYTES).toString("hex")}`;

export function jobPaths(stateDir, jobId) {
  if (!validJobId(jobId)) throw new RunnerError(CODES.JOB_UNIDENTIFIED, "invalid job identity");
  const directory = path.join(jobsRoot(stateDir), jobId);
  return {
    directory,
    driverFile: path.join(directory, JOB_FILES.DRIVER),
    eventsFile: path.join(directory, JOB_FILES.EVENTS),
    finalFile: path.join(directory, JOB_FILES.FINAL),
    turnFile: path.join(directory, JOB_FILES.TURN),
    logFile: path.join(directory, JOB_FILES.LOG),
    progressFile: path.join(directory, JOB_FILES.PROGRESS),
    diffFile: path.join(directory, JOB_FILES.DIFF),
  };
}

function checkParents(stateDir, paths) {
  requireDirectory(stateDir);
  requireDirectory(jobsRoot(stateDir));
  requireDirectory(paths.directory);
}

function validate(record, jobId, terminal = false) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.jobId !== jobId ||
    record.version !== JOB_RECORD_VERSION ||
    (terminal && (typeof record.status !== "string" || !record.status)) ||
    [record.threadId, record.turnId].some((id) => id != null && (typeof id !== "string" || !id))
  )
    throw invalid(`invalid record for job ${jobId}; state retained`);
  return record;
}

function observation(stateDir, paths, file, jobId, terminal) {
  try {
    checkParents(stateDir, paths);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw invalid(`expected a regular job record: ${file}`);
    const text = readLimited(file, JOB_MAX_RECORD_BYTES).toString("utf8");
    let record;
    try {
      record = JSON.parse(text);
    } catch (cause) {
      throw new RunnerError(CODES.INVALID_JSON, `invalid JSON in ${file}`, { cause });
    }
    return { file, record: validate(record, jobId, terminal), missing: false, issue: null };
  } catch (error) {
    if (error.code === ERRNO.ENOENT) return { file, record: null, missing: true, issue: null };
    return { file, record: null, missing: false, issue: error };
  }
}

function policyValue(observed, policy) {
  if (policy === JOB_READ_POLICY.OBSERVED) return observed;
  if (policy !== JOB_READ_POLICY.BEST_EFFORT && policy !== JOB_READ_POLICY.STRICT)
    throw new Error("unknown job reader policy");
  if (policy === JOB_READ_POLICY.STRICT && observed.issue) throw observed.issue;
  return observed.record;
}

export function readDriver(stateDir, jobId, { policy = JOB_READ_POLICY.BEST_EFFORT } = {}) {
  const paths = jobPaths(stateDir, jobId);
  return policyValue(observation(stateDir, paths, paths.driverFile, jobId, false), policy);
}
export function readTurn(stateDir, jobId, { policy = JOB_READ_POLICY.BEST_EFFORT } = {}) {
  const paths = jobPaths(stateDir, jobId);
  return policyValue(observation(stateDir, paths, paths.turnFile, jobId, true), policy);
}

// A prepared job cannot have dispatched without a birth identity and gate.
// Allow both startup bounds before adopting it; damaged or partial identities
// remain unknown. An empty directory is the earlier mkdir-before-record case.
export function abandonedJob(stateDir, jobId, now = Date.now()) {
  const paths = jobPaths(stateDir, jobId);
  try {
    checkParents(stateDir, paths);
  } catch (error) {
    if (error.code === ERRNO.ENOENT) return null;
    throw error;
  }
  const driver = readDriver(stateDir, jobId, { policy: JOB_READ_POLICY.STRICT });
  if (driver) {
    if (
      driver.phase !== DRIVER_PHASE.GATED ||
      [
        driver.pid,
        driver.processStart,
        driver.appServer,
        driver.threadId,
        driver.turnId,
        driver.clientUserMessageId,
      ].some((value) => value != null) ||
      driver.dispatching
    )
      return null;
  } else if (fs.readdirSync(paths.directory).length) return null;
  try {
    fs.lstatSync(path.join(paths.directory, DRIVER_FILES.GATE));
    return null;
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
  }
  const modified = Math.max(
    fs.lstatSync(paths.directory).mtimeMs,
    driver ? fs.lstatSync(paths.driverFile).mtimeMs : 0,
    driver ? Date.parse(driver.startedAt) : 0,
  );
  if (!Number.isFinite(modified) || now - modified <= DRIVER_GATE_MS + LAUNCH_SETTLE_MS)
    return null;
  return (
    driver ?? {
      jobId,
      version: JOB_RECORD_VERSION,
      phase: DRIVER_PHASE.GATED,
      startedAt: new Date(modified).toISOString(),
    }
  );
}

function readContent(stateDir, jobId, key, maxBytes, policy, transform = (text) => text) {
  const paths = jobPaths(stateDir, jobId);
  const file = paths[key];
  let observed;
  try {
    checkParents(stateDir, paths);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw invalid(`expected a regular job file: ${file}`);
    const bytes = readLimited(file, maxBytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    observed = { file, record: transform(text, bytes), missing: false, issue: null };
  } catch (error) {
    observed = {
      file,
      record: null,
      missing: error.code === ERRNO.ENOENT,
      issue: error.code === ERRNO.ENOENT ? null : error,
    };
  }
  return policyValue(observed, policy);
}
export function readFinal(
  stateDir,
  jobId,
  { policy = JOB_READ_POLICY.BEST_EFFORT, sha256 = null } = {},
) {
  return readContent(stateDir, jobId, "finalFile", MAX_OUTPUT_BYTES, policy, (text, bytes) => {
    if (sha256 !== null && digest(bytes) !== sha256)
      throw invalid("final text does not match its terminal hash");
    return text;
  });
}
export function readEvents(stateDir, jobId, { policy = JOB_READ_POLICY.BEST_EFFORT } = {}) {
  return readContent(stateDir, jobId, "eventsFile", JOB_MAX_EVENTS_BYTES, policy, (text) => {
    if (text && !text.endsWith("\n")) throw invalid("truncated job event frame");
    try {
      return text.split("\n").filter(Boolean).map(JSON.parse);
    } catch (cause) {
      throw new RunnerError(CODES.INVALID_JSON, "invalid job event JSON", { cause });
    }
  });
}
export function readLog(stateDir, jobId, { policy = JOB_READ_POLICY.BEST_EFFORT } = {}) {
  return readContent(stateDir, jobId, "logFile", JOB_MAX_LOG_BYTES, policy);
}

export function readProgress(stateDir, jobId) {
  return (
    readContent(
      stateDir,
      jobId,
      "progressFile",
      PROGRESS_MAX_BYTES,
      JOB_READ_POLICY.BEST_EFFORT,
      (text) => text.split("\n").filter(Boolean).map(JSON.parse),
    ) ?? []
  );
}
export function readDiff(stateDir, jobId) {
  return readContent(stateDir, jobId, "diffFile", DIFF_MAX_BYTES, JOB_READ_POLICY.STRICT) ?? "";
}
export function writeProgress(stateDir, jobId, update) {
  const paths = jobPaths(stateDir, jobId);
  checkParents(stateDir, paths);
  // A rolling append must never import an unrelated file through a link.
  for (const file of [
    update.entry && paths.progressFile,
    typeof update.diff === "string" && paths.diffFile,
  ].filter(Boolean)) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw invalid("expected an unlinked regular progress file");
    } catch (error) {
      if (error.code !== ERRNO.ENOENT) throw error;
    }
  }
  if (update.entry) {
    let previous = "";
    try {
      previous = readLimited(paths.progressFile, PROGRESS_MAX_BYTES).toString("utf8");
    } catch (error) {
      if (error.code !== ERRNO.ENOENT) throw error;
    }
    const rows = previous.split("\n").filter(Boolean).map(JSON.parse);
    rows.push(update.entry);
    const plan = rows.findLast((entry) => entry.kind === PROGRESS_KIND.PLAN);
    const kept = [
      ...(plan ? [plan] : []),
      ...rows.filter((entry) => entry.kind !== PROGRESS_KIND.PLAN),
    ].map((entry) => `${JSON.stringify(entry)}\n`);
    if (kept.some((line) => Buffer.byteLength(line) > PROGRESS_MAX_BYTES))
      throw invalid("job event exceeds its byte limit");
    let size = kept.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
    while (size > PROGRESS_MAX_BYTES) {
      const [removed] = kept.splice(plan ? 1 : 0, 1);
      size -= Buffer.byteLength(removed);
    }
    atomicWrite(paths.progressFile, kept.join(""));
  }
  if (typeof update.diff === "string") {
    if (Buffer.byteLength(update.diff) > DIFF_MAX_BYTES)
      throw invalid("diff exceeds its byte limit");
    atomicWrite(paths.diffFile, update.diff);
  }
}

export const validSteerNumber = (n) => Number.isSafeInteger(n) && n > 0 && n <= STEER_MAX_COUNT;
function steerPaths(stateDir, jobId, n) {
  if (!validSteerNumber(n)) throw new RunnerError(CODES.STEER_INVALID, STEER_TEXT.INVALID);
  const paths = jobPaths(stateDir, jobId);
  checkParents(stateDir, paths);
  const base = path.join(paths.directory, `${STEER_FILES.PREFIX}${n}`);
  return { text: base + STEER_FILES.TEXT, record: base + STEER_FILES.RECORD };
}
function writeExclusive(file, bytes) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function privateSteerFile(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new RunnerError(CODES.STEER_INVALID, STEER_TEXT.INVALID);
  return readLimited(file, limit);
}

// Exclusive metadata creation reserves a sequence across concurrent callers.
// A crash leaves an unused reservation; nobody automatically dispatches it.
export function createSteer(stateDir, driver, text) {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > STEER_MAX_BYTES)
    throw new RunnerError(CODES.STEER_LIMIT, STEER_TEXT.LIMIT);
  for (let n = 1; n <= STEER_MAX_COUNT; n++) {
    const files = steerPaths(stateDir, driver.jobId, n);
    const record = {
      n,
      jobId: driver.jobId,
      generation: driver.generation,
      expectedTurnId: driver.turnId,
      sha256: digest(text),
    };
    try {
      writeExclusive(files.record, JSON.stringify(record));
    } catch (error) {
      if (error.code === ERRNO.EEXIST) continue;
      throw error;
    }
    writeExclusive(files.text, text);
    return n;
  }
  throw new RunnerError(CODES.STEER_LIMIT, STEER_TEXT.LIMIT);
}

export function readSteer(stateDir, driver, n) {
  const files = steerPaths(stateDir, driver.jobId, n);
  const record = JSON.parse(privateSteerFile(files.record, JOB_MAX_RECORD_BYTES).toString("utf8"));
  if (
    record.n !== n ||
    record.jobId !== driver.jobId ||
    record.generation !== driver.generation ||
    typeof record.expectedTurnId !== "string" ||
    !record.expectedTurnId
  )
    throw new RunnerError(CODES.STEER_INVALID, STEER_TEXT.INVALID);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    privateSteerFile(files.text, STEER_MAX_BYTES),
  );
  if (!text.trim() || digest(text) !== record.sha256)
    throw new RunnerError(CODES.STEER_INVALID, STEER_TEXT.INVALID);
  return { ...record, text };
}

export function readJob(stateDir, jobId, { policy = JOB_READ_POLICY.BEST_EFFORT } = {}) {
  const paths = jobPaths(stateDir, jobId);
  const turn = observation(stateDir, paths, paths.turnFile, jobId, true);
  const driver = observation(stateDir, paths, paths.driverFile, jobId, false);
  if (driver.missing && turn.missing) driver.record = abandonedJob(stateDir, jobId);
  if (policy === JOB_READ_POLICY.STRICT) {
    if (turn.issue) throw turn.issue;
    if (driver.issue) throw driver.issue;
  } else if (policy !== JOB_READ_POLICY.OBSERVED && policy !== JOB_READ_POLICY.BEST_EFFORT)
    throw new Error("unknown job reader policy");
  const status =
    turn.record?.status ??
    (turn.issue || driver.issue
      ? JOB_ACTIVITY.UNKNOWN
      : driver.record
        ? driver.record.turnId
          ? JOB_STATUS.RUNNING
          : JOB_STATUS.QUEUED
        : null);
  if (policy !== JOB_READ_POLICY.OBSERVED && !driver.record && !turn.record) return null;
  const record = { ...driver.record, ...turn.record, id: jobId, jobId, status };
  return {
    record,
    driver: driver.record,
    turn: turn.record,
    paths,
    ...(policy === JOB_READ_POLICY.OBSERVED ? { observations: { driver, turn } } : {}),
  };
}

export function jobFiles(stateDir, jobId) {
  const job = readJob(stateDir, jobId);
  return job
    ? {
        record: job.record,
        recordFile: job.turn ? job.paths.turnFile : job.paths.driverFile,
        logFile: job.paths.logFile,
        eventsFile: job.paths.eventsFile,
        finalFile: job.paths.finalFile,
      }
    : null;
}

// Only direct job evidence supplies status. Unknown and damaged reads do not
// fall back to retired state.
export function jobStatus(stateDir, jobId) {
  return readJob(stateDir, jobId)?.record.status ?? null;
}

function bodyFor(record) {
  const text = JSON.stringify(record, null, 2);
  if (Buffer.byteLength(text) > JOB_MAX_RECORD_BYTES)
    throw invalid("job record exceeds its byte limit");
  return text;
}

export function createJob(stateDir, record = {}) {
  const jobId = record.jobId ?? mintJobId();
  const paths = jobPaths(stateDir, jobId);
  requireDirectory(stateDir);
  fs.mkdirSync(jobsRoot(stateDir), { recursive: true, mode: 0o700 });
  requireDirectory(jobsRoot(stateDir));
  fs.mkdirSync(paths.directory, { mode: 0o700 });
  writeDriver(stateDir, jobId, record);
  return jobId;
}

export function writeDriver(stateDir, jobId, record) {
  const paths = jobPaths(stateDir, jobId);
  checkParents(stateDir, paths);
  if (record.jobId !== undefined && record.jobId !== jobId)
    throw invalid("driver job identity changed");
  const value = validate({ ...record, jobId, version: JOB_RECORD_VERSION }, jobId);
  atomicWrite(paths.driverFile, bodyFor(value));
  return value;
}

// All publishers take the same identity-owned guard, including those using
// hard links. The rename fallback can then check absence without overwriting
// another publisher. Only complete, fsynced bytes ever appear at the terminal
// path; a crashed publisher leaves a recoverable guard, never a placeholder.
function publishOnce(stage, destination) {
  let release;
  for (let attempt = 0; ; attempt++) {
    try {
      release = holdGuard(`${destination}${JOB_PUBLICATION_SUFFIX}`, DRIVER_TEXT.PUBLICATION_BUSY);
      break;
    } catch (error) {
      if (error.code !== CODES.GUARD_BUSY || attempt >= JOB_ATOMIC_RENAME_RETRIES) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ATOMIC_RENAME_RETRY_MS);
    }
  }
  const exists = () => {
    try {
      fs.lstatSync(destination);
      return true;
    } catch (error) {
      if (error.code !== ERRNO.ENOENT) throw error;
      return false;
    }
  };
  try {
    if (exists()) return false;
    try {
      fs.linkSync(stage, destination);
    } catch (error) {
      if (error.code === ERRNO.EEXIST || exists()) return false;
      // The shared writer retries Windows sharing denials on the same stage.
      atomicWrite(
        destination,
        readLimited(stage, Math.max(MAX_OUTPUT_BYTES, JOB_MAX_RECORD_BYTES)),
      );
    }
    return true;
  } finally {
    release();
  }
}

export function writeFinal(stateDir, jobId, text) {
  const paths = jobPaths(stateDir, jobId);
  checkParents(stateDir, paths);
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_OUTPUT_BYTES)
    throw invalid("final text exceeds its byte limit or is not text");
  // A terminal winner's checksum must survive a racing settlement. Publish
  // the text once too; a crash after this publication can safely be adopted.
  const stage = `${paths.finalFile}.${crypto.randomBytes(JOB_ID_BYTES).toString("hex")}.tmp`;
  try {
    atomicWrite(stage, text);
    publishOnce(stage, paths.finalFile);
    return digest(readFinal(stateDir, jobId, { policy: JOB_READ_POLICY.STRICT }));
  } finally {
    fs.rmSync(stage, { force: true });
  }
}

// The waiter may persist cancel intent without racing the driver's writer.
// It never rewrites driver.json while the driver is alive.
export function writeCancelIntent(stateDir, jobId, generation) {
  const paths = jobPaths(stateDir, jobId);
  checkParents(stateDir, paths);
  const value = { jobId, generation, requestedAt: new Date().toISOString() };
  atomicWrite(path.join(paths.directory, DRIVER_FILES.CANCEL), JSON.stringify(value));
  return value;
}
export function readCancelIntent(stateDir, jobId) {
  const paths = jobPaths(stateDir, jobId);
  checkParents(stateDir, paths);
  try {
    const file = path.join(paths.directory, DRIVER_FILES.CANCEL);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw invalid("invalid cancel intent file");
    const value = JSON.parse(readLimited(file, JOB_MAX_RECORD_BYTES).toString("utf8"));
    if (value.jobId !== jobId || typeof value.generation !== "string")
      throw invalid("invalid cancel intent identity");
    return value;
  } catch (error) {
    if (error.code === ERRNO.ENOENT) return null;
    throw error;
  }
}

// First terminal writer wins, including a writer racing the last re-read.
// Publish complete bytes under the same guard on link-capable and other file
// systems, preserving the winner when a settlement races the live driver.
export function writeTurn(stateDir, jobId, record) {
  const paths = jobPaths(stateDir, jobId);
  checkParents(stateDir, paths);
  if (!TERMINAL.has(record.status) || (record.jobId !== undefined && record.jobId !== jobId))
    throw invalid("a terminal writer needs a known terminal status and matching job identity");
  const value = validate({ ...record, jobId, version: JOB_RECORD_VERSION }, jobId, true);
  const first = readTurn(stateDir, jobId, { policy: JOB_READ_POLICY.STRICT });
  if (first) {
    if (TERMINAL.has(first.status)) return first;
    throw new RunnerError(
      CODES.SUBMISSION_UNCERTAIN,
      "unrecognized terminal evidence; state retained",
    );
  }
  const stage = `${paths.turnFile}.${crypto.randomBytes(JOB_ID_BYTES).toString("hex")}.tmp`;
  try {
    atomicWrite(stage, bodyFor(value));
    if (!publishOnce(stage, paths.turnFile)) {
      const current = readTurn(stateDir, jobId, { policy: JOB_READ_POLICY.STRICT });
      if (!current || !TERMINAL.has(current.status))
        throw new RunnerError(
          CODES.SUBMISSION_UNCERTAIN,
          "unrecognized terminal evidence; state retained",
        );
      return current;
    }
    return value;
  } finally {
    fs.rmSync(stage, { force: true });
  }
}

function boundedAppend(stateDir, jobId, file, text, maxBytes, lines) {
  const paths = jobPaths(stateDir, jobId);
  checkParents(stateDir, paths);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw invalid("invalid job file byte limit");
  const added = Buffer.from(text);
  if (lines && added.length > maxBytes) throw invalid("job event exceeds its byte limit");
  let previous;
  try {
    previous = readLimited(file, maxBytes);
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
    previous = Buffer.alloc(0);
  }
  let bytes = Buffer.concat([previous, added]);
  if (bytes.length > maxBytes) {
    const offset = bytes.length - maxBytes;
    if (lines) {
      const boundary = bytes.subarray(offset - 1, offset).equals(Buffer.from("\n"));
      bytes = bytes.subarray(boundary ? offset : bytes.indexOf("\n", offset) + 1);
    } else
      bytes = Buffer.from(
        bytes
          .subarray(offset)
          .toString("utf8")
          .replace(/^\uFFFD+/u, ""),
      );
  }
  atomicWrite(file, bytes);
}
export function appendEvent(stateDir, jobId, event, { maxBytes = JOB_MAX_EVENTS_BYTES } = {}) {
  const json = JSON.stringify(event);
  if (json === undefined) throw invalid("job event is not JSON");
  boundedAppend(stateDir, jobId, jobPaths(stateDir, jobId).eventsFile, `${json}\n`, maxBytes, true);
}
export function appendLog(stateDir, jobId, text, { maxBytes = JOB_MAX_LOG_BYTES } = {}) {
  boundedAppend(stateDir, jobId, jobPaths(stateDir, jobId).logFile, text, maxBytes, false);
}

function jobNames(stateDir, policy) {
  try {
    requireDirectory(stateDir);
    requireDirectory(jobsRoot(stateDir));
    return fs.readdirSync(jobsRoot(stateDir)).sort();
  } catch (error) {
    if (error.code === ERRNO.ENOENT || policy === JOB_READ_POLICY.BEST_EFFORT) return [];
    throw error;
  }
}
export function observedJobs(stateDir) {
  return jobNames(stateDir, JOB_READ_POLICY.OBSERVED).map((jobId) => {
    try {
      return readJob(stateDir, jobId, { policy: JOB_READ_POLICY.OBSERVED });
    } catch (issue) {
      return {
        record: { jobId, id: jobId, status: JOB_ACTIVITY.UNKNOWN },
        driver: null,
        turn: null,
        paths: null,
        issue,
      };
    }
  });
}

export function unownedJobs(stateDir, run) {
  const turns = [run, ...(run.turns ?? [])];
  const known = new Set(
    turns.flatMap((turn) => [turn.jobId, ...(turn.retriedJobs ?? []).map((job) => job.jobId)]),
  );
  return jobNames(stateDir, JOB_READ_POLICY.STRICT)
    .filter((id) => !known.has(id))
    .map((id) => {
      const job = readJob(stateDir, id, { policy: JOB_READ_POLICY.STRICT });
      if (!job)
        throw new RunnerError(
          CODES.SUBMISSION_UNCERTAIN,
          `job ${id} has no readable identity; state retained`,
        );
      return job.record;
    });
}

function inspectDriver(driver) {
  if (!Number.isSafeInteger(driver.pid) || driver.pid <= 0) return WORKER_STATE.UNKNOWN;
  if (!alive(driver.pid)) return WORKER_STATE.GONE;
  if (typeof driver.processStart !== "string") return WORKER_STATE.UNKNOWN;
  const current = processStart(driver.pid);
  if (current === null) return alive(driver.pid) ? WORKER_STATE.UNKNOWN : WORKER_STATE.GONE;
  if (current === driver.processStart) return WORKER_STATE.WORKER;
  return changedStartState(
    driver.pid,
    current,
    validJobId(driver.jobId) ? workerCommandPattern(driver.jobId) : null,
  );
}

export async function settleJob(stateDir, jobId, patch, { inspect = inspectDriver } = {}) {
  const strict = { policy: JOB_READ_POLICY.STRICT };
  const terminal = () => {
    const turn = readTurn(stateDir, jobId, strict);
    if (turn && !TERMINAL.has(turn.status))
      throw new RunnerError(CODES.SUBMISSION_UNCERTAIN, "unknown terminal status; state retained");
    return turn;
  };
  const first = terminal();
  if (first) return first;
  if (!TERMINAL.has(patch.status)) throw invalid("settlement needs a terminal status");
  const driver = readDriver(stateDir, jobId, strict);
  if (!driver)
    throw new RunnerError(CODES.WORKER_UNCONFIRMED, "job has no driver identity; state retained");
  const state = await inspect(driver);
  const current = terminal();
  if (current) return current;
  if (!isGoneWorkerState(state))
    throw new RunnerError(
      state === WORKER_STATE.WORKER ? CODES.DRIVER_STILL_RUNNING : CODES.WORKER_UNCONFIRMED,
      "job driver is not confirmed gone; state retained",
    );
  const latest = readDriver(stateDir, jobId, strict);
  if (JSON.stringify(latest) !== JSON.stringify(driver))
    throw new RunnerError(
      CODES.SUBMISSION_UNCERTAIN,
      "driver record changed during settlement; state retained",
    );
  const { text, ...metadata } = patch;
  const finalSha256 =
    typeof text === "string" ? writeFinal(stateDir, jobId, text) : metadata.finalSha256;
  return writeTurn(stateDir, jobId, {
    threadId: driver.threadId ?? null,
    turnId: driver.turnId ?? null,
    startedAt: driver.startedAt ?? null,
    completedAt: new Date().toISOString(),
    ...metadata,
    ...(finalSha256 ? { finalSha256 } : {}),
  });
}

// Strict traversal is deliberately lazy: refuse a live driver or a caller's
// objection before touching later records. Terminal output does not prove exit.
export function visitStrictly(
  stateDir,
  { onDriver = () => {}, onJob = () => {}, driverAlive = ownerAlive } = {},
) {
  const strict = { policy: JOB_READ_POLICY.STRICT };
  for (const jobId of jobNames(stateDir, JOB_READ_POLICY.STRICT)) {
    const driver = readDriver(stateDir, jobId, strict);
    if (driver) {
      if (Number.isSafeInteger(driver.pid) && driver.pid > 0 && driverAlive(driver))
        throw new RunnerError(
          CODES.DRIVER_STILL_RUNNING,
          `job ${jobId} driver may still run; state retained`,
        );
      onDriver(driver);
    }
    const job = readJob(stateDir, jobId, strict);
    if (
      !job ||
      (!TERMINAL.has(job.record.status) &&
        (!driver || !Number.isSafeInteger(driver.pid) || driver.pid <= 0))
    )
      throw new RunnerError(
        CODES.WORKER_UNCONFIRMED,
        `cannot retire job ${jobId} without an ended driver`,
      );
    onJob(jobId, job.record);
  }
}
