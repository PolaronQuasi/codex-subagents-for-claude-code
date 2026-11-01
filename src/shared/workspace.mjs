import { GIT_IDENT_VARS, BRANCH_SUFFIX_CHARS } from "./constants.mjs";
// Workspaces: the git repository root that keys the writer lock, the
// workspace identity, git commands with a bounded run time, and the worktree
// a job runs in: its commit at delivery and its removal.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  WORKSPACE_KEY_HEX_CHARS,
  GIT_LABEL_WORDS,
  DEFAULT_COMMAND_MS,
  PROBE_OUTPUT_BYTES,
  IS_WINDOWS,
  GIT_MS,
  GIT_OUTPUT_BYTES,
  GIT_LINK,
  WINDOWS_MAX_PATH_CHARS,
  RUN_FOLDER_REMOVAL,
} from "./constants.mjs";
import { isMissing } from "./errors.mjs";
import { detail, digest, runProcess, sameFolder, withoutLocalGit } from "./io.mjs";
import { commitMessage } from "./commit-message.mjs";
import {
  rejectGrafts,
  rejectHiddenIndexEntries,
  rejectTreeFilters,
  rejectWorktreeFilters,
} from "./git-security.mjs";
const toplevels = new Map();
// Writer-lock acquisition is synchronous: resolve repository identity before
// choosing or inspecting a lock. Cache the bounded Git probe so release and
// later ownership checks in the same process do not keep spawning Git.
export function gitToplevel(dir) {
  const resolved = path.resolve(dir);
  if (toplevels.has(resolved)) return toplevels.get(resolved);
  let top = null;
  const probe = spawnSync("git", ["-C", resolved, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: DEFAULT_COMMAND_MS,
    maxBuffer: PROBE_OUTPUT_BYTES,
    windowsHide: true,
    env: withoutLocalGit(),
  });
  if (!probe.error && probe.status === 0 && probe.stdout.trim()) {
    try {
      top = fs.realpathSync.native(probe.stdout.trim());
    } catch {
      top = null;
    }
  }
  toplevels.set(resolved, top);
  return top;
}

export function workspaceId(workspace) {
  const resolved = gitToplevel(workspace) ?? path.resolve(workspace);
  return digest(IS_WINDOWS ? resolved.toLowerCase() : resolved).slice(0, WORKSPACE_KEY_HEX_CHARS);
}

