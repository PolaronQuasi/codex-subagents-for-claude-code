// Validation and read-only loading of current records, including partial publication.

import fs from "node:fs";
import path from "node:path";
import {
  EFFORTS,
  BACKEND,
  RUN_RECORD_VERSION,
  LEGACY_RUN_VERSION,
  LEGACY_RUN_TEXT,
  RUN_KEY,
  GIT_REF,
  MODEL,
  THREAD_ID,
  HISTORY_EDIT_MAX,
  TRANSCRIPT_MAX_TURNS,
  FORK_STATE,
  FORK_SETTINGS,
  REQUEST_DIGEST_VERSION,
  REQUEST_ID,
  SESSION_ID,
  TERMINAL,
  validJobId,
  CHANGE_SOURCE,
  PATCH_STATUS,
} from "../shared/constants.mjs";
import { sameFolder } from "../shared/io.mjs";
import { CODES, ERRNO, RunnerError } from "../shared/errors.mjs";
import { readRunFile } from "./run-store.mjs";
import { validTurnSettings } from "../shared/turn-settings.mjs";
import { assertMaintenanceIdle, validMaintenanceWorker } from "./maintenance-worker.mjs";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function validHistoryEdit(op, pending = false) {
  return (
    op &&
    typeof op === "object" &&
    Number.isFinite(Date.parse(op.at)) &&
    Number.isSafeInteger(op.beforeTurn) &&
    op.beforeTurn > 0 &&
    op.beforeTurn <= TRANSCRIPT_MAX_TURNS &&
    THREAD_ID.test(op.beforeTurnId ?? "") &&
    DIGEST.test(op.prefixHash ?? "") &&
    (!pending ||
      (Array.isArray(op.removedTurnIds) &&
        op.removedTurnIds.length <= TRANSCRIPT_MAX_TURNS &&
        op.removedTurnIds.every((id) => typeof id === "string" && THREAD_ID.test(id))))
  );
}

function validFork(run) {
  if (run.forkedFrom === undefined)
    return [
      run.forkState,
      run.forkSeed,
      run.contextThreadId,
      run.seedReservation,
      run.forkRedaction,
    ].every((v) => v === undefined);
  const source = run.forkedFrom;
  return (
    source &&
    RUN_KEY.test(source.runKey ?? "") &&
    THREAD_ID.test(source.threadId ?? "") &&
    THREAD_ID.test(source.turnId ?? "") &&
    Number.isSafeInteger(source.at) &&
    source.at > 0 &&
    source.at <= TRANSCRIPT_MAX_TURNS &&
    Object.values(FORK_STATE).includes(run.forkState) &&
    (run.forkSeed === undefined || run.forkSeed === true) &&
    run.forkRedaction === true &&
    (run.contextThreadId === undefined || THREAD_ID.test(run.contextThreadId)) &&
    (run.forkState !== FORK_STATE.READY || THREAD_ID.test(run.contextThreadId ?? "")) &&
    (run.seedReservation === undefined ||
      (run.forkSeed &&
        run.continuing &&
        run.seedReservation &&
        Object.keys(run.seedReservation).every((k) => FORK_SETTINGS.includes(k)) &&
        MODEL.test(run.seedReservation.model ?? "") &&
        EFFORTS.has(run.seedReservation.effort) &&
        typeof run.seedReservation.write === "boolean" &&
        validSeedSettings(run.seedReservation)))
  );
}

const validSeedSettings = validRunPreferences;

function validChanges(changes) {
  if (changes === undefined) return true;
  return (
    Boolean(changes) &&
    Object.values(CHANGE_SOURCE).includes(changes.source) &&
    Object.values(PATCH_STATUS).includes(changes.patch) &&
    (changes.source !== CHANGE_SOURCE.GIT ||
      (SHA.test(changes.base ?? "") && SHA.test(changes.head ?? ""))) &&
    (![PATCH_STATUS.COMPLETE, PATCH_STATUS.TRUNCATED, PATCH_STATUS.EMPTY].includes(changes.patch) ||
      DIGEST.test(changes.sha256 ?? ""))
  );
}

function validResult(result) {
  if (result === undefined) return true;
  return (
    Boolean(result) &&
    TERMINAL.has(result.status) &&
    DIGEST.test(result.sha256) &&
    validChanges(result.changes) &&
    (result.schema === undefined || ["valid", "invalid"].includes(result.schema)) &&
    (result.jsonFile === undefined ||
      (typeof result.jsonFile === "string" &&
        path.isAbsolute(result.jsonFile) &&
        !/[\x00-\x1f\x7f]/.test(result.jsonFile))) &&
    (result.progressWriteFailed === undefined || typeof result.progressWriteFailed === "boolean") &&
    (result.threadId == null || typeof result.threadId === "string") &&
    (result.durationMs == null || Number.isFinite(result.durationMs)) &&
    (result.touchedFiles === undefined ||
      (Array.isArray(result.touchedFiles) &&
        result.touchedFiles.every((file) => typeof file === "string"))) &&
    (result.resultFile == null || path.isAbsolute(result.resultFile)) &&
    (result.commit == null || SHA.test(result.commit)) &&
    (result.deliveredAt == null || typeof result.deliveredAt === "string") &&
    (result.usage == null || typeof result.usage === "object")
  );
}

