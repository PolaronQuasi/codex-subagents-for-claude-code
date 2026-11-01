#!/usr/bin/env node
// Installs the Claude Code side of the role runner from this folder: one
// forwarder agent per runner role, rendered from
// claude/agents/forwarder.template.md, into ~/.claude/agents, and the
// codex-subagents-for-claude-code skill, rendered from claude/skills/codex-subagents-for-claude-code/SKILL.md, into
// ~/.claude/skills/codex-subagents-for-claude-code. The sources hold no machine paths: the
// placeholders {{runner}}, {{manual}} and {{tmp}} become this folder's runner,
// its manual and the temporary folder, as forward-slash absolute paths, and
// {{taskfile}} the task file a forwarder writes there ({{prepare}} is empty).
// --check compares the installed files with these sources and writes nothing
// (exit 1 on any difference).
// --uninstall removes only unchanged definitions owned by this checkout;
// --uninstall --check previews that removal. Shared directories and all runner
// data remain. Edited or unproven definitions are preserved (exit 1).
//
// --plugin renders the same sources for the Claude Code plugin this folder
// also is (.claude-plugin/): agents/<role>.md and
// skills/codex-subagents-for-claude-code/SKILL.md in this folder, naming no
// machine path. Their {{prepare}} step runs
// ${CLAUDE_PLUGIN_ROOT}/run-codex-task.mjs --prepare, which prints the runner
// of the release's runtime snapshot and a task file to write; --plugin
// --check compares them. Node >= 22; no npm dependencies.

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as RUNNER from "./run-codex-task.mjs";
import { shellWord } from "./src/shared/shell.mjs";
import { ROLES as SOURCE_ROLES, DISPLAY as SOURCE_DISPLAY } from "./src/roles.mjs";
import { absoluteOverride } from "./src/shared/io.mjs";
import { inspectTargetFile, requireTargetFile } from "./src/shared/install-paths.mjs";
import { TASK_FOLDER, JSON_INDENT, IS_WINDOWS } from "./src/shared/constants.mjs";
import { ERRNO, EXIT } from "./src/shared/errors.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const SKILL_NAME = "codex-subagents-for-claude-code";
const PLUGIN_INVENTORY = ".generated.json";
const contentHash = (text) => crypto.createHash("sha256").update(text).digest("hex");

// Use the catalogue already selected by the entry shim. A concurrent pointer
// flip cannot combine roles and display data from different releases.
const selectedDisplay = RUNNER.DISPLAY;
if (!RUNNER.ROLES || !selectedDisplay)
  throw new Error("selected release has no matching role/display catalogue; no agents installed");
export const ROLES = RUNNER.ROLES;
export const DISPLAY = selectedDisplay;

// A display entry for a role without one: GPT-6.1-Terra for gpt-6.1-terra.
function derivedDisplay(role, roles) {
  const model = roles[role]?.model ?? role;
  const name = model
    .split("-")
    .map((part, index) =>
      index === 0 && part === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("-");
  return { model: name, alias: `("${role}")` };
}

const slashed = (file) => file.split(path.sep).join("/");
// Where this installation lives, as the agents and the skill name it.
export function installPaths({ root = HERE, tmp = os.tmpdir() } = {}) {
  return {
    runner: slashed(path.join(root, "run-codex-task.mjs")),
    manual: slashed(path.join(root, "docs", "MANUAL.md")),
    tmp: slashed(tmp),
  };
}

// What the plugin's renderings name instead: Claude Code replaces
// ${CLAUDE_PLUGIN_ROOT} in agent and skill text with the plugin's folder.
// entry answers --prepare; the runner it prints, the runtime snapshot's
// entry, stands where a checkout names its own runner.
const PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}";
export const PLUGIN_PATHS = Object.freeze({
  runner: "<runner path>",
  manual: `${PLUGIN_ROOT}/docs/MANUAL.md`,
  entry: `${PLUGIN_ROOT}/run-codex-task.mjs`,
});

// A replacement function inserts its value as it is; a replacement string
// would read $&, $', $` and $$ in a path as patterns.
function fill(text, values) {
  let out = text;
  for (const [name, value] of Object.entries(values))
    out = out.replaceAll(`{{${name}}}`, () => value);
  const left = /\{\{[a-z]+\}\}/.exec(out);
  if (left) throw new Error(`install.mjs left the placeholder ${left[0]} unfilled`);
  return out;
}

