// The run record's file, <run state folder>/run.json, which this module alone
// reads raw and writes. Every write replaces the whole file in one rename
// (atomicWrite), as indented JSON. Each write is an operation named for the
// checkpoint it is made at:
// - createRecord: a launch's first record, under the run lock and before a
//   writer lock or a worktree names the run, so a writer lock's owner without
//   a record is always a finished run;
// - saveRun: every later change of a run its invocation holds (a worktree's
//   start commit, a reservation, a turn, a launch helper, a job and its worker,
//   a result and its milestones, sleep);
// - recordDeliveryOverrides: the delivery options an attach gives explicitly,
//   recorded when it loads the run, so the attach command printed on exit 3
//   inherits them.
// --inspect reads the file itself (inspect.mjs), size-limited, observing what
// it cannot parse instead of failing on it.
import path from "node:path";
import { atomicWrite, readJson, readLimited } from "../shared/io.mjs";

export const runFile = (stateDir) => path.join(stateDir, "run.json");

// The record as stored: parsed, not validated (validateRun does that).
export const readRunFile = (stateDir, { maxBytes } = {}) =>
  maxBytes === undefined
    ? readJson(runFile(stateDir))
    : JSON.parse(readLimited(runFile(stateDir), maxBytes).toString("utf8"));

function writeRunFile(run, stateDir) {
  atomicWrite(runFile(stateDir), JSON.stringify(run, null, 2));
}

/** @param {import('../shared/types.mjs').RunRecord} run @param {string} stateDir */
export function createRecord(run, stateDir) {
  writeRunFile(run, stateDir);
}

/** @param {import('../shared/types.mjs').RunRecord} run @param {string} stateDir */
export function saveRun(run, stateDir) {
  writeRunFile(run, stateDir);
}

// The command-line delivery options and the record fields they set.
const DELIVERY_OPTIONS = [
  ["quiet", "quiet"],
  ["relay", "relay"],
  ["max-stdout-lines", "maxStdoutLines"],
  ["max-stdout-bytes", "maxStdoutBytes"],
];

// Records the delivery options an attach gives explicitly where they differ
// from the run's, and writes the record only then. Returns whether it did.
/** @param {import('../shared/types.mjs').RunRecord} run @param {object} options @param {string} stateDir */
export function recordDeliveryOverrides(run, options, stateDir) {
  let changed = false;
  for (const [option, field] of DELIVERY_OPTIONS) {
    if (options[option] !== undefined && run[field] !== options[option]) {
      run[field] = options[option];
      changed = true;
    }
  }
  if (changed) writeRunFile(run, stateDir);
  return changed;
}
