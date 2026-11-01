// Run state: run locks, workspace writer locks, request claims, the retained
// runs and the delivery milestones. The run record itself is run-record.mjs's
// (validation, loading) and its file run-store.mjs's.

import fs from "node:fs";
import {
  acquireLock,
  holdGuard,
  holdGuardForCleanup,
  holdGuardPatiently,
  deleting,
} from "./guards.mjs";
export { acquireLock, holdGuard, holdGuardPatiently } from "./guards.mjs";
import path from "node:path";
import { REAL_TIMING } from "../shared/timing.mjs";
import {
  RUN_LOCK_OUTCOME,
  REQUEST_CLAIM_STATE,
  STATE_CLAIM_DIRECTORY,
  REQUEST_ID,
  RUN_KEY,
  HELD_LOCK_POLL_MS,
  LOCK_RETRY_MS,
  LOCK_TAKEOVER_MS,
  STALE_CLAIM_MS,
  REQUEST_DIGEST_VERSION,
  SECOND_MS,
} from "../shared/constants.mjs";
import { atomicWrite, readJson, requireDirectory } from "../shared/io.mjs";
import { readRunFile } from "./run-store.mjs";
import { validateRun, isLegacyRun } from "./run-record.mjs";
import { turnInTransition } from "./turn-transition.mjs";
import { workspaceId } from "../shared/workspace.mjs";
import { CODES, ERRNO, RunnerError } from "../shared/errors.mjs";
import { ownerAlive, processOwner } from "../shared/process-identity.mjs";

// An ownerless claim can be reclaimed under its publication guard after a
// minute. Age alone never grants permission to replace the guard itself.
function staleDir(dir) {
  try {
    return fs.statSync(dir).mtimeMs < Date.now() - STALE_CLAIM_MS;
  } catch {
    return true;
  }
}

// Terminal model output is not process quiescence. Keep exclusion until the
// waiter has recorded both delivery and successful shutdown.
function writerActive(stateBase, runKey) {
  const dir = path.join(stateBase, runKey);
  let run;
  try {
    run = validateRun(readRunFile(dir), runKey, dir);
  } catch (error) {
    return error.code !== ERRNO.ENOENT;
  }
  // A turn in transition (reserved or switched) may hold the lock already.
  if (turnInTransition(run)) return true;
  return !(run.dormant === true && isDelivered(run) && !run.result?.shutdownPending);
}

// The writer and request claim share publication and removal mechanics. Their
// policies for an existing owner stay with the caller.
function publishOwnedFolder(folder, { busy, inspect, owner, readError = (error) => error }) {
  const ownerFile = path.join(folder, "owner.json");
  const recovery = `${folder}.recovery`;
  const release = holdGuard(recovery, busy);
  try {
    try {
      fs.mkdirSync(folder, { mode: 0o700 });
    } catch (error) {
      if (error.code !== ERRNO.EEXIST) throw error;
      let previous = null;
      try {
        previous = readJson(ownerFile);
      } catch (error) {
        if (error.code !== ERRNO.ENOENT) throw readError(error);
      }
      const existing = inspect(previous, ownerFile);
      if (existing !== undefined) return existing;
      fs.rmSync(folder, { recursive: true, force: true });
      fs.mkdirSync(folder, { mode: 0o700 });
    }
    atomicWrite(ownerFile, JSON.stringify(owner()));
    return { claimed: true, owner: null };
  } finally {
    release();
  }
}

async function releaseOwnedFolder(folder, runKey, signal, timing, independent = false) {
  if (!fs.existsSync(folder)) return true;
  const recovery = `${folder}.recovery`;
  const release = independent
    ? await holdGuardForCleanup(recovery, "busy", timing)
    : await holdGuardPatiently(recovery, "busy", signal, timing);
  if (!release) return false;
  try {
    try {
      if (readJson(path.join(folder, "owner.json")).runKey !== runKey) return true;
    } catch (error) {
      if (error.code === ERRNO.ENOENT) return true;
      throw error;
    }
    fs.rmSync(folder, { recursive: true, force: true });
    return true;
  } finally {
    release();
  }
}

