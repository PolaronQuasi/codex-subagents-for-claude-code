#!/usr/bin/env node
// The release tooling of the Codex role runner: the gates a commit must pass,
// the installation of a release, its verification, tags and rollback.
//
// The runner's modules are installed into an immutable folder
// dist/<version>-<commit>/src/, never overwritten, and the one-line pointer
// dist/current selects the folder the entry run-codex-task.mjs loads. A
// release writes the folder, checks it, makes it read-only and flips the
// pointer in one rename, so a new invocation loads one complete release; a
// rollback flips the pointer back. The entry itself changes rarely and is
// replaced in one rename too, read-only before and after. Node >= 22; no
// dependencies. The live installation is this repository's checkout;
// development happens in a copy.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { byCodeUnit, cleanGitEnvironment } from "./distribution.mjs";
import { moduleFiles } from "./test-files.mjs";
import { requireTargetFile } from "../src/shared/install-paths.mjs";
import { createScratch } from "./scratch.mjs";
import { PLUGIN_SOURCE, pluginPackageProblems } from "./plugin-package.mjs";
// Shared validation and error helpers come from this tool's own source tree.
import { ERRNO, EXIT } from "../src/shared/errors.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
export const ROOT = path.dirname(path.dirname(SCRIPT));
// The tool's policies, named once: it imports no src/shared/constants.mjs. What one
// git or node command may print; how often, and how far apart, a pointer flip
// that Windows refused (another process reading the pointer) is retried; how
// long the isolated import check of a stage may take and what it may print;
// how long reading a copy's roles may take.
const COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;
const FLIP_RETRIES = 100;
const FLIP_RETRY_MS = 10;
const POINTER_DETAIL_CHARS = 80;
const COMMIT_DISPLAY_CHARS = 7;
const DIGEST_DISPLAY_CHARS = 12;
const STAGE_CHECK_MS = 10_000;
const STAGE_CHECK_BYTES = 1024 * 1024;
const STAGE_CHECK_FILE = "tools/check-stage.mjs";
const TAG_CHECK_PREFIX = "codex-release-check-";
const ROLES_READ_MS = 10_000;
// How many untracked files install's refusal names.
const UNTRACKED_SHOWN = 10;
const RUNNER = "run-codex-task.mjs";
const STAGED = "run-codex-task.next.mjs";
// The runner's version lives in one module; the entry only re-exports it.
const VERSION_FILE = "src/version.mjs";
export const DIST = "dist";
export const POINTER = "dist/current";
const LEGAL_FILES = ["LICENSE", "NOTICE"];
// The modes git records for a regular file, plain and executable.
const REGULAR_MODES = ["100644", "100755"];
// A release folder is named <version>-<commit> (or <version>-<content digest>
// for a copy that is not a git checkout); the entry accepts the same shape.
export const RELEASE_ID = /^\d+\.\d+\.\d+-[0-9a-f]{7,40}$/;
// What `install --from-dir` copies into the target; everything else in the
// source directory (results, a .git, node_modules) stays there. It names every
// tracked top-level entry but the entry, which install replaces on its own, so
// that after the release's git steps the live checkout equals the release
// commit: a tracked entry missing here would show as deleted there and stop
// `tag`. test/tools/release-source.test.mjs keeps the list complete.
export const SOURCES = [
  ...LEGAL_FILES,
  "src",
  "test",
  "install.mjs",
  ".claude-plugin",
  "plugin",
  "assets",
  "agents",
  "skills",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "package.json",
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".prettierrc.json",
  ".prettierignore",
  "tools",
  "claude",
  "docs",
  "ci",
  ".githooks",
  ".gitea",
  ".github",
  "releases",
  "CONTRACT.md",
];
const CHECKED = [RUNNER, "install.mjs"];
// Every module under test/, the fixtures' fake Codex files included, as the
// one discovery in tools/test-files.mjs walks it.
const testFiles = (root) => moduleFiles(root, "test");
// Every module of the runner, for node --check: the entry, the installer, the
// modules under src/ (the release's, at any depth), and every module under
// test/ and tools/ at any depth.
export function checkedFiles(root = ROOT) {
  const modules = folderInventory(root).names.filter((name) => name.endsWith(".mjs"));
  const tools = moduleFiles(root, "tools");
  return [...new Set([...CHECKED, ...tools, ...modules, ...testFiles(root)])];
}
const SEMVER = /^\d+\.\d+\.\d+$/;

const HELP = `Usage:
  node tools/release.mjs check                      syntax of every module, version agreement (the
                                                    plugin's too), no machine paths, the skill's role
                                                    list equal to ROLES, installed agents and skill
                                                    current, the plugin's rendered agents and skill
                                                    current; warns while the newest releases/v*.json
                                                    has no tag
  node tools/release.mjs install --from-dir DIR [--target DIR]
                                                    install the release in a development copy: its modules
                                                    into dist/<version>-<commit>/ (read-only, never
                                                    overwritten), the other sources (a checkout's
                                                    tracked files, never one .gitignore excludes) and
                                                    the entry copied, dist/current flipped to it in one
                                                    rename, agents and skill installed,
                                                    releases/v<version>.json written
  node tools/release.mjs verify [--target DIR]      the entry and the release dist/current names are the
                                                    committed ones and read-only, and every
                                                    releases/v*.json has its tag (untagged=)
  node tools/release.mjs tag                        annotated tag v<version> on HEAD, which must be the
                                                    commit that recorded releases/v<version>.json;
                                                    refused while a tracked file has uncommitted
                                                    changes (untracked files do not count)
  node tools/release.mjs rollback VERSION [--target DIR]
                                                    flip dist/current back to the release of tag vVERSION
                                                    (materialized from the tag when it is not under dist/);
                                                    a tag whose runner is a single file puts that file back
  node tools/release.mjs setup                      point git at .githooks; on POSIX, make the hooks
                                                    executable when they are not
  node tools/release.mjs pre-commit                 the pre-commit hook's gate: refused while a file
                                                    check reads has unstaged changes or is
                                                    untracked, then check with temporary definitions
  node tools/release.mjs pre-push [REMOTE [URL]]    the pre-push hook's gate, with git's ref lines
                                                    on stdin: every pushed commit HEAD (or one the
                                                    remote has) and the files check reads equal to
                                                    HEAD's, then check with temporary definitions
--target defaults to this repository. check, tag, setup and the hook gates always act on this
repository and refuse --target; only install takes --from-dir. Exit 1 on any problem, an option or
argument a command does not take included.
`;

export const sha256 = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sha256Of = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export function runnerVersion(file) {
  const match = /^export const RUNNER_VERSION = "(\d+\.\d+\.\d+)";/m.exec(
    fs.readFileSync(file, "utf8"),
  );
  if (!match) throw new Error(`${file} declares no RUNNER_VERSION`);
  return match[1];
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
// Keep pointer replacement self-contained even when the runner cannot import.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Every child starts without GIT_* variables. A git hook, a wrapper or an
// agent shell can export GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or config
// overrides, and git would then read or tag that repository instead of the
// one each command names by its cwd. check asks git nothing (it reads the
// working tree), so inside the pre-commit hook the hook's own git diff
// --cached --check is what reads the index the hook was given.
const childEnvironment = (env) => ({ ...cleanGitEnvironment(env), GIT_TERMINAL_PROMPT: "0" });
const SPAWN_OPTIONS = { windowsHide: true, shell: false, maxBuffer: COMMAND_OUTPUT_BYTES };
function run(
  command,
  args,
  { cwd = ROOT, input, env = process.env, encoding = "utf8", timeout } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    env: childEnvironment(env),
    encoding,
    timeout,
    ...SPAWN_OPTIONS,
  });
  if (result.error) throw result.error;
  return result;
}
const node = (args, options) => run(process.execPath, args, options);

// git runs in one place, gitRun, and is asked in three ways, so that a failure
// is never read as an answer:
// - required (gitRequired, git): the command must succeed; any failure throws,
//   with git's stderr;
// - optional (gitFile): a committed file, or null only when git itself says
//   that the ref or the path does not exist (rev-parse --verify --quiet, then
//   ls-tree); a ref, a tree or a blob git cannot read throws;
// - status probe (gitProbe): a question git answers with its exit status, 0
//   for yes and GIT_NO for no; any other status throws.
// git that cannot be started at all (not installed or not on PATH, or not
// allowed to run: GIT_NOT_STARTED) throws GitUnavailable, which no caller
// explains as a fault of the repository. Any other spawn error means that git
// ran and was cut off (ERRNO.ENOBUFS, its output over COMMAND_OUTPUT_BYTES, or
// its child killed): a git failure, like a non-zero exit, with that error's
// message.
// The exit status of a git question answered no, as rev-parse --verify --quiet
// answers for a ref that does not exist; git exits 128 when it fails.
const GIT_NO = 1;
const GIT_NOT_STARTED = [ERRNO.ENOENT, ERRNO.EACCES, ERRNO.EPERM];
class GitUnavailable extends Error {}
const asText = (output) => (Buffer.isBuffer(output) ? output.toString("utf8") : (output ?? ""));
// What git said about a failure: its stderr, else its stdout, else the signal
// that killed it, else its exit status.
const gitReason = (result) =>
  asText(result.stderr).trim() ||
  asText(result.stdout).trim() ||
  (result.signal ? `killed by ${result.signal}` : `exit ${result.status}`);
