import { ARTIFACT_BYTES } from "../shared/constants.mjs";
// Durable artifact identity is separate from ephemeral run state. Names alone
// never authorize integration, retirement, or verification.
import fs from "node:fs";
import path from "node:path";
import { RUN_KEY, IS_WINDOWS } from "../shared/constants.mjs";
import { atomicWrite, digest, readLimited, requireDirectory } from "../shared/io.mjs";
import { workspaceGit as git } from "../shared/workspace.mjs";
import { stateRootHash } from "./thread-owners.mjs";
import { guardedCacheWrite } from "./cache-write.mjs";
import { requireDurableDestination } from "../delivery/result-path.mjs";

const sha = /^[0-9a-f]{40}$/;
export function artifactFile(resultsDir, key) {
  if (!RUN_KEY.test(key ?? "")) throw new Error("artifact needs a full run key");
  return path.join(resultsDir, "artifacts", key + ".json");
}
export async function repositoryIdentity(dir, options = {}) {
  if ((await git(["rev-parse", "--show-object-format"], dir, options)) !== "sha1")
    throw new Error("Git SHA-256 repositories are unsupported");
  const common = fs.realpathSync.native(
    await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir, options),
  );
  requireDirectory(common);
  const stat = fs.statSync(common, { bigint: true });
  return {
    common,
    identity: digest(
      JSON.stringify([
        IS_WINDOWS ? common.toLowerCase() : common,
        String(stat.dev),
        String(stat.ino),
      ]),
    ),
  };
}
export function readArtifact(key, { resultsDir, stateBase }) {
  const file = artifactFile(resultsDir, key);
  requireDirectory(resultsDir);
  requireDirectory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("unsafe artifact receipt");
  const value = JSON.parse(readLimited(file, ARTIFACT_BYTES).toString("utf8"));
  if (
    !value ||
    value.version !== 1 ||
    value.runKey !== key ||
    value.stateRoot !== stateRootHash(stateBase) ||
    !path.isAbsolute(value.repository ?? "") ||
    !path.isAbsolute(value.common ?? "") ||
    !/^[a-f0-9]{64}$/.test(value.repositoryIdentity ?? "") ||
    ![value.base, value.commit, value.tree].every((id) => sha.test(id ?? "")) ||
    !(
      value.branch === null ||
      /^(?:csfcc\/[a-f0-9]{20}|codex-subagents-for-claude-code\/[a-f0-9]{32})$/.test(
        value.branch ?? "",
      )
    ) ||
    !/^[a-f0-9]{64}$/.test(value.resultSha256 ?? "") ||
    typeof value.sealed !== "boolean" ||
    !Number.isInteger(value.turn) ||
    value.turn < 1 ||
    !path.isAbsolute(value.resultFile ?? "")
  )
    throw new Error("invalid or foreign artifact receipt; nothing changed");
  return value;
}
export function updateArtifact(receipt, context, update) {
  const file = artifactFile(context.resultsDir, receipt.runKey);
  const changed = guardedCacheWrite(file, () => {
    const current = readArtifact(receipt.runKey, context);
    if (
      current.commit !== receipt.commit ||
      current.resultSha256 !== receipt.resultSha256 ||
      !current.sealed
    )
      throw new Error("artifact changed; nothing changed");
    const next = update(current);
    const text = JSON.stringify(next, null, 2) + "\n";
    if (Buffer.byteLength(text) > ARTIFACT_BYTES) throw new Error("artifact receipt limit reached");
    atomicWrite(file, text);
    return next;
  });
  if (!changed) throw new Error("artifact publisher is busy; retry later");
  return changed;
}
export async function recordArtifact(run, context) {
  if (!run.worktree || !run.result?.commit || !run.result.resultFile) return null;
  const { stateDir, resultsDir, stateBase, signal } = context;
  const repo = await repositoryIdentity(run.worktree.base, { signal });
  if (
    run.worktree.branch &&
    (await git(
      ["rev-parse", "--verify", `refs/heads/${run.worktree.branch}^{commit}`],
      run.worktree.base,
      { signal },
    )) !== run.result.commit
  )
    throw new Error("artifact branch does not point at the delivered commit; state retained");
  const tree = await git(["rev-parse", run.result.commit + "^{tree}"], run.worktree.base, {
    signal,
  });
  const receipt = {
    version: 1,
    runKey: run.runKey,
    stateRoot: stateRootHash(stateBase),
    repository: fs.realpathSync(run.worktree.base),
    common: repo.common,
    repositoryIdentity: repo.identity,
    base: run.worktree.startCommit,
    commit: run.result.commit,
    tree,
    branch: run.worktree.branch,
    jobId: run.jobId,
    turn: (run.turns?.length ?? 0) + 1,
    status: run.result.status,
    model: run.model,
    effort: run.effort,
    requestId: run.turnRequestId ?? run.requestId ?? null,
    resultSha256: run.result.sha256,
    resultFile: run.result.resultFile,
    sealed: Boolean(run.sealed),
    at: new Date().toISOString(),
    ...(run.shutdownUnconfirmedAcceptedAt
      ? {
          shutdownUnconfirmedAcceptedAt: run.shutdownUnconfirmedAcceptedAt,
          shutdownUnconfirmedReason: "unknown-process-tree",
        }
      : {}),
  };
  const file = artifactFile(resultsDir, run.runKey);
  requireDurableDestination(file, run, stateDir);
  if (
    !guardedCacheWrite(file, () => {
      if (fs.existsSync(file)) {
        const old = readArtifact(run.runKey, context);
        if (
          old.repositoryIdentity !== receipt.repositoryIdentity ||
          old.branch !== receipt.branch ||
          old.turn > receipt.turn ||
          (old.sealed && (old.commit !== receipt.commit || !receipt.sealed))
        )
          throw new Error("artifact identity is sealed or changed; state retained");
        if (old.sealed) return true; // Preserve operation receipts on replay/close.
      }
      atomicWrite(file, JSON.stringify(receipt, null, 2) + "\n");
      return true;
    })
  )
    throw new Error("artifact publisher is busy; state retained");
  return file;
}
export async function requireArtifactRepository(receipt, dir = receipt.repository, options = {}) {
  const current = await repositoryIdentity(dir, options);
  if (current.identity !== receipt.repositoryIdentity)
    throw new Error("repository identity changed; nothing changed");
  if ((await git(["rev-parse", receipt.commit + "^{tree}"], dir, options)) !== receipt.tree)
    throw new Error("artifact commit/tree mismatch");
}
