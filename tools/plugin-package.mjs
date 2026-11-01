#!/usr/bin/env node
// The marketplace installs ./plugin, never the development checkout. Maintained
// sources stay at the repository root; this tool copies their runtime subset.
// Run install.mjs --plugin first, then this tool's build. CI/release check calls
// pluginPackageProblems(root) after checking the rendered agents and skills.
// No git, npm, Codex or Claude process is launched. Output is always root/plugin.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "../src/shared/errors.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
export const ROOT = path.dirname(path.dirname(SCRIPT));
export const PLUGIN_SOURCE = "./plugin";
export const INVENTORY = ".plugin-package.json";
const GENERATOR = "tools/plugin-package.mjs";
const CANONICAL = "https://github.com/PolaronQuasi/codex-subagents-for-claude-code/blob/main/";
const FILE_LIMIT = 2 * 1024 * 1024;
const TOTAL_LIMIT = 16 * 1024 * 1024;
const ENTRY_LIMIT = 2048;
const DEPTH_LIMIT = 16;
const PROBLEM_LIMIT = 20;
const PATH_CHARS = 240;
const PROBLEM_CHARS = 1000;
const ERROR_CHARS = 8000;
const FIXED = [
  ".claude-plugin/plugin.json",
  "assets/icon.svg",
  "run-codex-task.mjs",
  "LICENSE",
  "NOTICE",
  "SECURITY.md",
  "SUPPORT.md",
  "CONTRACT.md",
  "docs/MANUAL.md",
  "docs/EXAMPLES.md",
  "docs/OPERATIONS.md",
  "docs/COMPATIBILITY.md",
];
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const safeName = (name) =>
  typeof name === "string" &&
  name.length <= PATH_CHARS &&
  /^[A-Za-z0-9._/-]+$/.test(name) &&
  name.split("/").every((part) => part && part !== "." && part !== ".." && !part.endsWith("."));
const allowed = (name) =>
  name === "README.md" ||
  FIXED.includes(name) ||
  (name.startsWith("src/") && name.endsWith(".mjs")) ||
  (/^(agents|skills)\//.test(name) && name.endsWith(".md"));

// Check every ancestor, including absent leaves, before any read/write. No
// output option can redirect a cleanup to a user-chosen directory.
function locate(root, name) {
  if (!safeName(name)) throw new Error(`unsafe package path: ${String(name).slice(0, PATH_CHARS)}`);
  let current = root;
  const parts = name.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`package path is a link or junction: ${name}`);
    if (stat && index < parts.length - 1 && !stat.isDirectory())
      throw new Error(`package ancestor is not a directory: ${name}`);
  }
  return current;
}

function read(root, name) {
  const file = locate(root, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink > 1)
    throw new Error(`package input must be an unlinked regular file: ${name}`);
  if (stat.size > FILE_LIMIT) throw new Error(`package file exceeds ${FILE_LIMIT} bytes: ${name}`);
  // A bounded fd read also holds the limit if a file grows after lstat.
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > FILE_LIMIT) throw new Error(`package file exceeds ${FILE_LIMIT} bytes: ${name}`);
    return Buffer.from(buffer.subarray(0, length));
  } finally {
    fs.closeSync(fd);
  }
}

function walk(root, start) {
  const files = [],
    directories = [];
  let entries = 0;
  const visit = (name, depth) => {
    if (depth > DEPTH_LIMIT) throw new Error("package tree is too deep");
    const target = locate(root, name);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      directories.push(name);
      const children = [];
      const directory = fs.opendirSync(target);
      try {
        for (let child = directory.readSync(); child; child = directory.readSync()) {
          if (++entries > ENTRY_LIMIT) throw new Error("package tree has too many entries");
          children.push(child.name);
        }
      } finally {
        directory.closeSync();
      }
      for (const child of children.sort()) visit(`${name}/${child}`, depth + 1);
    } else if (stat.isFile() && stat.nlink === 1) files.push(name);
    else throw new Error(`package path is not an unlinked regular file: ${name}`);
  };
  visit(start, 0);
  return { files, directories };
}

