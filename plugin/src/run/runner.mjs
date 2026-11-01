// One invocation in explicit phases: resolve, prepare/open, advance, obtain,
// deliver. Cancellation precedes locking; the durable copy precedes stdout.
import fs from "node:fs";
import path from "node:path";
import {
  LAUNCH_OUTCOME,
  RETRY_REASON,
  RUN_LOCK_OUTCOME,
  RUN_PHASE,
  AUDIT_TRANSITION,
  LOST_JOB,
  OUTCOME,
  RUN_JOB,
  RUN_KEY,
  validJobId,
  JOB_STATUS,
  DRIVER_TEXT,
} from "../shared/constants.mjs";
import { createDriverClient } from "../codex/driver-client.mjs";
import { cancelJob } from "./cancel.mjs";
import { readProgress } from "../state/job-store.mjs";
import { requireDirectory, writeOutput } from "../shared/io.mjs";
import { consumeFiles, loadPrompt, onlyTaskFile, prepareTask } from "../cli/task-input.mjs";
import { isForkSeed, forkReceipt } from "../shared/fork.mjs";
import { acquireRunLock, claimedRun, deliveryPreferences, isDelivered } from "../state/state.mjs";
import {
  checkLockedRun,
  jobOfTurn,
  peekRun,
  readLockedRun,
  validateRun,
} from "../state/run-record.mjs";
import { readRunFile, recordDeliveryOverrides, saveRun } from "../state/run-store.mjs";
import {
  canRetry,
  unidentifiedJob,
  checkContinue,
  confirmJob,
  launchRun,
  lostJobCandidate,
  prepareContinue,
  retryJob,
  rollBackTurn,
  startJob,
  turnNotStarted,
} from "./launch.mjs";
import { closeRun, releaseWriter, sleepRun, stopAndSleep, stopRunDriver } from "./lifecycle.mjs";
import { readForcedClose } from "../state/forced-close.mjs";
import { turnInTransition } from "../state/turn-transition.mjs";
import {
  cacheResult,
  cachedResult,
  fetchResult,
  printResult,
  settleDeadWorker,
  settleRun,
  waitForJob,
  writeDurableCopy,
} from "./deliver.mjs";
import {
  findResultByJob,
  findResultByRun,
  findResultsByRequestId,
  jobReplay,
  launchedLine,
  renderProgress,
  renderProgressEntries,
  replayCopy,
  requestReplay,
  resumeCommand,
} from "../delivery/output.mjs";

import { REAL_TIMING } from "../shared/timing.mjs";
import { PROCESSES } from "../shared/process-stop.mjs";
import { closeDamagedRun, damagedRunError } from "../state/damaged-run.mjs";
import { CODES, EXIT, RunnerError } from "../shared/errors.mjs";

const done = (code) => ({ kind: RUN_PHASE.DONE, code });

// The informational diagnostics of a phase, written through warn unless the
// phase's delivery preferences are quiet.
const quietInfo = (warn, quiet) => (message) => (quiet ? undefined : warn(message));

// Writes a STILL RUNNING notice (exit 3 follows), and gives an in-process
// collector its first line as the reason the command delivered nothing.
async function stillRunning(context, text) {
  await writeOutput(context.stdout, text, { signal: context.signal, timeoutMs: context.commandMs });
  context.onOutcome?.({
    kind: OUTCOME.STILL_RUNNING,
    reason: text.slice(0, text.indexOf("\n")),
  });
}

function resolveRoute(options, context) {
  const route = { mode: options.mode, key: options.key };
  if (!route.key?.startsWith("rq:")) return route;
  const requestId = route.key.slice(3);
  // A claim lives in the root of the run that holds it.
  const holder = claimedRun(context.stateBase, requestId);
  if (holder) return { ...route, key: holder };
  const { resultsDir } = context;
  const copy = findResultsByRequestId(resultsDir, requestId).at(-1);
  if (copy && route.mode === "attach")
    return { kind: LAUNCH_OUTCOME.REPLAY, copy: copy.file, prefix: requestReplay(requestId) };
  throw new Error(
    `request ${requestId} names no retained run${copy ? `; it was delivered, see ${copy.file}` : ""}`,
  );
}

