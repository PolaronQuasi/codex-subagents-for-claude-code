// Cancellation deliberately runs before the waiter takes the run lock. The
// independent intent file avoids a second writer of run.json or driver.json.
import { createDriverClient, inspectDriver, stopDriver } from "../codex/driver-client.mjs";
import {
  readDriver,
  readTurn,
  settleJob,
  writeCancelIntent,
  abandonedJob,
} from "../state/job-store.mjs";
import { recoverJob } from "./recovery.mjs";
import { PROCESSES } from "../shared/process-stop.mjs";
import { REAL_TIMING } from "../shared/timing.mjs";
import {
  JOB_READ_POLICY,
  WORKER_STATE,
  isGoneWorkerState,
  STOP_OUTCOME,
  JOB_STATUS,
  DRIVER_TEXT,
  DRIVER_INTERRUPT_MS,
  DRIVER_POLL_MS,
} from "../shared/constants.mjs";
import { CODES, RunnerError } from "../shared/errors.mjs";

export async function cancelJob(run, context) {
  const { stateDir, processes = PROCESSES, timing = REAL_TIMING, signal } = context;
  const strict = { policy: JOB_READ_POLICY.STRICT };
  let terminal = readTurn(stateDir, run.jobId, strict);
  if (terminal) return terminal;
  const record = readDriver(stateDir, run.jobId, strict) ?? abandonedJob(stateDir, run.jobId);
  if (
    run.worker &&
    (record?.pid !== run.worker.pid || record?.processStart !== run.worker.processStart)
  )
    throw new RunnerError(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.STOP);
  const inspect = (record) => inspectDriver(record, { processes, stateDir, timing });
  const state = inspect(record);
  if (isGoneWorkerState(state)) return (await recoverJob(run, context)).terminal;
  if (state !== WORKER_STATE.WORKER)
    throw new RunnerError(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.STOP);
  signal?.throwIfAborted();
  writeCancelIntent(stateDir, run.jobId, record.generation);
  const deadline = timing.now() + DRIVER_INTERRUPT_MS;
  const driver = context.driver ?? createDriverClient(run, context);
  let retryInterrupt = false;
  try {
    await driver.interrupt();
  } catch {
    signal?.throwIfAborted();
    retryInterrupt = true;
  }
  for (;;) {
    terminal = readTurn(stateDir, run.jobId, strict);
    if (terminal) return terminal; // A completed result wins a racing cancel.
    if (isGoneWorkerState(inspect(record))) return (await recoverJob(run, context)).terminal;
    if (timing.now() >= deadline) break;
    await timing.sleep(DRIVER_POLL_MS, signal);
    if (retryInterrupt) {
      retryInterrupt = false;
      if (readTurn(stateDir, run.jobId, strict)) continue;
      if (timing.now() >= deadline) break;
      try {
        await driver.interrupt();
      } catch {
        signal?.throwIfAborted();
      }
    }
  }
  const stopped = await stopDriver(run, context);
  terminal = readTurn(stateDir, run.jobId, strict);
  if (terminal) return terminal;
  if (stopped.state !== STOP_OUTCOME.STOPPED) return (await recoverJob(run, context)).terminal;
  return settleJob(
    stateDir,
    run.jobId,
    {
      status: JOB_STATUS.CANCELLED,
      text: DRIVER_TEXT.CANCELLED,
      tokenUsage: null,
      rateLimits: null,
      touchedFiles: [],
      error: null,
    },
    { inspect },
  );
}