const failure = (args, reason) =>
  Object.assign(new Error(`git ${args.join(" ")}: ${reason}`), { reason });
const gitFailure = (args, result) => failure(args, gitReason(result));
// hookEnv: the hook's own environment, which the hooks' reads keep (hookGit);
// every other git starts without inherited GIT_* variables.
function gitRun(args, { cwd = ROOT, input, encoding = "utf8", hookEnv = null } = {}) {
  const env = hookEnv ? { ...hookEnv, GIT_TERMINAL_PROMPT: "0" } : childEnvironment(process.env);
  const result = spawnSync("git", args, { cwd, input, env, encoding, ...SPAWN_OPTIONS });
  if (result.error) {
    if (GIT_NOT_STARTED.includes(result.error.code))
      throw new GitUnavailable(`git ${args.join(" ")}: could not run git: ${result.error.message}`);
    throw failure(args, result.error.message);
  }
  return result;
}
// Required: git's stdout as it printed it (a Buffer for encoding "buffer").
function gitRequired(args, options) {
  const result = gitRun(args, options);
  if (result.status !== 0) throw gitFailure(args, result);
  return result.stdout;
}
// Required, for a one-line answer.
const git = (args, cwd) => gitRequired(args, { cwd }).trim();
// A status probe: git's answer (its stdout, trimmed) for yes, null for no.
function gitProbe(args, cwd) {
  const result = gitRun(args, { cwd });
  if (result.status === 0) return result.stdout.trim();
  if (result.status === GIT_NO) return null;
  throw gitFailure(args, result);
}
// A required step whose failure the caller explains in its own words, from
// git's reason; git that cannot run keeps its own message.
function explained(step, explain) {
  try {
    return step();
  } catch (error) {
    if (error instanceof GitUnavailable) throw error;
    throw new Error(explain(error.reason ?? error.message));
  }
}
const nulSeparated = (text) => text.split("\0").filter(Boolean);
// git ls-tree -z's entries, "<mode> <type> <object>\t<name>": Map name ->
// { mode, type, object }.
function treeEntries(listed) {
  const entries = new Map();
  for (const line of nulSeparated(listed)) {
    const tab = line.indexOf("\t");
    const [mode, type, object] = line.slice(0, tab).split(" ");
    entries.set(line.slice(tab + 1), { mode, type, object });
  }
  return entries;
}
// The files of a tree at ref under paths (all of them without paths), at any
// depth, as git lists them. Required: a ref or a tree git cannot read throws,
// never a shorter list.
const gitTree = (ref, cwd, paths = []) =>
  treeEntries(gitRequired(["ls-tree", "-r", "-z", ref, "--", ...paths], { cwd }));
// The bytes of git blobs, Map object -> Buffer, read by one git cat-file
// --batch. Required: an object git cannot read throws, whether it is missing
// or corrupt (cat-file --batch calls both "missing", exit 0, and says why on
// stderr), so a file a tree lists is never taken for a missing one.
function gitBlobs(objects, cwd) {
  const wanted = [...new Set(objects)];
  const blobs = new Map();
  if (!wanted.length) return blobs;
  const args = ["cat-file", "--batch"];
  // A string input is encoded by encoding, which "buffer" is not.
  const input = Buffer.from(`${wanted.join("\n")}\n`);
  const result = gitRun(args, { cwd, input, encoding: "buffer" });
  if (result.status !== 0) throw gitFailure(args, result);
  const output = result.stdout;
  let at = 0;
  for (const object of wanted) {
    const end = output.indexOf("\n", at);
    const header = output.subarray(at, end < 0 ? output.length : end).toString("utf8");
    const [named, type, size] = header.split(" ");
    if (end < 0 || named !== object || type !== "blob" || !/^\d+$/.test(size ?? ""))
      throw new Error(
        `git ${args.join(" ")}: could not read ${object} (${header.trim() || "no answer"})${asText(result.stderr).trim() ? `: ${asText(result.stderr).trim()}` : ""}`,
      );
    blobs.set(object, output.subarray(end + 1, end + 1 + Number(size)));
    at = end + 1 + Number(size) + 1;
  }
  return blobs;
}
// Optional: a committed file, { mode, bytes }, or null only when git says that
// ref does not exist or has no such file; a folder in its place is no file.
function gitFile(ref, file, cwd) {
  if (gitProbe(["rev-parse", "--verify", "--quiet", ref], cwd) === null) return null;
  const entry = treeEntries(gitRequired(["ls-tree", "-z", ref, "--", file], { cwd })).get(file);
  if (!entry) return null;
  if (entry.type !== "blob") throw new Error(`${file} at ${ref} is a ${entry.type}, not a file`);
  return { mode: entry.mode, bytes: gitBlobs([entry.object], cwd).get(entry.object) };
}

// Windows keeps the read-only attribute in the mode's write bits, so chmod is
// attrib -R / +R there and a plain mode change elsewhere. Windows reports the
// attribute in the owner's write bit; on POSIX a file is read-only only when
// nobody may write it, and these helpers change the write bits only, so an
// executable file stays executable.
const IS_WINDOWS = process.platform === "win32";
const POSIX = !IS_WINDOWS;
const writable = (file) =>
  fs.chmodSync(file, POSIX ? (fs.statSync(file).mode & 0o7777) | 0o200 : 0o644);
const readOnly = (file) => fs.chmodSync(file, POSIX ? fs.statSync(file).mode & 0o7555 : 0o444);
export const modeIsReadOnly = (mode, windows = IS_WINDOWS) =>
  (mode & (windows ? 0o200 : 0o222)) === 0;
export const isReadOnly = (file) => modeIsReadOnly(fs.statSync(file).mode);
// On POSIX an executable file is one git checks out from mode 100755: the
// owner may run it, and so may everyone who may read it. Windows has no such
// bit, and git records none there.
function setExecutable(file, executable) {
  if (!POSIX) return;
  const mode = fs.statSync(file).mode & 0o7777;
  const wanted = executable ? mode | 0o100 | ((mode & 0o044) >> 2) : mode & ~0o111;
  if (wanted !== mode) fs.chmodSync(file, wanted);
}

// Replaces the live entry in one rename: the staged file is complete and
// syntax-checked before it takes the live name, so a new invocation loads
// either the old file or the new one, never a mix. executable: whether the
// release records the entry as an executable file (mode 100755).
export function replaceRunner(target, text, executable = false) {
  const live = path.join(target, RUNNER),
    staged = path.join(target, STAGED);
  fs.writeFileSync(staged, text);
  setExecutable(staged, executable);
  const check = node(["--check", staged]);
  if (check.status !== 0) {
    fs.rmSync(staged, { force: true });
    throw new Error(`staged runner fails node --check: ${check.stderr.trim()}`);
  }
  if (fs.existsSync(live)) writable(live);
  try {
    fs.renameSync(staged, live);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    if (fs.existsSync(live)) readOnly(live);
    throw new Error(`could not replace ${live}: ${error.message}`);
  }
  readOnly(live);
  return sha256(live);
}

// The pointer: one line naming the release folder under dist/, or null when
// no release is installed (a fresh clone runs the modules under src/).
export function readPointer(target = ROOT) {
  let text;
  try {
    text = fs.readFileSync(path.join(target, POINTER), "utf8");
  } catch (error) {
    if (error.code === ERRNO.ENOENT) return null;
    throw error;
  }
  const id = text.trim();
  if (!RELEASE_ID.test(id))
    throw new Error(
      `${POINTER} names no release: ${JSON.stringify(id.slice(0, POINTER_DETAIL_CHARS))}`,
    );
  return id;
}

