// The end of a turn: waiting for the job, fetching its result, and the
// delivery in its fixed order: preserve the answer, stop owned processes,
// commit/capture the final workspace, write the durable copy and stdout, then
// release the writer lock and retain or clean up the settled run.

import fs from "node:fs";
import path from "node:path";
import { REAL_TIMING } from "../shared/timing.mjs";
import {
  MAX_OUTPUT_BYTES,
  TERMINAL,
  isGoneWorkerState,
  LAG_CONFIRMATIONS,
  LAG_RECHECK_MS,
  JOB_STATUS,
  JOB_READ_POLICY,
  DRIVER_POLL_MS,
  DRIVER_TEXT,
  SECOND_MS,
  QUOTA_SOURCE,
  CONTEXT_NOTE_PERCENT,
  CONTEXT_WARN_PERCENT,
} from "../shared/constants.mjs";
import { inspectDriver } from "../codex/driver-client.mjs";
import {
  readJob as readDirectJob,
  readTurn,
  readFinal,
  readEvents,
  readProgress,
} from "../state/job-store.mjs";
import { recoverJob } from "./recovery.mjs";
import {
  atomicWrite,
  digest,
  pathError,
  readLimited,
  requireDirectory,
  writeOutput,
} from "../shared/io.mjs";

import { stopAndSleep, teardown } from "./lifecycle.mjs";
import { PROCESSES } from "../shared/process-stop.mjs";
import {
  closeCommand,
  continueCommand,
  fitOutput,
  renderFooter,
  resultFileName,
  resumeCommand,
} from "../delivery/output.mjs";
import { protocolUsage } from "../delivery/usage.mjs";
import { cacheChanges } from "../delivery/changes.mjs";
import { rememberThread } from "../state/thread-owners.mjs";
import { threadName } from "../shared/thread-name.mjs";
import { structuredResult } from "../shared/output-schema.mjs";
import { quotaEntry } from "../codex/account.mjs";
import { writeQuotaCache } from "../state/quota-cache.mjs";
import { writeModelCache } from "../state/model-cache.mjs";
import { environmentPaths } from "../cli/options.mjs";
import { commitWorktree } from "../shared/workspace.mjs";
import { requireDurableDestination } from "../delivery/result-path.mjs";
import { CODES, RunnerError } from "../shared/errors.mjs";
import { recordArtifact } from "../state/artifact-store.mjs";

async function waitForDriverJob(run, { stateDir, deadline, signal, timing, processes }) {
  let suspicion = 0;
  for (;;) {
    signal?.throwIfAborted();
    const job = readDirectJob(stateDir, run.jobId, { policy: JOB_READ_POLICY.STRICT });
    if (!job) throw new RunnerError(CODES.SUBMISSION_UNCERTAIN, DRIVER_TEXT.UNCERTAIN);
    const events = readEvents(stateDir, run.jobId) ?? [];
    const snapshot = {
      job: {
        ...job.record,
        elapsed: `${Math.max(0, Math.round((Date.now() - Date.parse(job.record.startedAt)) / SECOND_MS))}s`,
        progressPreview: events.length ? [events.at(-1).method] : [],
        progress: readProgress(stateDir, run.jobId),
      },
    };
    if (job.turn) {
      if (!TERMINAL.has(job.turn.status))
        throw new RunnerError(CODES.SUBMISSION_UNCERTAIN, DRIVER_TEXT.UNCERTAIN);
      return { ended: true, status: job.turn.status, snapshot, stale: false, deadWorker: null };
    }
    const record = job.driver;
    if (
      run.worker?.jobId === run.jobId &&
      record &&
      (record.pid !== run.worker.pid || record.processStart !== run.worker.processStart)
    )
      throw new RunnerError(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.STOP);
    const state = inspectDriver(record, { processes, stateDir, timing });
    suspicion = isGoneWorkerState(state) ? suspicion + 1 : 0;
    if (suspicion >= LAG_CONFIRMATIONS)
      return {
        ended: true,
        status: JOB_STATUS.FAILED,
        snapshot,
        stale: false,
        deadWorker: record.pid ?? null,
        unstarted: record.pid == null,
      };
    if (suspicion) {
      await timing.sleep(LAG_RECHECK_MS, signal);
      continue;
    }
    if (timing.now() >= deadline) return { ended: false, snapshot };
    await timing.sleep(Math.min(DRIVER_POLL_MS, deadline - timing.now()), signal);
  }
}

