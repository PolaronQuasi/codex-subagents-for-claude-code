// The waiter owns run.json; the driver owns only its job directory.

import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { codexEnvironment } from "./cli.mjs";
import { trackedStop, shutdownEvidence } from "./shutdown.mjs";
import {
  connectIpc,
  createIpcSecret,
  ipcEndpoint,
  readIpcSecret,
  removeEndedEndpoint,
} from "./ipc.mjs";
import {
  createJob,
  readDriver,
  readTurn,
  writeDriver,
  writeFinal,
  writeTurn,
  jobPaths,
  abandonedJob,
} from "../state/job-store.mjs";
import { atomicWrite, alive } from "../shared/io.mjs";
import {
  APP_SERVER_COMMAND_PATTERN,
  changedStartState,
  startReader,
  workerCommandPattern,
} from "../shared/process-identity.mjs";
import { PROCESSES, stopOwnedChild } from "../shared/process-stop.mjs";
import { REAL_TIMING } from "../shared/timing.mjs";
import {
  DRIVER_ARG,
  DRIVER_ENTRY,
  DRIVER_FILES,
  DRIVER_PHASE,
  DRIVER_PROTOCOL_VERSION,
  DRIVER_IPC,
  DRIVER_REPLY_MS,
  DRIVER_INTERRUPT_MS,
  DRIVER_EXIT_MS,
  DRIVER_POLL_MS,
  JOB_READ_POLICY,
  IPC_NONCE_BYTES,
  DRIVER_ENCODING,
  DRIVER_TEXT,
  STOP_OUTCOME,
  WORKER_STATE,
  isGoneWorkerState,
  APP_SERVER_EXIT_MS,
  JOB_STATUS,
  validJobId,
} from "../shared/constants.mjs";
import { CODES, RunnerError } from "../shared/errors.mjs";

const ENTRY = fileURLToPath(new URL(DRIVER_ENTRY, import.meta.url));
const strict = { policy: JOB_READ_POLICY.STRICT };
const held = new Map();
export const driverCommandPattern = workerCommandPattern;

const incompleteStop = (record, detail) =>
  new RunnerError(
    CODES.STOP_INCOMPLETE,
    `${DRIVER_TEXT.STOP} ${DRIVER_TEXT.STOP_PID} ${record.pid}${detail ? `: ${detail}` : ""}`,
  );

// A changed start time is another process on Windows and Linux. On macOS it is
// one only when the command line now under that PID is not the one ours ran
// (pattern: this job's driver, or for an app-server APP_SERVER_COMMAND_PATTERN);
// a line that could be ours, or none, stays unknown (changedStartState).
export function inspectDriver(
  record,
  {
    processes = PROCESSES,
    stateDir,
    pattern = validJobId(record?.jobId) ? driverCommandPattern(record.jobId) : null,
  } = {},
) {
  if (!Number.isSafeInteger(record?.pid) || record.pid <= 0)
    return stateDir && record?.jobId && abandonedJob(stateDir, record.jobId)
      ? WORKER_STATE.GONE
      : WORKER_STATE.UNKNOWN;
  if (!alive(record.pid)) return WORKER_STATE.GONE;
  if (typeof record.processStart !== "string") return WORKER_STATE.UNKNOWN;
  const start = processes.probe.start(record.pid);
  if (start === null) return alive(record.pid) ? WORKER_STATE.UNKNOWN : WORKER_STATE.GONE;
  if (start === record.processStart) return WORKER_STATE.WORKER;
  return changedStartState(record.pid, start, pattern, { probe: processes.probe });
}

// The app-server a driver recorded ({ pid, processStart }, no job of its own).
export const inspectAppServer = (record, options = {}) =>
  inspectDriver(record, { ...options, stateDir: undefined, pattern: APP_SERVER_COMMAND_PATTERN });

