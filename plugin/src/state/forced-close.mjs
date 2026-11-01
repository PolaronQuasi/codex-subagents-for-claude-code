// Mandatory evidence for accepting an unknown process tree. Unlike best-effort
// invocation logs, failure to save this receipt prevents destructive cleanup.
import fs from "node:fs";
import path from "node:path";
import { auditDirectory } from "../shared/audit.mjs";
import { atomicWrite, readLimited, requireDirectory } from "../shared/io.mjs";
import {
  MAX_AUDIT_BYTES,
  MAX_FOOTER_BYTES,
  ARTIFACT_BYTES,
  WORKER_STATE,
  JSON_INDENT,
} from "../shared/constants.mjs";
import { isMissing } from "../shared/errors.mjs";
import { requireDurableDestination } from "../delivery/result-path.mjs";
import { readDurableCopy, shutdownMarker } from "../delivery/output.mjs";
import { stateRootHash, readThreadOwner, rememberThread } from "./thread-owners.mjs";
import { artifactFile, readArtifact } from "./artifact-store.mjs";
import { guardedCacheWrite } from "./cache-write.mjs";

const receiptFile = (resultsDir, key) =>
  path.join(auditDirectory(resultsDir, key), "forced-close.json");

export function readForcedClose(key, { resultsDir, stateBase }) {
  const file = receiptFile(resultsDir, key);
  try {
    requireDirectory(path.dirname(file));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("unsafe forced-close receipt");
    const receipt = JSON.parse(readLimited(file, MAX_AUDIT_BYTES).toString("utf8"));
    if (
      receipt.version !== 1 ||
      receipt.runKey !== key ||
      receipt.stateRoot !== stateRootHash(stateBase) ||
      receipt.reason !== "unknown-process-tree" ||
      !Number.isFinite(Date.parse(receipt.shutdownUnconfirmedAcceptedAt))
    )
      throw new Error("invalid or foreign forced-close receipt; state retained");
    return receipt;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function acceptUnknownShutdown(run, jobs, context) {
  const { resultsDir, stateBase, stateDir, save, warn } = context;
  const file = receiptFile(resultsDir, run.runKey);
  requireDurableDestination(file, run, stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  requireDirectory(path.dirname(file));
  const old = readForcedClose(run.runKey, context);
  const acceptedAt = old?.shutdownUnconfirmedAcceptedAt ?? new Date().toISOString();
  const receipt = {
    version: 1,
    runKey: run.runKey,
    stateRoot: stateRootHash(stateBase),
    shutdownUnconfirmedAcceptedAt: acceptedAt,
    reason: "unknown-process-tree",
    jobs,
  };
  const text = JSON.stringify(receipt, null, JSON_INDENT) + "\n";
  if (Buffer.byteLength(text) > MAX_AUDIT_BYTES)
    throw new Error("forced-close receipt limit reached; state retained");
  atomicWrite(file, text);
  run.shutdownUnconfirmedAcceptedAt = acceptedAt;
  save();
  for (const result of [run.result, ...(run.turns ?? []).map((turn) => turn.result)]) {
    if (result?.threadId) {
      const owner = readThreadOwner(resultsDir, result.threadId, stateBase);
      if (owner?.runKey === run.runKey && !rememberThread(run, context, owner))
        throw new Error("thread receipt could not record unconfirmed shutdown; state retained");
    }
    if (!result?.resultFile || !fs.existsSync(result.resultFile)) continue;
    requireDurableDestination(result.resultFile, run, stateDir, { existing: true });
    const { body, footer, identity } = readDurableCopy(result.resultFile);
    if (identity.run !== run.runKey) throw new Error("foreign result copy; state retained");
    const updated =
      footer.replace(/^codex-subagents-for-claude-code-shutdown:.*\n/gm, "") +
      shutdownMarker(acceptedAt) +
      "\n";
    if (Buffer.byteLength(updated) > MAX_FOOTER_BYTES)
      throw new Error("result footer limit reached; state retained");
    atomicWrite(result.resultFile, body + updated);
  }
  const artifact = artifactFile(resultsDir, run.runKey);
  if (
    fs.existsSync(artifact) &&
    !guardedCacheWrite(artifact, () => {
      const current = readArtifact(run.runKey, context);
      const updated =
        JSON.stringify(
          {
            ...current,
            shutdownUnconfirmedAcceptedAt: acceptedAt,
            shutdownUnconfirmedReason: receipt.reason,
          },
          null,
          JSON_INDENT,
        ) + "\n";
      if (Buffer.byteLength(updated) > ARTIFACT_BYTES)
        throw new Error("artifact receipt limit reached; state retained");
      atomicWrite(artifact, updated);
      return true;
    })
  )
    throw new Error("artifact publisher is busy; state retained");
  const pids = [
    ...new Set(
      jobs.flatMap((job) =>
        job.processes
          .filter((target) => target.state === WORKER_STATE.UNKNOWN)
          .map((target) => target.pid),
      ),
    ),
  ];
  await warn(
    `Run ${run.runKey}: shutdown was NOT confirmed; --force accepts an unknown process tree. Unconfirmed PIDs: ${pids.length ? pids.join(", ") : "none recorded; uncaptured descendants may remain"}. Evidence: ${file}`,
  );
}
