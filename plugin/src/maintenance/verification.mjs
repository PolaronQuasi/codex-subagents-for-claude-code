import { EXIT } from "../shared/errors.mjs";
import {
  VERIFY_RECEIPT_BYTES,
  RECIPE_BYTES,
  VERIFY_ARGS_MAX,
  VERIFY_VALUE_CHARS,
  VERIFY_ENV_MAX,
  VERIFY_TIMEOUT_MS,
  VERIFY_TIMEOUT_MAX_MS,
  VERIFY_LOG_BYTES,
  VERIFY_LOG_MAX_BYTES,
  VERIFY_EXECUTABLE_BYTES,
  VERIFY_TREE_ENTRIES_MAX,
  VERIFY_ERROR_CHARS,
  VERIFY_STATUS,
  IS_WINDOWS,
} from "../shared/constants.mjs";
// Caller-owned verification of an exact sealed artifact. It never resumes a
// model, installs dependencies implicitly, or reruns a recorded attempt.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { RUN_KEY, validRequestId } from "../shared/constants.mjs";
import {
  atomicWrite,
  digest,
  readLimited,
  requireDirectory,
  writeOutput,
  isAbsolutePath,
} from "../shared/io.mjs";
import { workspaceGit as git, removeWorktree } from "../shared/workspace.mjs";
import { holdGuard } from "../state/guards.mjs";
import { readArtifact, requireArtifactRepository } from "../state/artifact-store.mjs";
import { stateRootHash } from "../state/thread-owners.mjs";
import { executeVerification } from "../verification/process.mjs";
import {
  snapshotFiles,
  compareSnapshotFiles,
  snapshotControl,
  unchangedControl,
} from "../verification/files.mjs";

const receiptFile = (context, key, attempt) =>
  path.join(context.resultsDir, "verifications", key, attempt + ".json");
export function readVerification(key, attempt, context) {
  if (!RUN_KEY.test(key ?? "") || !validRequestId(attempt))
    throw new Error("invalid verification identity");
  const file = receiptFile(context, key, attempt),
    stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("unsafe verification receipt");
  const receipt = JSON.parse(readLimited(file, VERIFY_RECEIPT_BYTES).toString("utf8"));
  if (
    !receipt ||
    receipt.version !== 1 ||
    receipt.runKey !== key ||
    receipt.attempt !== attempt ||
    receipt.stateRoot !== stateRootHash(context.stateBase) ||
    !/^[a-f0-9]{64}$/.test(receipt.recipeSha256 ?? "") ||
    !Object.values(VERIFY_STATUS).includes(receipt.outcome)
  )
    throw new Error("invalid or foreign verification receipt");
  return receipt;
}
function verificationView(receipt, file) {
  const metadata = { ...receipt, receipt: file };
  // The private receipt preserves the exact recipe; stdout never echoes argv
  // or environment values that may contain credentials.
  delete metadata.recipe;
  return metadata;
}
function recipeFrom(file) {
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(readLimited(file, RECIPE_BYTES)),
  );
  if (
    !value ||
    Object.keys(value).some(
      (key) => !["version", "executable", "args", "env", "timeoutMs", "maxLogBytes"].includes(key),
    ) ||
    value.version !== 1 ||
    !isAbsolutePath(value.executable ?? "") ||
    !Array.isArray(value.args) ||
    value.args.length > VERIFY_ARGS_MAX ||
    value.args.some(
      (arg) => typeof arg !== "string" || arg.length > VERIFY_VALUE_CHARS || arg.includes("\0"),
    ) ||
    (value.env !== undefined &&
      (!value.env ||
        typeof value.env !== "object" ||
        Array.isArray(value.env) ||
        Object.keys(value.env).length > VERIFY_ENV_MAX ||
        Object.entries(value.env).some(
          ([key, v]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
            typeof v !== "string" ||
            v.includes("\0") ||
            v.length > VERIFY_VALUE_CHARS,
        )))
  )
    throw new Error(
      "invalid verification recipe: explicit executable, argv and optional environment required",
    );
  value.timeoutMs ??= VERIFY_TIMEOUT_MS;
  value.maxLogBytes ??= VERIFY_LOG_BYTES;
  value.env ??= {};
  if (
    IS_WINDOWS &&
    new Set(Object.keys(value.env).map((key) => key.toUpperCase())).size !==
      Object.keys(value.env).length
  )
    throw new Error("verification environment contains conflicting Windows variable names");
  if (
    !Number.isInteger(value.timeoutMs) ||
    value.timeoutMs < 1 ||
    value.timeoutMs > VERIFY_TIMEOUT_MAX_MS ||
    !Number.isInteger(value.maxLogBytes) ||
    value.maxLogBytes < 1 ||
    value.maxLogBytes > VERIFY_LOG_MAX_BYTES
  )
    throw new Error("verification timeout/log limits are out of range");
  return value;
}
async function hashExecutable(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > VERIFY_EXECUTABLE_BYTES)
    throw new Error("verification executable is not a bounded regular file");
  const hash = crypto.createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
