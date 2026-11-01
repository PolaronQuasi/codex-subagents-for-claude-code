// The runtime snapshot: an immutable copy of one release of the runner under
// <state>/runtime/<version>-<digest>/, outside any Claude Code plugin cache.
//
// Claude Code replaces a plugin's cache folder when the plugin updates (the
// old one is deleted later), and loads a plugin from a local marketplace in
// place, so its files can change at any time. The plugin's forwarders and
// skill therefore run the runner from a snapshot (--prepare prints its
// entry): every driver a turn starts, and every command the runner prints,
// names the snapshot, never the cache. A snapshot holds the entry, every
// module under src/, the legal files and a captured plugin definition inventory
// when applicable. It is named after the version and a digest of those files,
// so several releases coexist side by side. It is
// written once: staged, made read-only and renamed into place; reused while
// its bytes match; never overwritten, and never removed by the runner, so a
// running driver keeps its files whatever the plugin does.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_DEFINITION_BYTES,
  AGENT_INSTALLATION,
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
import { absoluteOverride, readLimited, requireDirectory } from "./io.mjs";
import { ROLES } from "../roles.mjs";
import {
  inspectTargetFile,
  requireTargetFile,
  requireTargetDirectory,
  systemDirectoryPath,
} from "./install-paths.mjs";

// The folder whose src/ holds this module: the release that is running (a
// checkout, a release under dist/, a plugin's cache folder or a snapshot).
export const RELEASE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const INSTALLATION_FILE = "runtime-installation.json";
const NAMESPACE = /^[a-z][a-z0-9-]{0,63}$/;
const DEFINITION_STATES = new Set(["ok", "missing", "stale", "unreadable"]);

function regularText(file) {
  requireTargetFile(path.dirname(file), path.basename(file));
  if (!fs.lstatSync(file).isFile()) throw new Error(`expected a regular file: ${file}`);
  return readLimited(file, AGENT_DEFINITION_BYTES).toString("utf8");
}

// Only inspect definitions in the selected directory. Links/junctions are not
// followed, reads are bounded, and no definition content is ever executed.
export function agentDefinitions(dir, { plugin = false } = {}) {
  let directoryState = null;
  try {
    requireDirectory(dir);
  } catch (error) {
    directoryState = error.code === ERRNO.ENOENT ? "missing" : "unreadable";
  }
  return Object.fromEntries(
    Object.keys(ROLES).map((role) => {
      let state = directoryState;
      if (!state) {
        try {
          const text = regularText(path.join(dir, `${role}.md`));
          const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
          const name = /^name:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(frontMatter ?? "")?.[1];
          state =
            text.includes(`--role ${role}`) &&
            text.includes("--task-file") &&
            (!plugin || name === role)
              ? "ok"
              : "stale";
        } catch (error) {
          state = error.code === ERRNO.ENOENT ? "missing" : "unreadable";
        }
      }
      return [role, state];
    }),
  );
}

// A hint may identify this release, but must never redirect discovery into an
// inherited different plugin root. Compare path spellings without inspecting
// that external path. A source archive has an installer even without .git;
// its co-located manifest alone does not select plugin use.
function pluginSelection(root, env) {
  const resolved = path.resolve(root);
  const folded = (value) => (IS_WINDOWS ? value.toLowerCase() : value);
  try {
    const hint = absoluteOverride(env, "CLAUDE_PLUGIN_ROOT");
    if (hint && folded(systemDirectoryPath(hint)) === folded(systemDirectoryPath(resolved)))
      return AGENT_INSTALLATION.PLUGIN;
  } catch {
    /* A malformed optional hint cannot choose an installation. */
  }
  const slashed = resolved.split(path.sep).join("/");
  if (/(?:^|\/)\.claude\/plugins\/(?:cache\/[^/]+\/[^/]+\/[^/]+|marketplaces\/.+)$/i.test(slashed))
    return AGENT_INSTALLATION.PLUGIN;
  try {
    fs.lstatSync(path.join(root, "install.mjs"));
    return AGENT_INSTALLATION.AMBIGUOUS;
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
    return AGENT_INSTALLATION.PLUGIN; // A plugin-only payload has no checkout installer.
  }
}

