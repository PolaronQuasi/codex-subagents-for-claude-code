// The state root's model catalogue cache (MODELS_FILE): model/list's answer
// for one CLI build and UTC day, so most launches send no model/list. The
// waiter and doctor write it; a driver only reads what its plan carries.
import path from "node:path";
import {
  MODELS_FILE,
  JOB_MAX_RECORD_BYTES,
  JOB_ATOMIC_RENAME_RETRIES,
} from "../shared/constants.mjs";
import { atomicWrite, readLimited } from "../shared/io.mjs";
import { guardedCacheWrite } from "./cache-write.mjs";

// A cached catalogue has the kept shape (catalogModel, codex/models.mjs);
// anything else is no catalogue.
const validCatalog = (models) =>
  Array.isArray(models) &&
  models.every(
    (entry) => typeof entry?.id === "string" && entry.id && Array.isArray(entry.efforts),
  );

export const modelsFile = (stateBase) => path.join(stateBase, MODELS_FILE);
// The UTC day of a moment: 2026-10-31.
export const utcDay = (at = Date.now()) => new Date(at).toISOString().replace(/T.*$/, "");

function readCatalog(stateBase) {
  try {
    const cache = JSON.parse(
      readLimited(modelsFile(stateBase), JOB_MAX_RECORD_BYTES).toString("utf8"),
    );
    return typeof cache?.build === "string" &&
      typeof cache.day === "string" &&
      validCatalog(cache.models)
      ? cache
      : null;
  } catch {
    return null;
  }
}

// The cached catalogue of this build for today, or null.
export function readModelCache(stateBase, build, day = utcDay()) {
  const cache = readCatalog(stateBase);
  return cache && cache.build === build && cache.day === day ? cache : null;
}

export function writeModelCache(stateBase, catalog) {
  if (
    typeof catalog?.build !== "string" ||
    typeof catalog.day !== "string" ||
    !validCatalog(catalog.models)
  )
    return false;
  const { build, day, at = new Date().toISOString(), models } = catalog;
  const seen = Date.parse(at);
  if (!Number.isFinite(seen)) return false;
  return guardedCacheWrite(modelsFile(stateBase), () => {
    const current = readCatalog(stateBase);
    if (current && Date.parse(current.at) > seen) return false;
    atomicWrite(modelsFile(stateBase), `${JSON.stringify({ build, day, at, models })}\n`, {
      renameRetries: JOB_ATOMIC_RENAME_RETRIES,
    });
    return true;
  });
}