// A terminal file or gone worker is only acted on after repeated observations;
// an ordinary active observation resets the existing confirmation counter. A
// worker is gone when its PID is dead or now held by another process (see
// inspectWorker); seen is a live PID the evidence shows to be the worker, for
// the caller to record (never one whose identity is unknown).

// The cached result of a run that already fetched its job's result, checked
// against the recorded checksum.
export function cachedResult(run, stateDir) {
  const cached = readLimited(path.join(stateDir, "result.txt"), MAX_OUTPUT_BYTES);
  if (digest(cached) !== run.result.sha256)
    throw new Error("cached result checksum mismatch; state retained");
  return cached.toString("utf8");
}

/** @param {import('../shared/types.mjs').RunRecord} run
 * @param {import('../shared/types.mjs').HelperContext & {deadline: number, warn: import('../shared/types.mjs').Diagnostic}} context
 * @returns {Promise<import('../shared/types.mjs').WaitOutcome>} */
export async function waitForJob(
  run,
  { stateDir, deadline, signal, timing = REAL_TIMING, processes = PROCESSES },
) {
  return waitForDriverJob(run, { stateDir, deadline, signal, timing, processes });
}

export async function settleDeadWorker(run, pid, context) {
  return recoverJob(run, context);
}

export async function fetchResult(run, waited, { stateDir }) {
  const turn = readTurn(stateDir, run.jobId, { policy: JOB_READ_POLICY.STRICT });
  if (!turn || !TERMINAL.has(turn.status))
    throw new RunnerError(CODES.SUBMISSION_UNCERTAIN, DRIVER_TEXT.UNCERTAIN);
  const output = readFinal(stateDir, run.jobId, {
    policy: JOB_READ_POLICY.STRICT,
    sha256: turn.finalSha256,
  });
  if (output === null) throw new RunnerError(CODES.SUBMISSION_UNCERTAIN, DRIVER_TEXT.UNCERTAIN);
  return {
    output,
    result: {
      status: turn.status,
      sha256: digest(output),
      threadId: turn.threadId ?? null,
      turnId: turn.turnId ?? null,
      durationMs: turn.durationMs ?? null,
      touchedFiles: (turn.touchedFiles ?? [])
        .filter((file) => typeof file === "string")
        .map((file) => file.replace(/[\x00-\x1f\x7f]/g, "?")),
      tokenUsage: turn.tokenUsage ?? null,
      usageBaseline: turn.usageBaseline ?? null,
      rateLimits: turn.rateLimits ?? null,
      error: turn.error ?? null,
      ...(turn.modelEvents ? { modelEvents: turn.modelEvents } : {}),
      ...(turn.progressWriteFailed ? { progressWriteFailed: true } : {}),
      ...(turn.compaction ? { compaction: turn.compaction } : {}),
    },
  };
}

// Caches the fetched result with the run: result.txt, the worktree's commit,
// the time of the fetch and Codex's own accounting for the turn (never fatal).
// The configured state root's quota cache learns the turn's last snapshot,
// as the driver saw it (it writes nothing outside its job folder).
function recordQuota(run, { stateDir, parentEnv }) {
  const turn = readTurn(stateDir, run.jobId);
  const entry = quotaEntry(turn?.rateLimits, {
    at: turn?.rateLimitsAt ?? turn?.completedAt,
    source: Object.values(QUOTA_SOURCE).includes(turn?.rateLimitsSource)
      ? turn.rateLimitsSource
      : QUOTA_SOURCE.TURN,
    ordinaryUsageAllowed: turn?.ordinaryUsageAllowed,
    resetCredits: turn?.resetCredits,
  });
  if (entry) writeQuotaCache(environmentPaths(parentEnv).stateBase, entry);
  // The catalogue a driver listed, for this run's CLI build only.
  if (turn?.modelCatalog?.build && turn.modelCatalog.build === run.codex?.build)
    writeModelCache(environmentPaths(parentEnv).stateBase, turn.modelCatalog);
  return turn;
}

