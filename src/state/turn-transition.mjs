import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../shared/io.mjs";
import { ERRNO } from "../shared/errors.mjs";
import { FORK_SETTINGS } from "../shared/constants.mjs";
import { turnSettings, restoreTurnSettings } from "../shared/turn-settings.mjs";
import { isForkSeed } from "../shared/fork.mjs";

const TURN_FILES = ["prompt.txt", "result.txt"];
const turnCopy = (stateDir, index, name) => path.join(stateDir, `turn-${index}-${name}`);

// Between its delivered turn and the next turn's job: reserved or switched.
export const turnInTransition = (run) => Boolean(run.continuing);
// Reserved for its next turn, nothing switched yet.
export const turnReserved = (run) => Boolean(run.continuing && run.result && run.jobId);
// Switched to its next turn, whose job is not recorded yet.
export const turnSwitched = (run) =>
  Boolean(run.continuing && !run.result && !run.jobId && run.turns?.at(-1)?.result);

// The reservation: the run is marked continuing and saved before anything
// else sees its next turn (a writer lock, a copy, a launch).
export function reserveTurn(run, save) {
  run.continuing = true;
  save();
}

// Gives back a reservation refused before anything was copied or launched (its
// writer lock was refused): the run is the idle, delivered run again.
export function unreserveTurn(run, save) {
  delete run.continuing;
  save();
}

// Archives the delivered turn and switches the record to the next one: its
// files are copied to turn-N-* first, so an interruption never leaves the
// record pointing at a file that no longer exists; then the record archives
// the turn (its job, model, effort, write mode, result, request, keep flag and
// retries), takes the next turn's settings (next: model, effort, write and its
// request ID and digest, if any) and is saved; then the next prompt is stored.
// Returns the archived turn's number N.
export function switchTurn(run, stateDir, prompt, next, save) {
  const { model, effort, write, requestId, requestDigest } = next;
  run.turns ??= [];
  const seed = isForkSeed(run);
  const index = seed ? 0 : run.turns.length + 1;
  if (seed)
    run.seedReservation = Object.fromEntries(
      FORK_SETTINGS.filter((k) => run[k] !== undefined).map((k) => [k, run[k]]),
    );
  if (!seed) {
    for (const name of TURN_FILES) {
      try {
        fs.copyFileSync(path.join(stateDir, name), turnCopy(stateDir, index, name));
      } catch (error) {
        if (error.code !== ERRNO.ENOENT) throw error;
      }
    }
    run.turns.push({
      jobId: run.jobId,
      model: run.model ?? null,
      effort: run.effort ?? null,
      write: Boolean(run.write),
      result: run.result,
      ...(run.turnRequestId ? { requestId: run.turnRequestId } : {}),
      // Kept so that a turn that never starts can be rolled back exactly.
      ...(run.turnRequestId && run.turnRequestDigest
        ? { requestDigest: run.turnRequestDigest }
        : {}),
      ...(run.keepState === true ? {} : { keepState: run.keepState ?? null }),
      ...(run.retriedJobs ? { retriedJobs: run.retriedJobs } : {}),
      ...turnSettings(run),
    });
  }
  delete run.result;
  delete run.retriedJobs;
  Object.assign(run, { jobId: null, model, effort, write, keepState: true });
  for (const key of ["commitSubject", "commitTrailers"]) {
    if (next[key] !== undefined) run[key] = next[key];
    else delete run[key];
  }
  if (next.review !== undefined) run.review = next.review;
  else delete run.review;
  if (next.outputSchema !== undefined) run.outputSchema = next.outputSchema;
  else delete run.outputSchema;
  if (next.tier !== undefined) run.tier = next.tier;
  else delete run.tier;
  if (next.compact) run.compact = true;
  else delete run.compact;
  if (requestId) Object.assign(run, { turnRequestId: requestId, turnRequestDigest: requestDigest });
  else {
    delete run.turnRequestId;
    delete run.turnRequestDigest;
  }
  save();
  atomicWrite(path.join(stateDir, "prompt.txt"), prompt);
  return index;
}
export function confirmTurnJob(run, jobId) {
  run.jobId = jobId;
  delete run.continuing;
  delete run.dormant;
  delete run.forkSeed;
  delete run.seedReservation;
}

// Rolls back the record and files of a turn that never started (the caller
// has checked that no job of the turn exists): the run becomes the idle,
// delivered run it was. Returns null for a run in neither state, else
// { writer, reportBusy }: whether the caller gives back a writer lock the turn
// may have taken, and whether one that stays busy is reported.
// - reserved: the reservation goes (saved), then any copies already made; a
//   lock the reservation may have taken is given back without a report;
// - switched: the delivered turn's prompt.txt is restored, the record switched
//   back (its job, model, effort, write mode, result, keep flag, retries and
//   request) and saved, then the turn's copies removed; a write turn's lock is
//   given back, and one that stays busy is reported.
// The record switches back before anything is removed, so an interruption
// leaves either the reserved turn or the delivered run.
export function rollBackTurnRecord(run, stateDir, save) {
  if (run.forkSeed && run.continuing && !run.jobId) {
    if (run.seedReservation)
      for (const key of FORK_SETTINGS) {
        if (run.seedReservation[key] !== undefined) run[key] = run.seedReservation[key];
        else delete run[key];
      }
    delete run.seedReservation;
    delete run.continuing;
    delete run.turnRequestId;
    delete run.turnRequestDigest;
    atomicWrite(path.join(stateDir, "prompt.txt"), "");
    save();
    return { writer: false, reportBusy: false };
  }
  if (turnReserved(run)) {
    const next = (run.turns?.length ?? 0) + 1;
    delete run.continuing;
    save();
    for (const name of TURN_FILES) fs.rmSync(turnCopy(stateDir, next, name), { force: true });
    return { writer: !run.scratchWorkspace && !run.worktree, reportBusy: false };
  }
  if (!turnSwitched(run)) return null;
  const turn = run.turns.at(-1);
  const index = run.turns.length;
  const writer = Boolean(run.write) && !run.scratchWorkspace && !run.worktree;
  try {
    atomicWrite(
      path.join(stateDir, "prompt.txt"),
      fs.readFileSync(turnCopy(stateDir, index, "prompt.txt")),
    );
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
  }
  run.turns.pop();
  run.jobId = turn.jobId;
  for (const field of ["model", "effort"]) {
    if (turn[field] == null) delete run[field];
    else run[field] = turn[field];
  }
  run.write = turn.write;
  restoreTurnSettings(run, turn);
  run.result = turn.result;
  // A run retained only for lack of a result copy was not kept by request.
  if (turn.keepState === null) delete run.keepState;
  else if (turn.keepState === false) run.keepState = false;
  if (turn.retriedJobs) run.retriedJobs = turn.retriedJobs;
  else delete run.retriedJobs;
  delete run.turnRequestId;
  delete run.turnRequestDigest;
  if (turn.requestId) run.turnRequestId = turn.requestId;
  if (turn.requestId && turn.requestDigest) run.turnRequestDigest = turn.requestDigest;
  delete run.continuing;
  save();
  for (const name of TURN_FILES) fs.rmSync(turnCopy(stateDir, index, name), { force: true });
  return { writer, reportBusy: true };
}
