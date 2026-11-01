import { BRANCH_SUFFIX_CHARS } from "../shared/constants.mjs";
// Launch and continuation. A new run claims its request ID first, then
// writes its run record, then takes its writer lock or creates its worktree,
// and only then starts its job; a continued turn records its reservation
// before taking the writer lock, and copies the finished turn's files before
// the record switches to the new turn.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  LAUNCH_OUTCOME,
  AUDIT_TRANSITION,
  LAUNCH_SETTLE_MS,
  LOST_JOB,
  RUN_FOLDER_REMOVAL,
  RUN_KEY,
  SESSION_ID,
  WORKER_STATE,
  CLAIM_RETRY_MS,
  REQUEST_DIGEST_VERSION,
  REQUEST_TEXT,
  BACKEND,
  MCP_MODE,
  PROGRESS_MODE,
  DRIVER_PROTOCOL_VERSION,
  DRIVER_TEXT,
  RUN_RECORD_VERSION,
  CODEX_IDENTITY_FIELDS,
  FORK_STATE,
} from "../shared/constants.mjs";
import { selectCodex as selectDirectCodex, requireSupportedCodex } from "../codex/cli.mjs";
import { spawnDriver, inspectDriver } from "../codex/driver-client.mjs";
import { defaultQuotaFloor, environmentPaths } from "../cli/options.mjs";
import { readModelCache } from "../state/model-cache.mjs";
import { readDriver, unownedJobs as unownedDriverJobs } from "../state/job-store.mjs";
import { alive, atomicWrite, digest, requireDirectory } from "../shared/io.mjs";
import { continueCommand, findResultsByRequestId, resumeCommand } from "../delivery/output.mjs";
import { noteWorker, ownerAlive } from "../shared/process-identity.mjs";
import {
  acquireLock,
  acquireWriterLock,
  claimRequest,
  markRequestClaimPossibleLive,
  releaseRequestClaim,
  releaseWriterLock,
  isDelivered,
} from "../state/state.mjs";
import { CODES, RunnerError } from "../shared/errors.mjs";
import { createRecord, saveRun } from "../state/run-store.mjs";
import { peekRun } from "../state/run-record.mjs";
import {
  confirmTurnJob,
  reserveTurn,
  rollBackTurnRecord,
  switchTurn,
  unreserveTurn,
} from "../state/turn-transition.mjs";
import { REAL_TIMING } from "../shared/timing.mjs";
import { createWorktree, gitToplevel } from "../shared/workspace.mjs";
import { PROCESSES } from "../shared/process-stop.mjs";
import { isForkSeed } from "../shared/fork.mjs";

const modeLabel = (write) => (write ? "workspace-write" : "read-only");
const unsupportedRequestDigest = (id) =>
  new Error(`request ${id} ${REQUEST_TEXT.UNSUPPORTED_DIGEST}`);

// The exact identity claimed for a launch. Batch coordination uses the same
// builder so ownership checks cannot drift from launch replay semantics.
export function launchRequestIdentity(options, promptSha256, base) {
  const version = REQUEST_DIGEST_VERSION;
  return {
    version,
    digest: digest(
      JSON.stringify({
        version,
        promptSha256,
        model: options.model,
        effort: options.effort,
        write: Boolean(options.write),
        workspace: options["scratch-workspace"] ? null : base,
        scratch: Boolean(options["scratch-workspace"]),
        worktree: Boolean(options.worktree),
        worktreeRef: options["worktree-ref"] ?? null,
        backend: BACKEND.DRIVER,
        ...(options.forkedFrom ? { forkedFrom: options.forkedFrom } : {}),
        mcp: options.mcp ?? MCP_MODE.INHERIT,
        progress: options.progress ?? PROGRESS_MODE.ON,
        ...(options.summary !== undefined ? { summary: options.summary } : {}),
        ...(options["quota-floor"] !== undefined ? { quotaFloor: options["quota-floor"] } : {}),
        ...(options.review !== undefined ? { review: options.review } : {}),
        ...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
        ...(options.tier !== undefined ? { tier: options.tier } : {}),
        ...(options.commitSubject !== undefined ? { commitSubject: options.commitSubject } : {}),
        ...(options.commitTrailers !== undefined ? { commitTrailers: options.commitTrailers } : {}),
      }),
    ),
  };
}