const optionalCount = (value) => value === undefined || (Number.isInteger(value) && value >= 0);
const optionalFlag = (value) => value === undefined || typeof value === "boolean";
const optionalMatch = (value, pattern) =>
  value === undefined || value === null || (typeof value === "string" && pattern.test(value));

export const isLegacyRun = (run) => run?.version === LEGACY_RUN_VERSION;
export const legacyRunError = () => new RunnerError(CODES.LEGACY_RUN_UNSUPPORTED, LEGACY_RUN_TEXT);

function validCodex(run) {
  return (
    Boolean(run.codex) &&
    path.isAbsolute(run.codex.path ?? "") &&
    path.isAbsolute(run.codex.realPath ?? "") &&
    typeof run.codex.version === "string" &&
    DIGEST.test(run.codex.build ?? "") &&
    Number.isSafeInteger(run.driverProtocol) &&
    run.driverProtocol > 0 &&
    ["scriptsDir", "pluginWorkspace", "sessionId", "broker", "codexDir"].every(
      (key) => !Object.hasOwn(run, key),
    )
  );
}

function validRunIdentity(run, key) {
  return (
    Boolean(run) &&
    run.version === RUN_RECORD_VERSION &&
    RUN_KEY.test(key) &&
    run.runKey === key &&
    path.isAbsolute(run.cwd ?? "") &&
    validCodex(run) &&
    (run.backend === undefined || run.backend === BACKEND.DRIVER) &&
    (run.jobId === null || validJobId(run.jobId)) &&
    (run.model === undefined || MODEL.test(run.model ?? "")) &&
    (run.effort === undefined || EFFORTS.has(run.effort)) &&
    validTurnSettings(run)
  );
}

function validRequestMetadata(run) {
  return (
    optionalMatch(run.requestId, REQUEST_ID) &&
    (run.requestId == null ||
      (DIGEST.test(run.requestDigest ?? "") &&
        run.requestDigestVersion === REQUEST_DIGEST_VERSION)) &&
    optionalMatch(run.requestDigest, DIGEST) &&
    (run.requestDigestVersion === undefined ||
      run.requestDigestVersion === REQUEST_DIGEST_VERSION) &&
    optionalMatch(run.turnRequestId, REQUEST_ID) &&
    optionalMatch(run.turnRequestDigest, DIGEST) &&
    optionalMatch(run.session, SESSION_ID) &&
    optionalMatch(run.hostSession, SESSION_ID)
  );
}

function validRunPreferences(run) {
  return (
    validTurnSettings(run) &&
    optionalFlag(run.keepState) &&
    optionalFlag(run.write) &&
    optionalFlag(run.quiet) &&
    optionalFlag(run.relay) &&
    optionalFlag(run.dormant) &&
    optionalFlag(run.sealed) &&
    optionalFlag(run.scratchWorkspace) &&
    optionalFlag(run.continuing) &&
    optionalFlag(run.compact) &&
    optionalCount(run.maxStdoutLines) &&
    optionalCount(run.maxStdoutBytes)
  );
}

function validWorktree(worktree) {
  // A read-only worktree is detached. Launch always publishes its requested
  // reference and a commit slot; that slot stays null until Git resolves it.
  return (
    worktree === undefined ||
    (worktree &&
      path.isAbsolute(worktree.base ?? "") &&
      (worktree.branch === null ||
        /^(?:codex-subagents-for-claude-code\/[0-9a-f]{32}|csfcc\/[0-9a-f]{20})$/.test(
          worktree.branch ?? "",
        )) &&
      typeof worktree.startRef === "string" &&
      GIT_REF.test(worktree.startRef) &&
      Object.hasOwn(worktree, "startCommit") &&
      (worktree.startCommit === null ||
        (typeof worktree.startCommit === "string" && SHA.test(worktree.startCommit))))
  );
}

// A worktree run works in <its state folder>/worktree and a scratch run in
// <its state folder>/workspace, which the runner made, and git commits,
// removes the worktree and the session-end hook acts there. A record naming
// any other folder was changed, and is refused like other damaged metadata.
function validWorkspace(run, stateDir) {
  const own = run.worktree ? "worktree" : run.scratchWorkspace ? "workspace" : null;
  return (
    !own ||
    stateDir === undefined ||
    (path.basename(path.resolve(run.cwd)) === own &&
      sameFolder(path.dirname(path.resolve(run.cwd)), stateDir))
  );
}

// The runner's record of the current job's worker: { jobId, pid, processStart }.
function validWorker(worker) {
  return (
    worker === undefined ||
    (Boolean(worker) &&
      validJobId(worker.jobId) &&
      Number.isSafeInteger(worker.pid) &&
      worker.pid > 0 &&
      typeof worker.processStart === "string")
  );
}

// The launch helper of the run's current launch, recorded while it runs:
// { pid, processStart, at }.
function validLaunching(launching) {
  return (
    launching === undefined ||
    (Boolean(launching) &&
      Number.isSafeInteger(launching.pid) &&
      launching.pid > 0 &&
      (launching.processStart === null || typeof launching.processStart === "string") &&
      typeof launching.at === "string")
  );
}