async function prepareOrOpen(options, context) {
  const route = resolveRoute(options, context);
  if (route.kind === LAUNCH_OUTCOME.REPLAY)
    return done(await context.replay(route.copy, route.prefix));
  if (route.mode !== "launch") return openRun(options, route, context);
  const requestedBase = path.resolve(context.cwd, options.cwd || ".");
  requireDirectory(requestedBase);
  const base = fs.realpathSync(requestedBase);
  const input = context.loadInput(base);
  const outcome = await launchRun(options, input.prompt, { ...context, base });
  if (outcome.kind === LAUNCH_OUTCOME.REPLAY)
    return done(await context.replay(outcome.copy, requestReplay(options["request-id"])));
  if (outcome.kind === LAUNCH_OUTCOME.WAITING) {
    // The budget ended while another launcher of this request was starting.
    const id = options["request-id"];
    const handle = { runKey: outcome.key ?? `rq:${id}`, jobId: null };
    await stillRunning(
      context,
      `STILL RUNNING: request ${id} is being launched by another process${outcome.key ? ` as run ${outcome.key}` : ""}. ` +
        `Wait again with: ${resumeCommand(handle, context.script)}\n` +
        `codex-subagents-for-claude-code-progress: phase=other-launcher elapsed=- last=request ${id} is claimed by another launcher\n`,
    );
    context.keepOnlyTaskFile();
    await context.consume();
    return done(EXIT.STILL_RUNNING);
  }
  if (outcome.kind === LAUNCH_OUTCOME.ATTACH) {
    context.keepOnlyTaskFile();
    return openRun(options, { mode: "attach", key: outcome.key }, context);
  }
  return { ...outcome, route, cancelSent: null };
}

// The durable copy of a run that another waiter delivered and removed: the
// named job's latest copy, else the copy of the job the run's audit says was
// delivered last (when the job was never known here, or was given up for a
// retry).
function deliveredCopy(resultsDir, runKey, jobId) {
  const copy = jobId ? findResultByJob(resultsDir, jobId, runKey) : null;
  return copy ? { file: copy, jobId } : findResultByRun(resultsDir, runKey);
}

// Gives back a run lock on an end of the command that has its own outcome: a
// failure to give it back is warned, never thrown over that outcome.
async function releaseWarned(releaseRunLock, warn) {
  try {
    releaseRunLock();
  } catch (error) {
    await warn(`Could not release run lock: ${error.message}`);
  }
}

// Cancel reaches a job before the run lock is taken, even while another
// waiter owns that lock; this ordering is intentional. A run whose current job
// has no result yet has it cancelled now (sendCancel), quiet as the command or
// the run asks, and the waiter that holds the lock, if any, delivers its
// terminal record. Returns the cancelled job's ID, or null when there was none
// to cancel before the lock.
async function cancelBeforeLock(options, route, context, stateDir) {
  if (route.mode !== "cancel") return null;
  let peek;
  try {
    peek = peekRun(stateDir, route.key);
  } catch (error) {
    throw damagedRunError(route.key, error);
  }
  if (!peek || peek.result || !peek.jobId) return null;
  context.audit?.bind(peek);
  try {
    await cancelJob(peek, { ...context, stateDir });
  } catch (error) {
    throw new RunnerError(
      error.code,
      `${error.message}. ${DRIVER_TEXT.RECOVER} ${resumeCommand(peek, context.script)}`,
      { cause: error },
    );
  }
  await context.audit?.emit(AUDIT_TRANSITION.CANCEL, peek);
  return peek.jobId;
}