// Flips the pointer in one rename: a reader sees the old release or the new
// one. On Windows the rename is refused (EPERM) for the instant another
// invocation holds the pointer open to read it, so it is retried for up to a
// second; when it still fails, the old pointer stays and the attempt is
// reported.
export function flipPointer(target, id) {
  if (!RELEASE_ID.test(id)) throw new Error(`invalid release id ${id}`);
  const file = path.join(target, POINTER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${id}\n`);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      if (attempt < FLIP_RETRIES && [ERRNO.EPERM, ERRNO.EBUSY, ERRNO.EACCES].includes(error.code)) {
        sleepSync(FLIP_RETRY_MS);
        continue;
      }
      fs.rmSync(temporary, { force: true });
      throw new Error(
        `could not flip ${POINTER} to ${id}: ${error.message}; the previous release stays current`,
      );
    }
  }
}

// The release inventory: one rule, isReleaseFile, says what a release's files
// are, every module under src/ at any depth and the legal files at its top,
// named by /-separated paths relative to the release root. Two listings apply
// it: folderInventory to a folder (a release under dist/, a staging folder, a
// development copy's src/) and treeInventory to a git tree (a tag, HEAD).
// Every inventory is ordered by code unit (byCodeUnit), never by a locale, so
// a content digest names the same files in the same order on every machine.
const RELEASE_MODULE = /^src\/(?:(?!\.\.?\/)[^/]+\/)*[^/]+\.mjs$/;
export const isReleaseFile = (name) => RELEASE_MODULE.test(name) || LEGAL_FILES.includes(name);
// Where a release file can be: anything under src/, and the legal files.
const inReleaseArea = (name) =>
  name === "src" || name.startsWith("src/") || LEGAL_FILES.includes(name);
// A module whose extension is .mjs in another case (.MJS, .Mjs). Windows and
// macOS load it as a module, but the rule, like git and Linux, tells case, so
// it would be missing from the release.
const OTHER_CASE_MODULE = /\.mjs$/i;
// A folder's release files, { names, others, miscased }. names: its regular
// files the rule names. others: every entry where a release file can be that
// is no regular file and no folder (a link, a junction, a device, src/ itself
// as a link), never followed and never skipped, so a caller refuses the
// folder. miscased: its regular files under src/ named like a module in
// another case. A missing folder has none.
function folderInventory(root) {
  const names = [],
    others = [],
    miscased = [];
  const visit = (name) => {
    let stat;
    try {
      stat = fs.lstatSync(path.join(root, name));
    } catch (error) {
      if (error.code === ERRNO.ENOENT) return;
      throw error;
    }
    if (stat.isDirectory() && !LEGAL_FILES.includes(name))
      for (const child of fs.readdirSync(path.join(root, name))) visit(`${name}/${child}`);
    else if (!stat.isFile()) others.push(name);
    else if (isReleaseFile(name)) names.push(name);
    else if (name.startsWith("src/") && OTHER_CASE_MODULE.test(name)) miscased.push(name);
  };
  for (const name of ["src", ...LEGAL_FILES]) visit(name);
  return {
    names: names.sort(byCodeUnit),
    others: others.sort(byCodeUnit),
    miscased: miscased.sort(byCodeUnit),
  };
}
// A git tree's release files (tree, from gitTree), { names, others }, as
// folderInventory has them: others are the entries where a release file can be
// that are no regular file (a link, a submodule).
function treeInventory(tree) {
  const names = [],
    others = [];
  for (const [name, { mode, type }] of tree) {
    if (!inReleaseArea(name)) continue;
    if (type !== "blob" || !REGULAR_MODES.includes(mode)) others.push(name);
    else if (isReleaseFile(name)) names.push(name);
  }
  return { names: names.sort(byCodeUnit), others: others.sort(byCodeUnit) };
}
// The committed bytes of a tree's release files, every blob read: Map name ->
// Buffer, in the inventory's order.
function committedFiles(tree, names, cwd) {
  const blobs = gitBlobs(
    names.map((name) => tree.get(name).object),
    cwd,
  );
  return new Map(names.map((name) => [name, blobs.get(tree.get(name).object)]));
}
// A copy's release files, from its inventory (sourceInventory), with their
// bytes.
function releaseFilesFrom(root, inventory) {
  const names = inventory.map(({ name }) => name);
  if (
    readJson(path.join(root, "package.json")).license === "Apache-2.0" &&
    !names.includes("LICENSE")
  )
    throw new Error("Apache-2.0 release is missing LICENSE; restore it before installing");
  const files = new Map(
    names
      .filter(isReleaseFile)
      .sort(byCodeUnit)
      .map((name) => [name, fs.readFileSync(path.join(root, name))]),
  );
  if (!files.has(VERSION_FILE))
    throw new Error(`${root} has no ${VERSION_FILE}; is it a runner whose modules are under src/?`);
  return files;
}
// The release files of a tag (or another ref) of the checkout at cwd, every
// blob read: Map name -> Buffer. tree: the ref's listing, when the caller has
// it. A link or a submodule where a release file can be, and a ref without
// src/version.mjs, are refused.
export function releaseFilesFromTag(
  ref,
  cwd = ROOT,
  tree = gitTree(ref, cwd, ["src", ...LEGAL_FILES]),
) {
  const { names, others } = treeInventory(tree);
  if (others.length)
    throw new Error(
      `${ref} holds ${others.join(", ")} as a link or a submodule; a release holds regular files only`,
    );
  if (!names.includes(VERSION_FILE)) throw new Error(`tag ${ref} has no ${VERSION_FILE}`);
  return committedFiles(tree, names, cwd);
}
// A digest of a release's files, names and bytes, in code-unit order: the name
// of a release from a copy that is no git checkout.
export const contentDigest = (files) => {
  const hash = crypto.createHash("sha256");
  for (const [name, bytes] of [...files].sort(([a], [b]) => byCodeUnit(a, b))) {
    hash.update(name);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
};
// Whether the folder root holds exactly these release files, byte for byte,
// as regular files.
function sameRelease(root, files) {
  const { names, others } = folderInventory(root);
  return (
    !others.length &&
    names.length === files.size &&
    names.every(
      (name) => files.has(name) && fs.readFileSync(path.join(root, name)).equals(files.get(name)),
    )
  );
}

// Whether two paths name one folder. The native real path can fail on a
// volume Windows cannot resolve that way (a RAM disk, a folder mounted without
// a drive letter); the JavaScript one, then the plain resolved path, still
// compare such a checkout correctly, so a dirty checkout there is not mistaken
// for a non-git copy.
const realPath = (file) => {
  for (const resolve of [fs.realpathSync.native, fs.realpathSync]) {
    try {
      return resolve(file);
    } catch {
      /* try the next way */
    }
  }
  return path.resolve(file);
};
export const samePath = (a, b) => path.relative(realPath(a), realPath(b)) === "";

// The short commit of a development copy, whether its tracked files have
// uncommitted changes, and its untracked files that no .gitignore excludes (a
// new module not yet added would ship missing); null when the copy is no git
// checkout of its own. A copy with its
// own .git (a folder, or the file of a linked worktree) is read as a checkout:
// when git cannot inspect it, or reads it as part of another repository, the
// install stops rather than naming the release after its content. A copy
// without one is not asked about: git searches upward, so a copy unpacked
// inside another repository (git archive | tar -x into a project folder, a
// temporary folder inside a checkout) would be judged and named by that
// repository, refused as dirty because its files are untracked there, or
// named after an unrelated HEAD when that repository ignores it. Such a copy
// is named after its content instead.
function sourceCommit(source) {
  if (!fs.existsSync(path.join(source, ".git"))) return null;
  const fix = "repair the checkout, or install from a copy without .git";
  const top = explained(
    () => git(["rev-parse", "--show-toplevel"], source),
    (reason) =>
      `${source} has a .git, but git cannot inspect it (git rev-parse --show-toplevel: ${reason}); ${fix}`,
  );
  if (!samePath(top, source))
    throw new Error(`${source} has a .git, but git reads it as part of ${top}; ${fix}`);
  // No commit at HEAD is git's no (an unborn branch); a HEAD git cannot read fails.
  const head = explained(
    () => gitProbe(["rev-parse", "--verify", "--quiet", "--short=7", "HEAD^{commit}"], source),
    (reason) =>
      `${source} has a .git, but git cannot inspect it (git rev-parse HEAD: ${reason}); ${fix}`,
  );
  if (!head)
    throw new Error(
      `${source} has a .git with no commit at HEAD; commit the copy first, so the release names its commit`,
    );
  const status = explained(
    () => gitRequired(["status", "--porcelain", "--untracked-files=no"], { cwd: source }),
    (reason) => `cannot establish source cleanliness: git status: ${reason}`,
  );
  const others = explained(
    () => gitRequired(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: source }),
    (reason) => `cannot establish source cleanliness: git ls-files --others: ${reason}`,
  );
  const files = trackedSources(source);
  for (const { name, mode } of files)
    if (!REGULAR_MODES.includes(mode))
      throw new Error(`tracked source must be a regular file: ${name}`);
  return {
    commit: head,
    dirty: status.trim() !== "",
    untracked: nulSeparated(others).sort(),
    files,
  };
}

// The tracked files of a checkout under the entry and SOURCES, with the modes
// git records: [{ name, mode }].
function trackedSources(root) {
  const listed = explained(
    () => gitRequired(["ls-files", "--stage", "-z", "--", RUNNER, ...SOURCES], { cwd: root }),
    (reason) => `cannot list the tracked sources: git ls-files: ${reason}`,
  );
  return nulSeparated(listed).map((entry) => ({
    name: entry.slice(entry.indexOf("\t") + 1),
    mode: entry.slice(0, entry.indexOf(" ")),
  }));
}

// A .gitignore reader for copies git cannot judge: blank lines and # comments,
// ! negation, a trailing / for folders, a leading or inner / anchoring a
// pattern to its file's folder, the wildcards *, ?, [...] and **, the
// .gitignore files of subfolders, and git's rule that nothing inside an
// ignored folder comes back. Returns (name) => whether the /-separated path
// name under root is ignored.
function compileIgnore(line) {
  let pattern = line.replace(/\r$/, "");
  if (!pattern.trim() || pattern.startsWith("#")) return null;
  pattern = pattern.replace(/(?<!\\)\s+$/, "");
  let negate = false;
  if (pattern.startsWith("!")) {
    negate = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) pattern = pattern.slice(1);
  const folder = pattern.endsWith("/");
  if (folder) pattern = pattern.slice(0, -1);
  if (!pattern) return null;
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      const atStart = i === 0 || pattern[i - 1] === "/";
      if (atStart && pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else if (atStart && i + 2 === pattern.length) {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[" && pattern.indexOf("]", i + 2) > 0) {
      const close = pattern.indexOf("]", i + 2);
      const body = pattern.slice(i + 1, close);
      source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      i = close;
    } else if (char === "\\" && i + 1 < pattern.length) source += literal(pattern[++i]);
    else source += literal(char);
  }
  return { negate, folder, regex: new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`) };
}
export function ignoreRules(root) {
  const rules = new Map();
  const rulesIn = (folder) => {
    if (!rules.has(folder)) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(root, folder, ".gitignore"), "utf8");
      } catch {
        /* no .gitignore there */
      }
      rules.set(folder, text.split("\n").map(compileIgnore).filter(Boolean));
    }
    return rules.get(folder);
  };
  // The last matching rule decides, a subfolder's .gitignore after its parents'.
  const matches = (name, isFolder) => {
    const parts = name.split("/");
    let ignored = false;
    for (let depth = 0; depth < parts.length; depth++) {
      const relative = parts.slice(depth).join("/");
      for (const rule of rulesIn(parts.slice(0, depth).join("/")))
        if ((!rule.folder || isFolder) && rule.regex.test(relative)) ignored = !rule.negate;
    }
    return ignored;
  };
  return (name) => {
    const parts = name.split("/");
    for (let depth = 1; depth < parts.length; depth++)
      if (matches(parts.slice(0, depth).join("/"), true)) return true;
    return matches(name, false);
  };
}