async function snapshot(receipt, directory, context) {
  const tree = await git(["ls-tree", "-rz", receipt.commit], receipt.repository, {
    ...context,
    raw: true,
  });
  const entries = tree.split("\0").filter(Boolean);
  if (entries.length > VERIFY_TREE_ENTRIES_MAX)
    throw new Error("verification snapshot exceeds 50000 entries");
  for (const entry of entries) {
    if (/^(120000|160000) /.test(entry))
      throw new Error("verification MVP refuses symlinks and submodules");
    const tab = entry.indexOf("\t"),
      metadata = entry.slice(0, tab),
      name = entry.slice(tab + 1);
    if (tab < 0 || /[\x00-\x1f\x7f]/.test(name))
      throw new Error("verification refuses control characters in tree paths");
    if (name.toLowerCase() === ".lfsconfig") throw new Error("verification MVP refuses LFS");
    if (name.split("/").at(-1).toLowerCase() === ".gitattributes") {
      const blob = await git(
        ["cat-file", "blob", metadata.split(" ")[2]],
        receipt.repository,
        context,
      );
      if (/\bfilter(?:[=\s]|$)/.test(blob))
        throw new Error("verification MVP refuses checkout filters, including LFS");
    }
  }
  const info = path.join(receipt.common, "info", "attributes");
  if (
    fs.existsSync(info) &&
    readLimited(info, RECIPE_BYTES)
      .toString("utf8")
      .split("\n")
      .some((line) => line.trim() && !line.trim().startsWith("#"))
  )
    throw new Error("verification refuses repository-local info/attributes overrides");
  const cwd = path.join(directory, "snapshot"),
    hooks = path.join(directory, "empty-hooks"),
    attrs = path.join(directory, "empty-attributes");
  fs.mkdirSync(hooks);
  atomicWrite(attrs, "");
  await git(
    [
      "-c",
      "core.hooksPath=" + hooks,
      "-c",
      "core.attributesFile=" + attrs,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.sparseCheckout=false",
      "-c",
      "core.sparseCheckoutCone=false",
      "worktree",
      "add",
      "--detach",
      cwd,
      receipt.commit,
    ],
    receipt.repository,
    context,
  );
  if ((await git(["rev-parse", "HEAD"], cwd, context)) !== receipt.commit)
    throw new Error("snapshot commit mismatch");
  return { cwd, paths: entries.map((entry) => entry.slice(entry.indexOf("\t") + 1)) };
}
export async function verifyArtifact(options, context) {
  const key = options.key,
    attempt = options.attempt;
  if (options.mode === "verification") {
    const receipt = readVerification(key, attempt, context);
    await writeOutput(
      context.stdout,
      JSON.stringify(verificationView(receipt, receiptFile(context, key, attempt)), null, 2) + "\n",
    );
    return EXIT.COMPLETED;
  }
  const artifact = readArtifact(key, context);
  if (!artifact.sealed) throw new Error("finalize the artifact before verification");
  const recipe = recipeFrom(path.resolve(context.cwd, options.recipe)),
    recipeSha256 = digest(JSON.stringify(recipe));
  const file = receiptFile(context, key, attempt);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  requireDirectory(path.dirname(file));
  const release = holdGuard(file + ".guard", "verification attempt is busy");
  try {
    if (fs.existsSync(file)) {
      const old = readVerification(key, attempt, context);
      if (
        old.recipeSha256 !== recipeSha256 ||
        old.commit !== artifact.commit ||
        old.resultSha256 !== artifact.resultSha256
      )
        throw new Error("attempt already records a different recipe or artifact");
      if ([VERIFY_STATUS.PREPARING, VERIFY_STATUS.RUNNING].includes(old.outcome)) {
        old.previousOutcome = old.outcome;
        old.outcome = VERIFY_STATUS.UNCERTAIN;
        old.error = "prior attempt ended without settlement evidence; never rerun";
        atomicWrite(file, JSON.stringify(old, null, 2) + "\n");
      }
      await writeOutput(
        context.stdout,
        JSON.stringify(verificationView({ ...old, replayed: true }, file), null, 2) + "\n",
      );
      return old.outcome === VERIFY_STATUS.EXIT_ZERO ? EXIT.COMPLETED : EXIT.NOT_COMPLETED;
    }
    await requireArtifactRepository(artifact, artifact.repository, context);
    const directory = path.join(context.stateBase, "verifications", key, attempt);
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    requireDirectory(path.dirname(directory));
    fs.mkdirSync(directory, { mode: 0o700 }); // Existing attempt files are never reused.
    const receipt = {
      version: 1,
      runKey: key,
      attempt,
      stateRoot: stateRootHash(context.stateBase),
      commit: artifact.commit,
      tree: artifact.tree,
      resultSha256: artifact.resultSha256,
      recipeSha256,
      recipe,
      profile: "trusted-local",
      platform: process.platform,
      node: process.version,
      startedAt: new Date().toISOString(),
      outcome: VERIFY_STATUS.PREPARING,
      directory,
      modelStatus: artifact.status,
    };
    const save = () => {
      const text = JSON.stringify(receipt, null, 2) + "\n";
      if (Buffer.byteLength(text) > VERIFY_RECEIPT_BYTES)
        throw new Error("verification receipt exceeds its bound");
      atomicWrite(file, text);
    };
    save();
    let control,
      baseline,
      executionStarted = false;
    try {
      receipt.executableSha256 = await hashExecutable(recipe.executable);
      const { cwd, paths } = await snapshot(artifact, directory, context);
      receipt.snapshot = cwd;
      control = snapshotControl(cwd, artifact.common, artifact.commit);
      baseline = await snapshotFiles(cwd);
      if (
        baseline.files.size !== paths.length ||
        paths.some((name) => baseline.files.get(name)?.type !== "file")
      )
        throw new Error("verification checkout does not contain the complete saved tree");
      receipt.baselineSha256 = digest(
        JSON.stringify([...baseline.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      );
      receipt.outcome = VERIFY_STATUS.RUNNING;
      save();
      executionStarted = true;
      const execution = await executeVerification(recipe, {
        directory,
        cwd,
        signal: context.signal,
        checkpoint: (patch) => {
          Object.assign(receipt, patch);
          save();
        },
      });
      receipt.execution = execution;
      receipt.outcome = !execution.settled
        ? VERIFY_STATUS.UNCERTAIN
        : execution.state === VERIFY_STATUS.TIMEOUT
          ? VERIFY_STATUS.ERROR
          : execution.state === VERIFY_STATUS.CANCELLED
            ? VERIFY_STATUS.CANCELLED
            : execution.state === VERIFY_STATUS.EXITED
              ? execution.code === EXIT.COMPLETED
                ? VERIFY_STATUS.EXIT_ZERO
                : VERIFY_STATUS.FAILED
              : VERIFY_STATUS.ERROR;
      if (execution.settled) {
        if (!unchangedControl(control)) {
          receipt.mutations = [".git identity changed"];
          receipt.outcome = VERIFY_STATUS.INVALIDATED;
        } else {
          Object.assign(receipt, compareSnapshotFiles(baseline, await snapshotFiles(cwd)));
          if (receipt.mutations.length) receipt.outcome = VERIFY_STATUS.INVALIDATED;
        }
      }
    } catch (error) {
      receipt.outcome =
        receipt.outcome === VERIFY_STATUS.PREPARING
          ? VERIFY_STATUS.SKIPPED
          : VERIFY_STATUS.UNCERTAIN;
      receipt.error = String(error.message).slice(0, VERIFY_ERROR_CHARS);
    }
    if (receipt.snapshot && control && (!executionStarted || receipt.execution?.settled)) {
      try {
        if (!unchangedControl(control)) throw new Error("snapshot Git identity changed");
        const root = fs.lstatSync(receipt.snapshot, { bigint: true });
        if (
          !baseline ||
          !root.isDirectory() ||
          root.isSymbolicLink() ||
          root.dev !== baseline.root.dev ||
          root.ino !== baseline.root.ino
        )
          throw new Error("snapshot directory identity changed");
        // Cancellation must not cancel cleanup after the owned process settled.
        await removeWorktree(
          { cwd: receipt.snapshot, worktree: { base: artifact.repository } },
          { stateDir: directory },
        );
        receipt.cleanup = { state: "removed" };
      } catch (error) {
        receipt.cleanup = {
          state: "retained",
          reason: String(error.message).slice(0, VERIFY_ERROR_CHARS),
        };
      }
    } else if (receipt.snapshot) {
      receipt.cleanup = {
        state: "retained",
        reason: "process settlement or snapshot identity is unproven",
      };
    }
    receipt.completedAt = new Date().toISOString();
    save();
    await writeOutput(
      context.stdout,
      JSON.stringify(verificationView(receipt, file), null, 2) + "\n",
    );
    return receipt.outcome === VERIFY_STATUS.EXIT_ZERO ? EXIT.COMPLETED : EXIT.NOT_COMPLETED;
  } finally {
    release();
  }
}