// Runs one git command in dir and returns its trimmed output; a failure names
// the subcommand that ran. Like every git the runner starts, it gets no
// repository-local variable from its caller (withoutLocalGit).
async function git(args, dir, options = {}) {
  const { signal, timeoutMs = GIT_MS, raw = false, env = process.env, input, indexFile } = options;
  let command = 0;
  while (["-C", "-c"].includes(args[command])) command += 2;
  const globals = args.slice(0, command);
  const settings = [];
  for (let i = 0; i < globals.length; i += 2)
    if (globals[i] === "-c") settings.push(globals[i], globals[i + 1]);
  const subcommand = args[command];
  // Probes never run a worktree operation, and can only use our own alternate
  // index. In particular, no inherited repository-local Git variables pass.
  const probe = (probeArgs, probeDir = dir, probeOptions = {}) =>
    git([...settings, ...probeArgs], probeDir, {
      ...options,
      raw: false,
      ...probeOptions,
      input: probeOptions.input,
      indexFile: probeOptions.indexFile,
      internalProbe: true,
    });
  if (!options.internalProbe) {
    const metadataOnly =
      subcommand === "rev-parse" &&
      !args.includes("--verify") &&
      args.some((arg) =>
        [
          "--show-toplevel",
          "--git-common-dir",
          "--git-dir",
          "--git-path",
          "--show-object-format",
        ].includes(arg),
      );
    const noGraph =
      ["config", "ls-files", "check-attr", "symbolic-ref", "var"].includes(subcommand) ||
      (subcommand === "worktree" && ["list", "remove"].includes(args[command + 1]));
    if (!metadataOnly && !noGraph) await rejectGrafts(probe, dir);
    if (["status", "add", "commit", "diff"].includes(subcommand)) {
      const root = await probe(["rev-parse", "--show-toplevel"], dir);
      const key = IS_WINDOWS ? root.toLowerCase() : root;
      if (!options.securityScope?.worktrees?.has(key)) {
        await rejectWorktreeFilters(probe, root);
        options.securityScope?.worktrees?.add(key);
      }
    }
    if (subcommand === "worktree" && args[command + 1] === "add")
      await rejectTreeFilters(probe, dir, args.at(-1));
    if (subcommand === "merge") {
      const root = await probe(["rev-parse", "--show-toplevel"], dir);
      const key = IS_WINDOWS ? root.toLowerCase() : root;
      if (!options.securityScope?.worktrees?.has(key)) {
        await rejectWorktreeFilters(probe, root);
        options.securityScope?.worktrees?.add(key);
      }
      await rejectTreeFilters(probe, dir, args.at(-1));
    }
  }
  // Per-process only: long branch names must work even when the repository
  // disables long paths. Never inherit GIT_CONFIG_* or change user settings.
  // Host-side Git must not execute scripts from model-controlled checkouts.
  // A fresh private directory also disables prepare/post hooks that --no-verify
  // does not cover. This affects runner operations only, never developer hooks.
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "csfcc-empty-hooks-"));
  const operation = args.slice(command);
  if (subcommand === "diff") {
    const separator = operation.indexOf("--");
    operation.splice(
      separator < 0 ? operation.length : separator,
      0,
      "--no-ext-diff",
      "--no-textconv",
    );
  }
  const commandArgs = [
    ...globals,
    "--no-pager",
    "--no-replace-objects",
    "-c",
    "core.hooksPath=" + hooks,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "merge.verifySignatures=false",
    "-c",
    "submodule.recurse=false",
    ...(IS_WINDOWS ? ["-c", "core.longpaths=true"] : []),
    ...operation,
  ];
  let result;
  try {
    result = await runProcess("git", commandArgs, {
      cwd: dir,
      timeoutMs,
      maxBuffer: GIT_OUTPUT_BYTES,
      signal,
      input,
      env: {
        ...withoutLocalGit(env),
        GIT_NO_REPLACE_OBJECTS: "1",
        ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
      },
    });
  } finally {
    fs.rmdirSync(hooks);
  }
  const named = (args[0] === "-C" ? args.slice(2) : args)
    .filter((arg) => !arg.startsWith("-"))
    .slice(0, GIT_LABEL_WORDS)
    .join(" ");
  if (result.error || result.status !== 0)
    throw new Error(`git ${named} failed: ${detail(result)}`);
  return raw ? result.stdout : result.stdout.trim();
}
export { git as workspaceGit, worktreeEntries };

export async function requireSafeGitTree(dir, tree, options = {}) {
  await rejectTreeFilters(git, dir, tree, options);
}

export async function gitIdentityOptions(dir, { signal, env = process.env } = {}) {
  const identity = [];
  for (const [key, value] of [
    ["user.name", "codex-subagents-for-claude-code"],
    ["user.email", "codex-subagents-for-claude-code@localhost"],
  ]) {
    const configured = await runProcess("git", ["-C", dir, "config", "--get", key], {
      cwd: dir,
      timeoutMs: GIT_MS,
      signal,
      env: withoutLocalGit(env),
      maxBuffer: PROBE_OUTPUT_BYTES,
    });
    if (configured.error || ![0, 1].includes(configured.status))
      throw new Error("cannot determine effective Git identity");
    if (configured.status !== 0 || !configured.stdout.trim())
      identity.push("-c", key + "=" + value);
  }
  return identity;
}

