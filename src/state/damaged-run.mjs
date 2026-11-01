// Retire unreadable metadata without trusting its paths or running its hooks.
import fs from "node:fs";
import path from "node:path";
import { ACTIVE, TERMINAL } from "../shared/constants.mjs";
import { alive, requireDirectory } from "../shared/io.mjs";
import { releaseDamagedClaims } from "./state.mjs";
import { visitStrictly } from "./job-store.mjs";
import { readRunFile } from "./run-store.mjs";

export function damagedRunError(key, error) {
  return new Error(
    `run ${key} has damaged or missing run.json: ${error.message}. Inspect with --inspect ${key}; restore the metadata, or retire it with --close ${key} --force.`,
    { cause: error },
  );
}

export async function closeDamagedRun(key, { stateBase, stateDir, warn, signal, timing }) {
  requireDirectory(stateBase);
  if (path.dirname(stateDir) !== stateBase || path.basename(stateDir) !== key)
    throw new Error("unsafe damaged-run path");
  const quarantine = path.join(stateBase, "quarantine");
  const target = path.join(quarantine, key);
  if (!fs.existsSync(stateDir)) {
    requireDirectory(quarantine);
    requireDirectory(target);
    return finishRetirement();
  }
  requireDirectory(stateDir);
  // A record can be damaged while its birth identity is still useful.
  let recorded;
  try {
    recorded = readRunFile(stateDir);
  } catch {
    /* Strict job traversal follows. */
  }
  for (const identity of [
    recorded?.worker,
    recorded?.launching,
    recorded?.broker,
    recorded?.maintenanceWorker,
  ]) {
    if (
      identity &&
      (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || alive(identity.pid))
    )
      throw new Error(
        `cannot retire damaged run ${key}: a recorded process may still run; state retained`,
      );
  }
  visitStrictly(stateDir, {
    onJob(job, record) {
      if (
        !TERMINAL.has(record.status) &&
        (!ACTIVE.has(record.status) ||
          !Number.isSafeInteger(record.pid) ||
          record.pid <= 0 ||
          alive(record.pid))
      )
        throw new Error(
          `cannot retire damaged run ${key}: job ${job} may still run; inspect with --inspect ${key} --probe and restore run.json before closing`,
        );
    },
  });
  signal?.throwIfAborted();
  fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
  requireDirectory(quarantine);
  if (fs.existsSync(target))
    throw new Error(
      `quarantine already exists at ${target}; restore or inspect it before retiring this run`,
    );
  fs.renameSync(stateDir, target);
  return finishRetirement();

  async function finishRetirement() {
    // Report the preserved files before any fallible or interruptible cleanup.
    await warn(
      `Damaged run ${key} retired; its files are preserved at ${target}. No process termination ran. Restore the directory before repairing any worktree references.`,
    );
    try {
      await releaseDamagedClaims(stateBase, key, { signal, timing });
    } catch (error) {
      throw new Error(
        `retirement cleanup incomplete: ${error.message}. Files preserved at ${target}; retry --close ${key} --force`,
        { cause: error },
      );
    }
  }
}