export async function cacheResult(run, output, context) {
  const { stateDir, signal, save } = context;
  atomicWrite(path.join(stateDir, "result.txt"), output);
  save(); // Preserve terminal evidence even when shutdown or Git fails.
  const stopped = await stopAndSleep(run, { ...context, unconfirmed: [] });
  if (stopped.failure) throw stopped.failure;
  if (run.outputSchema !== undefined) run.result.schema = structuredResult(output).status;
  if (run.worktree && !run.result.shutdownPending)
    run.result.commit = await commitWorktree(run, `turn ${(run.turns?.length ?? 0) + 1}`, {
      signal,
      env: context.parentEnv,
    });
  if (!run.result.shutdownPending) await cacheChanges(run, context);
  // deliveredAt is when the result was fetched (kept for --list and the
  // sweeps); cachedAt says so too, and durableSavedAt and acknowledgedAt
  // record what actually reached a copy or a caller.
  run.result.deliveredAt = run.result.cachedAt = new Date().toISOString();
  try {
    run.result.usage = protocolUsage(
      run.result.tokenUsage,
      run.result.rateLimits,
      run.result.usageBaseline ?? null,
    );
  } catch {
    run.result.usage = null;
  }
  if (!run.result.shutdownPending) run.result.finalizedAt = new Date().toISOString();
  save();
  try {
    rememberThread(run, context, {
      threadId: run.result.threadId,
      name: threadName(run.runKey, run.model) ?? "",
    });
  } catch {
    /* Receipt storage must not block result delivery. */
  }
  let turn = null;
  try {
    turn = recordQuota(run, context);
  } catch {
    /* A cache never blocks a delivery. */
  }
  if (typeof turn?.modelNotice === "string")
    await context.warn(turn.modelNotice.replace(/[\x00-\x1f\x7f]/g, " "));
  if (run.result.progressWriteFailed)
    await context.warn(
      "Progress storage failed during this turn; use --diff diagnostics and review the workspace or committed branch.",
    );
  if (turn?.threadNameFailed)
    await context.warn(
      "The Codex thread could not be named; its run and thread IDs remain available in the result.",
    );
  // A kept thread near its context window: a follow-up may compact or fail.
  const percent = run.result.usage?.context?.percent;
  if (run.keepState && Number.isFinite(percent) && percent >= CONTEXT_NOTE_PERCENT)
    await (percent >= CONTEXT_WARN_PERCENT ? context.warn : context.info)(
      `Run ${run.runKey}'s Codex thread is ${percent}% of its context window; a follow-up may compact or fail with ${CODES.CODEX_CONTEXT_FULL}. Start a new run for long follow-ups.`,
    );
}

