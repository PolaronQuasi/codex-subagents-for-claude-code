#!/usr/bin/env node
// Portable release archives, independent of the forge and the live installation.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT } from "../src/shared/errors.mjs";
import { createScratch } from "./scratch.mjs";

const IS_WINDOWS = process.platform === "win32";
// What a packaging command may print, and how long it may take.
const COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
const COMMAND_MS = 20 * 60 * 1000;

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PROJECT = "codex-subagents-for-claude-code";
export const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INCLUDED = new Set([
  "LICENSE",
  "NOTICE",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CONTRACT.md",
  "package.json",
  "run-codex-task.mjs",
  "install.mjs",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".prettierrc.json",
  ".githooks",
  ".claude-plugin",
  "agents",
  "skills",
  "src",
  "test",
  "tools",
  "claude",
  "docs",
  "ci",
]);
export const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
// The order of every file inventory: by UTF-16 code unit, as Array.prototype.sort
// orders strings, never by a locale, so it is the same on every machine.
export const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// The git variables a child keeps: those that only choose which configuration
// files git reads (a test suite's private global file, the system file left
// out). Every other GIT_* name goes, since it can point git at another
// repository, work tree or index, or override a setting.
const CONFIG_SOURCES = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]);
export const cleanGitEnvironment = (env = process.env) =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => {
      const upper = name.toUpperCase();
      return !upper.startsWith("GIT_") || CONFIG_SOURCES.has(upper);
    }),
  );
export function command(executable, args, { cwd = ROOT, env = process.env, inherit = false } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    env: { ...cleanGitEnvironment(env), GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
    shell: false,
    encoding: "utf8",
    maxBuffer: COMMAND_OUTPUT_BYTES,
    timeout: COMMAND_MS,
    ...(inherit ? { stdio: "inherit" } : {}),
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${path.basename(executable)} failed (${result.status}): ${(result.stderr || result.stdout || "see command output").trim()}`,
    );
  return result.stdout ?? "";
}
const git = (root, ...args) => command("git", args, { cwd: root });
const gitText = (root, ref, file) => git(root, "show", `${ref}:${file}`);
const safePath = (name) =>
  typeof name === "string" &&
  name.length > 0 &&
  !name.includes("\\") &&
  !name.includes(":") &&
  !name.startsWith("/") &&
  name.split("/").every((part) => part && part !== "." && part !== "..") &&
  !/[\x00-\x1f]/.test(name);
export const archiveNames = (version) => [
  `${PROJECT}-${version}.zip`,
  `${PROJECT}-${version}.tar.gz`,
];

export function buildBundle({ root = ROOT, tag, output, mainRef = "origin/main" }) {
  if (!TAG.test(tag ?? "")) throw new Error("release tag must be vMAJOR.MINOR.PATCH");
  if (!output) throw new Error("an output directory is required");
  if (git(root, "status", "--porcelain", "--untracked-files=no").trim())
    throw new Error("release packaging requires a clean tracked checkout");
  const ref = `refs/tags/${tag}`;
  const commit = git(root, "rev-parse", "--verify", `${ref}^{commit}`).trim();
  if (commit !== git(root, "rev-parse", "HEAD").trim())
    throw new Error("check out the release tag before packaging");
  git(root, "merge-base", "--is-ancestor", commit, mainRef);
  const version = tag.slice(1);
  const pkg = JSON.parse(gitText(root, ref, "package.json"));
  if (pkg.name !== PROJECT || pkg.version !== version || pkg.license !== "Apache-2.0")
    throw new Error("tag, package version, project name and Apache-2.0 license must agree");
  if (
    !gitText(root, ref, "src/version.mjs").includes(
      `export const RUNNER_VERSION = "${version}";`,
    ) ||
    !gitText(root, ref, "README.md").includes(`(runner ${version})`)
  )
    throw new Error("tag, runner version and README version must agree");
  const entries = git(root, "ls-tree", "-rz", ref)
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [header, name] = entry.split("\t");
      return { mode: header.split(" ")[0], name };
    })
    .filter(
      ({ name }) =>
        INCLUDED.has(name.split("/")[0]) &&
        !name.startsWith("docs/local/") &&
        !name
          .split("/")
          .some((part) => part === ".runner" || part === ".env" || part.startsWith(".env.")),
    );
  for (const { mode, name } of entries) {
    if (!safePath(name) || !["100644", "100755"].includes(mode))
      throw new Error(`release contains an unsupported path, link or submodule: ${name}`);
  }
  for (const required of [
    "LICENSE",
    "NOTICE",
    "install.mjs",
    "run-codex-task.mjs",
    "src/version.mjs",
  ])
    if (!entries.some(({ name }) => name === required))
      throw new Error(`release is missing ${required}`);
  const directory = path.resolve(output);
  if (fs.existsSync(directory) && fs.readdirSync(directory).length)
    throw new Error("output directory must be empty; existing artifacts are never replaced");
  fs.mkdirSync(directory, { recursive: true });
  const prefix = `${PROJECT}-${version}/`;
  // Read committed blobs as bytes, so archive checks do not depend on checkout line endings.
  // The inventory is in code-unit order, as the release tool's: a collation, even "en",
  // folds case and weighs punctuation by ICU data that differs between Node versions.
  const files = entries
    .sort((a, b) => byCodeUnit(a.name, b.name))
    .map(({ name, mode }) => {
      const bytes = spawnSync("git", ["show", `${ref}:${name}`], {
        cwd: root,
        env: cleanGitEnvironment(),
        windowsHide: true,
        maxBuffer: COMMAND_OUTPUT_BYTES,
      });
      if (bytes.error || bytes.status !== 0)
        throw new Error(
          `could not read committed file ${name}: ${bytes.error?.message ?? (bytes.stderr.toString("utf8").trim() || `git exited ${bytes.status}`)}`,
        );
      return { path: name, mode, size: bytes.stdout.length, sha256: digest(bytes.stdout) };
    });
  const archives = archiveNames(version).map((name) => {
    git(
      root,
      "archive",
      `--format=${name.endsWith(".zip") ? "zip" : "tar.gz"}`,
      `--prefix=${prefix}`,
      `--output=${path.join(directory, name)}`,
      ref,
      "--",
      ...entries.map((entry) => entry.name),
    );
    const bytes = fs.readFileSync(path.join(directory, name));
    return { name, size: bytes.length, sha256: digest(bytes) };
  });
  const manifest = { schema: 1, project: PROJECT, version, tag, commit, archives, files };
  fs.writeFileSync(
    path.join(directory, "release-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(directory, "RELEASE-NOTES.md"),
    `# Codex subagents for Claude Code ${version}\n\nCommit: \`${commit}\`\n\nRequires Node.js 22+, Git, Claude Code and a logged-in compatible Codex CLI. Tested with codex-cli 0.166.0; other versions are admitted subject to capabilities.\nSee the included README for installation and compatibility details.\n`,
  );
  const assets = [...archiveNames(version), "release-manifest.json", "RELEASE-NOTES.md"];
  fs.writeFileSync(
    path.join(directory, "SHA256SUMS"),
    assets
      .map((name) => `${digest(fs.readFileSync(path.join(directory, name)))}  ${name}\n`)
      .join(""),
  );
  return loadBundle(directory);
}