function parents(names) {
  const result = new Set();
  for (const name of names) {
    let parent = path.posix.dirname(name);
    while (parent !== ".") {
      result.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return result;
}

// Retained docs keep links into the payload; omitted repository material uses
// canonical GitHub URLs. Missing source targets and escapes fail the build.
function documentBytes(root, name, bytes, files) {
  const rewrite = (target) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return target;
    const [, raw, suffix = ""] = /^([^?#]*)([?#].*)?$/.exec(target);
    const local = path.posix.normalize(
      path.posix.join(path.posix.dirname(name), decodeURIComponent(raw)),
    );
    const source = locate(root, local);
    if (!fs.existsSync(source)) throw new Error(`broken package link in ${name}: ${target}`);
    if (files.has(local)) return target;
    return `${CANONICAL}${local.split("/").map(encodeURIComponent).join("/")}${suffix}`;
  };
  const text = bytes
    .toString("utf8")
    .replace(/(\]\(<?)([^\s)>]+)(?=>?(?:\s|\)))/g, (_, prefix, target) => prefix + rewrite(target))
    .replace(
      /^(\s*\[[^\]\n]+\]:\s*<?)([^\s>]+)/gm,
      (_, prefix, target) => prefix + rewrite(target),
    );
  for (const match of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g))
    if (!files.has(match[1])) throw new Error(`missing plugin-root target in ${name}: ${match[1]}`);
  return Buffer.from(text);
}

export function pluginPackageFiles(root = ROOT) {
  root = fs.realpathSync.native(root);
  const files = new Map();
  const folded = new Set();
  let total = 0;
  const add = (name) => {
    if (folded.has(name.toLowerCase())) throw new Error(`case-colliding package path: ${name}`);
    const bytes = read(root, name);
    total += bytes.length;
    if (total > TOTAL_LIMIT || files.size >= ENTRY_LIMIT)
      throw new Error("package exceeds its total size or file-count bound");
    files.set(name, bytes);
    folded.add(name.toLowerCase());
  };
  for (const name of FIXED) add(name);
  for (const folder of ["src", "agents", "skills"])
    for (const name of walk(root, folder).files) if (allowed(name)) add(name);
  for (const name of ["src/index.mjs", "src/version.mjs"])
    if (!files.has(name)) throw new Error(`missing package runtime file: ${name}`);
  for (const folder of ["agents/", "skills/"])
    if (![...files.keys()].some((name) => name.startsWith(folder)))
      throw new Error(`no rendered plugin files under ${folder}; run node install.mjs --plugin`);
  const manifest = JSON.parse(files.get(".claude-plugin/plugin.json"));
  const pkg = JSON.parse(read(root, "package.json"));
  const version = /export const RUNNER_VERSION = "([^"]+)";/.exec(
    files.get("src/version.mjs").toString(),
  )?.[1];
  if (manifest.version !== pkg.version || version !== pkg.version)
    throw new Error("package, runtime and plugin versions must agree");
  if (manifest.icon !== "./assets/icon.svg")
    throw new Error("plugin icon must be ./assets/icon.svg");
  const market = JSON.parse(read(root, ".claude-plugin/marketplace.json"));
  const entries = market.plugins?.filter((item) => item.name === manifest.name);
  if (entries?.length !== 1 || entries[0].source !== PLUGIN_SOURCE)
    throw new Error(`marketplace must list ${manifest.name} once from ${PLUGIN_SOURCE}`);
  for (const [name, bytes] of files)
    if (name.endsWith(".md")) files.set(name, documentBytes(root, name, bytes, files));
  // This is a small installed-payload guide, not a copy of the repository
  // README. Source-doc links to that README were deliberately made canonical
  // above, so their installation/role anchors still name the full guide.
  files.set(
    "README.md",
    Buffer.from(
      [
        "# Codex subagents for Claude Code",
        "",
        `Version ${manifest.version}. Requires Node.js 22+, Git, Claude Code and a logged-in compatible Codex CLI.`,
        "",
        "Install from the repository marketplace in Claude Code:",
        "",
        "```text",
        "/plugin marketplace add https://github.com/PolaronQuasi/codex-subagents-for-claude-code.git",
        "/plugin install codex-subagents@codex-subagents-for-claude-code",
        "```",
        "",
        "Use the named GPT forwarder agents or the direct-use skill to delegate tasks.",
        "The user commands are:",
        "",
        "- `/codex-subagents:codex-limits`",
        "- `/codex-subagents:codex-list`",
        "- `/codex-subagents:codex-doctor`",
        "",
        "See the [manual](docs/MANUAL.md), [examples](docs/EXAMPLES.md),",
        "[operations guide](docs/OPERATIONS.md), [compatibility](docs/COMPATIBILITY.md)",
        "and [security notes](SECURITY.md). Full installation instructions live in the",
        `[repository README](${CANONICAL}README.md#installation).`,
        "",
        "This directory is generated from the repository's maintained runtime, rendered",
        "agents/skills, selected user docs, manifest and icon. Development files stay in",
        "the repository. Change those sources, render with `node install.mjs --plugin`,",
        "then run `node tools/plugin-package.mjs build`. CI checks the byte inventory with",
        "`node tools/plugin-package.mjs check`; do not edit or format this copy independently.",
        "",
      ].join("\n"),
    ),
  );
  const sorted = new Map([...files].sort(([a], [b]) => byName(a, b)));
  const inventory = {
    schema: 1,
    generatedBy: GENERATOR,
    source: PLUGIN_SOURCE,
    version: manifest.version,
    files: [...sorted].map(([name, bytes]) => ({
      path: name,
      size: bytes.length,
      sha256: hash(bytes),
    })),
  };
  sorted.set(INVENTORY, jsonBytes(inventory));
  if (
    sorted.size > ENTRY_LIMIT ||
    [...sorted.values()].reduce((sum, bytes) => sum + bytes.length, 0) > TOTAL_LIMIT
  )
    throw new Error("generated package exceeds its total size or file-count bound");
  return new Map([...sorted].sort(([a], [b]) => byName(a, b)));
}