// What a release consists of besides dist/, as install copies it and check
// scans it: the entry and the files under SOURCES. In a checkout (a copy with
// its own .git) these are its tracked files, so nothing ignored or untracked
// counts; in a copy that is no checkout (git archive, a download), the files
// its .gitignore files do not exclude. [{ name, mode }] with git's modes, a
// copy's taken from its file system (120000 for a link).
export function sourceInventory(root = ROOT) {
  if (fs.existsSync(path.join(root, ".git"))) return trackedSources(root);
  const ignored = ignoreRules(root);
  const files = [];
  const visit = (name) => {
    let stat;
    try {
      stat = fs.lstatSync(path.join(root, name));
    } catch (error) {
      if (error.code === ERRNO.ENOENT) return;
      throw error;
    }
    if (stat.isDirectory())
      for (const child of fs.readdirSync(path.join(root, name)).sort()) visit(`${name}/${child}`);
    else if (!ignored(name))
      files.push({
        name,
        mode: stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644",
      });
  };
  for (const name of [RUNNER, ...SOURCES]) visit(name);
  // In git's order, byte by byte, as git ls-files lists a checkout.
  return files.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
}

// Inspect every path under the entry and SOURCES before changing the target.
// lstat rejects links and junctions at any level, ignored entries included:
// install copies none of those, but a link anywhere in a release's folders is
// refused rather than judged.
function validateSourceTree(source) {
  const root = fs.lstatSync(source);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error(`source must be a real directory: ${source}`);
  const visit = (file) => {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error.code === ERRNO.ENOENT) return;
      throw error;
    }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error(`source entry must be a regular file or directory: ${file}`);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
  };
  for (const name of [RUNNER, ...SOURCES]) visit(path.join(source, name));
}

// Publishes a release folder from the given modules: written to a staging
// folder beside it, syntax-checked, made read-only, then renamed into place.
// An existing folder with the same content is reused; one with different
// content is never overwritten.
function importCheck(root, id, checker = path.join(ROOT, STAGE_CHECK_FILE)) {
  const version = id.slice(0, id.indexOf("-"));
  const args = [checker, root, version];
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: STAGE_CHECK_MS,
    maxBuffer: STAGE_CHECK_BYTES,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `staged release fails import check: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
}

// Run a tag's own checker and its relative src/ imports from that same tag,
// without adding tooling to an immutable release or trusting the checkout's copy.
function taggedImportCheck(ref, target, files) {
  const checker = gitFile(ref, STAGE_CHECK_FILE, target);
  if (!checker) throw new Error(`${STAGE_CHECK_FILE} is missing at ${ref}; rollback refused`);
  if (!REGULAR_MODES.includes(checker.mode))
    throw new Error(`${STAGE_CHECK_FILE} at ${ref} must be a regular file`);
  return (root, id) => {
    const scratch = createScratch(TAG_CHECK_PREFIX, path.dirname(root));
    try {
      for (const [name, bytes] of [...files, [STAGE_CHECK_FILE, checker.bytes]]) {
        const file = path.join(scratch.directory, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      }
      importCheck(root, id, path.join(scratch.directory, STAGE_CHECK_FILE));
    } finally {
      scratch.remove();
    }
  };
}

export function publishRelease(target, id, files, { check = importCheck } = {}) {
  if (!RELEASE_ID.test(id)) throw new Error(`invalid release id ${id}`);
  const dist = path.join(target, DIST);
  fs.mkdirSync(dist, { recursive: true });
  const root = path.join(dist, id);
  if (fs.existsSync(root)) {
    if (sameRelease(root, files)) {
      // Reused as it is, and read-only again: a file made writable since is restored.
      for (const name of files.keys()) readOnly(path.join(root, name));
      check(root, id);
      return { root, reused: true };
    }
    throw new Error(
      `release ${id} already exists under ${DIST}/ with different content and is never overwritten; commit the change so the release gets a new id`,
    );
  }
  const staging = path.join(dist, `.staging-${id}-${process.pid}`);
  // Its files are made writable first: Windows refuses to remove a read-only one.
  const discard = () => {
    for (const name of folderInventory(staging).names) {
      try {
        writable(path.join(staging, name));
      } catch {
        /* gone */
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });
  };
  discard();
  try {
    // Each file's folders, src/ and every folder a nested module is in, first.
    fs.mkdirSync(staging, { recursive: true });
    for (const [name, bytes] of files) {
      const file = path.join(staging, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    for (const name of files.keys()) {
      if (name.endsWith(".mjs")) {
        const check = node(["--check", path.join(staging, name)]);
        if (check.status !== 0)
          throw new Error(`${name} fails node --check: ${check.stderr.trim()}`);
      }
      readOnly(path.join(staging, name));
    }
    check(staging, id);
    fs.renameSync(staging, root);
  } catch (error) {
    discard();
    throw error;
  }
  return { root, reused: false };
}

// check scans what install copies: every text file of the source inventory
// (sourceInventory), the entry included, so a tracked file under .gitea/ or
// ci/ is held to the same rules as one under src/. A file with a NUL
// byte is binary and not read as text. The scans' only exceptions:
// - the diagrams' SVG exports, which the Mermaid CLI writes as one line with
//   no final newline and nobody edits by hand, skip the whitespace rules; they
//   are still scanned for machine paths;
// - under ci/gitea/, the home folder of the node user, which the
//   official node image the runner image builds on has in /home, is the same
//   container path on every machine; any other user-profile path there is
//   still reported.
const GENERATED_TEXT = /^docs\/diagrams\/[^/]+\.svg$/;
const CONTAINER_PATHS = [{ file: /^ci\/gitea\//, path: /^\/home\/node$/ }];
function scannedTexts(root) {
  const texts = [];
  for (const { name, mode } of sourceInventory(root)) {
    if (!REGULAR_MODES.includes(mode)) continue;
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(root, name));
    } catch (error) {
      // A tracked file deleted in the working tree has nothing to scan.
      if (error.code === ERRNO.ENOENT) continue;
      throw error;
    }
    if (!bytes.includes(0)) texts.push({ name, text: bytes.toString("utf8") });
  }
  return texts;
}
// The tracked sources name no machine: install.mjs fills the real paths into the
// installed agents and skill.
const PROFILE_PATH =
  /\b[A-Za-z]:[\\/]+Users[\\/]+(?![<{$%])[^\\/\s"'`)]+|(?<![\w.])\/(?:home|Users)\/(?![<{$])[^/\s"'`)]+/g;
// Text hygiene only. This deliberately does not parse or lint JavaScript.
export function sourceHygiene(root = ROOT) {
  const problems = [];
  for (const { name, text } of scannedTexts(root)) {
    if (GENERATED_TEXT.test(name)) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (/[\t ]+$/.test(line)) problems.push(`${name}:${index + 1}: trailing whitespace`);
    });
    if (text && !text.endsWith("\n")) problems.push(`${name}: missing final newline`);
  }
  return problems;
}
export function machinePaths(root = ROOT) {
  const found = [];
  const container = (name, value) =>
    CONTAINER_PATHS.some(({ file, path: home }) => file.test(name) && home.test(value));
  for (const { name, text } of scannedTexts(root))
    text.split("\n").forEach((line, index) => {
      const match = [...line.matchAll(PROFILE_PATH)].find(([value]) => !container(name, value));
      if (match) found.push(`${name}:${index + 1}: ${match[0]}`);
    });
  return found;
}