// Snapshot metadata is a captured inventory, not proof of Claude registration
// or of files in a live plugin installation. It contains no source-cache path.
export function pluginInstallation(root = RELEASE_ROOT, env = {}) {
  const metadata = path.join(root, INSTALLATION_FILE);
  let captured;
  try {
    captured = regularText(metadata);
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
  }
  if (captured !== undefined) {
    const value = JSON.parse(captured);
    const roles = Object.keys(ROLES);
    if (
      value?.version !== 1 ||
      typeof value.namespace !== "string" ||
      !NAMESPACE.test(value.namespace) ||
      !value.definitions ||
      Object.keys(value.definitions).length !== roles.length ||
      !roles.every((role) => DEFINITION_STATES.has(value.definitions[role])) ||
      (value.selection !== undefined &&
        ![AGENT_INSTALLATION.PLUGIN, AGENT_INSTALLATION.AMBIGUOUS].includes(value.selection))
    )
      throw new Error("invalid runtime installation inventory");
    return {
      mode:
        value.selection === AGENT_INSTALLATION.AMBIGUOUS
          ? AGENT_INSTALLATION.AMBIGUOUS
          : AGENT_INSTALLATION.SNAPSHOT,
      namespace: value.namespace,
      agentsDir: null,
      evidence: "captured-at-prepare",
      definitions: value.definitions,
    };
  }
  const manifestDir = path.join(root, ".claude-plugin");
  try {
    requireDirectory(manifestDir);
  } catch (error) {
    if (error.code === ERRNO.ENOENT) return null;
    throw error;
  }
  const manifest = JSON.parse(regularText(path.join(manifestDir, "plugin.json")));
  if (typeof manifest?.name !== "string" || !NAMESPACE.test(manifest.name))
    throw new Error("invalid plugin manifest name");
  const agentsDir = path.join(root, "agents");
  return {
    mode: pluginSelection(root, env),
    namespace: manifest.name,
    agentsDir,
    evidence: "local-files",
    definitions: agentDefinitions(agentsDir, { plugin: true }),
  };
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// A snapshot's files are read by node only: read-only for everyone (on
// Windows the read-only attribute), and writable again only to be removed.
const readOnly = (file) => fs.chmodSync(file, 0o444);
const writable = (file) => fs.chmodSync(file, 0o644);

// The files a runtime holds, Map name -> Buffer in code-unit order: the entry
// (the file at entry, named run-codex-task.mjs), every module under root's
// src/ at any depth, and the legal files at root's top. A link, a junction or
// another entry that is no regular file is refused, never followed.
export function runtimeFiles(root, entry, { env = {} } = {}) {
  const files = new Map();
  const regular = (file, name) => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error(`${name} is no regular file; a runtime snapshot holds regular files only`);
    requireTargetFile(path.dirname(file), path.basename(file));
    files.set(name, fs.readFileSync(file));
  };
  const visit = (dir, name) => {
    requireTargetDirectory(dir);
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
  const installation = pluginInstallation(root, env);
  if (installation) {
    // Inventory participates in the content digest and is immutable alongside
    // the code. Re-preparing a snapshot preserves these exact canonical bytes.
    files.set(
      INSTALLATION_FILE,
      Buffer.from(
        JSON.stringify({
          version: 1,
          selection:
            installation.mode === AGENT_INSTALLATION.AMBIGUOUS
              ? AGENT_INSTALLATION.AMBIGUOUS
              : AGENT_INSTALLATION.PLUGIN,
          namespace: installation.namespace,
          definitions: installation.definitions,
        }) + "\n",
      ),
    );
  }
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
  requireTargetDirectory(dir);
  for (const [name, bytes] of files) {
    try {
      const inspected = inspectTargetFile(dir, name);
      if (!inspected?.stat || !fs.readFileSync(inspected.file).equals(bytes)) return false;
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
export function ensureRuntime({ stateBase, entry, version, root = RELEASE_ROOT, env = {} }) {
  const files = runtimeFiles(root, entry, { env });
  const id = runtimeId(files, version);
  const base = path.join(stateBase, RUNTIME_DIR),
    dir = path.join(base, id);
  const found = { id, dir, runner: path.join(dir, RUNTIME_ENTRY) };
  const reuse = () => {
    // Read-only again: a file made writable since is restored.
    for (const name of files.keys()) readOnly(requireTargetFile(dir, name));
    return { ...found, created: false };
  };
  const conflict = () =>
    Object.assign(
      new Error(
        `${CODES.RUNTIME_CONFLICT}: the runtime snapshot ${dir} differs from this release; it is never overwritten. Remove it once no job of that release runs, then retry`,
      ),
      { code: CODES.RUNTIME_CONFLICT },
    );
  requireTargetDirectory(dir, { missing: true });
  if (fs.existsSync(dir)) {
    if (holds(dir, files)) return reuse();
    throw conflict();
  }
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  requireTargetDirectory(base);
  const staging = path.join(
    base,
    `${RUNTIME_STAGING}${id}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  // Its files are made writable first: Windows refuses to remove a read-only one.
  const discard = () => {
    const current = fs.lstatSync(staging, { throwIfNoEntry: false });
    if (!current) return;
    requireTargetDirectory(staging);
    for (const name of files.keys()) {
      try {
        const inspected = inspectTargetFile(staging, name);
        if (!inspected) throw new Error(`unsafe runtime staging file: ${name}`);
        if (inspected.stat) writable(inspected.file);
      } catch (error) {
        if (error.code !== ERRNO.ENOENT) throw error;
      }
    }
    requireTargetDirectory(staging);
    fs.rmSync(staging, { recursive: true, force: true });
  };
  try {
    for (const [name, bytes] of files) {
      const file = requireTargetFile(staging, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      requireTargetFile(staging, name);
      fs.writeFileSync(file, bytes, { flag: "wx" });
      readOnly(requireTargetFile(staging, name));
    }
    // Windows can refuse the rename while a scanner reads a new file.
    for (let attempt = 0; ; attempt++) {
      try {
        requireTargetDirectory(staging);
        requireTargetDirectory(dir, { missing: true });
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
    requireTargetDirectory(path.join(stateBase, RUNTIME_DIR), { missing: true });
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