export async function spawnDriver(
  plan,
  {
    stateDir,
    env = process.env,
    onSpawn = () => {},
    onIdentity = () => {},
    processes = PROCESSES,
    openGate = true,
  } = {},
) {
  const generation = crypto.randomBytes(IPC_NONCE_BYTES).toString(DRIVER_ENCODING);
  const jobId = createJob(stateDir, {
    ...plan,
    generation,
    protocol: DRIVER_PROTOCOL_VERSION,
    phase: DRIVER_PHASE.GATED,
    startedAt: new Date().toISOString(),
  });
  let record = readDriver(stateDir, jobId, strict);
  const starts = startReader(processes.probe);
  let child;
  try {
    record = writeDriver(stateDir, jobId, { ...record, endpoint: ipcEndpoint(stateDir, jobId) });
    createIpcSecret(stateDir, jobId);
    child = spawn(
      process.execPath,
      [ENTRY, DRIVER_ARG.RUN, DRIVER_ARG.JOB, jobId, DRIVER_ARG.STATE, stateDir],
      {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: codexEnvironment(env),
        cwd: plan.cwd,
      },
    );
    const spawned = new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (child.pid) onSpawn({ jobId, pid: child.pid });
    await spawned;
    const processStart = await starts.start(child.pid);
    if (processStart === null) throw new RunnerError(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.STOP);
    const worker = { jobId, pid: child.pid, processStart };
    record = writeDriver(stateDir, jobId, { ...record, ...worker });
    // The caller saves run.worker before this function opens the gate.
    await onIdentity(worker, record);
    // A waiter paused before spawn can resume after orphan recovery. Its
    // ungated child must never dispatch a job already settled by a successor.
    if (readTurn(stateDir, jobId, strict))
      throw new RunnerError(CODES.CODEX_RPC_ERROR, DRIVER_TEXT.NOT_STARTED);
    if (openGate)
      atomicWrite(
        path.join(jobPaths(stateDir, jobId).directory, DRIVER_FILES.GATE),
        JSON.stringify({ ...worker, generation }),
      );
    held.set(jobId, child);
    child.once("exit", () => held.delete(jobId));
    child.unref();
    return { jobId, worker, record, child };
  } catch (error) {
    // No PID means no process can race this publication. Keep failed launch
    // evidence so every command can identify and retire the prepared job.
    if (!child?.pid) {
      const message = `${DRIVER_TEXT.NOT_STARTED} ${error.message}`;
      const finalSha256 = writeFinal(stateDir, jobId, message);
      writeTurn(stateDir, jobId, {
        status: JOB_STATUS.FAILED,
        finalSha256,
        startedAt: record.startedAt,
        completedAt: new Date().toISOString(),
        threadId: null,
        turnId: null,
        tokenUsage: null,
        rateLimits: null,
        touchedFiles: [],
        error: { code: error.code ?? CODES.CODEX_RPC_ERROR, message },
      });
    }
    throw error;
  } finally {
    starts.close();
    child?.unref();
  }
}

export function createDriverClient(
  run,
  { stateDir, processes = PROCESSES, timing = REAL_TIMING } = {},
) {
  const request = async (method, payload = {}, timeoutMs = DRIVER_REPLY_MS) => {
    const record = readDriver(stateDir, run.jobId, strict);
    if (
      !record ||
      (run.worker &&
        (record.pid !== run.worker.pid || record.processStart !== run.worker.processStart))
    )
      throw new RunnerError(CODES.IPC_AUTH_FAILED, DRIVER_TEXT.AUTH);
    const client = await connectIpc(record, readIpcSecret(stateDir, run.jobId));
    try {
      return await client.request(method, payload, { timeoutMs });
    } finally {
      client.close();
    }
  };
  return {
    request,
    hello: () => request(DRIVER_IPC.STATUS),
    status: () => request(DRIVER_IPC.STATUS),
    interrupt: () => request(DRIVER_IPC.INTERRUPT, {}, DRIVER_INTERRUPT_MS + DRIVER_REPLY_MS),
    shutdown: () => request(DRIVER_IPC.SHUTDOWN),
    stop: () => stopDriver(run, { stateDir, processes, timing }),
  };
}

