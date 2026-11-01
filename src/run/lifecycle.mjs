import fs from "node:fs";
import path from "node:path";
import {
  JOB_ACTIVITY,
  ACTIVE,
  AUDIT_TRANSITION,
  LOST_JOB,
  RUN_FOLDER_REMOVAL,
  STOP_OUTCOME,
  TERMINAL,
  WORKER_STATE,
  isGoneWorkerState,
  JOB_READ_POLICY,
  DRIVER_TEXT,
  GIT_LINK,
} from "../shared/constants.mjs";
import {
  observedJobs,
  readJob as readDriverJob,
  readDriver,
  abandonedJob,
} from "../state/job-store.mjs";
import { recoverJob } from "./recovery.mjs";
import { stopDriver, inspectDriver } from "../codex/driver-client.mjs";
import { cancelJob } from "./cancel.mjs";
import { requireDirectory } from "../shared/io.mjs";
import {
  isDelivered,
  releaseClosedRunClaims,
  releaseRequestClaim,
  releaseWriterLock,
  writeTombstone,
} from "../state/state.mjs";
import {
  commitWorktree,
  removeWorktree,
  worktreeLinked,
  requireWorktreeSnapshot,
} from "../shared/workspace.mjs";
import { lostJobCandidate, rollBackTurn } from "./launch.mjs";
import { confirmTurnJob, turnInTransition, turnReserved } from "../state/turn-transition.mjs";

import { PROCESSES } from "../shared/process-stop.mjs";
import { requireDurableDestination } from "../delivery/result-path.mjs";
import { CODES, RunnerError } from "../shared/errors.mjs";
import { REAL_TIMING } from "../shared/timing.mjs";
import { archiveRunThread } from "../maintenance/threads.mjs";
import { recordArtifact } from "../state/artifact-store.mjs";
import { unknownShutdown } from "../codex/uncertain-stop.mjs";
import { acceptUnknownShutdown } from "../state/forced-close.mjs";

async function warnIfBusy(released, what, warn) {
  if (!released)
    await warn(
      `${what} stayed busy; it belongs to a finished run and the next writer reclaims it.`,
    );
}

// A write job's workspace writer lock is released when its result is delivered
// or the run is closed; scratch and worktree jobs never took one.
export async function releaseWriter(run, { stateBase, signal, warn, timing }) {
  if (run.write && !run.scratchWorkspace && !run.worktree) {
    await warnIfBusy(
      await releaseWriterLock(stateBase, run.cwd, run.runKey, { signal, timing }),
      "The writer lock",
      warn,
    );
  }
}

async function activeJobStatus(run, { stateDir, save, processes = PROCESSES }) {
  if (run.result) return isDelivered(run) ? null : JOB_ACTIVITY.UNDELIVERED;
  if (!run.jobId) {
    let found;
    try {
      found = await lostJobCandidate(run, { probe: processes.probe, stateDir });
    } catch (error) {
      if (error.code === CODES.LAUNCH_SETTLING) throw error;
      return JOB_ACTIVITY.UNKNOWN;
    }
    if (found.kind === LOST_JOB.NONE) return null;
    if (found.kind !== LOST_JOB.FOUND) return JOB_ACTIVITY.UNKNOWN;
    confirmTurnJob(run, found.job.id);
    save();
  }

  const status = readDriverJob(stateDir, run.jobId, { policy: JOB_READ_POLICY.STRICT })?.record
    .status;
  return TERMINAL.has(status)
    ? JOB_ACTIVITY.UNDELIVERED
    : ACTIVE.has(status)
      ? status
      : JOB_ACTIVITY.UNKNOWN;
}