const writerLock = (stateBase, workspace) =>
  path.join(stateBase, STATE_CLAIM_DIRECTORY.WRITERS, `${workspaceId(workspace)}.lock`);
const writingError = (workspace, runKey) =>
  new Error(
    `workspace ${workspace} is being written by run ${runKey}; wait for it, or stop it with --cancel ${runKey}`,
  );

// The run that holds a workspace's writer lock in a state root and is still
// writing, or null; a lock still being published there, or unreadable, is
// held by a current active run in this configured root.
export function acquireWriterLock(stateBase, workspace, runKey) {
  const root = path.join(stateBase, STATE_CLAIM_DIRECTORY.WRITERS);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = writerLock(stateBase, workspace);
  publishOwnedFolder(lock, {
    busy: `the writer lock for ${workspace} is being changed by another process; retry in a moment`,
    readError: () =>
      new Error(
        `unreadable writer lock owner ${path.join(lock, "owner.json")}; remove it if no job is starting`,
      ),
    inspect(owner, ownerFile) {
      if (owner) {
        if (!RUN_KEY.test(owner.runKey ?? ""))
          throw new Error(
            `invalid writer lock owner ${ownerFile}; remove it if no job is starting`,
          );
        if (owner.runKey === runKey) return { retained: true };
        if (writerActive(stateBase, owner.runKey)) throw writingError(workspace, owner.runKey);
      } else if (!staleDir(lock)) {
        // An ownerless folder belongs to an interrupted publisher; allow a minute.
        throw new Error(
          `the writer lock for ${workspace} is incomplete; retry in a moment, or remove ${lock} if no job is starting`,
        );
      }
    },
    owner: () => ({ runKey, workspace, pid: process.pid, createdAt: new Date().toISOString() }),
  });
}

// False means the guard stayed busy; a later writer can reclaim the terminal owner.
export async function releaseWriterLock(
  stateBase,
  workspace,
  runKey,
  { signal, timing = REAL_TIMING } = {},
) {
  return releaseOwnedFolder(
    path.join(stateBase, STATE_CLAIM_DIRECTORY.WRITERS, `${workspaceId(workspace)}.lock`),
    runKey,
    signal,
    timing,
  );
}

export function writerOwners(stateBase) {
  const owners = new Set();
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(stateBase, STATE_CLAIM_DIRECTORY.WRITERS), {
      withFileTypes: true,
    });
  } catch {
    return owners;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      owners.add(
        readJson(path.join(stateBase, STATE_CLAIM_DIRECTORY.WRITERS, entry.name, "owner.json"))
          .runKey,
      );
    } catch {
      /* incomplete */
    }
  }
  return owners;
}

// A request ID is claimed exclusively before anything is launched, with a
// digest of the prompt, so a repeat can only attach to or replay the same task.
// Claiming holds a guard from inspection through publication.
function requestClaimDir(stateBase, requestId) {
  return path.join(stateBase, STATE_CLAIM_DIRECTORY.REQUESTS, `${requestId}.lock`);
}

function provenUndispatchedClaim(stateBase, owner) {
  return (
    owner?.launchState === REQUEST_CLAIM_STATE.UNDISPATCHED &&
    RUN_KEY.test(owner.runKey ?? "") &&
    owner.digestVersion === REQUEST_DIGEST_VERSION &&
    /^[a-f0-9]{64}$/.test(owner.promptSha256 ?? "") &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    (owner.processStart === null || typeof owner.processStart === "string") &&
    !fs.existsSync(path.join(stateBase, owner.runKey))
  );
}

export function claimRequest(stateBase, requestId, runKey, requestDigest) {
  fs.mkdirSync(path.join(stateBase, STATE_CLAIM_DIRECTORY.REQUESTS), {
    recursive: true,
    mode: 0o700,
  });
  const claim = requestClaimDir(stateBase, requestId);
  try {
    return publishOwnedFolder(claim, {
      busy: "busy",
      inspect(owner) {
        // This phase is written before a run exists and replaced before the
        // launch can reach its driver gate. A dead owner in it never dispatched.
        if (owner && provenUndispatchedClaim(stateBase, owner) && !ownerAlive(owner))
          return undefined;
        // The claim of a run an interrupted cleanup removed is given back.
        if (owner && closedRun(stateBase, owner)) return undefined;
        if (owner) return { claimed: false, owner };
        if (!staleDir(claim)) return { claimed: false, owner: null };
      },
      // The OS start time beside the PID tells this launcher from a later
      // process that reuses its PID (ownerAlive).
      owner: () => ({
        runKey,
        promptSha256: requestDigest,
        digestVersion: REQUEST_DIGEST_VERSION,
        launchState: REQUEST_CLAIM_STATE.UNDISPATCHED,
        ...processOwner(),
        createdAt: new Date().toISOString(),
      }),
    });
  } catch (error) {
    if (error.code === CODES.GUARD_BUSY) return { claimed: false, owner: null };
    throw error;
  }
}