export async function stopDriver(
  run,
  { stateDir, processes = PROCESSES, timing = REAL_TIMING, signal } = {},
) {
  const record = readDriver(stateDir, run.jobId, strict);
  if (!record) throw new RunnerError(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.STOP);
  if (
    run.worker &&
    (record.pid !== run.worker.pid || record.processStart !== run.worker.processStart)
  )
    throw new RunnerError(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.STOP);
  // A failed spawn has terminal evidence even before the settling bound.
  if (
    !record.pid &&
    !record.processStart &&
    !record.appServer &&
    readTurn(stateDir, run.jobId, strict)
  )
    return { state: STOP_OUTCOME.GONE };
  let state = inspectDriver(record, { processes, stateDir, timing });
  const saveShutdown = (patch) => {
    const latest = readDriver(stateDir, run.jobId, strict);
    return writeDriver(stateDir, run.jobId, { ...latest, ...patch });
  };
  const stopTracked = async (target, invoke) => {
    const before = readDriver(stateDir, run.jobId, strict);
    const retryCapture =
      before.shutdownCapturePending === true &&
      before.shutdownRoot?.pid === target.pid &&
      before.shutdownRoot?.start === target.start;
    let recaptured = false;
    const result = await trackedStop(target, invoke, (patch) => {
      if (retryCapture && patch.shutdownTreeUnknown === false) recaptured = true;
      return saveShutdown({
        ...patch,
        shutdownTree: [
          ...new Map(
            [...(before.shutdownTree ?? []), ...patch.shutdownTree].map((target) => [
              `${target.pid}/${target.start ?? ""}`,
              target,
            ]),
          ).values(),
        ],
        shutdownTreeUnknown:
          (before.shutdownTreeUnknown === true && !recaptured) || patch.shutdownTreeUnknown,
      });
    });
    if (
      !result.detail &&
      [STOP_OUTCOME.STOPPED, STOP_OUTCOME.GONE, STOP_OUTCOME.REUSED].includes(result.state)
    )
      saveShutdown({
        shutdownIncomplete: before.shutdownIncomplete ?? false,
        shutdownTree: before.shutdownTree ?? [],
        shutdownTreeUnknown: recaptured ? false : (before.shutdownTreeUnknown ?? false),
        shutdownCapturePending: recaptured ? false : (before.shutdownCapturePending ?? false),
      });
    return result;
  };
  const finish = async (result) => {
    let latest = readDriver(stateDir, run.jobId, strict);
    if (latest?.shutdownIncomplete) {
      const tree = Array.isArray(latest.shutdownTree)
        ? latest.shutdownTree.map((target) =>
            typeof target === "number" ? { pid: target, start: null } : target,
          )
        : latest.shutdownTree;
      if (
        !Array.isArray(tree) ||
        !tree.length ||
        tree.some((target) => !Number.isSafeInteger(target?.pid) || target.pid <= 0)
      ) {
        saveShutdown({
          ...shutdownEvidence(latest.appServer ?? { pid: latest.pid, start: latest.processStart }),
          // A legacy missing list does not prove the earlier stop sent no signals.
          shutdownCapturePending: false,
        });
        throw incompleteStop(latest, DRIVER_TEXT.STOP);
      }
      for (const target of tree) {
        const status = inspectDriver(
          { pid: target.pid, processStart: target.start },
          { processes, pattern: null },
        );
        if (isGoneWorkerState(status)) continue;
        if (status !== WORKER_STATE.WORKER) throw incompleteStop(target, DRIVER_TEXT.STOP);
        const ended = await stopTracked(target, (onIdentified) =>
          processes.stop({
            pid: target.pid,
            start: target.start,
            signal,
            onIdentified,
          }),
        );
        if (
          ended.detail ||
          ![STOP_OUTCOME.STOPPED, STOP_OUTCOME.GONE, STOP_OUTCOME.REUSED].includes(ended.state)
        )
          throw incompleteStop(target, ended.detail);
      }
      latest = readDriver(stateDir, run.jobId, strict);
      if (latest.shutdownTreeUnknown) throw incompleteStop(latest, DRIVER_TEXT.STOP);
    }
    await requireAppServerEnded(latest ?? record, { processes, timing, stopTracked, signal });
    if (latest?.shutdownIncomplete)
      saveShutdown({
        shutdownIncomplete: false,
        shutdownTree: [],
        shutdownTreeUnknown: false,
        shutdownCapturePending: false,
        shutdownRoot: null,
      });
    removeEndedEndpoint(record, stateDir);
    return result;
  };
  if (isGoneWorkerState(state)) return finish({ state: STOP_OUTCOME.GONE });
  if (state !== WORKER_STATE.WORKER)
    throw new RunnerError(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.STOP);
  signal?.throwIfAborted();
  let shutdownAccepted = false;
  try {
    await createDriverClient(run, { stateDir }).shutdown();
    shutdownAccepted = true;
  } catch {
    /* The identity-bound fallback works without IPC. */
  }
  const deadline = timing.now() + DRIVER_EXIT_MS;
  while (timing.now() < deadline) {
    if (!alive(record.pid))
      return finish({ state: shutdownAccepted ? STOP_OUTCOME.STOPPED : STOP_OUTCOME.GONE });
    await timing.sleep(DRIVER_POLL_MS, signal);
  }
  state = inspectDriver(record, { processes, stateDir, timing });
  if (isGoneWorkerState(state)) return finish({ state: STOP_OUTCOME.GONE });
  if (state !== WORKER_STATE.WORKER)
    throw new RunnerError(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.STOP);
  const child = held.get(run.jobId);
  const result = await stopTracked(
    { pid: record.pid, start: record.processStart },
    (onIdentified) =>
      child
        ? stopOwnedChild(child, record.processStart, {
            stop: (target) => processes.stop({ ...target, onIdentified }),
            signal,
          })
        : processes.stop({
            pid: record.pid,
            start: record.processStart,
            pattern: driverCommandPattern(run.jobId),
            signal,
            onIdentified,
          }),
  );
  if (
    result.detail ||
    ![STOP_OUTCOME.STOPPED, STOP_OUTCOME.GONE, STOP_OUTCOME.REUSED].includes(result.state)
  )
    throw incompleteStop(record, result.detail);
  return finish(result);
}

async function requireAppServerEnded(record, { processes, timing, stopTracked, signal }) {
  if (!record.appServer) return;
  const deadline = timing.now() + APP_SERVER_EXIT_MS;
  let state = inspectAppServer(record.appServer, { processes });
  while (state === WORKER_STATE.WORKER && timing.now() < deadline) {
    await timing.sleep(DRIVER_POLL_MS);
    state = inspectAppServer(record.appServer, { processes });
  }
  if (isGoneWorkerState(state)) return;
  if (state !== WORKER_STATE.WORKER)
    throw new RunnerError(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.STOP);
  const target = { pid: record.appServer.pid, start: record.appServer.processStart };
  const stopped = await stopTracked(target, (onIdentified) =>
    processes.stop({
      ...target,
      signal,
      onIdentified,
    }),
  );
  if (
    stopped.detail ||
    ![STOP_OUTCOME.STOPPED, STOP_OUTCOME.GONE, STOP_OUTCOME.REUSED].includes(stopped.state)
  )
    throw incompleteStop(record.appServer, stopped.detail);
}