export function loadBundle(directory) {
  directory = fs.realpathSync(directory);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "release-manifest.json"), "utf8"),
  );
  if (
    manifest.schema !== 1 ||
    manifest.project !== PROJECT ||
    !TAG.test(manifest.tag) ||
    manifest.version !== manifest.tag.slice(1) ||
    !/^[0-9a-f]{40}$/.test(manifest.commit)
  )
    throw new Error("invalid release manifest identity");
  const expected = [...archiveNames(manifest.version), "release-manifest.json", "RELEASE-NOTES.md"];
  const sums = fs
    .readFileSync(path.join(directory, "SHA256SUMS"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^([0-9a-f]{64})  ([^/\\\r\n]+)$/.exec(line);
      if (!match || !expected.includes(match[2])) throw new Error("unexpected checksum entry");
      return { name: match[2], sha256: match[1] };
    });
  assert.deepEqual(
    sums.map(({ name }) => name).sort(),
    [...expected].sort(),
    "checksum inventory must be complete and unique",
  );
  for (const { name, sha256 } of sums) {
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file)
      throw new Error(`asset must be a regular file: ${name}`);
    if (digest(fs.readFileSync(file)) !== sha256) throw new Error(`checksum mismatch: ${name}`);
  }
  assert.deepEqual(
    manifest.archives.map(({ name }) => name),
    archiveNames(manifest.version),
    "archive inventory mismatch",
  );
  for (const item of manifest.archives) {
    if (
      sums.find(({ name }) => name === item.name).sha256 !== item.sha256 ||
      fs.statSync(path.join(directory, item.name)).size !== item.size
    )
      throw new Error("archive manifest mismatch");
  }
  if (
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length ||
    manifest.files.some(
      (file) =>
        !safePath(file.path) ||
        !["100644", "100755"].includes(file.mode) ||
        !/^[0-9a-f]{64}$/.test(file.sha256),
    )
  )
    throw new Error("invalid file inventory");
  return { directory, manifest, assets: [...expected, "SHA256SUMS"] };
}