// Opens a run whose lock the caller holds, and never gives the lock back
// itself. The current record is read and checked, and an
// attach's explicit delivery options recorded at once, so the attach command
// printed on exit 3 inherits them. Returns { kind: RUN_PHASE.OPENED, run, delivery }
// with the run's delivery preferences; or
// { kind: RUN_PHASE.VANISHED } when the run's folder is gone, which another waiter
// delivered and removed while this invocation took the lock (never damaged
// metadata); or a done outcome once a forced close retired a damaged run.
// Damaged metadata otherwise throws.
async function openLockedRun(options, route, context, { stateBase, stateDir }) {
  const { warn, consume } = context;
  if (!fs.existsSync(stateDir)) return { kind: RUN_PHASE.VANISHED };
  let run;
  try {
    const keyed = { ...options, key: route.key };
    run = readLockedRun(keyed, { stateDir });
    checkLockedRun(run, keyed, stateDir);
    recordDeliveryOverrides(run, options, stateDir);
  } catch (error) {
    if (error.code === CODES.RUN_GONE) return { kind: RUN_PHASE.VANISHED };
    if (error.code !== CODES.RUN_METADATA_INVALID) throw error;
    if (route.mode !== "close" || !options.force) throw damagedRunError(route.key, error);
    await closeDamagedRun(route.key, { ...context, stateBase, stateDir });
    await context.audit?.emit(AUDIT_TRANSITION.CLOSE, { runKey: route.key });
    await consume();
    return done(EXIT.COMPLETED);
  }
  context.audit?.bind(run);
  if (route.mode === "attach") await context.audit?.emit(AUDIT_TRANSITION.ATTACH, run);
  return { kind: RUN_PHASE.OPENED, run, delivery: deliveryPreferences(run) };
}

// The run's folder vanished after it was found: another waiter delivered and
// removed it while this invocation took the lock, which is given back by now.
// An attach or a cancel replays the job's durable copy, close and sleep have
// nothing left to do, and a continue is refused; none of them is damaged
// metadata.
async function vanishedRun(route, peekedJob, context) {
  const { resultsDir, replay, warn, consume } = context;
  if (route.mode === "attach" || route.mode === "cancel") {
    const found = deliveredCopy(resultsDir, route.key, peekedJob);
    if (found) return done(await replay(found.file, jobReplay(found.jobId)));
    throw new Error(
      `run ${route.key} is no longer retained and no durable result copy was found; use --list to find retained runs`,
    );
  }
  if (route.mode === "close" || route.mode === "sleep") {
    await warn(
      `Run ${route.key} was already delivered and removed by another process; nothing is left to ${route.mode === "close" ? "close" : "put to sleep"}.`,
    );
    await consume();
    return done(EXIT.COMPLETED);
  }
  throw new RunnerError(
    CODES.RUN_GONE,
    `run ${route.key} was delivered and removed by another waiter; start a new task to go on`,
  );
}

