import { EXIT } from "../shared/errors.mjs";
import {
  BATCH_BYTES,
  BATCH_CHILDREN_MAX,
  BATCH_CONCURRENCY_MAX,
  BATCH_REQUEST_HASH_CHARS,
  BATCH_ERROR_CHARS,
  BATCH_POLL_MS,
  RECIPE_BYTES,
  BATCH_STATUS,
  OUTCOME,
} from "../shared/constants.mjs";
// A coordinator owns only its recorded child requests. It never retries an
// uncertain launch or failed model turn, and never sweeps another session.
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  MAX_PROMPT_BYTES,
  REQUEST_CLAIM_STATE,
  MODEL,
  validEffort,
  validRequestId,
  RUN_KEY,
} from "../shared/constants.mjs";
import {
  atomicWrite,
  digest,
  readLimited,
  requireDirectory,
  writeOutput,
  isAbsolutePath,
} from "../shared/io.mjs";
import { workspaceGit as git } from "../shared/workspace.mjs";
import { stateRootHash } from "../state/thread-owners.mjs";
import { requestClaimStatus } from "../state/state.mjs";
import { holdGuard } from "../state/guards.mjs";
import { peekRun } from "../state/run-record.mjs";
import { repositoryIdentity } from "../state/artifact-store.mjs";
import { consumeFiles } from "../cli/task-input.mjs";
import { launchRequestIdentity } from "../run/launch.mjs";

const finished = new Set([
  BATCH_STATUS.COMPLETED,
  BATCH_STATUS.FAILED,
  BATCH_STATUS.CANCELLED,
  BATCH_STATUS.SKIPPED,
]);
const LAUNCH_DISPOSITION = Object.freeze({
  IDENTIFIED: "identified",
  UNDISPATCHED: "undispatched",
  POSSIBLE_LIVE: "possible-live",
  RETIRED: "retired",
});
const dispositions = new Set(Object.values(LAUNCH_DISPOSITION));
const occupiesSlot = (child) =>
  child.status === BATCH_STATUS.RUNNING ||
  child.status === BATCH_STATUS.LAUNCHING ||
  (child.status === BATCH_STATUS.UNCERTAIN &&
    ![LAUNCH_DISPOSITION.UNDISPATCHED, LAUNCH_DISPOSITION.RETIRED].includes(
      child.launchDisposition,
    ));
const discard = () =>
  new Writable({
    write(chunk, encoding, done) {
      done();
    },
  });