function outputState(root) {
  const output = locate(root, "plugin");
  if (!fs.existsSync(output)) return { files: new Map(), directories: [] };
  if (!fs.lstatSync(output).isDirectory()) throw new Error("plugin output is not a directory");
  const tree = walk(root, "plugin");
  const files = new Map();
  let total = 0;
  for (const name of tree.files) {
    const bytes = read(root, name);
    total += bytes.length;
    if (total > TOTAL_LIMIT) throw new Error("existing plugin output exceeds its size bound");
    files.set(name.slice("plugin/".length), bytes);
  }
  return {
    files,
    directories: tree.directories.slice(1).map((name) => name.slice("plugin/".length)),
  };
}

function differences(expected, actual) {
  const problems = [];
  const note = (message) => {
    if (problems.length < PROBLEM_LIMIT) problems.push(message);
  };
  for (const [name, bytes] of expected)
    if (!actual.files.get(name)?.equals(bytes)) note(`plugin/${name} is missing or stale`);
  for (const name of actual.files.keys())
    if (!expected.has(name)) note(`plugin/${name} is unexpected`);
  const directories = parents(expected.keys());
  for (const name of actual.directories)
    if (!directories.has(name)) note(`plugin/${name}/ is unexpected`);
  if (problems.length === PROBLEM_LIMIT)
    problems.push("additional package differences may be omitted");
  return problems;
}

// A small, read-only diagnostic list for parent release/CI integration.
export function pluginPackageProblems(root = ROOT) {
  try {
    root = fs.realpathSync.native(root);
    return differences(pluginPackageFiles(root), outputState(root));
  } catch (error) {
    return [`plugin package: ${error.message.slice(0, PROBLEM_CHARS)}`];
  }
}