// Finds the run, cancels before the lock (cancelBeforeLock), takes the lock,
// and opens the run under it (openLockedRun). The configured stateBase holds
// its run lock, writer lock and request claim.
async function openRun(options, route, context) {
  const stateBase = context.stateBase;
  const { resultsDir, commandMs, signal, stdout, script, deadline, warn, consume, replay } =
    context;
  const stateDir = path.join(stateBase, route.key);
  if (route.mode === "attach" && !fs.existsSync(stateDir)) {
    const found = deliveredCopy(resultsDir, route.key, options.attach);
    if (found) return done(await replay(found.file, jobReplay(found.jobId)));
  }
  if (!fs.existsSync(stateDir))
    if (route.mode === "close" && options.force && readForcedClose(route.key, context)) {
      await warn(
        `Run ${route.key} was already closed with shutdown unconfirmed; its forced-close evidence is retained.`,
      );
      await consume();
      return done(EXIT.COMPLETED);
    } else if (
      route.mode === "close" &&
      options.force &&
      fs.existsSync(path.join(stateBase, "quarantine", route.key))
    ) {
      const lock = await acquireRunLock(route.key, {
        stateBase,
        deadline,
        mode: route.mode,
        signal,
        timing: context.timing,
      });
      try {
        await closeDamagedRun(route.key, { ...context, stateBase, stateDir });
        await consume();
        return done(EXIT.COMPLETED);
      } finally {
        lock.releaseRunLock();
      }
    } else
      throw new Error(
        `unknown run ${route.key}; use ${route.mode === "continue" ? "--list --mine" : "--list"} to find retained runs`,
      );
  requireDirectory(stateBase);
  requireDirectory(stateDir);
  context.audit?.bind({ runKey: route.key });
  if (options.detach && route.mode === "attach") {
    const existing = validateRun(readRunFile(stateDir), route.key, stateDir);
    await writeOutput(stdout, launchedLine(existing, script, true), {
      signal,
      timeoutMs: commandMs,
    });
    await consume();
    return done(EXIT.COMPLETED);
  }
  const cancelSent = await cancelBeforeLock(options, route, context, stateDir);
  let peekedJob = options.attach ?? null;
  try {
    peekedJob ??= readRunFile(stateDir).jobId ?? null;
  } catch {
    /* Rechecked under the lock. */
  }
  const lock = await acquireRunLock(route.key, {
    stateBase,
    deadline,
    mode: route.mode,
    cancelSent,
    signal,
    timing: context.timing,
  });
  if (lock.kind === RUN_LOCK_OUTCOME.HELD && cancelSent) {
    await writeOutput(
      stdout,
      `CANCEL REQUESTED: Codex job ${cancelSent}; the waiting process (PID ${lock.holder}) will deliver its terminal record.\n`,
      { signal, timeoutMs: commandMs },
    );
    await consume();
    return done(EXIT.COMPLETED);
  }
  if (lock.kind === RUN_LOCK_OUTCOME.HELD) {
    await stillRunning(
      context,
      `STILL RUNNING: Codex job ${peekedJob ?? "-"} is being delivered by another waiter (PID ${lock.holder}). ` +
        `Wait again with: ${resumeCommand({ runKey: route.key, jobId: peekedJob }, script)}\n` +
        `codex-subagents-for-claude-code-progress: phase=other-waiter elapsed=- last=PID ${lock.holder} holds this run\n` +
        (peekedJob ? renderProgressEntries(readProgress(stateDir, peekedJob)) : ""),
    );
    return done(EXIT.STILL_RUNNING);
  }
  // The one scope that owns the run lock. It hands the lock to the caller
  // with the opened run, gives it back before a vanished run's outcome (a
  // failure to give it back is then the command's error, after one more try,
  // warned), and gives it back on every other end, warning on a failure.
  const { releaseRunLock } = lock;
  let opened;
  try {
    opened = await openLockedRun(options, route, context, { stateBase, stateDir });
    if (opened.kind === RUN_PHASE.VANISHED) releaseRunLock();
  } catch (error) {
    await releaseWarned(releaseRunLock, warn);
    throw error;
  }
  if (opened.kind === RUN_PHASE.VANISHED) return vanishedRun(route, peekedJob, context);
  if (opened.kind === RUN_PHASE.OPENED)
    return {
      kind: RUN_PHASE.OPENED,
      run: opened.run,
      stateDir,
      stateBase,
      delivery: opened.delivery,
      releaseRunLock,
      route,
      cancelSent,
    };
  await releaseWarned(releaseRunLock, warn);
  return opened;
}

async function unstartedTurn(run, error, context) {
  let found;
  try {
    found = await lostJobCandidate(run, context);
  } catch {
    return error;
  }
  if (found.kind !== LOST_JOB.NONE || !(await rollBackTurn(run, context))) return error;
  return turnNotStarted(run, context.script, error.message);
}

// Records the job of a run whose launch response was lost (lostJobCandidate,
// which --close shares) the way a launch records its job (confirmJob: the job,
// the end of the reservation and of sleep, the worker). A continued turn with
// no job at all never started: it is rolled back to the delivered turn instead
// of being refused as unidentifiable. Returns a RUN_JOB for the caller to act
// on; several candidates, or none for a first turn, are refused.
async function identifyRunJob(run, context) {
  const found = await lostJobCandidate(run, {
    probe: context.processes?.probe,
    stateDir: context.stateDir,
  });
  if (found.kind === LOST_JOB.NONE && turnInTransition(run) && (await rollBackTurn(run, context)))
    return RUN_JOB.ROLLED_BACK;
  if (found.kind !== LOST_JOB.FOUND) throw unidentifiedJob(run, found.count);
  await confirmJob(run, found.job.id, context, found.job);
  return RUN_JOB.RECORDED;
}