// Copies one source file into the target, writing it only when its bytes
// differ; a read-only target file is made writable first, since Windows
// refuses to overwrite it. On POSIX the executable bit follows the one git
// records, for an unchanged file too. Returns 1 when it wrote the bytes.
function copySource(from, to, executable) {
  const bytes = fs.readFileSync(from);
  let wrote = 0;
  if (!(fs.existsSync(to) && fs.readFileSync(to).equals(bytes))) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) writable(to);
    fs.writeFileSync(to, bytes);
    wrote = 1;
  }
  setExecutable(to, executable);
  return wrote;
}

// The skill names every role in one sentence, "There is one role per model:
// `a`, `b` ... and `z`.", which may wrap over lines. Its role-shaped code
// spans, up to the full stop or blank line that ends the sentence, are the
// list; null when the skill has no such sentence.
const SKILL = "claude/skills/codex-subagents-for-claude-code/SKILL.md";
const ROLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
export function skillRoles(text) {
  const start = /\bone role per model:/i.exec(text);
  if (!start) return null;
  const roles = [];
  // A code span, else the end of the sentence: a full stop outside a span, or a blank line.
  const token = /`([^`\n]*)`|\.(?=\s|$)|\n[ \t\r]*\n/g;
  token.lastIndex = start.index + start[0].length;
  for (let match = token.exec(text); match?.[1] !== undefined; match = token.exec(text))
    if (ROLE_NAME.test(match[1])) roles.push(match[1]);
  return roles;
}
// The role names of the runner in root, read by a bounded child process as
// the import check does, so this tool still runs when that src/ cannot load.
function runnerRoles(root, env) {
  const index = pathToFileURL(path.join(root, "src", "index.mjs")).href;
  const read = `const { ROLES } = await import(${JSON.stringify(index)});
console.log(JSON.stringify(Object.keys(ROLES)));`;
  const result = node(["--input-type=module", "-e", read], {
    cwd: root,
    env,
    timeout: ROLES_READ_MS,
  });
  if (result.status !== 0) {
    const lines = result.stderr.trim().split("\n");
    throw new Error(
      `could not read ROLES from src/index.mjs: ${(lines.find((line) => /Error/.test(line)) ?? lines[0]).trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}
function skillRoleProblems(root, roles) {
  const listed = skillRoles(fs.readFileSync(path.join(root, SKILL), "utf8"));
  if (!listed)
    return [
      `${SKILL} has no role list: the sentence "There is one role per model: ..." is missing`,
    ];
  return [
    ...roles
      .filter((role) => !listed.includes(role))
      .map(
        (role) =>
          `${SKILL} does not list the role ${role}, which the runner's ROLES has (src/roles.mjs)`,
      ),
    ...[...new Set(listed)]
      .filter((role) => !roles.includes(role))
      .map(
        (role) =>
          `${SKILL} lists the role ${role}, which the runner's ROLES does not have (src/roles.mjs)`,
      ),
  ];
}

// The Claude Code plugin the repository also is (its marketplace lists it
// from the repository root): plugin.json's version must be the runner's,
// since an update reaches users only when that version changes, and
// marketplace.json must list the compact plugin once and no
// version of its own (plugin.json's would win, and validate warns about it).
// A copy without .claude-plugin/ has no plugin to check.
const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";
const MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json";
export function pluginProblems(root, version) {
  const problems = [];
  const manifest = (name) => {
    try {
      return readJson(path.join(root, name));
    } catch (error) {
      problems.push(`${name} is unreadable: ${error.message}`);
      return null;
    }
  };
  const plugin = manifest(PLUGIN_MANIFEST),
    market = manifest(MARKETPLACE_MANIFEST);
  if (plugin && plugin.version !== version)
    problems.push(`${PLUGIN_MANIFEST} says ${plugin.version}, the runner says ${version}`);
  if (!plugin || !market) return problems;
  const entries = (Array.isArray(market.plugins) ? market.plugins : []).filter(
    (entry) => entry?.name === plugin.name,
  );
  if (entries.length !== 1)
    problems.push(`${MARKETPLACE_MANIFEST} must list the plugin ${plugin.name} exactly once`);
  else if (entries[0].source !== PLUGIN_SOURCE)
    problems.push(
      `${MARKETPLACE_MANIFEST} lists ${plugin.name} from ${JSON.stringify(entries[0].source)}, not "${PLUGIN_SOURCE}"`,
    );
  else if (entries[0].version !== undefined)
    problems.push(
      `${MARKETPLACE_MANIFEST} sets a version for ${plugin.name}; ${PLUGIN_MANIFEST} alone names it`,
    );
  return problems;
}

// The cheap gates: everything a commit must pass, in a few seconds, without
// invoking Codex.
export function check({ root = ROOT, env = process.env, write = console.log } = {}) {
  const problems = [];
  try {
    problems.push(...sourceHygiene(root));
    for (const where of machinePaths(root))
      problems.push(
        `a machine-specific path in a tracked source (use ~, $HOME or an install.mjs placeholder): ${where}`,
      );
  } catch (error) {
    problems.push(error.message);
  }
  // A link where a release file can be is never followed: install refuses it.
  // A module named .mjs in another case loads here, but no release holds it.
  const { others, miscased } = folderInventory(root);
  for (const name of others)
    problems.push(`${name} is no regular file (a link or a junction); a release holds files only`);
  for (const name of miscased)
    problems.push(
      `${name} ends in .mjs in another case: a release holds only *.mjs, so it would be missing from it; rename it`,
    );
  const checked = checkedFiles(root);
  for (const name of checked) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) {
      problems.push(`${name} is missing`);
      continue;
    }
    const result = node(["--check", file]);
    if (result.status !== 0) problems.push(`${name}: ${result.stderr.trim()}`);
  }
  let version = null;
  try {
    version = runnerVersion(path.join(root, VERSION_FILE));
    const declared = readJson(path.join(root, "package.json")).version;
    if (declared !== version)
      problems.push(`package.json says ${declared}, the runner says ${version}`);
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    if (!readme.includes(`(runner ${version})`))
      problems.push(`README.md does not introduce runner ${version}`);
  } catch (error) {
    problems.push(error.message);
  }
  // Keep the spawn result here: run() throws its error and loses any output
  // captured before a spawn/buffer failure. Installer refusals are not drift.
  const installed = spawnSync(process.execPath, [path.join(root, "install.mjs"), "--check"], {
    cwd: root,
    env: childEnvironment(env),
    encoding: "utf8",
    ...SPAWN_OPTIONS,
  });
  if (installed.error || installed.status !== EXIT.COMPLETED) {
    const stdout = asText(installed.stdout).trim(),
      stderr = asText(installed.stderr).trim();
    const output = stdout.split(/\r?\n/);
    const drift =
      !installed.error &&
      installed.status === EXIT.FAILURE &&
      !stderr &&
      output.some((line) => /^(missing|differs) /.test(line)) &&
      output.every((line) => /^(same|missing|differs) /.test(line));
    const detail =
      [installed.error?.message, stderr, stdout].filter(Boolean).join("\n") ||
      (installed.signal ? `killed by ${installed.signal}` : `exit ${installed.status}`);
    const message = drift
      ? "installed agents or skill differ from the sources (node install.mjs fixes that)"
      : "installer check failed (node install.mjs --check)";
    problems.push(`${message}:\n${detail}`);
  }
  if (fs.existsSync(path.join(root, PLUGIN_MANIFEST))) {
    problems.push(...pluginProblems(root, version));
    problems.push(...pluginPackageProblems(root));
    const rendered = node([path.join(root, "install.mjs"), "--plugin", "--check"], {
      cwd: root,
      env,
    });
    if (rendered.status !== 0)
      problems.push(
        `the plugin's agents or skill differ from the sources (node install.mjs --plugin fixes that):\n${(rendered.stdout || rendered.stderr).trim()}`,
      );
  }
  try {
    problems.push(...skillRoleProblems(root, runnerRoles(root, env)));
  } catch (error) {
    problems.push(error.message);
  }
  // A warning, not a problem: the manifest commit itself runs check (the
  // pre-commit hook) before its tag can exist. verify reports every untagged
  // manifest as a problem. A copy that is no checkout has no tags to ask
  // about; a checkout whose tags git cannot list is said so, as a warning too.
  const warnings = [];
  try {
    const newest = manifestVersions(root).at(-1);
    if (newest && untaggedReleases(root)?.includes(newest))
      warnings.push(
        `releases/v${newest}.json has no tag v${newest}: tag release ${newest} at its manifest commit (node tools/release.mjs tag)`,
      );
  } catch (error) {
    warnings.push(
      `could not tell whether the newest release manifest has its tag: ${error.message}`,
    );
  }
  write(`runner=${version ?? "-"} checked=${checked.length} problems=${problems.length}`);
  for (const problem of problems) write(`problem: ${problem}`);
  for (const warning of warnings) write(`warning: ${warning}`);
  return problems.length ? EXIT.FAILURE : EXIT.COMPLETED;
}

