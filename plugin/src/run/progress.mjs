// A patch observation never takes a delivery lock or launches/reconciles a turn.
import fs from "node:fs";
import path from "node:path";
import { claimedRun } from "../state/state.mjs";
import { peekRun } from "../state/run-record.mjs";
import { readDiff, readTurn, readDriver } from "../state/job-store.mjs";
import { readChangesPatch } from "../delivery/changes.mjs";
import { requireDirectory, writeOutput } from "../shared/io.mjs";
import {
  TERMINAL,
  JOB_READ_POLICY,
  PATCH_STATUS,
  PROGRESS_MODE,
  CHANGE_SOURCE,
} from "../shared/constants.mjs";
import { EXIT } from "../shared/errors.mjs";

export function observeRun(key, stateBase, { allowSeed = false } = {}) {
  if (key.startsWith("rq:")) key = claimedRun(stateBase, key.slice(3));
  if (!key) throw new Error("request names no retained run");
  const stateDir = path.join(stateBase, key);
  if (!fs.existsSync(stateDir))
    throw new Error(`unknown run ${key}; use --list to find retained runs`);
  requireDirectory(stateBase);
  requireDirectory(stateDir);
  const run = peekRun(stateDir, key);
  if (!run?.jobId && !(allowSeed && run?.forkSeed)) throw new Error("run has no current job");
  return { run, stateDir };
}

export async function printDiff(options, { stateBase, stdout, signal, commandMs, warn }) {
  const { run, stateDir } = observeRun(options.key, stateBase);
  const changes = run.result?.changes;
  const off = run.progress === PROGRESS_MODE.OFF;
  const recorded =
    changes &&
    [PATCH_STATUS.COMPLETE, PATCH_STATUS.TRUNCATED, PATCH_STATUS.EMPTY].includes(changes.patch);
  const diff = off
    ? ""
    : recorded
      ? readChangesPatch(run, stateDir)
      : changes?.source === CHANGE_SOURCE.GIT
        ? ""
        : readDiff(stateDir, run.jobId);
  await writeOutput(stdout, diff, { signal, timeoutMs: commandMs });
  const turn = readTurn(stateDir, run.jobId, { policy: JOB_READ_POLICY.STRICT });
  if (!diff)
    await warn(
      off
        ? "No patch recorded: progress is off for this turn."
        : changes?.patch === PATCH_STATUS.EMPTY
          ? "No changes between the worktree's start and delivered commits."
          : changes?.patch === PATCH_STATUS.UNAVAILABLE
            ? "No saved Git patch; inspect the retained branch with Git."
            : "No patch recorded. This does not prove that no files changed; review touched paths and the workspace or branch.",
    );
  if (changes?.patch === PATCH_STATUS.TRUNCATED)
    await warn(
      "Saved patch is truncated to its byte limit; use Git for the complete committed diff.",
    );
  if (
    (turn?.progressWriteFailed || readDriver(stateDir, run.jobId)?.progressWriteFailed) &&
    !recorded
  )
    await warn("Progress storage failed; the saved patch may be incomplete.");
  return TERMINAL.has(turn?.status) ? EXIT.COMPLETED : EXIT.STILL_RUNNING;
}