async function releaseUndispatchedClaim(
  { stateBase, id, key, timing = REAL_TIMING, warn },
  beforeRelease = () => {},
) {
  if (!id) {
    await beforeRelease();
    return true;
  }
  // The claim's undispatched phase was durable before run creation. Remove any
  // recorded run before giving that claim back; an interruption remains safe.
  await beforeRelease();
  const released = await releaseRequestClaim(stateBase, id, key, { timing });
  if (!released)
    await warn?.(
      `The claim of request ${id} stayed busy after an undispatched launch; its durable ownership was retained.`,
    );
  return released;
}

// Launches a new run for prompt in the workspace base. Returns one of
//   { kind: LAUNCH_OUTCOME.PREPARED, run, stateDir, releaseRunLock }: the run is recorded and
//     locked (releaseRunLock frees the lock); its job is not started yet;
//   { kind: LAUNCH_OUTCOME.ATTACH, key }: a repeated request ID names a retained run;
//   { kind: LAUNCH_OUTCOME.REPLAY, copy }: the request was delivered earlier; replay its
//     durable copy;
//   { kind: LAUNCH_OUTCOME.WAITING, key }: the budget ended while another launcher of the
//     same request was still starting (key: its run, when known).
// A failure gives back what this attempt still owns: the run lock, which only
// the prepared outcome hands to the caller, the request claim until the
// recorded run takes it over, and the run folder until its record is written.
// A recorded run stays for --run and --close.
// delivery holds the quiet, relay, maxLines and maxBytes preferences the run
// records so a later attach behaves like the launch.
/** @param {object} options @param {Buffer} prompt @param {import('../shared/types.mjs').LaunchContext} context
 * @returns {Promise<import('../shared/types.mjs').LaunchOutcome>} */
export async function launchRun(options, prompt, context) {
  const { base, stateBase, parentEnv, commandMs, signal } = context;
  const codex = requireSupportedCodex(
    await selectDirectCodex(parentEnv, base, commandMs, signal),
    parentEnv,
  );
  const key = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(stateBase, { recursive: true, mode: 0o700 });
  requireDirectory(stateBase);
  if (options["scratch-workspace"]) {
    const repo = gitToplevel(stateBase);
    if (repo)
      throw new Error(
        `the state root ${stateBase} lies inside the git repository ${repo}, so a scratch workspace would run in that repository; set CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR outside any repository`,
      );
  }
  return resolveLaunchRequest(options, prompt, { ...context, codex, key });
}

// A repeated request whose claim another launcher holds: what to do now, or
// null to wait. The claimant's run is attached once its record names a job
// (or a result, or the claimant is gone and --run must recover it), so a
// waiter that outlives that run still knows which copy to replay; a matching
// durable copy is replayed. A claimant that ended before it recorded its run
// is not a race, and is reported. A claimant whose PID another process holds
// now (its recorded start time differs) is gone too.
function joinClaimant(owner, { id, sameTask, stateBase, resultsDir }) {
  if (!owner) return null; // The claim is still being written.
  if (owner.digestVersion !== REQUEST_DIGEST_VERSION) throw unsupportedRequestDigest(id);
  if (!sameTask(owner.digestVersion, owner.promptSha256)) {
    throw new Error(
      `request ${id} was already used for a different task (prompt, model, effort, write mode or workspace); choose a new request ID`,
    );
  }
  const claimant = Number.isSafeInteger(owner.pid) && owner.pid > 0 && ownerAlive(owner);
  const run = RUN_KEY.test(owner.runKey ?? "")
    ? peekRun(path.join(stateBase, owner.runKey), owner.runKey)
    : null;
  if (run && (run.jobId || run.result || run.forkedFrom || !claimant))
    return { kind: LAUNCH_OUTCOME.ATTACH, key: owner.runKey };
  const copy = findResultsByRequestId(resultsDir, id).find((entry) =>
    sameTask(entry.version, entry.digest),
  );
  if (copy) return { kind: LAUNCH_OUTCOME.REPLAY, copy: copy.file };
  if (run || claimant) return null;
  throw new Error(
    `request ${id} was claimed by process ${owner.pid ?? "?"}, which ended before it recorded its run; inspect ${path.join(stateBase, "requests", `${id}.lock`)} and that run before choosing a new request ID`,
  );
}

