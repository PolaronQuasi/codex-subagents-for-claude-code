// Only an explicitly uncaptured tree can use the close override. Missing or
// foreign driver records and known surviving processes keep their normal gates.
import { inspectDriver } from "./driver-client.mjs";
import { shutdownEvidence, trackedStop } from "./shutdown.mjs";
import { readDriver, writeDriver } from "../state/job-store.mjs";
import { JOB_READ_POLICY, WORKER_STATE, DRIVER_TEXT } from "../shared/constants.mjs";
import { CODES, RunnerError } from "../shared/errors.mjs";

export async function unknownShutdown(run, context, failure, { stop = false } = {}) {
  if (![CODES.STOP_INCOMPLETE, CODES.WORKER_UNCONFIRMED].includes(failure.code)) return null;
  const { stateDir, processes, signal } = context;
  const read = () => readDriver(stateDir, run.jobId, { policy: JOB_READ_POLICY.STRICT });
  const record = read();
  if (
    !record?.shutdownIncomplete ||
    record.shutdownTreeUnknown !== true ||
    (run.worker &&
      (record.pid !== run.worker.pid || record.processStart !== run.worker.processStart))
  )
    return null;
  const targets = new Map();
  const add = (target) => {
    if (typeof target === "number") target = { pid: target, start: null };
    if (!Number.isSafeInteger(target?.pid) || target.pid <= 0) return;
    const start = target.start ?? target.processStart ?? null;
    targets.set(`${target.pid}/${start ?? ""}`, { pid: target.pid, start });
  };
  add(record);
  add(record.appServer);
  add(record.shutdownRoot);
  for (const target of record.shutdownTree ?? []) add(target);
  const observations = [];
  for (const target of targets.values()) {
    signal?.throwIfAborted();
    const inspect = () =>
      inspectDriver({ pid: target.pid, processStart: target.start }, { processes, pattern: null });
    let state = inspect();
    if (stop && state === WORKER_STATE.WORKER) {
      await trackedStop(
        target,
        (onIdentified) => processes.stop({ ...target, signal, onIdentified }),
        (patch) => {
          const latest = read();
          const evidence = shutdownEvidence(
            target,
            { identities: patch.shutdownTree, treeUnknown: true },
            latest,
          );
          writeDriver(stateDir, run.jobId, { ...latest, ...evidence });
          for (const captured of evidence.shutdownTree) add(captured);
        },
      );
      state = inspect();
      if (state === WORKER_STATE.WORKER)
        throw new RunnerError(
          CODES.STOP_INCOMPLETE,
          `${DRIVER_TEXT.STOP} Known process PID ${target.pid} still runs.`,
        );
    }
    observations.push({ ...target, state });
  }
  return { jobId: run.jobId, processes: observations };
}