async function advanceRun(options, opened, context) {
  const { run, route, cancelSent } = opened;
  const {
    stateBase,
    stateDir,
    save,
    info,
    script,
    signal,
    stdout,
    commandMs,
    warn,
    consume,
    keepOnlyTaskFile,
  } = context;
  if (route.mode === "close") {
    await closeRun(options, run, context);
    await consume();
    return done(EXIT.COMPLETED);
  }
  if (route.mode === "sleep") {
    if (isForkSeed(run) && !run.continuing) {
      await writeOutput(stdout, forkReceipt(run), { signal, timeoutMs: commandMs });
      return done(EXIT.COMPLETED);
    }
    await sleepRun(run, context);
    await consume();
    return done(EXIT.COMPLETED);
  }
  let repeatTurn = false;
  if (isForkSeed(run) && !run.continuing && route.mode !== "continue") {
    await writeOutput(stdout, forkReceipt(run), { signal, timeoutMs: commandMs });
    return done(EXIT.COMPLETED);
  }
  if (route.mode === "continue") {
    const turn = checkContinue(options, run);
    const input = context.loadInput(context.cwd);
    repeatTurn = await prepareContinue(options, run, input.prompt, turn, {
      stateBase,
      stateDir,
      save,
      info,
      script,
    });
    if (repeatTurn) keepOnlyTaskFile();
  }
  if (repeatTurn && options.detach) {
    await writeOutput(stdout, launchedLine(run, script, true), { signal, timeoutMs: commandMs });
    await consume();
    return done(EXIT.COMPLETED);
  }
  if (opened.kind === LAUNCH_OUTCOME.PREPARED || (route.mode === "continue" && !repeatTurn)) {
    try {
      await startJob(run, {
        ...context,
        resume: route.mode === "continue",
        stateDir,
        save,
        info,
        script,
        processes: context.processes,
      });
    } catch (error) {
      if (route.mode === "continue") throw await unstartedTurn(run, error, context);
      throw error;
    }
    await context.audit?.emit(
      route.mode === "continue" ? AUDIT_TRANSITION.CONTINUE : AUDIT_TRANSITION.LAUNCH,
      run,
    );
    await consume();
    if (options.detach) {
      await writeOutput(stdout, launchedLine(run, script), { signal, timeoutMs: commandMs });
      return done(EXIT.COMPLETED);
    }
  }
  // A cancelled turn that never started is rolled back; nothing ran, so the
  // cancel succeeds without delivering the earlier turn's result as its own.
  let neverStarted = false;
  if (route.mode === "cancel" && !cancelSent) {
    if (run.result)
      await warn(`Codex job ${run.jobId} already has a delivered result; nothing to cancel.`);
    else {
      if (!run.jobId && (await identifyRunJob(run, context)) === RUN_JOB.ROLLED_BACK) {
        neverStarted = true;
        await warn(
          `${turnNotStarted(run, script).message}; nothing was running, so nothing was cancelled.`,
        );
      } else {
        await cancelJob(run, context);
        await context.audit?.emit(AUDIT_TRANSITION.CANCEL, run);
      }
    }
  }

  if (neverStarted) {
    await consume();
    return done(EXIT.COMPLETED);
  }
  return { kind: RUN_PHASE.OBTAIN };
}