// The jobs a turn gave up and submitted again: { jobId, reason } each.
function validRetried(list) {
  return (
    list === undefined ||
    (Array.isArray(list) &&
      list.every((entry) => validJobId(entry?.jobId) && typeof entry.reason === "string"))
  );
}

// An archived turn as the archive writes it (switchTurn, turn-transition.mjs):
// its model and effort (null for a run that recorded neither), write mode and
// result, and, when the run had them, its request ID and digest, its keep
// flag (false, or null for a run kept only for lack of a result copy) and its
// retries. A rollback of the turn after it restores each of these into the
// run, and a teardown reads its result's copy (resultFile, an absolute path),
// so each must pass the run's own rule for that field: a recovery never stops
// halfway on a turn the load let through. A result may lack the fields later
// runners added (usage, the delivery milestones), as the current one may.
function archivedTurn(turn) {
  return (
    validTurnSettings(turn) &&
    (turn.model === null || (typeof turn.model === "string" && MODEL.test(turn.model))) &&
    (turn.effort === null || EFFORTS.has(turn.effort)) &&
    typeof turn.write === "boolean" &&
    optionalFlag(turn.compact) &&
    Boolean(turn.result) &&
    validResult(turn.result) &&
    (turn.keepState === undefined ||
      turn.keepState === null ||
      typeof turn.keepState === "boolean") &&
    optionalMatch(turn.requestId, REQUEST_ID) &&
    optionalMatch(turn.requestDigest, DIGEST)
  );
}

// Every archived turn names its job and its retries validly, and has the
// archive's current shape; anything else is refused at load, with the
// rest of a damaged record.
function validTurn(turn) {
  return (
    Boolean(turn) &&
    typeof turn === "object" &&
    !Array.isArray(turn) &&
    validJobId(turn.jobId) &&
    validRetried(turn.retriedJobs) &&
    archivedTurn(turn)
  );
}

function validTurns(turns) {
  return turns === undefined || (Array.isArray(turns) && turns.every(validTurn));
}

// Whether jobId names the run's current turn: its job, or a job this turn gave
// up for a retry (an attach command printed before the retry names that one).
export function jobOfTurn(run, jobId) {
  return jobId === run.jobId || (run.retriedJobs ?? []).some((entry) => entry.jobId === jobId);
}

// stateDir: the run's state folder, which a worktree or scratch workspace
// must lie in (see validWorkspace).
/** @param {import('../shared/types.mjs').RunRecord} run @param {string} key @param {string} [stateDir] @returns {import('../shared/types.mjs').RunRecord} */
export function validateRun(run, key, stateDir) {
  if (isLegacyRun(run)) throw legacyRunError();
  if (
    !validRunIdentity(run, key) ||
    !validFork(run) ||
    !validRequestMetadata(run) ||
    !validRunPreferences(run) ||
    !validWorktree(run.worktree) ||
    !validWorkspace(run, stateDir) ||
    !validWorker(run.worker) ||
    !validMaintenanceWorker(run.maintenanceWorker) ||
    !validLaunching(run.launching) ||
    !validTurns(run.turns) ||
    !validRetried(run.retriedJobs) ||
    !validResult(run.result) ||
    (run.historyOperation !== undefined && !validHistoryEdit(run.historyOperation, true)) ||
    (run.historyEdits !== undefined &&
      (!Array.isArray(run.historyEdits) ||
        run.historyEdits.length > HISTORY_EDIT_MAX ||
        !run.historyEdits.every((op) => validHistoryEdit(op))))
  ) {
    throw new Error("invalid run metadata; state retained for inspection");
  }
  return run;
}

// The record of a retained run, read without its lock; null when the run
// has no record (yet).
export function peekRun(stateDir, key) {
  try {
    return validateRun(readRunFile(stateDir), key, stateDir);
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
    return null;
  }
}

// Reads a current record without writing. A vanished run and a damaged
// retained folder are different outcomes; neither reconstructs metadata.
export function readLockedRun(options, { stateDir }) {
  try {
    return readRunFile(stateDir);
  } catch (error) {
    if (error.code === ERRNO.ENOENT && !fs.existsSync(stateDir))
      throw new RunnerError(
        CODES.RUN_GONE,
        `run ${options.key} was delivered and removed by another waiter meanwhile`,
      );
    throw Object.assign(error, { code: CODES.RUN_METADATA_INVALID });
  }
}

// Checks the record of a locked run against its key and the attached job ID:
// RUN_METADATA_INVALID for a record that is not valid.
export function checkLockedRun(run, options, stateDir) {
  try {
    validateRun(run, options.key, stateDir);
  } catch (error) {
    if (error.code === CODES.LEGACY_RUN_UNSUPPORTED) throw error;
    throw Object.assign(error, { code: CODES.RUN_METADATA_INVALID });
  }
  if (options.attach && run.jobId && !jobOfTurn(run, options.attach))
    throw new Error("job ID does not match this run");
  assertMaintenanceIdle(run);
  return run;
}