// Publishes the point after which a driver may be started. The request claim
// already names the run and exact digest; changing this field under its guard
// makes that possible-live identity durable before the driver gate can open.
export async function markRequestClaimPossibleLive(
  stateBase,
  requestId,
  runKey,
  requestDigest,
  { signal, timing = REAL_TIMING } = {},
) {
  if (!requestId) return true;
  const claim = requestClaimDir(stateBase, requestId);
  const release = await holdGuardPatiently(
    `${claim}.recovery`,
    "request claim is changing hands",
    signal,
    timing,
  );
  if (!release) return false;
  try {
    const ownerFile = path.join(claim, "owner.json");
    const owner = readJson(ownerFile);
    if (
      owner.runKey !== runKey ||
      owner.promptSha256 !== requestDigest ||
      owner.digestVersion !== REQUEST_DIGEST_VERSION ||
      ![REQUEST_CLAIM_STATE.UNDISPATCHED, REQUEST_CLAIM_STATE.POSSIBLE_LIVE].includes(
        owner.launchState,
      )
    )
      throw new Error(`request ${requestId} ownership changed before dispatch`);
    if (owner.launchState !== REQUEST_CLAIM_STATE.POSSIBLE_LIVE)
      atomicWrite(
        ownerFile,
        JSON.stringify({ ...owner, launchState: REQUEST_CLAIM_STATE.POSSIBLE_LIVE }),
      );
    return true;
  } finally {
    release();
  }
}

