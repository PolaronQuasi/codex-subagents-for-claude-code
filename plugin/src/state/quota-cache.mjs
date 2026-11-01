// The state root's quota cache (QUOTA_FILE): one normalized snapshot, the
// latest a read or a delivered turn saw. Readers, a status line among them,
// never start a process; a damaged or missing file reads as no cache.
import path from "node:path";
import {
  QUOTA_FILE,
  QUOTA_FILE_BYTES,
  QUOTA_SOURCE,
  JOB_ATOMIC_RENAME_RETRIES,
  LIMITS_LOGIN,
} from "../shared/constants.mjs";
import { atomicWrite, readLimited } from "../shared/io.mjs";
import { guardedCacheWrite } from "./cache-write.mjs";

export const quotaFile = (stateBase) => path.join(stateBase, QUOTA_FILE);
const seenAt = (entry) => Date.parse(entry?.at ?? "");
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const windowShape = (value) =>
  value == null || (object(value) && Number.isFinite(value.usedPercent) && value.usedPercent >= 0);
const validEntry = (entry) =>
  object(entry) &&
  Number.isFinite(seenAt(entry)) &&
  Object.values(QUOTA_SOURCE).includes(entry.source) &&
  windowShape(entry.primary) &&
  windowShape(entry.secondary) &&
  (entry.credits == null || object(entry.credits)) &&
  (entry.buckets == null ||
    (Array.isArray(entry.buckets) &&
      entry.buckets.every(
        (bucket) =>
          object(bucket) &&
          typeof bucket.limitId === "string" &&
          windowShape(bucket.primary) &&
          windowShape(bucket.secondary),
      )));

export function readQuotaCache(stateBase) {
  try {
    const entry = JSON.parse(readLimited(quotaFile(stateBase), QUOTA_FILE_BYTES).toString("utf8"));
    return validEntry(entry) ? entry : null;
  } catch {
    return null;
  }
}

// Status-only observations and logout markers supersede older quota too.
// The final rename retries as the job store's do,
// since a status line may be reading the file.
export function writeQuotaCache(stateBase, entry) {
  if (!validEntry(entry)) return false;
  return guardedCacheWrite(quotaFile(stateBase), () => {
    const current = readQuotaCache(stateBase);
    if (current && seenAt(current) > seenAt(entry)) return false;
    atomicWrite(quotaFile(stateBase), `${JSON.stringify(entry)}\n`, {
      renameRetries: JOB_ATOMIC_RENAME_RETRIES,
    });
    return true;
  });
}

// A timestamped marker prevents a delayed older delivery from restoring the
// previous account's quota after an observed logout. It contains no identity.
export const writeQuotaLogout = (stateBase, at = new Date().toISOString()) =>
  writeQuotaCache(stateBase, { at, source: QUOTA_SOURCE.READ, login: LIMITS_LOGIN.OUT });
