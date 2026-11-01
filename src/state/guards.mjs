// Low-level ownership guards: no run, driver or job-store dependencies.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REAL_TIMING } from "../shared/timing.mjs";
import {
  LOCK_FOLDER_REMOVAL,
  ORPHANED_LOCK_MS,
  IS_WINDOWS,
  GUARD_RETRIES,
  GUARD_RETRY_MS,
  LOCK_TAKEOVER_MS,
} from "../shared/constants.mjs";
import { atomicWrite, readJson, requireDirectory } from "../shared/io.mjs";
import { CODES, ERRNO, RUN_LOCK_CODES, RunnerError } from "../shared/errors.mjs";
import { ownerAlive, processOwner } from "../shared/process-identity.mjs";

// Guards serialize every change to a lock or claim, from inspection through
// publication, so two processes can never both decide it is free. Guards carry
// process identity and a token: a paused live publisher keeps ownership, and a
// dead publisher is replaced under the same recovery protocol as a run lock.
export function holdGuard(dir, busy) {
  const ownerFile = path.join(dir, "owner.json");
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (deleting(error)) throw new RunnerError(CODES.GUARD_BUSY, busy);
    if (error.code !== ERRNO.EEXIST) throw error;
    let owner = null;
    try {
      requireDirectory(dir);
      owner = readJson(ownerFile);
    } catch (error) {
      // Its maker writes the owner right after the folder: one still without
      // an owner after ORPHANED_LOCK_MS was left by an interrupted maker and
      // is reclaimed below, under the recovery guard.
      if (error.code !== ERRNO.ENOENT || !orphaned(dir))
        throw new RunnerError(
          CODES.GUARD_BUSY,
          error.code === ERRNO.ENOENT
            ? `${busy}; guard ${dir} has no owner yet`
            : `${busy}; guard ${dir} has no readable owner; remove ${dir} only after confirming no publisher is running`,
        );
    }
    if (owner && (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || ownerAlive(owner)))
      throw new RunnerError(CODES.GUARD_BUSY, busy);
    try {
      // This rechecks ownership under a second guard. Two reclaimers cannot
      // delete the fresh guard installed by the other in between their reads.
      takeOverLock(dir, dir);
    } catch (error) {
      if (RUN_LOCK_CODES.has(error.code))
        throw new RunnerError(CODES.GUARD_BUSY, `${busy}; ${error.message}`);
      throw error;
    }
  }
  return publishOwner(
    dir,
    () => new RunnerError(CODES.GUARD_OWNERSHIP_CHANGED, `guard ownership changed: ${dir}`),
  );
}

// Writes the owner of a lock or guard folder this process has just made (its
// PID and start time, with a token) and returns the folder's release, which
// removes it only while that owner is still the one written, and throws
// ownershipChanged() otherwise. A folder whose owner cannot be written is
// removed at once. holdGuard and acquireLock share it; each keeps its own way
// of making or taking over the folder, and its own errors.
function publishOwner(dir, ownershipChanged) {
  const ownerFile = path.join(dir, "owner.json");
  const token = crypto.randomBytes(16).toString("hex");
  try {
    atomicWrite(ownerFile, JSON.stringify({ ...processOwner(), token }));
  } catch (error) {
    fs.rmdirSync(dir);
    throw error;
  }
  return () => {
    requireDirectory(dir);
    if (readJson(ownerFile).token !== token) throw ownershipChanged();
    fs.unlinkSync(ownerFile);
    removeFolder(dir);
  };
}

export async function holdGuardPatiently(dir, busy, signal, timing = REAL_TIMING) {
  for (let attempt = 0; ; attempt++) {
    try {
      return holdGuard(dir, busy);
    } catch (error) {
      if (error.code !== CODES.GUARD_BUSY) throw error;
      if (attempt >= GUARD_RETRIES) return false;
      await timing.sleep(GUARD_RETRY_MS, signal);
    }
  }
}

// Teardown must not inherit the command's cancellation: it gets the same
// bounded retry budget, but no caller signal can interrupt those retries.
export function holdGuardForCleanup(dir, busy, timing = REAL_TIMING) {
  return holdGuardPatiently(dir, busy, undefined, timing);
}

function young(dir) {
  try {
    return fs.statSync(dir).mtimeMs > Date.now() - LOCK_TAKEOVER_MS;
  } catch {
    return true; // It vanished: whoever held it is done with it.
  }
}

