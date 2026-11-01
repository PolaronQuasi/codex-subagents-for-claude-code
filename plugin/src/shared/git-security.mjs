// Checks run before Git is allowed to inspect or materialize worktree files.
// A filter is rejected, not disabled: bypassing it would change stored content.
import { ERRNO } from "./errors.mjs";
import { GIT_SUBMODULE_DEPTH_MAX } from "./constants.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function rejectGrafts(git, dir, options = {}) {
  const file = await git(
    ["rev-parse", "--path-format=absolute", "--git-path", "info/grafts"],
    dir,
    options,
  );
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error.code === ERRNO.ENOENT) return;
    throw error;
  }
  throw new Error("Git grafts are unsupported; remove them before this operation");
}

async function configuredFilters(git, dir, options) {
  const names = await git(["config", "--null", "--list", "--name-only"], dir, {
    ...options,
    raw: true,
  });
  const filters = new Set();
  for (const name of names.split("\0")) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process)$/i.exec(name);
    if (match) filters.add(match[1].toLowerCase());
  }
  return filters;
}

async function checkPaths(git, dir, options, filters, cached) {
  if (!filters.size) return;
  const paths = await git(
    ["ls-files", "-z", "--cached", ...(cached ? [] : ["--others", "--exclude-standard"])],
    dir,
    { ...options, raw: true },
  );
  if (!paths) return;
  const attrs = await git(
    ["check-attr", "-z", ...(cached ? ["--cached"] : []), "--stdin", "filter"],
    dir,
    { ...options, raw: true, input: paths },
  );
  const fields = attrs.split("\0");
  if (fields.at(-1) !== "" || (fields.length - 1) % 3 !== 0)
    throw new Error("cannot safely inspect Git filter attributes");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 1] !== "filter") throw new Error("unexpected Git attribute response");
    if (filters.has(fields[i + 2].toLowerCase()))
      throw new Error(
        `external Git filter ${JSON.stringify(fields[i + 2])} applies to ${JSON.stringify(fields[i])}; operation refused`,
      );
  }
}

// For a checkout of an existing tree, use a disposable index so attributes
// from that tree, plus normal global/info attributes, are evaluated by Git.
export async function rejectTreeFilters(git, dir, tree, options = {}) {
  const filters = await configuredFilters(git, dir, options);
  if (!filters.size) return;
  const root = await git(["rev-parse", "--show-toplevel"], dir, options);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "csfcc-git-index-"));
  const indexFile = path.join(temporary, "index");
  try {
    const isolated = { ...options, indexFile };
    await git(["read-tree", tree], root, isolated);
    await checkPaths(git, root, isolated, filters, true);
  } finally {
    for (const file of [indexFile, indexFile + ".lock"]) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== ERRNO.ENOENT) throw error;
      }
    }
    fs.rmdirSync(temporary);
  }
}

export async function rejectWorktreeFilters(git, dir, options = {}, depth = 0) {
  if (depth > GIT_SUBMODULE_DEPTH_MAX)
    throw new Error("nested submodules exceed the Git security check limit");
  const filters = await configuredFilters(git, dir, options);
  await checkPaths(git, dir, options, filters, false);
  // `status --ignore-submodules=none` can inspect initialized submodules,
  // whose own configuration may define filters not present in the parent.
  const entries = await git(["ls-files", "--stage", "-z"], dir, { ...options, raw: true });
  for (const entry of entries.split("\0")) {
    if (!entry.startsWith("160000 ")) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("invalid Git submodule entry");
    const sub = path.resolve(dir, entry.slice(tab + 1));
    const relative = path.relative(dir, sub);
    if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
      throw new Error("unsafe Git submodule path");
    let stat;
    try {
      stat = fs.lstatSync(sub);
    } catch (error) {
      if (error.code === ERRNO.ENOENT) continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("linked Git submodule path is unsupported");
    if (!stat.isDirectory() || !fs.existsSync(path.join(sub, ".git"))) continue;
    await rejectGrafts(git, sub, options);
    await rejectWorktreeFilters(git, sub, options, depth + 1);
  }
}

export async function rejectHiddenIndexEntries(git, dir, options = {}) {
  const entries = await git(["ls-files", "-v", "-z"], dir, { ...options, raw: true });
  if (entries.split("\0").some((entry) => entry && (/^[a-z] /.test(entry) || /^S /.test(entry))))
    throw new Error("Git index has assume-unchanged or skip-worktree entries; state retained");
}