// The durable copy: the complete text with its footer under the results
// directory, written before stdout sees anything, so a broken pipe or a
// failed hook stays recoverable. Returns its path, or null when it could not
// be written; with requireDurableCopy that failure retains the run instead.
export async function writeDurableCopy(
  run,
  text,
  { resultsDir, stateDir, requireDurableCopy, save, warn },
) {
  let resultFile = null;
  const previousJsonFile = run.result.jsonFile;
  let published = false;
  let destination = run.result.resultFile ?? null;
  try {
    if (destination) {
      try {
        requireDurableDestination(destination, run, stateDir);
      } catch (error) {
        if (error.code !== CODES.UNSAFE_RESULT_DESTINATION) throw error;
        // A changed record or path may point inside the cleanup tree. Keep
        // explicit recovery through a corrected results directory safe.
        destination = null;
      }
    }
    destination ??= path.join(resultsDir, resultFileName(run));
    requireDurableDestination(destination, run, stateDir);
    if (run.outputSchema !== undefined) {
      const structured = structuredResult(text);
      run.result.schema = structured.status;
      delete run.result.jsonFile;
      if (structured.text !== null) {
        const jsonFile = `${destination}.result.json`;
        requireDurableDestination(jsonFile, run, stateDir);
        fs.mkdirSync(path.dirname(jsonFile), { recursive: true, mode: 0o700 });
        requireDurableDestination(jsonFile, run, stateDir);
        atomicWrite(jsonFile, structured.text);
        run.result.jsonFile = jsonFile;
      }
    }
    const directory = path.dirname(destination);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    requireDirectory(directory);
    requireDurableDestination(destination, run, stateDir);
    atomicWrite(destination, `${text}${renderFooter(run, destination)}`);
    published = true; // Markdown is the completion marker for the optional pair.
    resultFile = run.result.resultFile = destination;
    run.result.durableSavedAt ??= new Date().toISOString();
    save();
  } catch (error) {
    if (!published) {
      if (previousJsonFile === undefined) delete run.result.jsonFile;
      else run.result.jsonFile = previousJsonFile;
      // A partial sidecar is recoverable at this deterministic destination.
      // Never expose it as a completed pair or erase a pre-existing artifact.
      try {
        save();
      } catch {
        /* Retain the original publication failure. */
      }
    }
    const explanation = pathError(
      error,
      destination ?? resultsDir,
      destination
        ? "result file (CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR)"
        : "results directory (CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR)",
    ).message;
    if (requireDurableCopy)
      throw new Error(`durable copy not written (${explanation}); run retained`);
    await warn(
      `Could not write the durable result copy: ${explanation}; run retained, fix the directory and attach again.`,
    );
  }
  return resultFile;
}

// Prints the result and records that stdout accepted it. Only what stdout
// shows is cut, and only when the complete text is safe in the durable copy
// that the omission line points to.
export async function printResult(
  run,
  text,
  resultFile,
  { stdout, maxLines, maxBytes, commandMs, signal, save },
) {
  await writeOutput(
    stdout,
    fitOutput(text, {
      maxLines,
      maxBytes,
      resultFile,
      footer: (omitted) => renderFooter(run, resultFile, omitted),
    }),
    { signal, timeoutMs: commandMs },
  );
  run.result.acknowledgedAt ??= new Date().toISOString();
  save();
}

export async function settleRun(run, resultFile, context) {
  const { stateDir, warn, script, info } = context;
  if (resultFile && run.worktree) {
    try {
      await recordArtifact(run, context);
    } catch (error) {
      await warn("Artifact receipt not saved; run retained: " + error.message);
      return;
    }
  }
  if (run.keepState || !resultFile) {
    let asleep = run.dormant === true;
    if (!asleep) {
      // The shared stop-and-record (stopAndSleep); this caller only warns.
      const slept = await stopAndSleep(run, context);
      try {
        if (slept.failure) throw slept.failure;
        asleep = true;
      } catch (error) {
        await warn(
          `${error.message}; the kept run's Codex processes stay up until --sleep or --close.`,
        );
      }
    }
    if (!resultFile) {
      await warn(
        `State kept at ${stateDir}: without a durable copy this run's cached result is the only one` +
          `${run.requestId ? `, and it keeps request ${run.requestId} deduplicated` : ""}. Re-read: ${resumeCommand(run, script)}  Close: ${closeCommand(run, script)}`,
      );
    } else {
      await info(
        `State kept at ${stateDir}${asleep ? "; its Codex processes are stopped until the next turn" : ""}. ` +
          `Continue: ${continueCommand(run, script)}  Close: ${closeCommand(run, script)}`,
      );
    }
    return;
  }
  try {
    await teardown(run, { ...context, force: false });
  } catch (error) {
    await warn(
      `Cleanup incomplete: ${error.message}. Result and state retained at ${stateDir}. Retry: ${resumeCommand(run, script)}`,
    );
  }
}