// The claim belongs to this attempt until createRun publishes both initial
// files. A replay or any earlier failure releases it in this scope.
async function resolveLaunchRequest(options, prompt, context) {
  const {
    base,
    key,
    stateBase,
    resultsDir,
    signal,
    info,
    warn,
    timing = REAL_TIMING,
    deadline = 0,
  } = context;
  // A repeated request never starts a second job: its ID is claimed before
  // anything else, so a repeat joins the retained run or replays the durable
  // copy of a finished one, and the same ID with another task is refused.
  const id = options["request-id"];
  // The current full digest covers every setting that changes the task.
  const requestDigest = launchRequestIdentity(options, digest(prompt), base).digest;
  const sameTask = (version, value) =>
    version === REQUEST_DIGEST_VERSION && value === requestDigest;
  let claimed = false;
  try {
    if (id) {
      // Another launcher of the same request may hold the claim while it is
      // still starting: wait for it within the budget, then attach or replay.
      for (let waited = false; ; waited = true) {
        const claim = claimRequest(stateBase, id, key, requestDigest);
        if (claim.claimed) break;
        const joined = joinClaimant(claim.owner, {
          id,
          sameTask,
          stateBase,
          resultsDir,
        });
        if (joined?.kind === LAUNCH_OUTCOME.ATTACH)
          await info(`Request ${id} is run ${joined.key}; attaching instead of launching.`);
        if (joined) return joined;
        if (timing.now() >= deadline)
          return { kind: LAUNCH_OUTCOME.WAITING, key: claim.owner?.runKey ?? null };
        if (!waited)
          await info(`Request ${id} is being launched by another process; waiting for it.`);
        await timing.sleep(Math.max(1, Math.min(CLAIM_RETRY_MS, deadline - timing.now())), signal);
      }
      claimed = true;
      const copies = findResultsByRequestId(resultsDir, id);
      const same = copies.filter((entry) => sameTask(entry.version, entry.digest)).at(-1);
      if (same) {
        await releaseUndispatchedClaim({
          stateBase,
          id,
          key,
          timing,
          warn,
        });
        claimed = false;
        return { kind: LAUNCH_OUTCOME.REPLAY, copy: same.file };
      }
      if (copies.length)
        throw new Error(
          `request ${id} was already used for a different task (prompt, model, effort, write mode or workspace); choose a new request ID`,
        );
    }
    return await createRun(options, prompt, {
      ...context,
      id,
      requestDigest,
      transferClaim: () => {
        claimed = false;
      },
    });
  } finally {
    if (claimed)
      await releaseUndispatchedClaim({
        stateBase,
        id,
        key,
        timing,
        warn,
      });
  }
}