// Source hooks validate rendering in their own temporary installation. A
// contributor's live definitions can legitimately name a different checkout.
function checkForHook({ root, env, write }) {
  const temporary = createScratch("codex-subagents-for-claude-code-hook-");
  try {
    const isolated = {
      ...env,
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: path.join(temporary.directory, "agents"),
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: path.join(temporary.directory, "skill"),
    };
    const rendered = node([path.join(root, "install.mjs")], { cwd: root, env: isolated });
    if (rendered.status !== EXIT.COMPLETED) {
      write(
        `problem: temporary agent/skill rendering failed:\n${(rendered.stderr || rendered.stdout).trim()}`,
      );
      return EXIT.FAILURE;
    }
    return check({ root, env: isolated, write });
  } finally {
    temporary.remove();
  }
}

// The hooks run check, which reads the working tree, so they first make sure
// that what it reads is what git records. These are the paths check reads:
// the whole source inventory, which it scans, syntax-checks, renders or
// compares.
export const CHECK_INPUTS = [RUNNER, ...SOURCES];

// git in the hook's own environment, which every other git deliberately drops:
// GIT_DIR, and GIT_INDEX_FILE when git commit -a or a commit of named paths
// hands the hook a temporary index. Only these reads keep it; check's children
// do not. Required, like every git the hooks ask.
const hookGit = (args, { cwd, env }) => gitRequired(args, { cwd, hookEnv: env });

// The paths check reads whose working-tree bytes are not what git records:
// changed against the index (a commit) or against HEAD (a push), and untracked.
export function unrecordedInputs({ root = ROOT, env = process.env, against = "index" } = {}) {
  const base = against === "HEAD" ? ["HEAD"] : [];
  return {
    changed: nulSeparated(
      hookGit(["diff", "--name-only", "-z", ...base, "--", ...CHECK_INPUTS], { cwd: root, env }),
    ),
    untracked: nulSeparated(
      hookGit(["ls-files", "--others", "--exclude-standard", "-z", "--", ...CHECK_INPUTS], {
        cwd: root,
        env,
      }),
    ),
  };
}

// The pre-commit hook's gate, then check: a path check reads with unstaged
// changes, or untracked, is refused first, so check judges exactly what the
// commit records.
export function preCommit({ root = ROOT, env = process.env, write = console.log } = {}) {
  const { changed, untracked } = unrecordedInputs({ root, env, against: "index" });
  const problems = [
    ...changed.map((name) => `${name} has unstaged changes: stage them (git add) or stash them`),
    ...untracked.map((name) => `${name} is untracked: add it, or move it out of the checked paths`),
  ];
  if (!problems.length) return checkForHook({ root, env, write });
  write(
    `pre-commit: check reads the working tree, which must be what is committed; problems=${problems.length}`,
  );
  for (const problem of problems) write(`problem: ${problem}`);
  return EXIT.FAILURE;
}

// The pre-push hook's gate, then check: the hook checks and tests the working
// tree at HEAD, so every pushed commit must be HEAD, or one the remote already
// has as this checkout last fetched it, and the paths check reads must equal
// HEAD's. refs are git's pre-push lines, "<local ref> <local object> <remote
// ref> <remote object>"; a deletion pushes no commit.
export function prePush({
  root = ROOT,
  env = process.env,
  remote = null,
  refs = [],
  write = console.log,
} = {}) {
  const at = (args) => hookGit(args, { cwd: root, env }).trim();
  const head = at(["rev-parse", "HEAD"]);
  const problems = [];
  for (const line of refs) {
    const [localRef, localObject] = line.trim().split(/\s+/);
    if (!localObject || /^0+$/.test(localObject)) continue;
    const commit = at(["rev-parse", "--verify", `${localObject}^{commit}`]);
    if (commit === head) continue;
    if (
      remote &&
      at(["for-each-ref", "--contains", commit, "--format=%(refname)", `refs/remotes/${remote}`])
    )
      continue;
    problems.push(
      `${localRef} pushes ${commit.slice(0, COMMIT_DISPLAY_CHARS)}, not HEAD ${head.slice(0, COMMIT_DISPLAY_CHARS)}: the hook checks the working tree at HEAD, so check that commit out and push from there`,
    );
  }
  const { changed, untracked } = unrecordedInputs({ root, env, against: "HEAD" });
  problems.push(
    ...changed.map((name) => `${name} differs from HEAD: commit or stash it before pushing`),
    ...untracked.map(
      (name) => `${name} is untracked: commit it, or move it out of the checked paths`,
    ),
  );
  if (!problems.length) return checkForHook({ root, env, write });
  write(
    `pre-push: the hook checks and tests the working tree, which must be what is pushed; problems=${problems.length}`,
  );
  for (const problem of problems) write(`problem: ${problem}`);
  return EXIT.FAILURE;
}

// The release, in five steps, in an order that keeps every new invocation
// consistent. No step undoes an earlier one: once the pointer flips, sessions
// may already run the new release. What a failure in each step leaves:
// - preflight: the target as it was, not even created; a copy without its
//   entry is refused here too;
// - stage: a failed release folder discards its staging folder, and nothing
//   else has changed; a failure while copying the other sources leaves the
//   release folder in dist/ (inert while the pointer names another) and the
//   files copied so far; the entry, the pointer, the agents and the manifest
//   are as they were. A target without a pointer runs src/ itself, so it runs
//   the copied modules at once;
// - activate: an entry that fails node --check, or whose rename fails, leaves
//   the old entry, read-only, and the pointer as it was; a pointer flip still
//   refused after its retries leaves the previous release current, with the
//   new entry in place;
// - agents: the new release active, and no manifest written (the previous
//   one, if any, as it was);
// - manifest: the new release active and its agents installed, and the
//   previous manifest complete.
export function install({ fromDir, target = ROOT, env = process.env, write = console.log }) {
  const release = installPreflight(fromDir, target);
  installStage(release, target, write);
  installActivate(release, target, write);
  installAgents(target, env, write);
  installManifest(release, target, env, write);
  return EXIT.COMPLETED;
}

// Preflight: everything that is read and asked before the first write. The
// copy's tree holds no link, it has its entry, its version agrees, a checkout
// of its own is clean, fully tracked and readable by git, and its release
// files and the release id are known:
// { source, entry, version, commit, inventory, files, id, ignored }.
function installPreflight(fromDir, target) {
  if (!fromDir) throw new Error("install needs --from-dir DIR, the development copy");
  const source = path.resolve(fromDir);
  if (path.resolve(target) === source)
    throw new Error("--from-dir is the target itself; develop in a copy");
  validateSourceTree(source);
  // The entry the activate step puts in place, read before anything is
  // written: a copy without one (validateSourceTree passes over a missing
  // path) is no release.
  let entry;
  try {
    entry = fs.readFileSync(path.join(source, RUNNER));
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
    throw new Error(`${source} has no ${RUNNER}, the entry a release installs; restore it first`);
  }
  const version = runnerVersion(path.join(source, VERSION_FILE));
  if (
    fs.existsSync(path.join(source, "package.json")) &&
    readJson(path.join(source, "package.json")).version !== version
  ) {
    throw new Error(`the copy's package.json and runner disagree on the version (${version})`);
  }
  const checkout = sourceCommit(source);
  if (checkout?.dirty)
    throw new Error(
      "the development copy has uncommitted changes; commit them first, so the release names its commit",
    );
  if (checkout?.untracked.length) {
    const { untracked } = checkout;
    const shown = untracked.slice(0, UNTRACKED_SHOWN).join(", ");
    const more =
      untracked.length > UNTRACKED_SHOWN ? ` and ${untracked.length - UNTRACKED_SHOWN} more` : "";
    throw new Error(
      `the development copy has untracked files: ${shown}${more}; commit, ignore or remove them first, so the release holds every file its commit would`,
    );
  }
  const inventory = checkout?.files ?? sourceInventory(source);
  const files = releaseFilesFrom(source, inventory);
  const commit = checkout?.commit ?? null;
  const id = `${version}-${commit ?? contentDigest(files).slice(0, COMMIT_DISPLAY_CHARS)}`;
  // Resolve every decision now: copying .gitignore must not change which
  // target files are protected, including rules in nested .gitignore files.
  const ignoredBySource = ignoreRules(source),
    ignoredByTarget = ignoreRules(target);
  const names = inventory.map(({ name }) => name);
  const ignored = new Set(names.filter((name) => ignoredBySource(name) || ignoredByTarget(name)));
  validateInstallTarget({ inventory, files, id, version, ignored }, target);
  return { source, entry, version, commit, inventory, files, id, ignored };
}

