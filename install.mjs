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
import { fileURLToPath, pathToFileURL } from "node:url";
import * as RUNNER from "./run-codex-task.mjs";
import { shellWord } from "./src/shared/shell.mjs";
import { ROLES as SOURCE_ROLES, DISPLAY as SOURCE_DISPLAY } from "./src/roles.mjs";
import { absoluteOverride } from "./src/shared/io.mjs";
import { TASK_FOLDER, JSON_INDENT } from "./src/shared/constants.mjs";
import { ERRNO, EXIT } from "./src/shared/errors.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const SKILL_NAME = "codex-subagents-for-claude-code";
const PLUGIN_INVENTORY = ".generated.json";
const contentHash = (text) => crypto.createHash("sha256").update(text).digest("hex");

// Use the catalogue already selected by the entry shim. A concurrent pointer
// flip cannot combine roles and display data from different releases.
let selectedDisplay = RUNNER.DISPLAY;
// Older entry shims do not export DISPLAY. Preserve rollback compatibility,
// verifying module identity if their pointer has to be consulted once more.
if (!selectedDisplay) {
  let root = HERE;
  try {
    const id = fs.readFileSync(path.join(HERE, "dist", "current"), "utf8").trim();
    if (!/^\d+\.\d+\.\d+-[0-9a-f]{7,40}$/.test(id)) throw new Error("invalid release pointer");
    root = path.join(HERE, "dist", id);
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
  }
  const legacy = await import(pathToFileURL(path.join(root, "src", "roles.mjs")).href);
  if (legacy.ROLES === RUNNER.ROLES) selectedDisplay = legacy.DISPLAY;
}
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
  return fill(text, { ...skillTask(paths), ...paths, runnerarg: shellWord(paths.runner) });
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

export function install({
  check = false,
  plugin = false,
  env = process.env,
  home = os.homedir(),
  write = (line) => console.log(line),
} = {}) {
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
    let current = null;
    try {
      current = fs.readFileSync(target, "utf8");
    } catch (error) {
      if (error.code !== ERRNO.ENOENT) throw error;
    }
    const state = current === text ? "same" : current === null ? "missing" : "differs";
    if (state !== "same") {
      drift++;
      if (!check) {
        // Written beside the target and renamed into place, so Claude Code
        // never reads a half-written agent or skill.
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const staged = `${target}.${process.pid}.next`;
        try {
          fs.writeFileSync(staged, text);
          fs.renameSync(staged, target);
        } finally {
          fs.rmSync(staged, { force: true });
        }
      }
    }
    write(`${check ? state : state === "same" ? "unchanged" : "installed"} ${target}`);
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
    args.some((arg) => arg !== "--check" && arg !== "--plugin") ||
    new Set(args).size !== args.length
  ) {
    console.error("usage: node install.mjs [--plugin] [--check]");
    process.exitCode = EXIT.FAILURE;
  } else {
    try {
      process.exitCode = install({
        check: args.includes("--check"),
        plugin: args.includes("--plugin"),
      });
    } catch (error) {
      console.error(`install.mjs: ${error.message}`);
      process.exitCode = EXIT.FAILURE;
    }
  }
}
