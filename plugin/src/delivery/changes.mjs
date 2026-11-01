// Delivery-owned evidence supplements Codex's patch-tool observations. Only
// isolated workspaces can be attributed to this run; shared checkouts cannot.
import fs from "node:fs";
import path from "node:path";
import {
  CHANGE_MAX_ENTRIES,
  CHANGE_MAX_PATH_BYTES,
  CHANGE_SOURCE,
  PATCH_STATUS,
  DIFF_MAX_BYTES,
  PROGRESS_MODE,
  validJobId,
  JOB_READ_POLICY,
} from "../shared/constants.mjs";
import { atomicWrite, digest, readLimited, requireDirectory } from "../shared/io.mjs";
import { worktreeDiff } from "../shared/workspace.mjs";
import { jobPromptRedactor } from "../state/prompt-inputs.mjs";
import { readDriver } from "../state/job-store.mjs";

function patchFile(stateDir, jobId) {
  if (!validJobId(jobId)) throw new Error("invalid change evidence job identity");
  requireDirectory(stateDir);
  return path.join(stateDir, `changes-${jobId}.patch`);
}

function boundedPaths(paths) {
  let bytes = 0;
  const kept = [];
  for (const file of paths) {
    bytes += Buffer.byteLength(file);
    if (kept.length >= CHANGE_MAX_ENTRIES || bytes > CHANGE_MAX_PATH_BYTES)
      throw new Error(
        "workspace change inventory exceeds its limit; state retained for manual review",
      );
    kept.push(file.replace(/[\x00-\x1f\x7f]/g, "?"));
  }
  return kept;
}

function scratchPaths(cwd) {
  requireDirectory(cwd);
  const pending = [cwd],
    files = [];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop();
    requireDirectory(directory); // Reject junctions, including a replaced parent.
    const handle = fs.opendirSync(directory);
    try {
      for (let entry; (entry = handle.readSync());) {
        if (++visited > CHANGE_MAX_ENTRIES)
          throw new Error("scratch inventory exceeds its limit; state retained for manual review");
        const full = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(full);
        else files.push(path.relative(cwd, full).split(path.sep).join("/"));
      }
    } finally {
      handle.closeSync();
    }
  }
  return files.sort();
}

export async function cacheChanges(run, { stateDir, signal, warn }) {
  if (!run.worktree && !run.scratchWorkspace) return;
  const source = run.worktree ? CHANGE_SOURCE.GIT : CHANGE_SOURCE.SCRATCH;
  const paths = run.worktree
    ? (await worktreeDiff(run, { names: true, signal })).split("\0").filter(Boolean)
    : scratchPaths(run.cwd);
  run.result.touchedFiles = boundedPaths(paths);
  const changes = (run.result.changes = {
    source,
    patch: run.progress === PROGRESS_MODE.OFF ? PATCH_STATUS.OFF : PATCH_STATUS.NOT_RECORDED,
    ...(run.worktree ? { base: run.worktree.startCommit, head: run.result.commit } : {}),
  });
  if (!run.worktree || changes.patch === PATCH_STATUS.OFF) return;
  try {
    const patch = await worktreeDiff(run, { signal });
    const redactor = jobPromptRedactor(
      stateDir,
      readDriver(stateDir, run.jobId, { policy: JOB_READ_POLICY.STRICT }),
    );
    const text = redactor.redact(patch, DIFF_MAX_BYTES);
    // Atomic replacement cannot write through a pre-existing linked leaf.
    atomicWrite(patchFile(stateDir, run.jobId), text);
    changes.sha256 = digest(text);
    changes.patch = !patch
      ? PATCH_STATUS.EMPTY
      : Buffer.byteLength(patch) > DIFF_MAX_BYTES || Buffer.byteLength(text) >= DIFF_MAX_BYTES
        ? PATCH_STATUS.TRUNCATED
        : PATCH_STATUS.COMPLETE;
  } catch {
    signal?.throwIfAborted();
    changes.patch = PATCH_STATUS.UNAVAILABLE;
    await warn(
      "Committed files were counted, but the bounded Git patch could not be saved; inspect the retained branch with Git.",
    );
  }
}

export function readChangesPatch(run, stateDir) {
  const file = patchFile(stateDir, run.jobId);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("unsafe committed patch file; state retained");
  const bytes = readLimited(file, DIFF_MAX_BYTES);
  if (digest(bytes) !== run.result.changes.sha256)
    throw new Error("committed patch checksum mismatch; state retained");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