// How a forwarder finds the file it writes its task to: a checkout names its
// temporary folder; the plugin's text, which names no machine path, has the
// forwarder run --prepare first, which prints that file and the runner.
function agentTask(role, paths) {
  if (!paths.entry)
    return {
      prepare: "",
      taskfile: `${paths.tmp}/${TASK_FOLDER}/${role}-<8 random lowercase hex characters>.md`,
    };
  return {
    prepare: [
      "Use the Bash tool to run",
      `   \`node ${shellWord(paths.entry)} --prepare ${role}\`. It prints two lines,`,
      "   `runner: <runner path>` and `task-file: <task path>`; if it exits with another code than 0,",
      "   reply with its output exactly and stop. ",
    ].join("\n"),
    taskfile: "<task path>",
  };
}
// The skill's counterpart: a checkout's task file example, or the plugin's
// paragraph on --prepare.
function skillTask(paths) {
  if (!paths.entry)
    return { prepare: "", taskfile: `\`${paths.tmp}/${TASK_FOLDER}/<role>-<8 hex>.md\`` };
  return {
    prepare: [
      "In this plugin, `<runner path>` is the `runner:` line that",
      `\`node ${shellWord(paths.entry)} --prepare <role>\` prints: this release's immutable copy of the`,
      "runner, kept outside the plugin cache, which the command makes when it is missing. Its",
      "`task-file:` line names an unused task file in the temporary folder; run it again for each new",
      "task file.",
      "",
      "",
    ].join("\n"),
    taskfile: "the `task-file:` path that `--prepare` prints",
  };
}

const warnOnStderr = (line) => console.error(line);

// display and roles: the catalogue (ROLES, DISPLAY by default). A role without
// display data gets a derived name, and warn says so.
export function renderAgent(
  template,
  role,
  paths = installPaths(),
  { display = DISPLAY, roles = ROLES, warn = warnOnStderr } = {},
) {
  let entry = display[role];
  if (!entry) {
    entry = derivedDisplay(role, roles);
    warn(
      `install.mjs: role ${role} has no display entry; its agent is named ${entry.model} ${entry.alias}`,
    );
  }
  return fill(template, {
    role,
    model: entry.model,
    alias: entry.alias,
    ...agentTask(role, paths),
    ...paths,
    runnerarg: shellWord(paths.runner),
  });
}

export function renderSkill(text, paths = installPaths()) {
  return fill(text, {
    ...skillTask(paths),
    ...paths,
    agentnamespace: paths.entry ? "codex-subagents:" : "",
    runnerarg: shellWord(paths.runner),
  });
}

const readSource = (...parts) => fs.readFileSync(path.join(HERE, ...parts), "utf8");
const forwarderTemplate = () => readSource("claude", "agents", "forwarder.template.md");
const skillSource = () => readSource("claude", "skills", SKILL_NAME, "SKILL.md");

// The files this folder installs: [{ target, text }], one agent per role of
// the catalogue (roles, display: ROLES and DISPLAY by default) and the skill.
export function plannedFiles({
  env = process.env,
  home = os.homedir(),
  paths = installPaths(),
  roles = ROLES,
  display = DISPLAY,
  warn = warnOnStderr,
} = {}) {
  const template = forwarderTemplate();
  const agentsDir =
    env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR || path.join(home, ".claude", "agents");
  const skillDir =
    env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR ||
    path.join(home, ".claude", "skills", SKILL_NAME);
  const files = Object.keys(roles).map((role) => ({
    target: path.join(agentsDir, `${role}.md`),
    text: renderAgent(template, role, paths, { display, roles, warn }),
  }));
  files.push({ target: path.join(skillDir, "SKILL.md"), text: renderSkill(skillSource(), paths) });
  return files;
}