const folder = (resultsDir, key) => path.join(resultsDir, "batches", key);
const manifestFile = (resultsDir, key) => path.join(folder(resultsDir, key), "manifest.json");
function writeManifest(record, context) {
  const text = JSON.stringify(record, null, 2) + "\n";
  if (Buffer.byteLength(text) > BATCH_BYTES) throw new Error("batch manifest exceeds its bound");
  atomicWrite(manifestFile(context.resultsDir, record.id), text);
}
export function readBatch(key, context) {
  if (!validRequestId(key)) throw new Error("invalid batch identity");
  requireDirectory(folder(context.resultsDir, key));
  const stat = fs.lstatSync(manifestFile(context.resultsDir, key));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("unsafe batch manifest");
  const record = JSON.parse(
    readLimited(manifestFile(context.resultsDir, key), BATCH_BYTES).toString("utf8"),
  );
  if (
    !record ||
    record.version !== 1 ||
    record.id !== key ||
    record.stateRoot !== stateRootHash(context.stateBase) ||
    typeof record.write !== "boolean" ||
    (record.cancelRequested !== undefined && typeof record.cancelRequested !== "boolean") ||
    ![record.recipeHash, record.promptSha256, record.repositoryIdentity].every((hash) =>
      /^[a-f0-9]{64}$/.test(hash ?? ""),
    ) ||
    !Array.isArray(record.children) ||
    !record.children.length ||
    record.children.length > BATCH_CHILDREN_MAX ||
    !Number.isInteger(record.concurrency) ||
    record.concurrency < 1 ||
    record.concurrency > BATCH_CONCURRENCY_MAX ||
    !/^[0-9a-f]{40}$/.test(record.commit ?? "") ||
    !isAbsolutePath(record.cwd ?? "") ||
    record.children.some(
      (child, i) =>
        !child ||
        child.index !== i ||
        child.requestId !== childRequest(key, i) ||
        !MODEL.test(child.model ?? "") ||
        !validEffort(child.effort) ||
        (child.runKey !== undefined && !RUN_KEY.test(child.runKey)) ||
        (child.requestDigest !== undefined && !/^[a-f0-9]{64}$/.test(child.requestDigest)) ||
        (child.requestDigestVersion !== undefined &&
          !Number.isSafeInteger(child.requestDigestVersion)) ||
        (child.requestDigest === undefined) !== (child.requestDigestVersion === undefined) ||
        (child.launchDisposition !== undefined && !dispositions.has(child.launchDisposition)) ||
        ![
          BATCH_STATUS.PLANNED,
          BATCH_STATUS.LAUNCHING,
          BATCH_STATUS.RUNNING,
          BATCH_STATUS.UNCERTAIN,
          ...finished,
        ].includes(child.status),
    )
  )
    throw new Error("invalid or foreign batch receipt");
  for (const child of record.children) {
    const identity = batchChildIdentity(record, child);
    if (child.requestDigest === undefined) {
      child.requestDigest = identity.digest;
      child.requestDigestVersion = identity.version;
    } else if (
      child.requestDigest !== identity.digest ||
      child.requestDigestVersion !== identity.version
    )
      throw new Error("invalid or foreign batch receipt");
  }
  return record;
}
const childRequest = (key, index) =>
  "b-" + digest(key).slice(0, BATCH_REQUEST_HASH_CHARS) + "-" + index;
const batchChildIdentity = (record, child) =>
  launchRequestIdentity(
    {
      model: child.model,
      effort: child.effort,
      write: record.write,
      "scratch-workspace": false,
      worktree: true,
      "worktree-ref": record.commit,
    },
    record.promptSha256,
    record.cwd,
  );
