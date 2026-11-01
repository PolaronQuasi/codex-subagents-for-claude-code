import { EXIT, ERRNO } from "../shared/errors.mjs";
import { GIT_OPERATION_MARKERS, JOB_STATUS, JSON_INDENT, RUN_KEY } from "../shared/constants.mjs";
import fs from "node:fs";
import path from "node:path";
import { acquireRunLock, isDelivered } from "../state/state.mjs";
import { holdGuard } from "../state/guards.mjs";
import { saveRun } from "../state/run-store.mjs";
import { observeRun } from "../run/progress.mjs";
import { stopRunDriver } from "../run/lifecycle.mjs";
import { assertMaintenanceIdle } from "../state/maintenance-worker.mjs";
import { RUN_LOCK_OUTCOME } from "../shared/constants.mjs";
import {
  workspaceGit as git,
  worktreeEntries,
  requireWorktreeSnapshot,
  requireSafeGitTree,
  workspaceId,
} from "../shared/workspace.mjs";
import { requireDirectory, sameFolder, writeOutput } from "../shared/io.mjs";
import { rejectHiddenIndexEntries } from "../shared/git-security.mjs";
import {
  artifactFile,
  readArtifact,
  recordArtifact,
  requireArtifactRepository,
  updateArtifact,
} from "../state/artifact-store.mjs";

export async function finalizeArtifact(key, context) {
  const { stateBase, signal } = context;
  if (!fs.existsSync(path.join(stateBase, key))) {
    const receipt = readArtifact(key, context);
    if (!receipt.sealed) throw new Error("run state is missing and artifact is not sealed");
    return receipt;
  }
  const lock = await acquireRunLock(key, {
    stateBase,
    signal,
    deadline: Date.now(),
    mode: "finalize",
  });
  if (lock.kind !== RUN_LOCK_OUTCOME.LOCKED)
    throw new Error("run is busy; no finalization performed");
  try {
    const { run, stateDir } = observeRun(key, stateBase);
    assertMaintenanceIdle(run, context.processes);
    if (
      !run.worktree ||
      !isDelivered(run) ||
      run.result?.shutdownPending ||
      !run.dormant ||
      run.continuing ||
      run.launching ||
      run.historyOperation
    )
      throw new Error("finalization requires a delivered, sleeping worktree run");
    const save = () => saveRun(run, stateDir);
    await stopRunDriver(run, { ...context, stateDir, save, warn: async () => {} });
    await requireWorktreeSnapshot(run, { signal });
    run.sealed = true;
    save();
    await recordArtifact(run, { ...context, stateDir });
    return readArtifact(key, context);
  } finally {
    lock.releaseRunLock();
  }
}