// The plugin's rendered files, in this folder: [{ target, text }]. The plugin
// runs this folder's src/, so its roles are those of src/roles.mjs, whatever
// release dist/current selects.
export function plannedPluginFiles({
  root = HERE,
  roles = SOURCE_ROLES,
  display = SOURCE_DISPLAY,
  warn = warnOnStderr,
} = {}) {
  const template = forwarderTemplate();
  const files = Object.keys(roles).map((role) => ({
    target: path.join(root, "agents", `${role}.md`),
    text: renderAgent(template, role, PLUGIN_PATHS, { display, roles, warn }),
  }));
  files.push({
    target: path.join(root, "skills", SKILL_NAME, "SKILL.md"),
    text: renderSkill(skillSource(), PLUGIN_PATHS),
  });
  files.push({
    target: path.join(root, "agents", PLUGIN_INVENTORY),
    text:
      JSON.stringify(
        {
          version: 1,
          files: Object.fromEntries(
            files
              .filter((file) => path.dirname(file.target) === path.join(root, "agents"))
              .map((file) => [path.basename(file.target), contentHash(file.text)]),
          ),
        },
        null,
        JSON_INDENT,
      ) + "\n",
  });
  return files;
}

// Only remove an obsolete generated agent whose bytes still match our previous
// inventory. Unexpected/custom files are reported; user edits are preserved.
export function retiredPluginFiles(files) {
  const manifest = files.find((file) => path.basename(file.target) === PLUGIN_INVENTORY);
  const dir = path.dirname(manifest.target);
  let previous = { version: 1, files: {} };
  try {
    previous = JSON.parse(fs.readFileSync(manifest.target, "utf8"));
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
  }
  if (
    previous?.version !== 1 ||
    !previous.files ||
    typeof previous.files !== "object" ||
    Array.isArray(previous.files) ||
    Object.entries(previous.files).some(
      ([name, hash]) => !/^gpt-[a-zA-Z0-9.-]+\.md$/.test(name) || !/^[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new Error("invalid generated plugin inventory; no agents removed");
  const expected = new Set(files.map((file) => file.target));
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
  }
  return names
    .filter((name) => name.endsWith(".md") && !expected.has(path.join(dir, name)))
    .map((name) => {
      const target = path.join(dir, name);
      const stat = fs.lstatSync(target);
      const owned =
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        previous.files[name] === contentHash(fs.readFileSync(target));
      return { target, owned };
    });
}

const pathKey = (target) => {
  const resolved = path.resolve(target);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
};
const CHECKOUT = pathKey(fs.realpathSync.native(HERE));
const RECEIPT_NAME = `.codex-subagents-install-${contentHash(CHECKOUT)}.json`;
const MAX_DEFINITION_BYTES = 2 * 1024 * 1024;

// Receipt metadata must never expand ownership to arbitrary gpt-*.md files.
// The selected catalogue is the checkout installer's trusted current inventory.
const CHECKOUT_AGENT_NAMES = new Set(Object.keys(ROLES).map((role) => `${role}.md`));

function inspectDefinition(target) {
  const dir = path.dirname(target),
    name = path.basename(target);
  const inspected = inspectTargetFile(dir, name);
  if (!inspected) {
    requireTargetFile(dir, name); // Shared diagnostic and alias policy.
    throw new Error(`destination changed while inspecting: ${target}`);
  }
  return inspected.stat;
}

function sameStat(a, b) {
  return (
    a &&
    b &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function definitionState(target) {
  const before = inspectDefinition(target);
  if (!before) return null;
  const ancestors = new Map();
  // Resolve physical spelling only after the shared alias policy has passed.
  // Track both spellings so fixed /var aliases also pin /private's identity.
  for (let dir of [
    path.dirname(path.resolve(target)),
    fs.realpathSync.native(path.dirname(target)),
  ]) {
    while (!ancestors.has(dir)) {
      const stat = fs.lstatSync(dir);
      ancestors.set(dir, { dev: stat.dev, ino: stat.ino });
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const stat = inspectDefinition(target);
  if (!sameStat(before, stat)) throw new Error(`destination changed while inspecting: ${target}`);
  return { stat, ancestors };
}

function sameState(a, b) {
  return a === null || b === null
    ? a === b
    : sameStat(a.stat, b.stat) &&
        a.ancestors.size === b.ancestors.size &&
        [...a.ancestors].every(([dir, stat]) => {
          const after = b.ancestors.get(dir);
          return after && after.dev === stat.dev && after.ino === stat.ino;
        });
}

function safeFile(target) {
  const snapshot = definitionState(target);
  if (!snapshot) return null;
  const { stat } = snapshot;
  if (stat.size > MAX_DEFINITION_BYTES)
    throw new Error(`definition or receipt exceeds ${MAX_DEFINITION_BYTES} bytes: ${target}`);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino
    )
      throw new Error(`file changed while opening: ${target}`);
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = definitionState(target);
    if (!sameState(snapshot, after) || length !== stat.size)
      throw new Error(`file changed while reading: ${target}`);
    return { ...snapshot, bytes: bytes.subarray(0, length) };
  } finally {
    fs.closeSync(fd);
  }
}

function sameSnapshot(a, b) {
  return a === null || b === null ? a === b : sameState(a, b) && a.bytes.equals(b.bytes);
}

function writeDefinition(target, text, previous) {
  inspectDefinition(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  inspectDefinition(target);
  const staged = `${target}.${crypto.randomBytes(12).toString("hex")}.next`;
  // Exclusive creation cannot follow a planted stage symlink or hardlink.
  const fd = fs.openSync(staged, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    if (!sameSnapshot(previous, safeFile(target)))
      throw new Error(`destination changed; refusing replacement: ${target}`);
    fs.renameSync(staged, target);
  } finally {
    const remaining = fs.lstatSync(staged, { throwIfNoEntry: false });
    if (remaining) fs.unlinkSync(staged);
  }
}

function checkoutReceipts(files) {
  const groups = new Map();
  for (const file of files) {
    const target = path.resolve(file.target);
    inspectDefinition(target);
    // Only resolve physical spelling after rejecting all arbitrary aliases.
    // A source under /private/var must also be protected when named via /var.
    let ancestor = path.dirname(target);
    const suffix = [path.basename(target)];
    while (!fs.existsSync(ancestor)) {
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
    const physical = path.join(fs.realpathSync.native(ancestor), ...suffix);
    const relative = path.relative(CHECKOUT, pathKey(physical));
    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    )
      throw new Error(`checkout definitions must be outside the source tree: ${target}`);
    const dir = path.dirname(target);
    const key = pathKey(path.dirname(physical));
    if (!groups.has(key)) groups.set(key, { dir, files: [] });
    groups.get(key).files.push({ ...file, target });
  }
  for (const group of groups.values()) {
    group.target = path.join(group.dir, RECEIPT_NAME);
    group.snapshot = safeFile(group.target);
    group.previous = {};
    if (!group.snapshot) continue;
    let receipt;
    try {
      receipt = JSON.parse(group.snapshot.bytes.toString("utf8"));
    } catch {
      throw new Error(`invalid checkout ownership receipt: ${group.target}`);
    }
    const agents = group.files.some((file) => path.basename(file.target) !== "SKILL.md");
    const skill = group.files.some((file) => path.basename(file.target) === "SKILL.md");
    if (
      receipt?.version !== 1 ||
      receipt.checkout !== CHECKOUT ||
      !receipt.files ||
      typeof receipt.files !== "object" ||
      Array.isArray(receipt.files) ||
      Object.entries(receipt.files).some(
        ([name, hash]) =>
          !((skill && name === "SKILL.md") || (agents && CHECKOUT_AGENT_NAMES.has(name))) ||
          typeof hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(hash),
      )
    )
      throw new Error(`invalid checkout ownership receipt: ${group.target}`);
    group.previous = receipt.files;
  }
  return [...groups.values()];
}

function removeDefinition(target, snapshot) {
  const current = safeFile(target);
  if (!sameSnapshot(snapshot, current) || !sameState(current, definitionState(target)))
    throw new Error(`destination changed; refusing removal: ${target}`);
  // Recheck after safeFile closes its descriptor, including ancestor identity.
  // Node unlink is still pathname-based: another process can race this last
  // check. Keeping a read fd open does not bind unlink to that file on Windows.
  fs.unlinkSync(target);
}

function uninstallCheckout(files, { check, write }) {
  const groups = checkoutReceipts(files);
  // Complete the plan and validate every path before the first removal.
  const plan = groups.flatMap((group) => {
    const expected = group.files.map((file) => path.basename(file.target));
    return [...new Set([...expected, ...Object.keys(group.previous)])].map((name) => {
      const target = path.join(group.dir, name);
      const snapshot = safeFile(target);
      const hash = snapshot && contentHash(snapshot.bytes);
      // A receipt is local, mutable evidence of bytes we installed, not an
      // authentication boundary against a same-user rewrite of names/hashes.
      // Matching rendered text alone does not establish installation ownership.
      const owned = Boolean(
        snapshot && Object.hasOwn(group.previous, name) && hash === group.previous[name],
      );
      return { group, target, snapshot, owned };
    });
  });
  let preserved = false;
  let pending = false;
  for (const file of plan) {
    if (!file.snapshot) write(`missing ${file.target}`);
    else if (!file.owned) {
      preserved = true;
      write(`preserved ${file.target} (edited or ownership unproven)`);
    } else {
      pending = true;
      if (!check) removeDefinition(file.target, file.snapshot);
      write(`${check ? "would-remove" : "removed"} ${file.target}`);
    }
  }
  for (const group of groups) {
    if (!group.snapshot) continue;
    if (plan.some((file) => file.group === group && file.snapshot && !file.owned)) {
      write(`preserved ${group.target} (definitions remain)`);
      continue;
    }
    pending = true;
    if (!check) removeDefinition(group.target, group.snapshot);
    write(`${check ? "would-remove" : "removed"} ${group.target}`);
  }
  return preserved || (check && pending) ? EXIT.FAILURE : EXIT.COMPLETED;
}

export function install({
  check = false,
  plugin = false,
  uninstall = false,
  env = process.env,
  home = os.homedir(),
  write = (line) => console.log(line),
} = {}) {
  if (plugin && uninstall) throw new Error("--uninstall cannot be combined with --plugin");
  // The folder overrides follow the runner's rule for path overrides (on
  // Windows a drive or UNC path), so a Git Bash path is refused rather than
  // installed under the current drive; an empty value means the default.
  if (!plugin)
    for (const name of [
      "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR",
      "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR",
    ])
      if (env[name]) absoluteOverride(env, name);
  let drift = 0;
  const files = plugin ? plannedPluginFiles() : plannedFiles({ env, home });
  if (uninstall) return uninstallCheckout(files, { check, write });
  const receipts = plugin ? [] : checkoutReceipts(files);
  // Check all definitions before any writes, not only as each is installed.
  for (const file of files) safeFile(file.target);
  const retired = plugin ? retiredPluginFiles(files) : [];
  if (!check && retired.some((file) => !file.owned))
    throw new Error(
      "unexpected or edited plugin agents; no agents removed: " +
        retired
          .filter((file) => !file.owned)
          .map((file) => file.target)
          .join(", "),
    );
  for (const file of retired) {
    drift++;
    write((check ? "stale " : "removed ") + file.target);
    if (!check) fs.unlinkSync(file.target);
  }
  for (const { target, text } of files) {
    const snapshot = safeFile(target);
    const current = snapshot?.bytes.toString("utf8") ?? null;
    const state = current === text ? "same" : current === null ? "missing" : "differs";
    if (state !== "same") {
      drift++;
      if (!check) {
        // Written beside the target and renamed into place, so Claude Code
        // never reads a half-written agent or skill.
        writeDefinition(target, text, snapshot);
      }
    }
    write(`${check ? state : state === "same" ? "unchanged" : "installed"} ${target}`);
  }
  if (!check)
    for (const group of receipts) {
      const text =
        JSON.stringify(
          {
            version: 1,
            checkout: CHECKOUT,
            files: {
              ...group.previous,
              ...Object.fromEntries(
                group.files.map((file) => [path.basename(file.target), contentHash(file.text)]),
              ),
            },
          },
          null,
          JSON_INDENT,
        ) + "\n";
      if (!group.snapshot?.bytes.equals(Buffer.from(text))) {
        writeDefinition(group.target, text, group.snapshot);
        write(`recorded ${group.target}`);
      }
    }
  return check && drift ? EXIT.FAILURE : EXIT.COMPLETED;
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
) {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !["--check", "--plugin", "--uninstall"].includes(arg)) ||
    new Set(args).size !== args.length ||
    (args.includes("--plugin") && args.includes("--uninstall"))
  ) {
    console.error("usage: node install.mjs [--plugin | --uninstall] [--check]");
    process.exitCode = EXIT.FAILURE;
  } else {
    try {
      process.exitCode = install({
        check: args.includes("--check"),
        plugin: args.includes("--plugin"),
        uninstall: args.includes("--uninstall"),
      });
    } catch (error) {
      console.error(`install.mjs: ${error.message}`);
      process.exitCode = EXIT.FAILURE;
    }
  }
}