// Run creation owns its run lock until the prepared outcome hands it over, and
// its run folder until the record is written: nothing refers to a folder
// without a record (--list shows it as no-metadata, --close refuses it), so a
// failure before then removes it.
async function createRun(options, prompt, context) {
  const {
    base,
    key,
    stateBase,
    parentEnv,
    codex,
    delivery,
    signal,
    script,
    info,
    warn,
    timing,
    id,
    requestDigest,
    transferClaim,
  } = context;
  let releaseRunLock = null,
    unrecorded = null;
  try {
    const stateDir = path.join(stateBase, key);
    fs.mkdirSync(stateDir, { mode: 0o700 }); // Exclusive: never reuse another run.
    unrecorded = stateDir;
    releaseRunLock = acquireLock(stateBase, key);
    // A scratch workspace keeps repository-free tasks away from this
    // folder's AGENTS.md and files; a worktree isolates a write job on its
    // own branch. Both live and die with the run's state.
    const workspace = options["scratch-workspace"]
      ? path.join(stateDir, "workspace")
      : options.worktree
        ? path.join(stateDir, "worktree")
        : base;
    if (options["scratch-workspace"]) fs.mkdirSync(workspace, { mode: 0o700 });
    const session = (name) => (SESSION_ID.test(parentEnv[name] ?? "") ? parentEnv[name] : null);
    const run = {
      version: RUN_RECORD_VERSION,
      runKey: key,
      jobId: null,
      cwd: workspace,
      model: options.model,
      effort: options.effort,
      write: options.write,
      keepState: options["keep-state"],
      scratchWorkspace: options["scratch-workspace"],
      quiet: delivery.quiet,
      relay: delivery.relay,
      maxStdoutLines: delivery.maxLines,
      maxStdoutBytes: delivery.maxBytes,
      turns: [],
      session: session("CLAUDE_CODE_SESSION_ID"),
      hostSession: session("CLAUDE_CODE_HOST_SESSION_ID"),
      createdAt: new Date().toISOString(),
      backend: BACKEND.DRIVER,
      codex,
      driverProtocol: DRIVER_PROTOCOL_VERSION,
      ...(options.forkedFrom
        ? {
            forkedFrom: options.forkedFrom,
            forkSeed: true,
            forkState: FORK_STATE.PREPARED,
            forkRedaction: true,
          }
        : {}),
      mcp: options.mcp ?? MCP_MODE.INHERIT,
      ...(options["quota-floor"] !== undefined ? { quotaFloor: options["quota-floor"] } : {}),
      ...(options.progress !== undefined ? { progress: options.progress } : {}),
      ...(options.summary !== undefined ? { summary: options.summary } : {}),
      ...(options.review !== undefined ? { review: options.review } : {}),
      ...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
      ...(options.tier !== undefined ? { tier: options.tier } : {}),
      ...(options.commitSubject !== undefined ? { commitSubject: options.commitSubject } : {}),
      ...(options.commitTrailers !== undefined ? { commitTrailers: options.commitTrailers } : {}),
    };
    context.audit?.bind(run);
    if (id) {
      run.requestId = id;
      run.requestDigest = requestDigest;
      run.requestDigestVersion = REQUEST_DIGEST_VERSION;
    }
    // A write job gets its own branch; a read-only one a detached snapshot.
    if (options.worktree)
      run.worktree = {
        base,
        branch: options.write ? `csfcc/${key.slice(0, BRANCH_SUFFIX_CHARS)}` : null,
        startRef: options["worktree-ref"] ?? "HEAD",
        startCommit: null,
      };
    // The record exists before a writer lock or worktree names this run, so
    // a writer lock owner without a record is always a finished run. (The
    // request claim and the run lock come first and promise no such thing.)
    createRecord(run, stateDir);
    unrecorded = null; // from here the folder stays for --run and --close
    atomicWrite(path.join(stateDir, "prompt.txt"), prompt);
    transferClaim(); // from here the claim belongs to the recorded run
    try {
      if (run.worktree) {
        await createWorktree(run, workspace, { signal, save: () => saveRun(run, stateDir) });
      } else if (run.write && !run.scratchWorkspace)
        // All writers coordinate in this invocation’s configured state root.
        acquireWriterLock(stateBase, base, key);
    } catch (error) {
      if (error.worktreeRecoveryRequired) {
        saveRun(run, stateDir);
        throw new Error(
          `${error.message}; state retained for run ${key}. Inspect with --inspect ${key} before retrying cleanup with --close ${key}`,
          { cause: error },
        );
      }
      // Nothing was launched: leave no trace of this attempt (the run lock
      // goes below).
      await releaseUndispatchedClaim({ stateBase, id: run.requestId, key, timing, warn }, () =>
        fs.rmSync(stateDir, { recursive: true, force: true }),
      );
      throw error;
    }
    if (
      run.requestId &&
      !(await markRequestClaimPossibleLive(stateBase, run.requestId, key, requestDigest, {
        signal,
        timing,
      }))
    )
      throw new Error(
        `request ${run.requestId} claim stayed busy before dispatch; state retained for run ${key}`,
      );
    await info(
      `Run ${key}; Codex ${codex.version}; ${modeLabel(run.write)}${run.scratchWorkspace ? "; scratch workspace" : ""}` +
        `${run.worktree ? `; worktree ${run.worktree.branch ? `on ${run.worktree.branch}` : "snapshot (detached, read-only)"} from ${run.worktree.startRef} (${run.worktree.startCommit})` : ""}` +
        `${run.keepState ? "; kept after its result" : ""}.`,
    );
    await info(`Recover this run with: ${resumeCommand(run, script)}`);
    const prepared = { kind: LAUNCH_OUTCOME.PREPARED, run, stateDir, releaseRunLock };
    releaseRunLock = null; // the caller releases the run lock from here
    return prepared;
  } catch (error) {
    // Still under the run lock, when it was taken; the finally releases it.
    if (unrecorded) {
      try {
        fs.rmSync(unrecorded, { recursive: true, force: true, ...RUN_FOLDER_REMOVAL });
      } catch (cleanupError) {
        await warn(
          `Could not remove the run folder ${unrecorded}, which has no record: ${cleanupError.message}`,
        );
      }
    }
    throw error;
  } finally {
    if (releaseRunLock) {
      try {
        releaseRunLock();
      } catch (error) {
        await warn(`Could not release run lock: ${error.message}`);
      }
    }
  }
}