export async function teardown(run, context) {
  const {
    call,
    stateBase,
    stateDir,
    signal,
    warn,
    timing = REAL_TIMING,
    audit,
    force = false,
  } = context;
  signal?.throwIfAborted();
  for (const result of [run.result, ...(run.turns ?? []).map((turn) => turn.result)]) {
    if (!result?.resultFile || !fs.existsSync(result.resultFile)) continue;
    try {
      requireDurableDestination(result.resultFile, run, stateDir, { existing: true });
    } catch (error) {
      if (error.code !== CODES.UNSAFE_RESULT_DESTINATION) throw error;
      // Closing removes that tree, and the copy with it.
      throw Object.assign(
        new Error(
          `the result copy ${result.resultFile} lies inside ${error.root}, which closing removes; move that file out of it first, then retry --close ${run.runKey}`,
          { cause: error },
        ),
        { code: error.code },
      );
    }
  }
  const unconfirmed = context.acceptUnknownTree ? [] : null;
  await stopRunDriver(run, { ...context, force, unconfirmed });
  if (unconfirmed?.length) await acceptUnknownShutdown(run, unconfirmed, context);
  requireDirectory(stateBase);
  requireDirectory(stateDir);
  if (path.dirname(stateDir) !== stateBase || path.basename(stateDir) !== run.runKey)
    throw new Error("unsafe cleanup path");
  if (run.worktree) {
    const exists = fs.existsSync(run.cwd);
    // A folder without its .git link (an earlier removal that failed part-way,
    // or a job that deleted it) cannot be committed; only --force removes it.
    if (exists) {
      if (worktreeLinked(run)) {
        if (run.result?.finalizedAt || (isDelivered(run) && !run.result.shutdownPending))
          await requireWorktreeSnapshot(run, { signal });
        else await commitWorktree(run, "close", { signal });
      } else if (!force)
        throw new Error(
          `the worktree ${run.cwd} of run ${run.runKey} has lost its ${GIT_LINK} link, so git can neither commit nor remove its files; ` +
            `remove them with --close ${run.runKey} --force${run.worktree.branch ? ` (branch ${run.worktree.branch} keeps what was committed)` : ""}`,
        );
    }
    // The checkout may already be gone. Publish its sealed artifact before
    // deleting the only remaining run state; publication rechecks branch and
    // repository identity, and a failure retains that state for recovery.
    if (isDelivered(run) && run.result?.resultFile && !run.result.shutdownPending) {
      run.sealed = true;
      context.save();
      await recordArtifact(run, context);
    }
    // Missing folders can still have a Git registration. An attempt that
    // never resolved its start commit has no registration to reconcile.
    if (exists || run.worktree.startCommit) await removeWorktree(run, { signal, stateDir });
  }
  await archiveRunThread(run, context);
  // The tombstone outlives the folder until the claim is released, so a
  // crash between the two leaves the claim reconcilable (closedRunClaims).
  const tombstone = writeTombstone(stateBase, run);
  fs.rmSync(stateDir, { recursive: true, force: true, ...RUN_FOLDER_REMOVAL });
  await releaseWriter(run, { stateBase, signal, warn, timing });
  const released = await releaseRequestClaim(stateBase, run.requestId, run.runKey, {
    signal,
    timing,
  });
  await warnIfBusy(released, `The claim of request ${run.requestId}`, warn);
  if (released && tombstone) fs.rmSync(tombstone, { force: true });
  await releaseClosedRunClaims(stateBase, { signal, timing });
  await audit?.emit(AUDIT_TRANSITION.CLOSE, run);
}

// --close: tears down a kept or retained run whose job is not active and
// releases its workspace writer lock and request claim. It refuses when it
// cannot tell whether the job still runs, and when a finished job's result
// was never delivered; --force closes anyway, and stops a running job's
// worker first (teardown).
export async function closeRun(options, run, context) {
  const { stateDir, warn, save, processes = PROCESSES } = context;
  const active = await activeJobStatus(run, { stateDir, save, processes });
  if (active && !options.force) {
    if (active === JOB_ACTIVITY.UNKNOWN) {
      throw new Error(
        `cannot tell whether Codex job ${run.jobId ?? "(not identified)"} of run ${run.runKey} is still running; retry, ` +
          `stop it with --cancel ${run.runKey}, or close anyway with --close ${run.runKey} --force (which stops a running job)`,
      );
    }
    if (active === JOB_ACTIVITY.UNDELIVERED) {
      throw new Error(
        `Codex job ${run.jobId} finished but its result was never delivered; collect it with --run ${run.runKey}, ` +
          `or drop it with --close ${run.runKey} --force`,
      );
    }
    throw new Error(
      `Codex job ${run.jobId} is still ${active}; cancel it first with --cancel ${run.runKey}`,
    );
  }
  if (active) {
    const record = ACTIVE.has(active) ? readDriver(stateDir, run.jobId) : null;
    const pid = record?.pid;
    const worker =
      Number.isSafeInteger(pid) && pid > 0 ? inspectDriver(record, { processes }) : null;
    const effect = !ACTIVE.has(active)
      ? active === JOB_ACTIVITY.UNDELIVERED
        ? "; its result is dropped"
        : ""
      : isGoneWorkerState(worker)
        ? `; its worker process ${pid} has ended${worker === WORKER_STATE.REUSED ? " and its PID now belongs to another process" : ""}, so the job is marked failed and that PID is not killed`
        : "; its worker is stopped first, as the process the runner identified";
    await warn(`Closing run ${run.runKey} with --force although its job is ${active}${effect}.`);
  }
  await teardown(run, {
    ...context,
    force: Boolean(options.force),
    acceptUnknownTree: Boolean(options.force),
  });
  await warn(
    `Run ${run.runKey} closed; its state was removed` +
      `${run.worktree?.branch ? `; branch ${run.worktree.branch} kept` : run.worktree ? "; its snapshot was removed" : ""}.`,
  );
}

