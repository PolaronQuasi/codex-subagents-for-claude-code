// Receipts beside durable results survive run-state deletion. A thread name is
// discoverability, never sufficient authority to archive across state roots.
import fs from "node:fs";
import path from "node:path";
import {
  THREAD_OWNER_DIRECTORY,
  THREAD_OWNER_BYTES,
  THREAD_OWNER_VERSION,
  THREAD_ID,
  RUN_KEY,
  IS_WINDOWS,
} from "../shared/constants.mjs";
import { atomicWrite, digest, readLimited, requireDirectory } from "../shared/io.mjs";
import { requireDurableDestination } from "../delivery/result-path.mjs";
import { guardedCacheWrite } from "./cache-write.mjs";
import { ERRNO } from "../shared/errors.mjs";

export function stateRootHash(stateBase) {
  let root = path.resolve(stateBase);
  try {
    root = fs.realpathSync.native(root);
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
  }
  return digest(IS_WINDOWS ? root.toLowerCase() : root);
}
function receiptFile(resultsDir, threadId) {
  if (!THREAD_ID.test(threadId ?? "")) throw new Error("invalid thread receipt identity");
  return path.join(resultsDir, THREAD_OWNER_DIRECTORY, `${digest(threadId)}.json`);
}
export function readThreadOwner(resultsDir, threadId, stateBase) {
  try {
    const file = receiptFile(resultsDir, threadId);
    requireDirectory(resultsDir);
    requireDirectory(path.dirname(file));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
    const value = JSON.parse(readLimited(file, THREAD_OWNER_BYTES).toString("utf8"));
    if (
      value.version !== THREAD_OWNER_VERSION ||
      value.threadId !== threadId ||
      value.stateRoot !== stateRootHash(stateBase) ||
      !RUN_KEY.test(value.runKey ?? "") ||
      typeof value.name !== "string" ||
      !Number.isFinite(Date.parse(value.at))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function rememberThread(
  run,
  { stateBase, stateDir, resultsDir },
  { threadId, name = "", archived = false },
) {
  if (!THREAD_ID.test(threadId ?? "") || !RUN_KEY.test(run.runKey)) return false;
  const file = receiptFile(resultsDir, threadId);
  requireDurableDestination(file, run, stateDir);
  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  requireDirectory(resultsDir);
  return guardedCacheWrite(file, () => {
    const existing = readThreadOwner(resultsDir, threadId, stateBase);
    // Never adopt an unrelated or damaged existing receipt.
    if (fs.existsSync(file) && (!existing || existing.runKey !== run.runKey)) return false;
    const acceptedAt = run.shutdownUnconfirmedAcceptedAt ?? existing?.shutdownUnconfirmedAcceptedAt;
    const record = {
      version: THREAD_OWNER_VERSION,
      stateRoot: stateRootHash(stateBase),
      runKey: run.runKey,
      threadId,
      name,
      at: new Date().toISOString(),
      archived: Boolean(archived),
      ...(acceptedAt
        ? {
            shutdownUnconfirmedAcceptedAt: acceptedAt,
            shutdownUnconfirmedReason: "unknown-process-tree",
          }
        : {}),
    };
    const text = JSON.stringify(record);
    if (Buffer.byteLength(text) > THREAD_OWNER_BYTES) return false;
    atomicWrite(file, text);
    return true;
  });
}