export function checkContinue(options, run) {
  if (run.sealed) throw new Error("run artifact is finalized; start a new run or fork its context");
  if (run.forkSeed && run.continuing)
    throw new Error(
      "the fork's first turn is reserved; collect or reconcile it with --run before continuing",
    );
  if (run.forkedFrom && run.forkState !== FORK_STATE.READY)
    throw new Error("fork dispatch is unconfirmed; no turn may be sent");
  if (run.forkedFrom && options.write && !run.worktree && !run.scratchWorkspace)
    throw new Error("a shared-checkout fork stays read-only; start a fresh worktree write run");
  if (run.historyOperation)
    throw new Error("history mutation is unconfirmed; reconcile with --revert before continuing");
  if (run.driverProtocol !== DRIVER_PROTOCOL_VERSION)
    throw new RunnerError(CODES.DRIVER_PROTOCOL_MISMATCH, DRIVER_TEXT.PROTOCOL);
  const model = options.model ?? run.model,
    effort = options.effort ?? run.effort;
  if (!model || !effort)
    throw new Error("this run did not record its model and effort; pass --model and --effort");
  if (options.write && run.worktree && !run.worktree.branch) {
    throw Object.assign(
      new Error(
        "this run reads a detached read-only snapshot; start a new write job instead of continuing it with write",
      ),
      {
        recovery:
          "Start a new job with --worktree --write and a prompt file, or continue this run without --write.",
      },
    );
  }
  return { model, effort };
}