function validateOutputOwnership(actual, expected) {
  if (!actual.files.size && !actual.directories.length) return new Map();
  const inventoryBytes = actual.files.get(INVENTORY);
  if (!inventoryBytes)
    throw new Error("refusing to replace nonempty plugin/ without its generated inventory");
  const inventory = JSON.parse(inventoryBytes);
  if (
    inventory.schema !== 1 ||
    inventory.generatedBy !== GENERATOR ||
    inventory.source !== PLUGIN_SOURCE ||
    !Array.isArray(inventory.files) ||
    inventory.files.length > ENTRY_LIMIT
  )
    throw new Error("invalid generated plugin inventory");
  const previousEntries = new Map();
  const caseFoldedPaths = new Set();
  for (const entry of inventory.files) {
    if (
      !safeName(entry.path) ||
      !allowed(entry.path) ||
      caseFoldedPaths.has(entry.path.toLowerCase()) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > FILE_LIMIT ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error("invalid generated plugin inventory entry");
    previousEntries.set(entry.path, entry);
    caseFoldedPaths.add(entry.path.toLowerCase());
  }
  for (const [name, content] of actual.files) {
    if (name === INVENTORY) continue;
    // An interrupted update can have written some current inputs while the
    // final inventory still describes the previous generation. Exact current
    // bytes are safe to keep, including a newly added allowlisted input.
    if (expected.get(name)?.equals(content)) continue;
    const entry = previousEntries.get(name);
    if (!entry) throw new Error(`refusing to overwrite unowned plugin/${name}`);
    if (entry.size !== content.length || entry.sha256 !== hash(content))
      throw new Error(`refusing to overwrite modified generated plugin/${name}`);
  }
  const ownedDirectories = parents([...previousEntries.keys(), ...expected.keys()]);
  for (const name of actual.directories)
    if (!ownedDirectories.has(name)) throw new Error(`refusing to remove unowned plugin/${name}/`);
  return previousEntries;
}

export function buildPluginPackage({ root = ROOT } = {}) {
  root = fs.realpathSync.native(root);
  const expected = pluginPackageFiles(root);
  const actual = outputState(root);
  // Validate the entire output before changing any file.
  validateOutputOwnership(actual, expected);
  for (const name of actual.files.keys()) {
    if (!expected.has(name)) {
      fs.unlinkSync(locate(root, `plugin/${name}`));
    }
  }
  const wantedDirectories = parents(expected.keys());
  // Only empty, previously inventoried directories; never recursive deletion.
  for (const name of actual.directories.sort((a, b) => b.length - a.length)) {
    if (!wantedDirectories.has(name)) {
      fs.rmdirSync(locate(root, `plugin/${name}`));
    }
  }
  const write = (name, bytes) => {
    if (actual.files.get(name)?.equals(bytes)) {
      return;
    }
    const target = locate(root, `plugin/${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Replace by unlink + exclusive create, never truncate an existing inode.
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
  };
  for (const [name, bytes] of expected) {
    if (name !== INVENTORY) {
      write(name, bytes);
    }
  }
  // Publish the inventory last so interrupted updates retain the previous
  // generation's ownership record while completed writes match current bytes.
  write(INVENTORY, expected.get(INVENTORY));
  return {
    source: PLUGIN_SOURCE,
    files: expected.size,
    bytes: [...expected.values()].reduce((total, bytes) => total + bytes.length, 0),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  try {
    const [command, ...extra] = process.argv.slice(2);
    if (extra.length || !["build", "check"].includes(command))
      throw new Error(
        "usage: node tools/plugin-package.mjs build|check (output is always ./plugin)",
      );
    if (command === "build") console.log(JSON.stringify(buildPluginPackage()));
    else {
      const problems = pluginPackageProblems();
      if (problems.length)
        throw new Error(
          problems.join("\n") +
            "\nRun node tools/plugin-package.mjs build after rendering the plugin.",
        );
      console.log("plugin package is current");
    }
  } catch (error) {
    console.error(`plugin-package: ${error.message.slice(0, ERROR_CHARS)}`);
    process.exitCode = EXIT.FAILURE;
  }
}