// A cleanup tombstone, <state root>/closing/<run key>.json: written before a
// closed run's folder is removed, with its request ID and result copy, and
// removed once its request claim is released. One left by an interrupted
// cleanup names a claim whose run is gone. Returns its path, or null for a
// run without a request ID.
export function writeTombstone(stateBase, run) {
  if (!run.requestId) return null;
  const dir = path.join(stateBase, "closing");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${run.runKey}.json`);
  atomicWrite(
    file,
    JSON.stringify({
      runKey: run.runKey,
      requestId: run.requestId,
      resultFile: run.result?.resultFile ?? null,
      closedAt: new Date().toISOString(),
    }),
  );
  return file;
}

// Whether owner, a request claim's owner, names a run a cleanup closed: its
// tombstone is there and its folder is gone.
function closedRun(stateBase, owner) {
  return (
    RUN_KEY.test(owner?.runKey ?? "") &&
    !fs.existsSync(path.join(stateBase, owner.runKey)) &&
    fs.existsSync(path.join(stateBase, "closing", `${owner.runKey}.json`))
  );
}

// Releases the claims that interrupted cleanups left to runs they removed,
// and their tombstones; a run whose folder is back keeps both.
export async function releaseClosedRunClaims(stateBase, { signal, timing } = {}) {
  const dir = path.join(stateBase, "closing");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  for (const name of names) {
    let tombstone;
    try {
      tombstone = readJson(path.join(dir, name));
    } catch {
      continue;
    }
    if (!RUN_KEY.test(tombstone?.runKey ?? "") || `${tombstone.runKey}.json` !== name) continue;
    if (fs.existsSync(path.join(stateBase, tombstone.runKey))) continue;
    if (
      !REQUEST_ID.test(tombstone.requestId ?? "") ||
      (await releaseRequestClaim(stateBase, tombstone.requestId, tombstone.runKey, {
        signal,
        timing,
      }))
    )
      fs.rmSync(path.join(dir, name), { force: true });
  }
}

export async function releaseRequestClaim(
  stateBase,
  requestId,
  runKey,
  { timing = REAL_TIMING } = {},
) {
  if (!requestId) return true;
  // Claim cleanup is bounded, but independent of command cancellation. A
  // caller abort after the launch failed must not strand this ownership.
  return releaseOwnedFolder(requestClaimDir(stateBase, requestId), runKey, undefined, timing, true);
}

export async function releaseDamagedClaims(stateBase, runKey, { signal, timing }) {
  const pending = [];
  for (const kind of [STATE_CLAIM_DIRECTORY.REQUESTS, STATE_CLAIM_DIRECTORY.WRITERS]) {
    const root = path.join(stateBase, kind);
    if (!fs.existsSync(root)) continue;
    requireDirectory(root);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.endsWith(".lock")) continue;
      const folder = path.join(root, entry.name);
      try {
        let owner;
        try {
          owner = readJson(path.join(folder, "owner.json"));
        } catch (error) {
          // Other launchers publish/remove claims concurrently. An incomplete
          // owner does not prove ownership by this run and must be left alone.
          if (error.code === ERRNO.ENOENT || error.code === CODES.INVALID_JSON || deleting(error))
            continue;
          throw error;
        }
        if (
          owner?.runKey === runKey &&
          !(await releaseOwnedFolder(
            folder,
            runKey,
            signal,
            timing,
            kind === STATE_CLAIM_DIRECTORY.REQUESTS,
          ))
        )
          pending.push(`claim stayed busy at ${folder}`);
      } catch (error) {
        pending.push(`${folder}: ${error.message}`);
      }
    }
  }
  if (pending.length) throw new Error(pending.join("; "));
}

// The state roots an invocation searches for an existing run: its own, then
// the one runs were kept in before (environmentPaths), when that applies.
// The owner of a request's claim in a state root, or null without a readable one.
export function claimOwner(stateBase, requestId) {
  try {
    return readJson(path.join(requestClaimDir(stateBase, requestId), "owner.json"));
  } catch {
    return null;
  }
}

// Batch coordinators use this durable distinction to preserve process bounds:
// only a proven unstarted child frees a slot; incomplete or damaged identity
// remains possible-live. The caller still validates the exact request digest.
export function requestClaimStatus(stateBase, requestId) {
  const claim = requestClaimDir(stateBase, requestId);
  let owner;
  try {
    owner = readJson(path.join(claim, "owner.json"));
  } catch (error) {
    if (error.code !== ERRNO.ENOENT)
      return { state: REQUEST_CLAIM_STATE.POSSIBLE_LIVE, owner: null };
    return {
      state:
        fs.existsSync(claim) || fs.existsSync(`${claim}.recovery`)
          ? REQUEST_CLAIM_STATE.POSSIBLE_LIVE
          : REQUEST_CLAIM_STATE.UNDISPATCHED,
      owner: null,
    };
  }
  if (RUN_KEY.test(owner?.runKey ?? "") && fs.existsSync(path.join(stateBase, owner.runKey)))
    return { state: REQUEST_CLAIM_STATE.RECORDED, owner };
  // The phase alone proves only that no worker exists yet. A live launcher can
  // still advance it after this read, so only dead ownership frees a slot.
  if (provenUndispatchedClaim(stateBase, owner) && !ownerAlive(owner))
    return { state: REQUEST_CLAIM_STATE.UNDISPATCHED, owner };
  if (closedRun(stateBase, owner)) return { state: REQUEST_CLAIM_STATE.CLOSED, owner };
  return { state: REQUEST_CLAIM_STATE.POSSIBLE_LIVE, owner };
}

export function retainedRuns(stateBase) {
  let entries = [];
  try {
    entries = fs.readdirSync(stateBase, { withFileTypes: true });
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_KEY.test(entry.name)) continue;
    const dir = path.join(stateBase, entry.name);
    let run = null;
    try {
      const record = readRunFile(dir);
      run =
        isLegacyRun(record) && record.runKey === entry.name
          ? record
          : validateRun(record, entry.name, dir);
    } catch {
      /* Legacy or damaged metadata is listed, not hidden. */
    }
    runs.push({ key: entry.name, dir, run, root: stateBase });
  }
  return runs;
}

// Whether a run's cached result reached anyone: its durable copy was written
// (durableSavedAt) or stdout accepted it (acknowledgedAt). A record without
// positive delivery milestones counts as undelivered; caching alone proves no delivery.
export function isDelivered(run) {
  const result = run?.result;
  if (!result) return false;
  return Boolean(result.durableSavedAt || result.acknowledgedAt);
}

// When a run's last result was fetched: the stored result's deliveredAt, which
// the runner sets when it caches a fetched result (with cachedAt, before the
// durable copy or stdout see it, so it is no evidence of delivery: isDelivered
// says that), or for a record without one the time result.txt was written. The
// sweeps' ages and --list's delivered= column read it.
export function resultFetchedAt(dir, run) {
  if (!run?.result) return null;
  if (run.result.deliveredAt) return run.result.deliveredAt;
  try {
    return fs.statSync(path.join(dir, "result.txt")).mtime.toISOString();
  } catch {
    return run.createdAt ?? null;
  }
}

export function liveWaiter(stateBase, key) {
  try {
    const owner = readJson(path.join(stateBase, `${key}.lock`, "owner.json"));
    return ownerAlive(owner) ? owner.pid : null;
  } catch {
    return null;
  }
}

// The delivery preferences a run recorded at its launch (or an attach
// overrode): how its result is printed and how its exit code is chosen.
/** @param {import('../shared/types.mjs').RunRecord} run @returns {import('../shared/types.mjs').DeliveryPreferences} */
export function deliveryPreferences(run) {
  return {
    quiet: run.quiet ?? false,
    relay: run.relay ?? false,
    maxLines: run.maxStdoutLines ?? 0,
    maxBytes: run.maxStdoutBytes ?? 0,
  };
}

// The retained run that holds a request's claim, or null once it is gone.
export function claimedRun(stateBase, requestId) {
  let owner = null;
  try {
    owner = readJson(path.join(requestClaimDir(stateBase, requestId), "owner.json"));
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
  }
  return owner &&
    RUN_KEY.test(owner.runKey ?? "") &&
    fs.existsSync(path.join(stateBase, owner.runKey))
    ? owner.runKey
    : null;
}

// Takes the lock of a retained run: { kind: RUN_LOCK_OUTCOME.LOCKED, releaseRunLock }. When another
// live process holds it: a cancel whose interrupt was already sent reports the
// holder at once (that waiter delivers the terminal record), an attach waits
// for the holder within its budget and then reports it, and any other mode
// fails. Returns { kind: RUN_LOCK_OUTCOME.HELD, holder } with the holder's PID.
export async function acquireRunLock(
  key,
  { stateBase, deadline, mode, cancelSent, signal, timing = REAL_TIMING },
) {
  let busySince = null;
  for (;;) {
    try {
      return { kind: RUN_LOCK_OUTCOME.LOCKED, releaseRunLock: acquireLock(stateBase, key) };
    } catch (error) {
      // Several processes taking the lock at once: wait for the one that wins
      // (an attach then waits for it like for any other waiter).
      if (error.code === CODES.RUN_LOCK_BUSY) {
        busySince ??= timing.now();
        if (timing.now() - busySince < LOCK_TAKEOVER_MS) {
          await timing.sleep(LOCK_RETRY_MS, signal);
          continue;
        }
        throw new RunnerError(
          CODES.RUN_LOCK_STUCK,
          `run ${key}'s lock kept changing hands for ${LOCK_TAKEOVER_MS / SECOND_MS} s${error.detail ? ` (last: ${error.detail})` : ""}; retry, or look at it with --inspect ${key}`,
        );
      }
      busySince = null;
      const holder = error.code === CODES.RUN_LOCK_HELD ? String(error.pid) : null;
      if (holder && cancelSent) return { kind: RUN_LOCK_OUTCOME.HELD, holder };
      if (!holder || mode !== "attach") throw error;
      if (timing.now() >= deadline) return { kind: RUN_LOCK_OUTCOME.HELD, holder };
      await timing.sleep(
        Math.max(1, Math.min(HELD_LOCK_POLL_MS, Math.floor(deadline - timing.now()))),
        signal,
      );
    }
  }
}
