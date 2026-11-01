// The runtime snapshot: an immutable copy of one release of the runner under
// <state>/runtime/<version>-<digest>/, outside any Claude Code plugin cache.
//
// Claude Code replaces a plugin's cache folder when the plugin updates (the
// old one is deleted later), and loads a plugin from a local marketplace in
// place, so its files can change at any time. The plugin's forwarders and
// skill therefore run the runner from a snapshot (--prepare prints its
// entry): every driver a turn starts, and every command the runner prints,
// names the snapshot, never the cache. A snapshot holds the entry, every
// module under src/ and the legal files, and is named after the version and a
// digest of those files, so several releases coexist side by side. It is
// written once: staged, made read-only and renamed into place; reused while
// its bytes match; never overwritten, and never removed by the runner, so a
// running driver keeps its files whatever the plugin does.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATOMIC_RENAME_RETRIES,
  ATOMIC_RENAME_RETRY_MS,
  IS_WINDOWS,
  RUNTIME_DIGEST_CHARS,
  RUNTIME_DIR,
  RUNTIME_ENTRY,
  RUNTIME_LEGAL_FILES,
  RUNTIME_MODULES,
  RUNTIME_STAGING,
} from "./constants.mjs";
import { CODES, ERRNO } from "./errors.mjs";

// The folder whose src/ holds this module: the release that is running (a
// checkout, a release under dist/, a plugin's cache folder or a snapshot).
export const RELEASE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// A snapshot's files are read by node only: read-only for everyone (on
// Windows the read-only attribute), and writable again only to be removed.
const readOnly = (file) => fs.chmodSync(file, 0o444);
const writable = (file) => fs.chmodSync(file, 0o644);

// The files a runtime holds, Map name -> Buffer in code-unit order: the entry
// (the file at entry, named run-codex-task.mjs), every module under root's
// src/ at any depth, and the legal files at root's top. A link, a junction or
// another entry that is no regular file is refused, never followed.
export function runtimeFiles(root, entry) {
  const files = new Map();
  const regular = (file, name) => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile())
      throw new Error(`${name} is no regular file; a runtime snapshot holds regular files only`);
    files.set(name, fs.readFileSync(file));
  };
  const visit = (dir, name) => {
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, child.name),
        relative = `${name}/${child.name}`;
      if (child.isDirectory()) visit(file, relative);
      else if (child.name.endsWith(".mjs")) regular(file, relative);
      else if (!child.isFile())
        throw new Error(
          `${relative} is no regular file; a runtime snapshot holds regular files only`,
        );
    }
  };
  regular(entry, RUNTIME_ENTRY);
  visit(path.join(root, RUNTIME_MODULES), RUNTIME_MODULES);
  for (const name of RUNTIME_LEGAL_FILES) regular(path.join(root, name), name);
  return new Map([...files].sort(([a], [b]) => byCodeUnit(a, b)));
}

// A runtime's id: <version>-<the first RUNTIME_DIGEST_CHARS hex digits of a
// SHA-256 over every file's name and bytes, in code-unit order>.
export function runtimeId(files, version) {
  const hash = crypto.createHash("sha256");
  for (const [name, bytes] of files) {
    hash.update(name);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return `${version}-${hash.digest("hex").slice(0, RUNTIME_DIGEST_CHARS)}`;
}

// Whether dir holds every one of files, byte for byte, as regular files.
// Anything else in dir is no part of the runtime and is left alone.
function holds(dir, files) {
  for (const [name, bytes] of files) {
    try {
      const file = path.join(dir, name);
      if (!fs.lstatSync(file).isFile() || !fs.readFileSync(file).equals(bytes)) return false;
    } catch (error) {
      if (error.code === ERRNO.ENOENT || error.code === ERRNO.ENOTDIR) return false;
      throw error;
    }
  }
  return true;
}

const pause = () =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ATOMIC_RENAME_RETRY_MS);

// The snapshot of the release at root (its entry: entry) under
// <stateBase>/runtime/, made when missing: { id, dir, runner, created }.
// runner is the snapshot's entry, which loads the snapshot's own src/.
export function ensureRuntime({ stateBase, entry, version, root = RELEASE_ROOT }) {
  const files = runtimeFiles(root, entry);
  const id = runtimeId(files, version);
  const base = path.join(stateBase, RUNTIME_DIR),
    dir = path.join(base, id);
  const found = { id, dir, runner: path.join(dir, RUNTIME_ENTRY) };
  const reuse = () => {
    // Read-only again: a file made writable since is restored.
    for (const name of files.keys()) readOnly(path.join(dir, name));
    return { ...found, created: false };
  };
  const conflict = () =>
    Object.assign(
      new Error(
        `${CODES.RUNTIME_CONFLICT}: the runtime snapshot ${dir} differs from this release; it is never overwritten. Remove it once no job of that release runs, then retry`,
      ),
      { code: CODES.RUNTIME_CONFLICT },
    );
  if (fs.existsSync(dir)) {
    if (holds(dir, files)) return reuse();
    throw conflict();
  }
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const staging = path.join(
    base,
    `${RUNTIME_STAGING}${id}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  // Its files are made writable first: Windows refuses to remove a read-only one.
  const discard = () => {
    for (const name of files.keys()) {
      try {
        writable(path.join(staging, name));
      } catch {
        /* never written */
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });
  };
  try {
    for (const [name, bytes] of files) {
      const file = path.join(staging, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      readOnly(file);
    }
    // Windows can refuse the rename while a scanner reads a new file.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(staging, dir);
        return { ...found, created: true };
      } catch (error) {
        // Another invocation published the same snapshot first.
        if (fs.existsSync(dir)) {
          discard();
          if (holds(dir, files)) return reuse();
          throw conflict();
        }
        if (
          !IS_WINDOWS ||
          ![ERRNO.EPERM, ERRNO.EACCES, ERRNO.EBUSY].includes(error.code) ||
          attempt >= ATOMIC_RENAME_RETRIES
        )
          throw error;
        pause();
      }
    }
  } catch (error) {
    discard();
    throw error;
  }
}

// The runtime snapshots under stateBase, by id, oldest name first.
export function runtimeSnapshots(stateBase) {
  try {
    return fs
      .readdirSync(path.join(stateBase, RUNTIME_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(RUNTIME_STAGING))
      .map((entry) => entry.name)
      .sort(byCodeUnit);
  } catch (error) {
    if (error.code === ERRNO.ENOENT) return [];
    throw error;
  }
}