async function obtainResult(options, run, context, { retry }) {
  const { stateDir, deadline, commandMs, signal, warn, script, codexHome, save } = context;
  if (run.result) {
    const output = cachedResult(run, stateDir);
    if (!run.result.finalizedAt && (!isDelivered(run) || run.result.shutdownPending))
      await cacheResult(run, output, context);
    return {
      kind: RUN_PHASE.RESULT,
      output,
      status: run.result.status,
    };
  }
  if (!run.jobId && (await identifyRunJob(run, context)) === RUN_JOB.ROLLED_BACK)
    throw turnNotStarted(run, context.script);
  if (options.attach && !jobOfTurn(run, options.attach))
    throw new Error("job ID does not match this run");
  for (;;) {
    const waited = await waitForJob(run, {
      ...context,
      stateDir,
      deadline,
      commandMs,
      signal,
      warn,
      save,
      timing: context.timing,
      processes: context.processes,
    });
    if (!waited.ended) {
      await stillRunning(
        context,
        `STILL RUNNING: Codex job ${run.jobId}. Wait again with: ${resumeCommand(run, script)}\n${renderProgress(waited.snapshot.job)}`,
      );
      return done(EXIT.STILL_RUNNING);
    }
    // A job whose worker died before the job started never reached Codex, so
    // the turn is submitted once more (never for --cancel).
    if (waited.deadWorker || waited.unstarted) {
      const { retryable, terminal } = await settleDeadWorker(run, waited.deadWorker, context);
      if (retryable && retry && canRetry(run, RETRY_REASON.WORKER_DIED)) {
        await retryJob(run, RETRY_REASON.WORKER_DIED, context);
        continue;
      }
      // A terminal file may have appeared between observation and settlement.
      // Deliver that result rather than synthesizing a worker-death failure.
      if (terminal)
        Object.assign(waited, { status: terminal.status, stale: true, deadWorker: null });
    }

    const fetched = await fetchResult(run, waited, context);
    run.result = fetched.result;
    await cacheResult(run, fetched.output, context);
    return { kind: RUN_PHASE.RESULT, output: fetched.output, status: waited.status };
  }
}

async function deliverResult(run, { output, status }, context) {
  const { signal, delivery, consume, info } = context;
  signal?.throwIfAborted();
  // Cached results also have to settle their processes before replay.
  if (run.dormant !== true && !run.result.shutdownPending) {
    const stopped = await stopAndSleep(run, { ...context, unconfirmed: [] });
    if (stopped.failure) throw stopped.failure;
  }
  const text = output && !output.endsWith("\n") ? `${output}\n` : output;
  // A complete durable copy must precede stdout, including its recorded milestone.
  const resultFile = await writeDurableCopy(run, text, context);
  await printResult(run, text, resultFile, { ...context, ...delivery });
  await context.audit?.emit(AUDIT_TRANSITION.DELIVER, run);
  context.onOutcome?.({
    kind: OUTCOME.DELIVERED,
    status,
    keep: run.keepState || !resultFile || run.result.shutdownPending ? "yes" : "no",
    resultFile,
  });
  if (run.result.shutdownPending) {
    await context.warn(
      `Answer delivered; shutdown remains unconfirmed. State and writer/request claims are retained. Inspect the processes, then explicitly accept this uncertainty with --close ${run.runKey} --force. Workspace changes are not finalized.`,
    );
    await consume();
    return done(
      status === JOB_STATUS.COMPLETED || delivery.relay ? EXIT.COMPLETED : EXIT.NOT_COMPLETED,
    );
  }
  try {
    // The delivery callback may reveal a late job publication. Recheck shared
    // writer ownership before giving exclusion back; never lose delivered exit
    // status when that new evidence requires retaining the state.
    if (run.write && !run.scratchWorkspace && !run.worktree) await stopRunDriver(run, context);
    await releaseWriter(run, context);
  } catch (error) {
    run.dormant = false;
    context.save();
    await context.warn(`${error.message}; result and state retained until shutdown is confirmed`);
    return done(
      status === JOB_STATUS.COMPLETED || delivery.relay ? EXIT.COMPLETED : EXIT.NOT_COMPLETED,
    );
  }
  await consume();
  if (status !== JOB_STATUS.COMPLETED)
    await info(`Codex job ${run.jobId} ended with status ${status}.`);
  await settleRun(run, resultFile, context);
  return done(
    status === JOB_STATUS.COMPLETED || delivery.relay ? EXIT.COMPLETED : EXIT.NOT_COMPLETED,
  );
}

function runContext(invocation, opened, run) {
  const { stateDir, stateBase = invocation.stateBase, delivery = invocation.delivery } = opened;
  const { parentEnv, commandMs, signal, timing, warn, deadline } = invocation;
  return Object.freeze({
    ...invocation,
    stateBase,
    stateDir,
    delivery,
    info: quietInfo(warn, delivery.quiet),
    save: () => saveRun(run, stateDir),
    driver: createDriverClient(run, { stateDir, processes: invocation.processes, timing }),
  });
}