export async function stopAndSleep(run, context) {
  let outcome;
  try {
    outcome = await stopRunDriver(run, context);
  } catch (failure) {
    return { outcome: null, failure };
  }
  if (outcome === STOP_OUTCOME.UNKNOWN) {
    run.dormant = false;
    run.result.shutdownPending = true;
    context.save();
    return { outcome, failure: null };
  }
  // A separate --sleep may confirm exit, but collection still has to finalize
  // the previously deferred workspace before continuation or artifact sealing.
  if (run.result && context.unconfirmed) delete run.result.shutdownPending;
  run.dormant = true;
  context.save();
  await context.audit?.emit(AUDIT_TRANSITION.SLEEP, run);
  return { outcome, failure: null };
}

export async function sleepRun(run, context) {
  const { stateDir, warn } = context;
  // A continuation reserved but never started (its invocation was
  // interrupted) is given back first: the delivered run can sleep.
  if (turnReserved(run) && (await rollBackTurn(run, context)))
    await warn(
      `Run ${run.runKey} was reserved for a continued turn that never started; the reservation was given back.`,
    );
  if (!run.result || turnInTransition(run))
    throw new Error(
      run.result
        ? `run ${run.runKey} is starting its next turn; attach with --run ${run.runKey}, or --close it`
        : `run ${run.runKey} has no delivered result; only a run waiting for --continue or --close can sleep`,
    );

  const { failure } = await stopAndSleep(run, context);
  if (failure) throw failure;
  await warn(
    `Run ${run.runKey} sleeps: its Codex processes are stopped; ` +
      (run.result.shutdownPending
        ? `collect with --run ${run.runKey} to finalize its workspace before continuation.`
        : "--continue starts them again."),
  );
  return;
}

export async function stopRunDriver(run, context) {
  const { stateDir, processes = PROCESSES, force = false } = context;
  for (const job of observedJobs(stateDir)) {
    if (job.issue) throw job.issue;
    for (const observed of Object.values(job.observations ?? {}))
      if (observed.issue) throw observed.issue;
    let record = job.driver;
    if (!record) throw new RunnerError(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.STOP);
    const target = { ...run, jobId: record.jobId };
    if (run.worker?.jobId !== target.jobId) delete target.worker;
    if (!job.turn && abandonedJob(stateDir, target.jobId)) {
      await recoverJob(target, context);
      record = readDriver(stateDir, target.jobId, { policy: JOB_READ_POLICY.STRICT });
      job.turn = readDriverJob(stateDir, target.jobId, { policy: JOB_READ_POLICY.STRICT }).turn;
    }
    if (!job.turn) {
      if (!force) throw new RunnerError(CODES.DRIVER_STILL_RUNNING, DRIVER_TEXT.STOP);
      await cancelJob(target, { ...context, driver: undefined });
    } else if (!TERMINAL.has(job.turn.status))
      throw new RunnerError(CODES.SUBMISSION_UNCERTAIN, DRIVER_TEXT.UNCERTAIN);
    try {
      await stopDriver(target, { ...context, processes });
    } catch (failure) {
      const report =
        context.unconfirmed &&
        (await unknownShutdown(target, { ...context, processes }, failure, {
          stop: context.acceptUnknownTree === true,
        }));
      if (!report) throw failure;
      context.unconfirmed.push(report);
    }
  }
  return context.unconfirmed?.length ? STOP_OUTCOME.UNKNOWN : STOP_OUTCOME.STOPPED;
}