export async function gitDiagnostics(dir, options = {}) {
  const root = gitToplevel(dir);
  if (!root) return { "git-identity": "not-a-repository" };
  const identity = await gitIdentityOptions(dir, options),
    result = {};
  for (const [kind, variable] of Object.entries(GIT_IDENT_VARS)) {
    const value = await git([...identity, "var", variable], dir, options);
    result["git-" + kind.toLowerCase()] = value.replace(/\s+\d+ [+-]\d{4}$/, "");
  }
  result["git-identity-warning"] = Object.values(result).some((value) =>
    /codex-subagents-for-claude-code|Your Name|@(?:example\.com|localhost)>/i.test(value),
  )
    ? "placeholder identity; configure the intended author explicitly"
    : "-";
  if (IS_WINDOWS) {
    const common = await git(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      dir,
      options,
    );
    const configured = await runProcess("git", ["config", "--bool", "core.longpaths"], {
      cwd: dir,
      timeoutMs: GIT_MS,
      maxBuffer: PROBE_OUTPUT_BYTES,
      signal: options.signal,
      env: withoutLocalGit(options.env),
    });
    result["git-longpaths"] =
      configured.stdout.trim() === "true"
        ? "enabled"
        : "runner-only; external Git may reject long paths";
    result["git-loose-ref-path-chars"] = String(
      path.join(common, "refs", "heads", "csfcc", "0".repeat(BRANCH_SUFFIX_CHARS)).length,
    );
  }
  return result;
}

// Only commit IDs recorded by our worktree lifecycle may delimit this diff.
// Disable external diff/text converters; repository config must not turn a
// read into an arbitrary helper invocation. No rename inference is needed.
export async function worktreeDiff(run, { names = false, signal } = {}) {
  const base = run.worktree?.startCommit,
    head = run.result?.commit;
  if (![base, head].every((id) => /^[0-9a-f]{40}$/.test(id ?? "")))
    throw new Error("worktree change accounting needs pinned commits; state retained");
  if (!worktreeLinked(run)) throw new Error("worktree link missing; state retained");
  return git(
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--submodule=short",
      "--ignore-submodules=none",
      ...(names ? ["--name-only", "-z"] : ["--src-prefix=a/", "--dst-prefix=b/"]),
      base,
      head,
      "--",
    ],
    run.cwd,
    { signal, raw: true },
  );
}

// Whether a run's worktree folder still holds its .git link, the file that
// points git at this worktree. Without it a git command run in the folder
// would search its parents for some other repository, so none is: a removal
// that failed part-way (git deletes the link and its own record first) or a
// job that deleted the link leaves files git can no longer account for.
export function worktreeLinked(run) {
  try {
    const stat = fs.lstatSync(path.join(run.cwd, GIT_LINK));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

// A .git file by itself proves neither the repository nor the checked-out
// branch. Bind it to the registered linked worktree before host-side writes.
export async function requireWorktreeIdentity(run, options = {}) {
  if (!worktreeLinked(run)) throw new Error("worktree link missing; state retained");
  const { base, branch, startCommit } = run.worktree;
  const root = await git(["rev-parse", "--show-toplevel"], run.cwd, options);
  const common = await git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    run.cwd,
    options,
  );
  const baseCommon = await git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    base,
    options,
  );
  const gitDir = await git(["rev-parse", "--path-format=absolute", "--git-dir"], run.cwd, options);
  if (!sameFolder(root, run.cwd) || !sameFolder(common, baseCommon))
    throw new Error("worktree repository identity changed; state retained");
  let linkedPath;
  try {
    linkedPath = fs.readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
  } catch {
    throw new Error("worktree registration is missing; state retained");
  }
  if (!sameFolder(linkedPath, path.join(run.cwd, GIT_LINK)))
    throw new Error("worktree registration changed; state retained");
  const entry = (await worktreeEntries(base, options)).find(
    (item) => item.worktree && sameFolder(item.worktree, run.cwd),
  );
  const head = await git(["rev-parse", "HEAD"], run.cwd, options);
  if (
    !entry ||
    entry.HEAD !== head ||
    (branch ? entry.branch !== `refs/heads/${branch}` : !entry.detached)
  )
    throw new Error("worktree branch identity changed; state retained");
  if (startCommit) await git(["merge-base", "--is-ancestor", startCommit, head], run.cwd, options);
  return head;
}