// Turns a delivered run into the next turn on its Codex thread: the run is
// reserved (continuing) before the writer lock is taken, the finished turn's
// files are copied before the record switches, and the new prompt is stored.
// Returns true when the request ID names the turn already in progress, so
// the caller attaches to it instead of starting another one.
export async function prepareContinue(
  options,
  run,
  prompt,
  { model, effort },
  { stateBase, stateDir, save, info, script },
) {
  // A request ID makes a turn retry-safe: repeating it attaches to that turn
  // or re-delivers it instead of adding another one.
  const turnId = options["request-id"];
  const turnDigest = turnId
    ? digest(
        JSON.stringify({
          version: REQUEST_DIGEST_VERSION,
          promptSha256: digest(prompt),
          model,
          effort,
          write: Boolean(options.write),
          mcp: options.mcp ?? run.mcp ?? MCP_MODE.INHERIT,
          progress: options.progress ?? run.progress ?? PROGRESS_MODE.ON,
          ...((options.summary ?? run.summary) ? { summary: options.summary ?? run.summary } : {}),
          ...(options.review !== undefined ? { review: options.review } : {}),
          ...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
          ...(options.tier !== undefined ? { tier: options.tier } : {}),
          ...(options.compact ? { compact: true } : {}),
          ...(options["quota-floor"] !== undefined ? { quotaFloor: options["quota-floor"] } : {}),
          ...(options.commitSubject !== undefined ? { commitSubject: options.commitSubject } : {}),
          ...(options.commitTrailers !== undefined
            ? { commitTrailers: options.commitTrailers }
            : {}),
        }),
      )
    : undefined;
  const earlier = turnId ? (run.turns ?? []).findIndex((turn) => turn.requestId === turnId) : -1;
  if (turnId && run.turnRequestId === turnId) {
    if (run.turnRequestDigest !== turnDigest)
      throw new Error(
        `request ${turnId} was already used for a different turn of run ${run.runKey}; choose a new request ID`,
      );
    await info(
      `Request ${turnId} is turn ${(run.turns?.length ?? 0) + 1} of run ${run.runKey}; attaching instead of starting another turn.`,
    );
    return true;
  }
  if (earlier >= 0) {
    throw new Error(
      `request ${turnId} was turn ${earlier + 1} of run ${run.runKey}, which has later turns since; choose a new request ID`,
    );
  }
  if (
    !isForkSeed(run) &&
    (!isDelivered(run) || run.dormant !== true || run.result?.shutdownPending)
  )
    throw new Error(
      "the current job has no delivered and stopped result yet; attach with --run before continuing",
    );
  if (
    (options.commitSubject !== undefined || options.commitTrailers !== undefined) &&
    !run.worktree
  )
    throw new Error("commit metadata requires a write worktree turn");
  // Reserve the run before anything else sees it: a continuing run stays
  // active for writer-lock purposes even while its last result is present.
  reserveTurn(run, save);
  if (options.write && !run.scratchWorkspace && !run.worktree) {
    try {
      acquireWriterLock(stateBase, run.cwd, run.runKey);
    } catch (error) {
      // A definite refusal before anything launched: give the reservation
      // back, so the run stays an idle, delivered run.
      unreserveTurn(run, save);
      throw error;
    }
  }
  const index = switchTurn(
    run,
    stateDir,
    prompt,
    {
      model,
      effort,
      write: options.write,
      review: options.review,
      outputSchema: options.outputSchema,
      commitSubject: options.commitSubject,
      commitTrailers: options.commitTrailers,
      tier: options.tier,
      compact: Boolean(options.compact),
      requestId: turnId,
      requestDigest: turnDigest,
    },
    save,
  );
  if (options.mcp !== undefined) {
    run.mcp = options.mcp;
    save();
  }
  if (options.progress !== undefined) {
    run.progress = options.progress;
    save();
  }
  if (options.summary !== undefined) {
    run.summary = options.summary;
    save();
  }
  if (options["quota-floor"] !== undefined) {
    run.quotaFloor = options["quota-floor"];
    save();
  }
  await info(`Run ${run.runKey}: turn ${index + 1} on its Codex thread; ${modeLabel(run.write)}.`);
  await info(`Recover this run with: ${resumeCommand(run, script)}`);
  return false;
}

export async function rollBackTurn(run, { stateBase, stateDir, save, signal, timing, warn }) {
  // The record and the turn's files go back first (turn-transition.mjs), then
  // a writer lock the turn took.
  const undone = rollBackTurnRecord(run, stateDir, save);
  if (!undone) return false;
  if (
    undone.writer &&
    !(await releaseWriterLock(stateBase, run.cwd, run.runKey, { signal, timing })) &&
    undone.reportBusy
  )
    await warn(
      "The writer lock stayed busy; it belongs to a delivered run and the next writer reclaims it.",
    );
  return true;
}