// Reject a linked destination (at any depth, even above target) before stage
// writes anything. The copy loop checks again immediately before each write.
function validateInstallTarget({ inventory, files, id, version, ignored }, target) {
  const names = [
    ...inventory.filter(({ name }) => !ignored.has(name)).map(({ name }) => name),
    RUNNER,
    STAGED,
    POINTER,
    `releases/v${version}.json`,
    ...[...files.keys()].flatMap((name) => [
      `${DIST}/${id}/${name}`,
      `${DIST}/.staging-${id}-${process.pid}/${name}`,
    ]),
  ];
  for (const name of names) requireTargetFile(target, name);
}

// Stage: the release folder under dist/, inert until the pointer names it,
// then the other sources copied into the target (src/ among them, which the
// entry runs while no pointer exists).
function installStage(release, target, write) {
  const { source, inventory, files, id, ignored } = release;
  validateInstallTarget(release, target);
  const { root, reused } = publishRelease(target, id, files);
  write(
    `release ${id}: ${files.size} files ${reused ? "already under dist/, reused" : `installed read-only at ${root}`}`,
  );
  // The release's files, not the copy's folders: nothing ignored or untracked
  // is copied, and a path that either side's .gitignore excludes is never
  // written, even when the copy tracks it, so the target's machine-local
  // files, such as ci/gitea/.env, stay as they are.
  let copied = 0;
  const kept = [];
  for (const { name, mode } of inventory) {
    if (name === RUNNER) continue;
    if (ignored.has(name)) kept.push(name);
    else {
      copied += copySource(
        path.join(source, name),
        requireTargetFile(target, name),
        mode === "100755",
      );
    }
  }
  write(`copied ${copied} changed source files`);
  if (kept.length)
    write(
      `left ${kept.length} ignored file${kept.length > 1 ? "s" : ""} alone: ${kept.join(", ")}`,
    );
}

// Activate: the entry preflight read, replaced in one rename when it changed,
// then the pointer flipped to the release in one rename.
function installActivate({ entry, inventory, id }, target, write) {
  for (const name of [RUNNER, STAGED, POINTER]) requireTargetFile(target, name);
  const executable = inventory.find(({ name }) => name === RUNNER)?.mode === "100755";
  const live = path.join(target, RUNNER);
  if (fs.existsSync(live) && fs.readFileSync(live).equals(entry)) {
    setExecutable(live, executable);
    readOnly(live);
    write(`entry ${live} unchanged read-only=${isReadOnly(live)}`);
  } else
    write(
      `replaced ${live} sha256=${replaceRunner(target, entry, executable).slice(0, DIGEST_DISPLAY_CHARS)} read-only=${isReadOnly(live)}`,
    );
  let previous = "?";
  try {
    previous = readPointer(target) ?? "-";
  } catch {
    /* an invalid pointer is replaced */
  }
  flipPointer(target, id);
  write(`pointer ${POINTER}: ${previous} -> ${id}`);
}

// Agents: the target's install.mjs renders the agents and the skill from the
// release the pointer now names.
function installAgents(target, env, write) {
  const agents = node([path.join(target, "install.mjs")], { cwd: target, env });
  if (agents.status !== 0)
    throw new Error(`install.mjs failed: ${(agents.stderr || agents.stdout).trim()}`);
  for (const line of agents.stdout.trim().split("\n")) write(line);
}

// Manifest: releases/v<version>.json, naming what was installed, written to a
// unique sibling file and renamed into place, so a reader sees the previous
// complete JSON or the new one.
function installManifest({ version, id, commit, files }, target, env, write) {
  const live = path.join(target, RUNNER);
  const manifest = {
    version,
    release: id,
    commit,
    installedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    entrySha256: sha256(live),
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256Of(bytes)])),
    tests: Object.fromEntries(
      testFiles(target).map((name) => [name, sha256(path.join(target, name))]),
    ),
    codex: codexVersion(env),
  };
  fs.mkdirSync(path.join(target, "releases"), { recursive: true });
  const file = requireTargetFile(target, `releases/v${version}.json`);
  const stagedManifest = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(stagedManifest, file);
  } finally {
    fs.rmSync(stagedManifest, { force: true });
  }
  write(`manifest ${file}`);
}

// Identify the selected CLI in an isolated version-only probe. The release
// tool can still repair a copy whose runtime modules cannot be imported.
export function codexVersion(env) {
  const cli = new URL("../src/codex/cli.mjs", import.meta.url).href;
  const script = `import {selectCodex} from ${JSON.stringify(cli)}; try { console.log((await selectCodex(process.env)).version); } catch { /* CLI may be absent on the packaging host. */ }`;
  const result = node(["--input-type=module", "--eval", script], { env });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

// The release manifests releases/v<version>.json under root, as versions,
// oldest first.
const MANIFEST = /^v(\d+\.\d+\.\d+)\.json$/;
const bySemver = (a, b) => {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
export function manifestVersions(root = ROOT) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, "releases"));
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
  }
  return names
    .map((name) => MANIFEST.exec(name)?.[1])
    .filter(Boolean)
    .sort(bySemver);
}
// The installed releases that were never tagged: the versions of the
// manifests under root without a tag v<version>, oldest first, or null when
// root is no checkout of its own. A checkout whose tags git cannot list throws,
// so that failure never reads as "every release is tagged".
export function untaggedReleases(root = ROOT) {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  const listed = gitRequired(["tag", "--list", "v*"], { cwd: root });
  const tags = new Set(listed.split("\n").map((name) => name.trim()));
  return manifestVersions(root).filter((version) => !tags.has(`v${version}`));
}

// The live installation is the committed one: the entry equals HEAD's, and
// the release the pointer names holds exactly HEAD's modules, all read-only.
// The check that would have caught the 2026-10-23 overwrite. It also names
// every installed release that was never tagged (untagged=).
export function verify({ target = ROOT, write = console.log } = {}) {
  const problems = [];
  const live = path.join(target, RUNNER);
  const head = git(["rev-parse", "--short", "HEAD"], target);
  const tags = git(["tag", "--points-at", "HEAD"], target).split("\n").filter(Boolean);
  const entrySha = sha256(live);
  const committedEntry = gitFile("HEAD", RUNNER, target)?.bytes ?? null;
  const entrySame = committedEntry !== null && sha256Of(committedEntry) === entrySha;
  if (!entrySame)
    problems.push(
      `the entry ${RUNNER} is not the committed one; compare with git diff, then release or roll back`,
    );
  if (!isReadOnly(live))
    problems.push(`the entry ${RUNNER} is writable; the release tool leaves it read-only`);
  let id = "-",
    version = "-",
    releaseSame = false;
  let pointer = null;
  try {
    pointer = readPointer(target);
  } catch (error) {
    problems.push(error.message);
  }
  if (pointer) {
    id = pointer;
    const root = path.join(target, DIST, id);
    if (!fs.existsSync(path.join(root, "src")))
      problems.push(`release ${id}, named by ${POINTER}, is missing under ${DIST}/`);
    else {
      try {
        version = runnerVersion(path.join(root, VERSION_FILE));
      } catch (error) {
        problems.push(error.message);
      }
      // The installed release and HEAD's, each listed by the release rule. HEAD's
      // files are every one read: a tree or a blob git cannot read fails verify,
      // never shortens the list or reads as a difference.
      const installed = folderInventory(root);
      const tree = gitTree("HEAD", target, ["src", ...LEGAL_FILES]);
      const atHead = treeInventory(tree);
      const committed = committedFiles(tree, atHead.names, target);
      const before = problems.length;
      for (const name of installed.others)
        problems.push(
          `release ${id}: ${name} is no regular file (a link or a junction); the release tool installs regular files only`,
        );
      for (const name of atHead.others)
        problems.push(`release ${id}: ${name} is committed as a link or a submodule`);
      for (const name of installed.names) {
        const blob = committed.get(name);
        if (!blob || !blob.equals(fs.readFileSync(path.join(root, name))))
          problems.push(`release ${id}: ${name} differs from HEAD`);
        if (!isReadOnly(path.join(root, name)))
          problems.push(`release ${id}: ${name} is writable; the release tool leaves it read-only`);
      }
      for (const name of committed.keys())
        if (!installed.names.includes(name))
          problems.push(`release ${id}: ${name} is committed but not installed`);
      releaseSame = problems.length === before;
    }
  } else if (pointer === null) {
    problems.push(
      `no release is installed (${POINTER} is missing), so the entry runs the modules under src/; run node tools/release.mjs install`,
    );
  }
  const same = entrySame && releaseSame;
  const untagged = untaggedReleases(target) ?? [];
  for (const untaggedVersion of untagged)
    problems.push(
      `releases/v${untaggedVersion}.json has no tag v${untaggedVersion}: release ${untaggedVersion} was installed but never tagged; tag its manifest commit (node tools/release.mjs tag, run at that commit)`,
    );
  write(
    `live=${version} release=${id} entry-sha256=${entrySha.slice(0, DIGEST_DISPLAY_CHARS)} read-only=${isReadOnly(live)} head=${head}${tags.length ? ` tags=${tags.join(",")}` : ""} matches-head=${same ? "yes" : "no"} untagged=${untagged.length ? untagged.join(",") : "-"}`,
  );
  for (const problem of problems) write(`problem: ${problem}`);
  return problems.length ? EXIT.FAILURE : EXIT.COMPLETED;
}