// Cleanup must never silently advance the artifact already offered for review.
export async function requireWorktreeSnapshot(run, { signal } = {}) {
  const secure = { signal, securityScope: { worktrees: new Set() } };
  const head = await requireWorktreeIdentity(run, secure);
  await rejectHiddenIndexEntries(git, run.cwd, secure);
  const dirty = await git(
    [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored=matching",
      "--ignore-submodules=none",
    ],
    run.cwd,
    secure,
  );
  if (head !== run.result?.commit || dirty)
    throw new Error(
      "worktree changed after delivery; state retained. Preserve or review those changes before closing",
    );
}

// Commits whatever a write worktree job changed on its branch and returns
// the head; a read-only snapshot has no branch and is never committed.
export async function commitWorktree(run, label, { signal, env } = {}) {
  if (!run.worktree) return null;
  const secure = { signal, env, securityScope: { worktrees: new Set() } };
  if (!worktreeLinked(run))
    throw new Error(
      `worktree ${run.cwd} has lost its ${GIT_LINK} link, so git cannot commit its files; state retained`,
    );
  await requireWorktreeIdentity(run, secure);
  await rejectHiddenIndexEntries(git, run.cwd, secure);
  if (
    run.worktree.branch &&
    (await git(
      ["-C", run.cwd, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
      run.cwd,
      secure,
    ))
  ) {
    await git(["-C", run.cwd, "add", "-A"], run.cwd, secure);
    // git add can erase a previously staged edit when the working file was
    // restored to HEAD. Any unstaged content left now (notably submodule
    // edits/untracked files) cannot be preserved by this repository's commit.
    if (
      await git(["-C", run.cwd, "diff", "--name-only", "--ignore-submodules=none"], run.cwd, secure)
    )
      throw new Error(
        "worktree has unstaged changes after git add (including dirty submodules); state retained",
      );
    if (!(await git(["-C", run.cwd, "diff", "--cached", "--name-only"], run.cwd, secure)))
      return requireWorktreeIdentity(run, secure);
    const identity = await gitIdentityOptions(run.cwd, { signal, env });
    await git(
      ["-C", run.cwd, ...identity, "commit", "-q", "-m", commitMessage(run, label)],
      run.cwd,
      secure,
    );
  }
  return requireWorktreeIdentity(run, secure);
}

// Creates the run's worktree at workspace from its start ref, pinned to the
// resolved commit even if the ref moves: a write job on its own branch, a
// read-only job as a detached snapshot. Records the commit on the run.
export async function createWorktree(run, workspace, { signal, save }) {
  const base = run.worktree.base;
  const ref = run.worktree.startRef;
  const unresolved = (error) =>
    new Error(
      `worktree ref ${JSON.stringify(ref)} could not be resolved to a local commit: ${error.message}`,
    );
  let objectFormat;
  try {
    objectFormat = await git(["rev-parse", "--show-object-format"], base, { signal });
  } catch (error) {
    throw unresolved(error);
  }
  if (objectFormat !== "sha1")
    throw new Error("Git SHA-256 repositories are unsupported; no worktree was created");
  const stem = ref.split(/[\^~:]|@\{/u)[0];
  if (stem && !stem.startsWith("refs/")) {
    const refs = new Set(
      (await git(["for-each-ref", "--format=%(refname)"], base, { signal })).split("\n"),
    );
    const candidates = [
      `refs/${stem}`,
      `refs/tags/${stem}`,
      `refs/heads/${stem}`,
      `refs/remotes/${stem}`,
      `refs/remotes/${stem}/HEAD`,
    ].filter((name) => refs.has(name));
    if (stem === "HEAD") candidates.push("HEAD");
    if (candidates.length > 1)
      throw new Error(`ambiguous worktree ref ${JSON.stringify(ref)}; use a fully qualified ref`);
  }
  try {
    run.worktree.startCommit = await git(
      [
        "-C",
        base,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${run.worktree.startRef}^{commit}`,
      ],
      base,
      { signal },
    );
  } catch (error) {
    throw unresolved(error);
  }
  save?.();
  const { branch, startCommit } = run.worktree;
  // Create the branch separately: a successful exclusive creation proves
  // ownership. A failed -b worktree add alone does not prove who made it.
  let branchCreated = false;
  try {
    if (branch) {
      await git(["branch", branch, startCommit], base, { signal });
      branchCreated = true;
    }
    await git(
      ["worktree", "add", ...(branch ? [] : ["--detach"]), workspace, branch ?? startCommit],
      base,
      { signal },
    );
  } catch (error) {
    try {
      // Even a failed command can have registered the worktree before its
      // post-checkout hook failed. Roll back only pristine artifacts owned by
      // this attempt; no force, prune, or recursive removal of dirty files.
      if (branch && !branchCreated) {
        const ref = `refs/heads/${branch}`;
        const refs = await git(["for-each-ref", "--format=%(refname)", ref], base);
        if (refs.split("\n").includes(ref))
          throw new Error(
            "branch creation was not confirmed but the named branch exists; preserving it",
          );
      } else await rollbackWorktree(run, workspace);
    } catch (cleanupError) {
      throw Object.assign(
        new Error(`${error.message}; worktree rollback failed: ${cleanupError.message}`, {
          cause: error,
        }),
        { worktreeRecoveryRequired: true },
      );
    }
    throw error;
  }
}

// The worktrees git lists for base, one { worktree, HEAD, branch, ... } each.
const worktreeEntries = async (base, options) =>
  (await git(["worktree", "list", "--porcelain", "-z"], base, options))
    .split("\0\0")
    .filter(Boolean)
    .map((entry) =>
      Object.fromEntries(
        entry
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const split = line.indexOf(" ");
            return split < 0 ? [line, true] : [line.slice(0, split), line.slice(split + 1)];
          }),
      ),
    );
const pathKey = (value) => (IS_WINDOWS ? path.resolve(value).toLowerCase() : path.resolve(value));

async function rollbackWorktree(run, workspace) {
  const { base, branch, startCommit } = run.worktree;
  const entries = () => worktreeEntries(base);
  const target = pathKey(workspace);
  const registered = (await entries()).find(
    (entry) => entry.worktree && pathKey(entry.worktree) === target,
  );
  if (
    branch &&
    (await git(["rev-parse", "--verify", `refs/heads/${branch}`], base)) !== startCommit
  )
    throw new Error("the newly created branch changed; preserving it and its worktree");
  if (registered) {
    if (
      registered.HEAD !== startCommit ||
      (branch ? registered.branch !== `refs/heads/${branch}` : !registered.detached)
    )
      throw new Error("the worktree identity changed; preserving it");
    if (
      await git(
        [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--ignored=matching",
          "--ignore-submodules=none",
        ],
        workspace,
      )
    )
      throw new Error("the worktree contains changes; preserving it");
    await git(["worktree", "remove", workspace], base);
  } else if (fs.existsSync(workspace)) {
    throw new Error("an unregistered worktree directory remains; preserving it");
  }
  const remaining = await entries();
  if (remaining.some((entry) => entry.worktree && pathKey(entry.worktree) === target))
    throw new Error("the worktree is still registered");
  if (branch) {
    if (remaining.some((entry) => entry.branch === `refs/heads/${branch}`))
      throw new Error("the new branch is in use by another worktree; preserving it");
    // Compare-and-delete: an intervening commit must never be discarded.
    await git(["update-ref", "-d", `refs/heads/${branch}`, startCommit], base);
  }
}

// Whether folder still holds an entry whose absolute path is MAX_PATH long or
// longer, which git for Windows cannot remove without core.longpaths. Links
// and junctions are not followed; a folder that cannot be read counts as none.
function holdsLongPath(folder) {
  const pending = [path.resolve(folder)];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (full.length >= WINDOWS_MAX_PATH_CHARS) return true;
      if (entry.isDirectory()) pending.push(full);
    }
  }
  return false;
}

// Unlinks every symbolic link and junction inside a run's worktree folder,
// each as a link, before git removes the folder: git for Windows reads a
// junction as a folder and deletes the files it points at. The walk follows
// no link, the folder itself must be none, and a link that cannot be
// unlinked retains the state rather than reach git.
function unlinkLinks(folder) {
  const pending = [path.resolve(folder)];
  try {
    if (fs.lstatSync(pending[0]).isSymbolicLink()) throw new Error("the folder itself is a link");
    while (pending.length) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) fs.unlinkSync(full);
        else if (entry.isDirectory()) pending.push(full);
      }
    }
  } catch (error) {
    throw new Error(
      `the links in worktree ${folder} could not be removed before git removes it: ${error.message}; state retained`,
      { cause: error },
    );
  }
}

// Removes a run's worktree folder; its branch, when it has one, stays. Git
// removes a linked worktree once every link and junction in it is unlinked
// (unlinkLinks). On Windows without core.longpaths git cannot
// remove a path of MAX_PATH or more: it deletes the .git link and its own
// record, stops part-way and leaves the rest. Then, and for a folder whose
// link was already gone, Node removes the folder, which handles long paths,
// and git forgets the worktree if it still lists it: that entry alone, never
// another stale one as git worktree prune would. The folder must be the run's
// own, directly in stateDir and no link. Callers commit first, and decide
// whether an unlinked folder may go.
export async function removeWorktree(run, { signal, stateDir }) {
  const { base } = run.worktree;
  if (fs.existsSync(run.cwd)) {
    const stat = fs.lstatSync(run.cwd);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !stateDir ||
      !sameFolder(path.dirname(path.resolve(run.cwd)), stateDir)
    )
      throw new Error(`${run.cwd} is not this run's own worktree folder; state retained`);
    if (run.runKey && worktreeLinked(run)) {
      if (run.result?.commit) await requireWorktreeSnapshot(run, { signal });
      else {
        await requireWorktreeIdentity(run, { signal });
        await rejectHiddenIndexEntries(git, run.cwd, { signal });
        if (
          await git(
            [
              "status",
              "--porcelain",
              "--untracked-files=all",
              "--ignored=matching",
              "--ignore-submodules=none",
            ],
            run.cwd,
            { signal },
          )
        )
          throw new Error("worktree contains unpreserved changes or ignored files; state retained");
      }
    }
  }
  if (worktreeLinked(run)) {
    unlinkLinks(run.cwd);
    try {
      await git(["-C", base, "worktree", "remove", "--force", run.cwd], base, { signal });
      return;
    } catch (error) {
      if (!IS_WINDOWS || !holdsLongPath(run.cwd)) throw error;
    }
  }
  try {
    const stat = fs.lstatSync(run.cwd);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !stateDir ||
      !sameFolder(path.dirname(path.resolve(run.cwd)), stateDir)
    )
      throw new Error(`${run.cwd} is not this run's own worktree folder; state retained`);
    fs.rmSync(run.cwd, { recursive: true, force: true, ...RUN_FOLDER_REMOVAL });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const target = pathKey(run.cwd);
  if (
    (await worktreeEntries(base, { signal })).some(
      (entry) => entry.worktree && pathKey(entry.worktree) === target,
    )
  )
    await git(["-C", base, "worktree", "remove", "--force", run.cwd], base, { signal });
}