// What a rolled-back turn tells the caller: the turn was not started, and the
// same --continue can be repeated.
export function turnNotStarted(run, script, cause) {
  if (isForkSeed(run))
    return new RunnerError(
      CODES.TURN_NOT_STARTED,
      `${cause ? `${cause}; ` : ""}the fork's first turn was not started; its context is ready and --continue ${run.runKey} can be repeated`,
      { recovery: `Repeat the turn with: ${continueCommand(run, script)}` },
    );
  const delivered = (run.turns?.length ?? 0) + 1;
  return new RunnerError(
    CODES.TURN_NOT_STARTED,
    `${cause ? `${cause}; ` : ""}turn ${delivered + 1} of run ${run.runKey} was not started` +
      `${cause ? "" : ": its launch failed before a driver job was recorded"}, so the run is back at its delivered turn ${delivered}, and --continue ${run.runKey} can be repeated`,
    { recovery: `Repeat the turn with: ${continueCommand(run, script)}` },
  );
}

export async function startJob(
  run,
  { resume, stateDir, save, info, script, parentEnv, commandMs, signal, processes = PROCESSES },
) {
  const codex = requireSupportedCodex(
    await selectDirectCodex(parentEnv, run.cwd, commandMs, signal),
    parentEnv,
  );
  if (run.codex && [...CODEX_IDENTITY_FIELDS].some((key) => codex[key] !== run.codex[key]))
    throw new RunnerError(CODES.CODEX_UNSUPPORTED, DRIVER_TEXT.CLI_CHANGED);
  try {
    await spawnDriver(
      {
        runKey: run.runKey,
        cwd: run.cwd,
        codex,
        model: run.model,
        effort: run.effort,
        write: Boolean(run.write),
        mcp: run.mcp ?? MCP_MODE.INHERIT,
        progress: run.progress,
        summary: run.summary,
        review: run.review,
        outputSchema: run.outputSchema,
        tier: run.tier,
        compact: run.compact,
        forkRedaction: run.forkRedaction,
        redactionHistory: (run.turns ?? []).map((turn, index) => ({
          turn: index + 1,
          jobId: turn.jobId,
        })),
        quotaFloor: Number.isInteger(run.quotaFloor)
          ? run.quotaFloor
          : defaultQuotaFloor(parentEnv),
        // Today's catalogue of this CLI build, when the state root has one.
        models: readModelCache(environmentPaths(parentEnv).stateBase, codex.build)?.models ?? null,
        threadId: resume
          ? (run.turns?.at(-1)?.result?.threadId ?? run.contextThreadId ?? null)
          : null,
        // Native totals survive resume. Fork inheritance and missing counters
        // stay unknown unless the resumed server supplies a fresh baseline.
        usageBaseline: resume ? (run.turns?.at(-1)?.result?.tokenUsage?.total ?? null) : undefined,
      },
      {
        stateDir,
        env: parentEnv,
        processes,
        onSpawn: ({ pid }) => {
          run.launching = { pid, processStart: null, at: new Date().toISOString() };
          save();
        },
        onIdentity: (worker) => {
          confirmTurnJob(run, worker.jobId);
          run.worker = worker;
          run.launching.processStart = worker.processStart;
          save();
        },
      },
    );
  } finally {
    if (run.launching) {
      delete run.launching;
      save();
    }
  }
  await info(
    `Codex job ${run.jobId} started: ${run.model}, effort ${run.effort}. Resume: ${resumeCommand(run, script)}`,
  );
  return;
}

export async function confirmJob(
  run,
  jobId,
  { stateDir, save, processes = PROCESSES },
  indexed = null,
) {
  confirmTurnJob(run, jobId);
  const record = readDriver(stateDir, jobId) ?? indexed;
  if (inspectDriver(record, { processes }) === WORKER_STATE.WORKER)
    noteWorker(run, record.pid, record.processStart);
  save();
  return;
}