export async function runCommand(inputOptions, io) {
  const {
    parentEnv,
    cwd,
    stdout,
    signal,
    requireDurableCopy,
    script,
    paths,
    warn,
    timing = REAL_TIMING,
    processes = PROCESSES,
    audit,
    onOutcome,
  } = io;
  let run, stateDir, releaseRunLock;
  try {
    // Task directives normalize a private copy once. Routing after this point
    // returns outcomes and never rewrites the caller's mode or key.
    const options = { ...inputOptions };
    const delivery = {
      quiet: options.quiet ?? false,
      relay: options.relay ?? false,
      maxLines: options["max-stdout-lines"] ?? 0,
      maxBytes: options["max-stdout-bytes"] ?? 0,
    };
    const taskSource = prepareTask(options, cwd);
    const commandMs = options["command-timeout-ms"];
    const deadline = timing.now() + (options.mode === "cancel" ? 0 : options["wait-ms"]);
    let consumables =
      taskSource?.file && ["cancel", "close"].includes(options.mode)
        ? [{ file: taskSource.file, bytes: taskSource.bytes }]
        : [];
    const loadInput = (base) => {
      const input = loadPrompt(options, taskSource, base);
      consumables.push(...input.files);
      return input;
    };
    const consume = () => {
      const files = consumables;
      consumables = [];
      return consumeFiles(files, { keepPrompt: options["keep-prompt"], warn });
    };
    const keepOnlyTaskFile = () => {
      consumables = onlyTaskFile(consumables, taskSource);
    };
    // The invocation's context: what every phase reads and none changes. Its
    // delivery preferences and info diagnostics are the command line's, which
    // a replay of a durable copy keeps to, until a run is opened.
    const invocation = Object.freeze({
      ...paths,
      parentEnv,
      cwd,
      stdout,
      signal,
      requireDurableCopy,
      script,
      warn,
      delivery,
      commandMs,
      deadline,
      timing,
      processes,
      audit,
      onOutcome,
      info: quietInfo(warn, delivery.quiet),
      loadInput,
      consume,
      keepOnlyTaskFile,
      replay: async (copy, prefix) => {
        await audit?.emit(AUDIT_TRANSITION.ATTACH);
        const code = await replayCopy(copy, prefix, {
          stdout,
          ...delivery,
          commandMs,
          signal,
          onOutcome,
        });
        await audit?.emit(AUDIT_TRANSITION.DELIVER);
        keepOnlyTaskFile();
        await consume();
        return code;
      },
    });
    const opened = await prepareOrOpen(options, invocation);
    if (opened.kind === RUN_PHASE.DONE) return opened.code;
    ({ run, stateDir, releaseRunLock } = opened);
    validateRun(run, run.runKey, stateDir);
    const context = runContext(invocation, opened, run);
    const advanced = await advanceRun(options, opened, context);
    if (advanced.kind === RUN_PHASE.DONE) return advanced.code;
    const result = await obtainResult(options, run, context, {
      retry: opened.route.mode !== "cancel",
    });
    if (result.kind === RUN_PHASE.DONE) return result.code;
    return (await deliverResult(run, result, context)).code;
  } catch (error) {
    // An in-process collector gets the reason, as the error line says it.
    onOutcome?.({ kind: OUTCOME.FAILED, reason: error.message ?? String(error) });
    await audit?.emit(AUDIT_TRANSITION.ERROR, run);
    await warn(error.message ?? String(error));
    const code = error.code === CODES.LAUNCH_SETTLING ? EXIT.STILL_RUNNING : EXIT.FAILURE;
    if (
      run &&
      RUN_KEY.test(run.runKey) &&
      (run.jobId === null || validJobId(run.jobId)) &&
      stateDir
    ) {
      const next =
        error.recovery ??
        (run.result && !turnInTransition(run)
          ? `Inspect with --inspect ${run.runKey}; correct the refused command before retrying.`
          : `Recover with: ${resumeCommand(run, script)}`);
      await warn(`State retained at ${stateDir}. ${next}`);
    }
    return code;
  } finally {
    // The opened run's lock, which openRun or the launch handed over.
    if (releaseRunLock) await releaseWarned(releaseRunLock, warn);
  }
}