function readRecipe(file, context) {
  const recipe = JSON.parse(readLimited(file, RECIPE_BYTES).toString("utf8"));
  const keys = [
    "version",
    "requestId",
    "cwd",
    "ref",
    "promptFile",
    "models",
    "concurrency",
    "write",
  ];
  if (
    !recipe ||
    typeof recipe !== "object" ||
    Array.isArray(recipe) ||
    Object.keys(recipe).some((key) => !keys.includes(key)) ||
    recipe.version !== 1 ||
    !validRequestId(recipe.requestId) ||
    !isAbsolutePath(recipe.cwd ?? "") ||
    !isAbsolutePath(recipe.promptFile ?? "") ||
    !Array.isArray(recipe.models) ||
    !recipe.models.length ||
    recipe.models.length > BATCH_CHILDREN_MAX ||
    recipe.models.some(
      (item) =>
        !item ||
        Object.keys(item).some((key) => !["model", "effort"].includes(key)) ||
        !MODEL.test(item.model ?? "") ||
        !validEffort(item.effort),
    ) ||
    (recipe.write !== undefined && typeof recipe.write !== "boolean") ||
    (recipe.ref !== undefined &&
      (typeof recipe.ref !== "string" ||
        !recipe.ref ||
        /[\x00-\x20]/.test(recipe.ref) ||
        recipe.ref.startsWith("-")))
  )
    throw new Error(
      "invalid batch recipe: version, requestId, absolute cwd/promptFile and 1-16 model/effort entries required",
    );
  recipe.concurrency ??= 2;
  if (
    !Number.isInteger(recipe.concurrency) ||
    recipe.concurrency < 1 ||
    recipe.concurrency > BATCH_CONCURRENCY_MAX
  )
    throw new Error("batch concurrency must be 1-4");
  return recipe;
}
async function prepareBatch(recipe, context) {
  const key = recipe.requestId,
    file = manifestFile(context.resultsDir, key);
  const recipeHash = digest(JSON.stringify(recipe));
  if (fs.existsSync(file)) {
    const old = readBatch(key, context);
    if (old.recipeHash !== recipeHash)
      throw new Error("batch request ID already names a different recipe");
    if (
      fs.existsSync(recipe.promptFile) &&
      digest(readLimited(recipe.promptFile, MAX_PROMPT_BYTES)) !== old.promptSha256
    )
      throw new Error("batch prompt changed; choose a new request ID");
    return old;
  }
  if (fs.lstatSync(recipe.promptFile).isSymbolicLink())
    throw new Error("batch prompt must not be a symbolic link");
  const prompt = readLimited(recipe.promptFile, MAX_PROMPT_BYTES);
  if (!new TextDecoder("utf-8", { fatal: true }).decode(prompt).trim())
    throw new Error("batch prompt is empty");
  const cwd = fs.realpathSync(recipe.cwd);
  const commit = await git(
    ["rev-parse", "--verify", "--end-of-options", (recipe.ref ?? "HEAD") + "^{commit}"],
    cwd,
    context,
  );
  const privateDir = path.join(context.stateBase, "batches", key);
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  requireDirectory(privateDir);
  const promptPath = path.join(privateDir, "prompt.txt");
  atomicWrite(promptPath, prompt);
  const record = {
    version: 1,
    id: key,
    stateRoot: stateRootHash(context.stateBase),
    recipeHash,
    promptSha256: digest(prompt),
    cwd,
    repositoryIdentity: (await repositoryIdentity(cwd, context)).identity,
    commit,
    write: Boolean(recipe.write),
    concurrency: recipe.concurrency,
    createdAt: new Date().toISOString(),
    children: recipe.models.map((item, index) => ({
      ...item,
      index,
      requestId: childRequest(key, index),
      status: BATCH_STATUS.PLANNED,
    })),
  };
  for (const child of record.children) {
    const identity = batchChildIdentity(record, child);
    child.requestDigest = identity.digest;
    child.requestDigestVersion = identity.version;
  }
  writeManifest(record, context);
  await consumeFiles([{ file: recipe.promptFile, bytes: prompt }], { warn: context.warn });
  return record;
}
function ownedChild(child, context, record) {
  const claim = requestClaimStatus(context.stateBase, child.requestId);
  if (
    claim.owner &&
    (!RUN_KEY.test(claim.owner.runKey ?? "") ||
      claim.owner.promptSha256 !== child.requestDigest ||
      claim.owner.digestVersion !== child.requestDigestVersion ||
      (child.runKey !== undefined && child.runKey !== claim.owner.runKey))
  )
    throw new Error("batch child request ownership is missing or changed; no child action issued");
  const key = child.runKey ?? claim.owner?.runKey ?? null;
  if (!key) {
    child.launchDisposition =
      claim.state === REQUEST_CLAIM_STATE.UNDISPATCHED
        ? LAUNCH_DISPOSITION.UNDISPATCHED
        : claim.state === REQUEST_CLAIM_STATE.CLOSED
          ? LAUNCH_DISPOSITION.RETIRED
          : LAUNCH_DISPOSITION.POSSIBLE_LIVE;
    return null;
  }
  const run = peekRun(path.join(context.stateBase, key), key);
  if (!run) {
    child.launchDisposition =
      child.runKey === undefined && claim.state === REQUEST_CLAIM_STATE.UNDISPATCHED
        ? LAUNCH_DISPOSITION.UNDISPATCHED
        : child.runKey === undefined && claim.state === REQUEST_CLAIM_STATE.CLOSED
          ? LAUNCH_DISPOSITION.RETIRED
          : LAUNCH_DISPOSITION.POSSIBLE_LIVE;
    return null;
  }
  if (
    run.requestId !== child.requestId ||
    run.requestDigest !== child.requestDigest ||
    run.requestDigestVersion !== child.requestDigestVersion ||
    run.model !== child.model ||
    run.effort !== child.effort ||
    (run.turns?.length ?? 0) !== 0 ||
    Boolean(run.write) !== record.write ||
    run.worktree?.startCommit !== record.commit
  )
    throw new Error("batch child ownership is missing or changed; no child action issued");
  child.runKey = key;
  child.launchDisposition = LAUNCH_DISPOSITION.IDENTIFIED;
  return run;
}