// Whether a launch this run recorded may still be creating its job: the
// launch helper (run.launching) began less than LAUNCH_SETTLE_MS ago and its
// PID still holds the process recorded then. An empty job list proves that
// nothing was launched only once that helper has gone.
export function launchSettling(run, { probe = PROCESSES.probe } = {}) {
  const launching = run.launching;
  if (!launching || !(Date.now() - Date.parse(launching.at) < LAUNCH_SETTLE_MS)) return false;
  if (!alive(launching.pid)) return false;
  if (typeof launching.processStart !== "string") return true;
  const start = probe.start(launching.pid);
  return start === null || start === launching.processStart;
}

// The refusal while launchSettling: exit 3, as for a job still running.
export function launchStillSettling(run) {
  return new RunnerError(
    CODES.LAUNCH_SETTLING,
    `launch still settling; retry in a moment (its helper, process ${run.launching.pid}, may still be creating run ${run.runKey}'s job)`,
  );
}

// The candidate job of a run whose launch response was lost, identified once
// for every command that looks for it (--run, --cancel and --close): what
// findLostJob found (one job, none, or several), except that an empty listing
// while the launch helper the run recorded may still be creating the job
// (launchSettling) is no answer: LAUNCH_SETTLING is thrown. A listing that
// fails throws too. Each caller keeps its own policy for the answer and makes
// its own record of the job: the waiter and --cancel confirm it as a launch
// does (confirmJob), --close records the job alone (confirmTurnJob).
export async function lostJobCandidate(run, { probe, stateDir }) {
  const jobs = unownedDriverJobs(stateDir, run);
  const found =
    jobs.length === 1
      ? { kind: LOST_JOB.FOUND, job: jobs[0] }
      : { kind: jobs.length ? LOST_JOB.AMBIGUOUS : LOST_JOB.NONE, count: jobs.length };
  if (found.kind === LOST_JOB.NONE && launchSettling(run, { probe }))
    throw launchStillSettling(run);
  return found;
}

// Each reason gives a turn one retry.
export const canRetry = (run, reason) =>
  !(run.retriedJobs ?? []).some((entry) => entry.reason === reason);

export async function retryJob(run, reason, context) {
  const { save, warn, audit } = context;
  const given = run.jobId;
  const earlier = run.retriedJobs;
  run.retriedJobs = [...(earlier ?? []), { jobId: given, reason }];
  run.jobId = null;
  save();
  try {
    await startJob(run, {
      ...context,
      resume: Boolean(run.contextThreadId) || (run.turns?.length ?? 0) > 0,
    });
  } catch (error) {
    // Publication is authoritative even if the trailing diagnostic failed.
    // Never detach a newly gated job from its retry ledger.
    if (run.jobId) throw error;
    let jobs = null;
    try {
      jobs = unownedDriverJobs(context.stateDir, run);
    } catch {
      /* The listing failed: whether a job exists is unknown. */
    }
    // A job the second launch may have created is the turn's: --run finds it.
    if (jobs === null || jobs.length || launchSettling(run, { probe: context.processes?.probe }))
      throw error;
    // Only a successful empty listing after launch settlement proves that no
    // new job exists. Unknown publication keeps its reservation for recovery.
    run.jobId = given;
    if (earlier) run.retriedJobs = earlier;
    else delete run.retriedJobs;
    save();
    throw Object.assign(
      new Error(
        `${error.message}; the turn was not submitted again, and job ${given} stays its job`,
        { cause: error },
      ),
      { code: error.code },
    );
  }
  await audit?.emit(AUDIT_TRANSITION.RETRY, run);
  await warn(`Submitted the turn again as Codex job ${run.jobId}, in place of job ${given}.`);
}

export function unidentifiedJob(run, count) {
  return new RunnerError(
    CODES.JOB_UNIDENTIFIED,
    `run ${run.runKey}'s job could not be identified (${count ?? "unknown"} candidates); inspect with --inspect ${run.runKey} --probe before --close ${run.runKey} --force`,
  );
}