// An annotated tag on a consistent HEAD whose tracked files have no
// uncommitted changes. Untracked files, such as someone's report beside the
// sources, do not block it. A version tag marks the installed release, so
// HEAD must be the commit that recorded its manifest, releases/v<version>.json:
// the tag is made right after the manifest commit, and nowhere else.
export function tag({ root = ROOT, env = process.env, write = console.log } = {}) {
  if (git(["status", "--porcelain", "--untracked-files=no"], root))
    throw new Error("a tracked file has uncommitted changes; commit first");
  if (check({ root, env, write: () => {} }) !== 0)
    throw new Error("check fails; fix it before tagging");
  const version = runnerVersion(path.join(root, VERSION_FILE));
  const name = `v${version}`;
  if (gitProbe(["rev-parse", "--verify", "--quiet", `refs/tags/${name}`], root) !== null)
    throw new Error(`tag ${name} exists`);
  const manifest = `releases/v${version}.json`;
  const committed = gitFile("HEAD", manifest, root);
  if (committed === null)
    throw new Error(
      `${manifest} is not at HEAD: install release ${version} (install --from-dir), commit its manifest, then tag that commit`,
    );
  let recorded = null;
  try {
    recorded = JSON.parse(committed.bytes.toString("utf8")).version ?? null;
  } catch {
    /* reported below */
  }
  if (recorded !== version)
    throw new Error(
      `${manifest} at HEAD records version ${JSON.stringify(recorded)}, not ${version}`,
    );
  const head = git(["rev-parse", "HEAD"], root);
  const changed = git(["log", "-1", "--format=%H", "HEAD", "--", manifest], root);
  if (changed !== head)
    throw new Error(
      `HEAD is not the manifest commit of ${version}: ${manifest} last changed in ${changed.slice(0, COMMIT_DISPLAY_CHARS)}; tag right after the manifest commit`,
    );
  git(["tag", "-a", name, "-m", `Runner ${version}`], root);
  write(`tagged ${name} at ${git(["rev-parse", "--short", "HEAD"], root)}`);
  return EXIT.COMPLETED;
}

// The release of an earlier tag back in place: its modules under dist/ (an
// existing folder with the same content is reused, else one is materialized
// from the tag), its entry when that differs, then the pointer flipped. The
// other files stay at HEAD; this is for a bad release while the fix is
// prepared. The tagged modules and export checker must be complete.
export function rollback(version, { target = ROOT, write = console.log } = {}) {
  if (!SEMVER.test(version ?? "")) throw new Error("rollback needs a version, MAJOR.MINOR.PATCH");
  const tagName = `v${version}`;
  const ref = `refs/tags/${tagName}`;
  if (gitProbe(["rev-parse", "--verify", "--quiet", ref], target) === null)
    throw new Error(`no tag ${tagName}`);
  const live = path.join(target, RUNNER);
  // Every required module and the entry blob is read before anything changes.
  // A missing version module and a failed Git read both refuse activation.
  const tree = gitTree(ref, target, [RUNNER, "src", ...LEGAL_FILES]);
  const runner = tree.get(RUNNER) ?? null;
  const executable = runner?.mode === "100755";
  const entry = runner ? gitBlobs([runner.object], target).get(runner.object) : null;
  const files = releaseFilesFromTag(ref, target, tree);
  const check = taggedImportCheck(ref, target, files);
  let id = null;
  try {
    id =
      fs
        .readdirSync(path.join(target, DIST))
        .filter((name) => name.startsWith(`${version}-`) && RELEASE_ID.test(name))
        .find((name) => sameRelease(path.join(target, DIST, name), files)) ?? null;
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
  }
  id ??= `${version}-${git(["rev-parse", "--short=7", `${ref}^{commit}`], target)}`;
  const { reused } = publishRelease(target, id, files, { check });
  if (entry && !(fs.existsSync(live) && fs.readFileSync(live).equals(entry)))
    write(
      `replaced ${live} with the entry of ${tagName} sha256=${replaceRunner(target, entry, executable).slice(0, DIGEST_DISPLAY_CHARS)} read-only=${isReadOnly(live)}`,
    );
  else if (entry) {
    setExecutable(live, executable);
    readOnly(live);
    write(`entry ${live} unchanged read-only=${isReadOnly(live)}`);
  }
  flipPointer(target, id);
  write(
    `rolled back ${POINTER} to ${id} (${reused ? "already under dist/" : "materialized from the tag"}); README, tests and agents stay at HEAD`,
  );
  return EXIT.COMPLETED;
}

export function setup({ root = ROOT, write = console.log } = {}) {
  git(["config", "core.hooksPath", ".githooks"], root);
  write(
    `core.hooksPath=.githooks (pre-commit: check of what is committed; pre-push: check and the suite on HEAD)`,
  );
  // On POSIX git skips a hook it may not execute, silently: a copy that lost
  // the bit (for example, unpacked without modes)
  // gets it back here.
  if (POSIX)
    for (const name of fs.readdirSync(path.join(root, ".githooks")).sort()) {
      const file = path.join(root, ".githooks", name);
      const before = fs.statSync(file).mode & 0o7777;
      setExecutable(file, true);
      const after = fs.statSync(file).mode & 0o7777;
      if (after !== before)
        write(
          `repaired .githooks/${name}: it was not executable (mode ${before.toString(8)}, now ${after.toString(8)})`,
        );
    }
  return EXIT.COMPLETED;
}

// What each command reads besides its name. An option or argument a command
// does not use is refused, never ignored: check, tag and setup always act on
// the repository that holds this tool, and only install reads a copy.
const ACCEPTS = {
  check: { usage: "check", flags: [], args: 0 },
  install: {
    usage: "install --from-dir DIR [--target DIR]",
    flags: ["from-dir", "target"],
    args: 0,
  },
  verify: { usage: "verify [--target DIR]", flags: ["target"], args: 0 },
  tag: { usage: "tag", flags: [], args: 0 },
  rollback: { usage: "rollback VERSION [--target DIR]", flags: ["target"], args: 1 },
  setup: { usage: "setup", flags: [], args: 0 },
  "pre-commit": { usage: "pre-commit", flags: [], args: 0 },
  "pre-push": { usage: "pre-push [REMOTE [URL]]", flags: [], args: 2 },
};
// The refs a pre-push hook is given on stdin, one line each.
function stdinLines() {
  try {
    return fs
      .readFileSync(0, "utf8")
      .split("\n")
      .filter((line) => line.trim());
  } catch {
    return [];
  }
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = { positional: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--from-dir" || rest[i] === "--target") {
      const flag = rest[i];
      const key = flag.slice(2);
      const value = rest[++i];
      options[key] = value;
      if (value === undefined) throw new Error(`${flag} needs a value`);
    } else if (rest[i].startsWith("--")) throw new Error(`unknown option ${rest[i]}`);
    else options.positional.push(rest[i]);
  }
  const accepts = Object.hasOwn(ACCEPTS, command) ? ACCEPTS[command] : null;
  if (accepts) {
    if (options.target !== undefined && !accepts.flags.includes("target"))
      throw new Error(
        `${command} takes no --target; it acts on the repository that holds this tool, ${ROOT}; run that repository's own tools/release.mjs ${command}`,
      );
    if (options["from-dir"] !== undefined && !accepts.flags.includes("from-dir"))
      throw new Error(
        `${command} takes no --from-dir; only install reads a development copy (usage: ${accepts.usage})`,
      );
    const extra = options.positional[accepts.args];
    if (extra !== undefined)
      throw new Error(`unexpected argument ${JSON.stringify(extra)} (usage: ${accepts.usage})`);
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { command, options } = parse(argv);
    const target = options.target ? path.resolve(options.target) : ROOT;
    switch (command) {
      case "check":
        return check();
      case "install":
        return install({ fromDir: options["from-dir"], target });
      case "verify":
        return verify({ target });
      case "tag":
        return tag();
      case "rollback":
        return rollback(options.positional[0], { target });
      case "setup":
        return setup();
      case "pre-commit":
        return preCommit();
      case "pre-push":
        return prePush({ remote: options.positional[0] ?? null, refs: stdinLines() });
      case "help":
      case "--help":
      case undefined:
        process.stdout.write(HELP);
        return command ? EXIT.COMPLETED : EXIT.FAILURE;
      default:
        throw new Error(`unknown command ${command}`);
    }
  } catch (error) {
    console.error(`release: ${error.message}`);
    return EXIT.FAILURE;
  }
}

// Node loads the main module from its real path, so through a directory
// junction or symlink process.argv[1] names another path to this same file.
const sameFile = (a, b) => {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
};
if (
  process.argv[1] &&
  (path.resolve(process.argv[1]) === SCRIPT || sameFile(process.argv[1], SCRIPT))
)
  process.exitCode = await main();