function unknownLaunch(child, reason) {
  child.status = BATCH_STATUS.UNCERTAIN;
  child.error = String(
    reason ??
      (child.launchDisposition === LAUNCH_DISPOSITION.UNDISPATCHED
        ? "launch was not dispatched; never resubmitted"
        : child.launchDisposition === LAUNCH_DISPOSITION.RETIRED
          ? "launch identity was retired before collection"
          : "launch may still be live; never resubmitted"),
  ).slice(0, BATCH_ERROR_CHARS);
}
function usageSummary(children) {
  const counts = children.map((child) => child.usage?.turn?.total);
  return {
    knownTotalTokens: counts.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0),
    unknownChildren: counts.filter((n) => !Number.isFinite(n)).length,
    quota: "per-child snapshots; not additive",
  };
}
export async function batch(options, context) {
  const recipe =
    options.mode === "batch" ? readRecipe(path.resolve(context.cwd, options.batch), context) : null;
  const key = recipe?.requestId ?? options.key;
  const dir = folder(context.resultsDir, key);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  requireDirectory(dir);
  const release = holdGuard(path.join(dir, "coordinator.guard"), "batch coordinator is busy");
  let record;
  try {
    record = recipe ? await prepareBatch(recipe, context) : readBatch(key, context);
    const save = () => writeManifest(record, context);
    // Drain every owned operation before releasing the coordinator guard, even
    // if persisting a child result fails.
    const together = async (actions) => {
      const outcomes = await Promise.allSettled(actions);
      const failure = outcomes.find((item) => item.status === "rejected");
      if (failure) throw failure.reason;
    };
    const invoke = async (args) => {
      let outcome;
      const code = await context.invoke(args, {
        env: context.parentEnv,
        cwd: record.cwd,
        stdout: discard(),
        stderr: discard(),
        signal: context.signal,
        requireDurableCopy: true,
        onOutcome: (value) => {
          outcome = value;
        },
      });
      return { code, outcome };
    };
    const collect = async (child) => {
      const run = ownedChild(child, context, record);
      if (!run) {
        unknownLaunch(child);
        return;
      }
      const result = await invoke(["--run", child.runKey, "--wait-ms", "0"]);
      if (result.outcome?.kind === OUTCOME.DELIVERED) {
        const final = ownedChild(child, context, record);
        child.status = final.result.status;
        child.resultFile = final.result.resultFile;
        child.commit = final.result.commit;
        child.usage = final.result.usage;
        if (final.result.shutdownPending) {
          child.launchDisposition = LAUNCH_DISPOSITION.POSSIBLE_LIVE;
          unknownLaunch(
            child,
            `answer saved but shutdown is unconfirmed; inspect the run, then --close ${child.runKey} --force to accept the uncertainty`,
          );
        } else delete child.error;
      } else if (result.code === EXIT.STILL_RUNNING) child.status = BATCH_STATUS.RUNNING;
      else unknownLaunch(child, result.outcome?.reason ?? "collection failed");
    };
    const guarded = async (child, action) => {
      try {
        await action();
      } catch (error) {
        child.status = BATCH_STATUS.UNCERTAIN;
        child.launchDisposition = LAUNCH_DISPOSITION.POSSIBLE_LIVE;
        child.error = String(error.message).slice(0, BATCH_ERROR_CHARS);
      }
      save();
    };
    if (options.mode === "batch-cancel") {
      record.cancelRequested = true;
      // Make every never-started child non-dispatchable before touching any
      // child that may fail ownership validation or cancellation.
      for (const child of record.children)
        if (child.status === BATCH_STATUS.PLANNED) child.status = BATCH_STATUS.SKIPPED;
      save();
      for (const child of record.children) {
        if (finished.has(child.status)) continue;
        await guarded(child, async () => {
          const run = ownedChild(child, context, record);
          if (!run) {
            unknownLaunch(
              child,
              child.launchDisposition === LAUNCH_DISPOSITION.UNDISPATCHED
                ? "child was not dispatched; nothing to cancel"
                : "no proven owned child identity to cancel",
            );
            return;
          }
          await invoke(["--cancel", child.runKey, "--wait-ms", "0"]);
          await collect(child);
        });
      }
    } else {
      const deadline = Date.now() + options["wait-ms"];
      for (;;) {
        context.signal?.throwIfAborted();
        const active = record.children.filter(occupiesSlot);
        await together(active.map((child) => guarded(child, () => collect(child))));
        const inFlight = record.children.filter(occupiesSlot).length;
        const selected = record.cancelRequested
          ? []
          : record.children
              .filter((child) => child.status === BATCH_STATUS.PLANNED)
              .slice(0, Math.max(0, record.concurrency - inFlight));
        const promptPath = path.join(context.stateBase, "batches", key, "prompt.txt");
        if (
          selected.length &&
          digest(readLimited(promptPath, MAX_PROMPT_BYTES)) !== record.promptSha256
        )
          throw new Error("batch prompt cache changed; nothing submitted");
        if (
          selected.length &&
          (await repositoryIdentity(record.cwd, context)).identity !== record.repositoryIdentity
        )
          throw new Error("batch repository identity changed; nothing submitted");
        for (const child of selected) {
          const claim = requestClaimStatus(context.stateBase, child.requestId);
          if (claim.owner || claim.state !== REQUEST_CLAIM_STATE.UNDISPATCHED)
            throw new Error("batch child request ID already claimed before dispatch");
          child.status = BATCH_STATUS.LAUNCHING;
          child.launchDisposition = LAUNCH_DISPOSITION.POSSIBLE_LIVE;
          delete child.error;
        }
        save(); // Intent before any child dispatch.
        await together(
          selected.map((child) =>
            guarded(child, async () => {
              const launched = await invoke([
                "--model",
                child.model,
                "--effort",
                child.effort,
                "--prompt-file",
                promptPath,
                "--cwd",
                record.cwd,
                "--worktree",
                "--worktree-ref",
                record.commit,
                "--request-id",
                child.requestId,
                "--keep-state",
                "--keep-prompt",
                "--detach",
                ...(record.write ? ["--write"] : []),
              ]);
              if (ownedChild(child, context, record)) child.status = BATCH_STATUS.RUNNING;
              else unknownLaunch(child, launched.outcome?.reason);
            }),
          ),
        );
        const canProgress = record.children.some(
          (child) => occupiesSlot(child) || child.status === BATCH_STATUS.PLANNED,
        );
        if (
          record.children.every((child) => finished.has(child.status)) ||
          Date.now() >= deadline ||
          !canProgress
        )
          break;
        await delay(Math.min(BATCH_POLL_MS, Math.max(1, deadline - Date.now())), undefined, {
          signal: context.signal,
        });
      }
    }
    record.usage = usageSummary(record.children);
    record.updatedAt = new Date().toISOString();
    save();
    await writeOutput(
      context.stdout,
      JSON.stringify({ ...record, manifest: manifestFile(context.resultsDir, key) }, null, 2) +
        "\n",
    );
    if (!record.children.every((child) => finished.has(child.status))) return EXIT.STILL_RUNNING;
    return record.children.every((child) => child.status === BATCH_STATUS.COMPLETED)
      ? EXIT.COMPLETED
      : EXIT.NOT_COMPLETED;
  } finally {
    release();
  }
}