// A lock or guard folder that has had no owner for ORPHANED_LOCK_MS.
function orphaned(dir) {
  try {
    return fs.statSync(dir).mtimeMs <= Date.now() - ORPHANED_LOCK_MS;
  } catch {
    return false;
  }
}

// Windows keeps a deleted file or folder until its last open handle closes,
// and refuses access to it, or a new one of that name, meanwhile (EPERM).
export const deleting = (error) => IS_WINDOWS && error.code === ERRNO.EPERM;

// Lock and guard folders are removed with retries (LOCK_FOLDER_REMOVAL).
const removeFolder = (dir) =>
  fs.rmSync(dir, { recursive: true, force: true, ...LOCK_FOLDER_REMOVAL });

const lockBusy = (key, cause, lock = null) =>
  new RunnerError(
    CODES.RUN_LOCK_BUSY,
    `run ${key}'s lock${lock ? ` ${lock}` : ""} is changing hands; retry in a moment`,
    { detail: cause?.message ?? null },
  );

// Another process holds the recovery guard. It records its PID, so the guard
// is reported only when that process is gone, or for a guard without a PID
// (an interrupted creation, or an older runner's) once it is no longer young.
function recoveryInProgress(recovery, key) {
  let owner = null;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(recovery, "owner"), "utf8"));
    owner = typeof value === "number" ? { pid: value } : value;
  } catch {
    /* Not written yet, or a guard without one. */
  }
  const pid = owner?.pid;
  const known = Number.isSafeInteger(pid) && pid > 0;
  if (known ? ownerAlive(owner) : young(recovery)) return lockBusy(key, null, recovery);
  return new RunnerError(
    CODES.RUN_LOCK_RECOVERY_STALE,
    `lock recovery of run ${key} was interrupted${known ? ` (its process ${pid} is no longer running)` : ""}; if no waiter owns the run, remove ${recovery} and retry`,
  );
}

// Takes over a run lock whose owner is gone, under the recovery guard, which
// serializes stale-owner removal: the owner is re-read under the guard so a
// second attacher cannot remove a newly acquired lock. Returns with the lock
// directory freshly made and not yet owned; throws RUN_LOCK_HELD for a live
// owner and RUN_LOCK_BUSY while the lock is being made or released.
function takeOverLock(lock, key) {
  const recovery = `${lock}.recovery`;
  try {
    fs.mkdirSync(recovery, { mode: 0o700 });
  } catch (error) {
    // An existing guard means another recovery, and one still being removed
    // a recovery just finished; any other failure is its own error.
    if (error.code === ERRNO.EEXIST) throw recoveryInProgress(recovery, key);
    if (deleting(error)) throw lockBusy(key, error, lock);
    throw error;
  }
  try {
    fs.writeFileSync(path.join(recovery, "owner"), JSON.stringify(processOwner()));
    let owner;
    try {
      requireDirectory(lock);
      owner = readJson(path.join(lock, "owner.json"));
    } catch (error) {
      if (error.code !== ERRNO.ENOENT && !deleting(error)) throw error;
      // Its maker has not written the owner yet, or its owner just released
      // it; one still without an owner after ORPHANED_LOCK_MS was left by an
      // interrupted maker, never a live one, and is reclaimed.
      if (deleting(error) || !orphaned(lock)) throw lockBusy(key, error, lock);
      owner = null;
    }
    if (owner && ownerAlive(owner))
      throw new RunnerError(
        CODES.RUN_LOCK_HELD,
        `run ${key} is already being handled by PID ${owner.pid}`,
        {
          pid: owner.pid,
        },
      );
    fs.rmSync(path.join(lock, "owner.json"), { force: true });
    removeFolder(lock);
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      // Another attacher made the lock in the moment it was gone; it owns it.
      if (error.code === ERRNO.EEXIST || deleting(error)) throw lockBusy(key, error, lock);
      throw error;
    }
  } finally {
    removeFolder(recovery);
  }
}

export function acquireLock(base, key) {
  const lock = path.join(base, `${key}.lock`);
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (deleting(error)) throw lockBusy(key, error); // Its owner is just releasing it.
    if (error.code !== ERRNO.EEXIST) throw error;
    takeOverLock(lock, key);
  }
  return publishOwner(
    lock,
    () => new RunnerError(CODES.RUN_LOCK_OWNERSHIP_CHANGED, `lock ownership changed: ${lock}`),
  );
}