const clean = async (dir, options) => {
  await rejectHiddenIndexEntries(git, dir, options);
  if (
    await git(
      ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
      dir,
      options,
    )
  )
    throw new Error("target checkout is dirty; nothing changed");
  for (const name of GIT_OPERATION_MARKERS) {
    const file = await git(
      ["rev-parse", "--path-format=absolute", "--git-path", name],
      dir,
      options,
    );
    if (fs.existsSync(file))
      throw new Error("target has an unfinished Git operation; nothing changed");
  }
};
export async function integrateArtifact(receipt, target, context) {
  context = { ...context, securityScope: { worktrees: new Set() } };
  if (
    !receipt.sealed ||
    receipt.status !== JOB_STATUS.COMPLETED ||
    !receipt.branch ||
    receipt.retired
  )
    throw new Error("integration needs a completed sealed branch artifact");
  target = fs.realpathSync.native(await git(["rev-parse", "--show-toplevel"], target, context));
  await requireArtifactRepository(receipt, target, context);
  const release = holdGuard(
    path.join(receipt.common, "csfcc-artifact.guard"),
    "repository artifact operation is busy",
  );
  let releaseWriter;
  try {
    fs.mkdirSync(context.stateBase, { recursive: true, mode: 0o700 });
    requireDirectory(context.stateBase);
    // A runner-owned worktree has no shared-checkout writer lock. Do not
    // advance one behind the run that owns it, even when it is momentarily clean.
    const parent = path.dirname(target);
    if (
      path.basename(target).toLowerCase() === "worktree" &&
      RUN_KEY.test(path.basename(parent)) &&
      sameFolder(path.dirname(parent), context.stateBase)
    )
      throw new Error("target is a runner-owned worktree; choose a separate checkout");
    const writers = path.join(context.stateBase, "writers");
    fs.mkdirSync(writers, { recursive: true, mode: 0o700 });
    requireDirectory(writers);
    const writer = path.join(writers, `${workspaceId(target)}.lock`);
    // This is the same guard held while a shared writer acquires its lock.
    // Keeping it for the merge excludes new writers; any existing lock is
    // conservatively retained rather than guessed stale here.
    releaseWriter = holdGuard(writer + ".recovery", "target writer lock is busy");
    try {
      fs.lstatSync(writer);
      throw new Error("target checkout has a writer lock; nothing changed");
    } catch (error) {
      if (error.code !== ERRNO.ENOENT) throw error;
    }
    await clean(target, context);
    const branch = await git(["symbolic-ref", "--quiet", "HEAD"], target, context);
    if (branch === "refs/heads/" + receipt.branch)
      throw new Error("select a separate target branch");
    const head = await git(["rev-parse", "HEAD"], target, context);
    const current = readArtifact(receipt.runKey, context);
    if (current.retired || !current.sealed)
      throw new Error("artifact is no longer available for integration");
    if (current.integration) {
      const op = current.integration;
      let sameTarget = typeof op.target === "string" && sameFolder(op.target, target);
      if (!sameTarget && typeof op.target === "string") {
        try {
          sameTarget = sameFolder(
            await git(["rev-parse", "--show-toplevel"], op.target, context),
            target,
          );
        } catch {
          /* A missing or foreign old target cannot prove identity. */
        }
      }
      if (!sameTarget || op.branch !== branch)
        throw new Error("artifact already has another integration attempt");
      if (head === receipt.commit) {
        return updateArtifact(receipt, context, (r) => ({
          ...r,
          integration: { ...op, status: "integrated" },
        }));
      }
      throw new Error(
        "previous integration is uncertain or its target moved; inspect it manually, no retry issued",
      );
    }
    if (
      (await git(["rev-parse", "refs/heads/" + receipt.branch], receipt.repository, context)) !==
      receipt.commit
    )
      throw new Error("artifact branch moved since finalization");
    await git(["merge-base", "--is-ancestor", head, receipt.commit], target, context);
    await requireSafeGitTree(target, receipt.commit, context);
    const op = {
      target: fs.realpathSync.native(target),
      branch,
      before: head,
      after: receipt.commit,
      status: "pending",
      at: new Date().toISOString(),
    };
    updateArtifact(receipt, context, (r) => ({ ...r, integration: op }));
    await clean(target, context);
    if (
      (await git(["rev-parse", "HEAD"], target, context)) !== head ||
      (await git(["symbolic-ref", "--quiet", "HEAD"], target, context)) !== branch
    )
      throw new Error("target moved; integration receipt retained");
    await git(
      ["merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", receipt.commit],
      target,
      context,
    );
    context.securityScope.worktrees.clear();
    await clean(target, context);
    if (
      (await git(["rev-parse", "HEAD"], target, context)) !== receipt.commit ||
      (await git(["symbolic-ref", "--quiet", "HEAD"], target, context)) !== branch
    )
      throw new Error("integration outcome uncertain");
    return updateArtifact(receipt, context, (r) => ({
      ...r,
      integration: { ...op, status: "integrated" },
    }));
  } finally {
    try {
      releaseWriter?.();
    } finally {
      release();
    }
  }
}
export async function retireArtifact(receipt, context) {
  if (!receipt.sealed || !receipt.branch)
    throw new Error("discard requires a sealed branch artifact");
  await requireArtifactRepository(receipt, receipt.repository, context);
  const release = holdGuard(
    path.join(receipt.common, "csfcc-artifact.guard"),
    "repository artifact operation is busy",
  );
  try {
    if (
      (await worktreeEntries(receipt.repository, context)).some(
        (entry) => entry.branch === "refs/heads/" + receipt.branch,
      )
    )
      throw new Error("branch is checked out; close its run/worktree before discarding");
    const recovery = "refs/csfcc/retired/" + receipt.runKey;
    const refs = await git(
      [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        recovery,
        "refs/heads/" + receipt.branch,
      ],
      receipt.repository,
      context,
    );
    const entries = new Map(
      refs
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ")),
    );
    if (entries.has(recovery) && entries.get(recovery) !== receipt.commit)
      throw new Error("retirement ref changed");
    const branch = entries.get("refs/heads/" + receipt.branch);
    if (branch && branch !== receipt.commit)
      throw new Error("artifact branch moved; nothing discarded");
    if (!branch && entries.get(recovery) !== receipt.commit)
      throw new Error("branch disappeared without recovery evidence");
    if (!entries.has(recovery))
      await git(
        ["update-ref", recovery, receipt.commit, "0".repeat(40)],
        receipt.repository,
        context,
      );
    if (branch)
      await git(
        ["update-ref", "-d", "refs/heads/" + receipt.branch, receipt.commit],
        receipt.repository,
        context,
      );
    return updateArtifact(receipt, context, (r) => ({
      ...r,
      retired: { ref: recovery, commit: receipt.commit, at: new Date().toISOString() },
    }));
  } finally {
    release();
  }
}
export async function artifacts(options, context) {
  let receipt =
    options.mode === "finalize"
      ? await finalizeArtifact(options.key, context)
      : readArtifact(options.key, context);
  if (options.mode === "integrate")
    receipt = await integrateArtifact(receipt, path.resolve(context.cwd, options.target), context);
  if (options.mode === "discard") receipt = await retireArtifact(receipt, context);
  await writeOutput(
    context.stdout,
    JSON.stringify(
      { ...receipt, receipt: artifactFile(context.resultsDir, receipt.runKey) },
      null,
      JSON_INDENT,
    ) + "\n",
  );
  return EXIT.COMPLETED;
}
