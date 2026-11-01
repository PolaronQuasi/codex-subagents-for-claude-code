// Disposable committed copies used by publication tests: the tracked tree of this repository at a
// commit, and nothing untracked; a test that needs another file passes it in files. Git hook
// variables never escape here, and the copy's git reads a private configuration
// (test/support/git-environment.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, buildBundle } from "../../tools/distribution.mjs";
import { gitEnvironment, initRepository } from "./git-environment.mjs";

const IS_WINDOWS = process.platform === "win32";
// What git may print while the fixture reads a whole tree.
const GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
// Removing a scratch folder: Windows can hold a handle in it for a moment.
const SCRATCH_REMOVAL = Object.freeze({ maxRetries: 5, retryDelay: 100 });

function gitIn(cwd, args, { input, encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding,
    windowsHide: true,
    env: gitEnvironment(),
    maxBuffer: GIT_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${String(result.error?.message ?? result.stderr).trim()}`,
    );
  return result.stdout;
}

// The tracked files of this repository at commit, read from git's objects in one batch:
// [{ name, mode, bytes }].
export function trackedTree(commit = "HEAD") {
  const entries = gitIn(ROOT, ["ls-tree", "-r", "-z", "--full-tree", commit])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, type, object] = entry.slice(0, tab).split(" ");
      return { mode, type, object, name: entry.slice(tab + 1) };
    });
  for (const { mode, type, name } of entries)
    if (type !== "blob" || !["100644", "100755"].includes(mode))
      throw new Error(`the fixture copies regular files only: ${name} is ${type} ${mode}`);
  const batch = gitIn(ROOT, ["cat-file", "--batch"], {
    input: Buffer.from(`${entries.map(({ object }) => object).join("\n")}\n`),
    encoding: "buffer",
  });
  let at = 0;
  return entries.map(({ mode, name }) => {
    const end = batch.indexOf(0x0a, at);
    const size = Number(batch.subarray(at, end).toString("latin1").split(" ")[2]);
    const bytes = batch.subarray(end + 1, end + 1 + size);
    at = end + 1 + size + 1;
    return { name, mode, bytes };
  });
}

export function distributionFixture(t, { commit = "HEAD", files = {} } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-distribution-test-"));
  t.after(() => {
    if (
      path.dirname(scratch) !== os.tmpdir() ||
      !path.basename(scratch).startsWith("codex-distribution-test-")
    )
      throw new Error("unexpected test path");
    fs.rmSync(scratch, { recursive: true, force: true, ...SCRATCH_REMOVAL });
  });
  const root = path.join(scratch, "source");
  fs.mkdirSync(root);
  const tree = trackedTree(commit);
  for (const [name, bytes, mode] of [
    ...tree.map(({ name, bytes, mode }) => [name, bytes, mode]),
    ...Object.entries(files),
  ]) {
    const destination = path.join(root, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    if (mode === "100755" && !IS_WINDOWS) fs.chmodSync(destination, 0o755);
  }
  const git = (...args) => gitIn(root, args).trim();
  initRepository(root, { name: "Distribution Test", email: "distribution@example.invalid" });
  // Everything written here, ignored files included: a test often adds one .gitignore excludes.
  git("add", "-A", "-f");
  // The commit's executable bits, which a Windows checkout cannot see.
  const executables = tree.filter(({ mode }) => mode === "100755").map(({ name }) => name);
  if (executables.length) git("update-index", "--chmod=+x", "--", ...executables);
  git("commit", "-q", "-m", "Publication fixture");
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
  const tag = `v${version}`;
  git("tag", "-a", tag, "-m", tag);
  const output = path.join(scratch, "bundle");
  const options = { root, tag, output, mainRef: "main" };
  return { scratch, root, git, options, bundle: buildBundle(options) };
}