export function smokeBundle(directory) {
  const bundle = loadBundle(directory);
  const temporary = createScratch("codex-subagents-for-claude-code-package-");
  const scratch = temporary.directory;
  try {
    for (const archive of bundle.manifest.archives) {
      const destination = path.join(scratch, archive.name.endsWith(".zip") ? "zip" : "tar");
      fs.mkdirSync(destination);
      const archivePath = path.join(bundle.directory, archive.name);
      if (archive.name.endsWith(".zip")) {
        if (IS_WINDOWS)
          command(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:CODEX_RELEASE_ARCHIVE, $env:CODEX_RELEASE_EXTRACT)",
            ],
            {
              env: {
                ...process.env,
                CODEX_RELEASE_ARCHIVE: archivePath,
                CODEX_RELEASE_EXTRACT: destination,
              },
            },
          );
        else command("unzip", ["-q", archivePath, "-d", destination]);
      } else {
        // Git hooks prepend Git Bash tools to PATH. GNU tar treats C: as a remote host.
        const tar = IS_WINDOWS ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
        command(tar, ["-xzf", archivePath, "-C", destination]);
      }
      const extracted = path.join(destination, `${PROJECT}-${bundle.manifest.version}`);
      const actual = fs
        .readdirSync(extracted, { recursive: true, withFileTypes: true })
        .filter((item) => !item.isDirectory())
        .map((item) => {
          if (!item.isFile()) throw new Error("extracted package contains a link");
          return path
            .relative(extracted, path.join(item.parentPath, item.name))
            .split(path.sep)
            .join("/");
        })
        .sort();
      assert.deepEqual(
        actual,
        bundle.manifest.files.map((file) => file.path).sort(),
        "extracted file inventory mismatch",
      );
      for (const file of bundle.manifest.files) {
        const bytes = fs.readFileSync(path.join(extracted, file.path));
        if (bytes.length !== file.size || digest(bytes) !== file.sha256)
          throw new Error(`extracted file mismatch: ${file.path}`);
        if (
          !IS_WINDOWS &&
          Boolean(fs.statSync(path.join(extracted, file.path)).mode & 0o111) !==
            (file.mode === "100755")
        )
          throw new Error(`extracted executable mode mismatch: ${file.path}`);
      }
      const env = {
        ...process.env,
        CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: path.join(destination, "agents"),
        CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: path.join(destination, "skill"),
      };
      const help = command(process.execPath, ["run-codex-task.mjs", "--help"], {
        cwd: extracted,
        env,
      });
      if (!help.includes(bundle.manifest.version))
        throw new Error("packaged runner reports the wrong version");
      command(process.execPath, ["install.mjs"], { cwd: extracted, env });
      command(process.execPath, ["install.mjs", "--check"], { cwd: extracted, env });
      const target = path.join(destination, "managed-install");
      command(
        process.execPath,
        ["tools/release.mjs", "install", "--from-dir", extracted, "--target", target],
        { cwd: extracted, env },
      );
      command(process.execPath, ["run-codex-task.mjs", "--help"], { cwd: target, env });
      command(process.execPath, ["install.mjs", "--check"], { cwd: target, env });
    }
  } finally {
    temporary.remove();
  }
  return bundle;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, tagOrDirectory, output, ...extra] = process.argv.slice(2);
    if (
      extra.length ||
      (operation === "smoke" && output) ||
      !["build", "smoke"].includes(operation)
    )
      throw new Error("usage: node tools/distribution.mjs build vX.Y.Z OUTPUT | smoke OUTPUT");
    const bundle =
      operation === "build"
        ? buildBundle({ tag: tagOrDirectory, output })
        : smokeBundle(tagOrDirectory);
    console.log(
      `${operation}: ${bundle.manifest.tag} commit=${bundle.manifest.commit} assets=${bundle.assets.length}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = EXIT.FAILURE;
  }
}
