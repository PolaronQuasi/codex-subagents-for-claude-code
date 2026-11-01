// The release tests' fixture (test/tools/release-*.test.mjs): scratch folders, development
// copies of this repository's runner, committed checkouts the release tool can tag, and the git
// that sets them up.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitEnvironment, initRepository } from "./git-environment.mjs";
import { ROOT } from "../../tools/release.mjs";

const IS_WINDOWS = process.platform === "win32";
const SCRIPT = fileURLToPath(new URL("../../tools/release.mjs", import.meta.url));
const RUNNER = "run-codex-task.mjs";
const stub = (version) => `export const RUNNER_VERSION = "${version}";\n`;
const node = (args, options = {}) =>
  spawnSync(process.execPath, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
    env: gitEnvironment(options.env),
  });

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagents-for-claude-code-release "));
  t.after(() => {
    for (const file of fs.readdirSync(root, { recursive: true })) {
      try {
        const target = path.join(root, file);
        const stat = fs.lstatSync(target);
        // POSIX directories need search permission while their children are removed.
        // Do not follow symlinks when repairing permissions in disposable fixtures.
        if (stat.isDirectory()) fs.chmodSync(target, 0o755);
        else if (stat.isFile()) fs.chmodSync(target, 0o644);
      } catch {
        /* a test may already have removed an entry */
      }
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}
const IDENTITY = { name: "release-test", email: "release-test@example.invalid" };
const gitIn = (cwd, ...args) => {
  const result = spawnSync(
    "git",
    ["-c", `user.name=${IDENTITY.name}`, "-c", `user.email=${IDENTITY.email}`, ...args],
    { cwd, encoding: "utf8", windowsHide: true, env: gitEnvironment() },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const lines = () => {
  const out = [];
  return { write: (line) => out.push(line), text: () => out.join("\n") };
};
const modules = () =>
  fs
    .readdirSync(path.join(ROOT, "src"), { recursive: true })
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => name.split(path.sep).join("/"))
    .sort();
const versionModule = (version) =>
  fs
    .readFileSync(path.join(ROOT, "src", "version.mjs"), "utf8")
    .replace(/RUNNER_VERSION = "[^"]+"/, `RUNNER_VERSION = "${version}"`);
// A development copy of this repository's runner at a version: the entry, the
// modules, the installer and the templates, and the files check reads.
function devCopy(root, version) {
  fs.mkdirSync(root, { recursive: true });
  // A copy's entry is writable, as a development copy's is: the live folder
  // keeps its entry read-only, and a copy of that file keeps the attribute on
  // Windows (on POSIX, its mode), so a test that rewrites the copy's entry, or
  // copies over it again, would be refused there.
  const entry = path.join(root, RUNNER);
  if (fs.existsSync(entry)) fs.chmodSync(entry, fs.statSync(entry).mode | 0o200);
  fs.copyFileSync(path.join(ROOT, RUNNER), entry);
  fs.chmodSync(entry, fs.statSync(entry).mode | 0o200);
  fs.cpSync(path.join(ROOT, "src"), path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "version.mjs"), versionModule(version));
  fs.copyFileSync(path.join(ROOT, "install.mjs"), path.join(root, "install.mjs"));
  for (const name of ["LICENSE", "NOTICE"])
    fs.copyFileSync(path.join(ROOT, name), path.join(root, name));
  fs.cpSync(path.join(ROOT, "claude"), path.join(root, "claude"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "codex-subagents-for-claude-code",
      version,
      type: "module",
      license: "Apache-2.0",
    }),
  );
  fs.writeFileSync(path.join(root, "README.md"), `# dev copy (runner ${version})\n`);
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "MANUAL.md"), "# manual\n");
}
const installEnv = (root) => ({
  ...gitEnvironment(),
  CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH: path.join(root, "missing-codex"),
  CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: path.join(root, "agents"),
  CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: path.join(root, "skill"),
});
// For git commands whose hooks run: those call node from PATH.
function hookEnv(root) {
  const env = installEnv(root);
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  env[key] = `${path.dirname(process.execPath)}${path.delimiter}${env[key] ?? ""}`;
  return env;
}
// git that may fail, as when a hook refuses.
const gitTry = (cwd, args, env) =>
  spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env });
// A release manifest as install writes it, reduced to the field tag reads.
const writeManifest = (repo, version, recorded = version) => {
  fs.mkdirSync(path.join(repo, "releases"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "releases", `v${version}.json`),
    `${JSON.stringify({ version: recorded }, null, 2)}\n`,
  );
};
// A committed checkout that passes check, so it can be tagged: the copy, the
// release tools, its agents rendered under root and, unless
// manifest is false, the version's manifest in the same commit.
function taggableRepo(root, repo, version, { manifest = true } = {}) {
  devCopy(repo, version);
  fs.appendFileSync(path.join(repo, "package.json"), "\n");
  fs.cpSync(path.join(ROOT, "tools"), path.join(repo, "tools"), { recursive: true });
  fs.cpSync(path.join(ROOT, ".githooks"), path.join(repo, ".githooks"), { recursive: true });
  if (manifest) writeManifest(repo, version);
  const env = installEnv(root);
  const rendered = node([path.join(repo, "install.mjs")], { env });
  assert.equal(rendered.status, 0, rendered.stderr);
  initRepository(repo, IDENTITY);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", version);
  return env;
}

const hashOf = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export {
  IS_WINDOWS,
  SCRIPT,
  RUNNER,
  stub,
  node,
  scratch,
  IDENTITY,
  gitIn,
  lines,
  modules,
  versionModule,
  devCopy,
  installEnv,
  hookEnv,
  gitTry,
  writeManifest,
  taggableRepo,
  hashOf,
};
