#!/usr/bin/env node
// Updates the tested Codex CLI baseline, proving the exact build before any edit:
// the binary must report the version, and the contract lane
// (tools/codex.contract.mjs) must pass against it through the explicit path
// without a runtime version allow override. Only then does it rewrite the pin
// where it is written by hand (the registry, the help text, the docs, the CI
// workflows, the tests and the generated release notes) and regenerate
// test/fixtures/role-rendering.json as docs/DEVELOPMENT.md describes.
// Every remaining mention of the replaced baseline is listed for review. It
// prints the one real GPT-6.x smoke call, a launch from this copy with a
// scratch state root, and runs it only with --smoke.
//   node tools/repin-codex.mjs <version> --codex-path <exe> [--smoke]
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXIT } from "../src/shared/errors.mjs";
import { selectCodex, validCodexVersion, semver, assertCodexIdentity } from "../src/codex/cli.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.dirname(path.dirname(SCRIPT));
const USAGE = "usage: node tools/repin-codex.mjs <version> --codex-path <exe> [--smoke]";
// How long the version probe and the rendering may take, the contract lane
// and the smoke call, and how much any of them may print.
const PROBE_MS = 60_000;
const CONTRACT_MS = 20 * 60 * 1000;
const SMOKE_MS = 20 * 60 * 1000;
const OUTPUT_BYTES = 64 * 1024 * 1024;
// The files read for mentions left, the folders never read, and how much of
// a line a mention quotes.
const SCAN_MAX_BYTES = 4 * 1024 * 1024;
const SCAN_SKIP = new Set([".git", "node_modules", "dist", "results", "releases"]);
const EXCERPT_CHARS = 160;
// The random part of a staged file's name.
const STAGE_BYTES = 8;
const ENV = Object.freeze({
  PATH: "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH",
  STATE: "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR",
  RESULTS: "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR",
});
const PIN_FILE = "src/shared/constants.mjs";
const PIN =
  /CODEX_VERSION_RANGE = Object\.freeze\(\{\s*min: ("(?:\\.|[^"\\])*"),\s*maxTested: ("(?:\\.|[^"\\])*"),?\s*\}\)/;
const BASELINE = "test/fixtures/role-rendering.json";
const CONTRACT = "tools/codex.contract.mjs";
const ENTRY = "run-codex-task.mjs";
// The smoke call's model is the role catalogue's first, read with the
// rendering: model names belong to src/roles.mjs.
const SMOKE = Object.freeze({
  prefix: "codex-repin-smoke-",
  effort: "low",
  prompt: "Reply with exactly one word: ONE\n",
});
// Informational baseline references and npm examples. A missing anchor stops
// the update before any write; unlisted mentions are reported for review. A
// version not followed by text ends where no digit, letter or dot follows.
const PINS = [
  [".claude-plugin/plugin.json", "Tested with codex-cli ", ";"],
  [".github/workflows/ci.yml", "@openai/codex@", ""],
  [".github/workflows/release.yml", "@openai/codex@", ""],
  ["CONTRACT.md", "tested with **", "**"],
  ["README.md", "**codex-cli ", " is the tested baseline.**"],
  ["README.md", "@openai/codex@", ""],
  ["README.md", "Version ", " is the tested baseline"],
  ["SECURITY.md", "Tested with codex-cli ", ";"],
  ["docs/COMPATIBILITY.md", "**codex-cli ", " is the tested reference"],
  ["docs/OPERATIONS.md", "**", " is the tested reference**"],
  ["docs/OPERATIONS.md", "The tested reference is ", ","],
  ["docs/OPERATIONS.md", "@openai/codex@", ""],
  ...["docs/MANUAL.md", "claude/skills/codex-subagents-for-claude-code/SKILL.md"].map((file) => [
    file,
    "",
    " is the tested",
  ]),
  ["src/cli/options.mjs", "Tested with codex-cli ", "."],
  ["tools/distribution.mjs", "Tested with codex-cli ", ";"],
  // The tests quote the pinned version, and its prerelease and build forms.
  ...[
    "test/backend-launch.test.mjs",
    "test/codex-cli.test.mjs",
    "test/maintenance.test.mjs",
    "test/run-record.test.mjs",
    "test/tools/release-codex.test.mjs",
    "test/turn-transition.test.mjs",
  ].map((file) => [file, '"', ""]),
];
// Run in a fresh node, so the installer renders the rewritten sources: the
// rendering baseline's hashes, keyed by each target's basename, and the role
// catalogue's first model, as JSON.
const RENDER_SCRIPT = [
  'import crypto from "node:crypto";',
  'import path from "node:path";',
  "const [installer, paths] = process.argv.slice(1);",
  "const { plannedFiles, ROLES, install } = await import(installer);",
  "install({ plugin: true, write: () => {} });",
  "const sha256 = {};",
  "for (const { target, text } of plannedFiles({ paths: JSON.parse(paths) }))",
  '  sha256[path.basename(target)] = crypto.createHash("sha256").update(text).digest("hex");',
  "process.stdout.write(JSON.stringify({ sha256, model: Object.values(ROLES)[0].model }));",
].join("\n");

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const END = "(?![0-9A-Za-z.])";
const mention = (version) => new RegExp(`(?<![0-9A-Za-z.])${escape(version)}${END}`);
// A word as a POSIX shell reads it back: quoted unless it is plain.
const shellWord = (value) =>
  /^[A-Za-z0-9_.,:=@%+/-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

function writeFile(file, text) {
  const stage = `${file}.${crypto.randomBytes(STAGE_BYTES).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(stage, text);
    fs.renameSync(stage, file);
  } finally {
    fs.rmSync(stage, { force: true });
  }
}

export function parseRepinArgs(argv) {
  const options = { smoke: false };
  const rest = [...argv];
  while (rest.length) {
    const arg = rest.shift();
    if (arg === "--smoke") options.smoke = true;
    else if (arg === "--codex-path" && rest.length) options.codexPath = rest.shift();
    else if (!arg.startsWith("-") && options.version === undefined) options.version = arg;
    else throw new Error(USAGE);
  }
  if (!options.version || !options.codexPath) throw new Error(USAGE);
  return options;
}

// Resolve and probe the native executable, never its package-manager wrapper.
export async function reportedVersion(executable, env = process.env) {
  return (await selectCodex({ ...env, [ENV.PATH]: executable }, ROOT, PROBE_MS)).version;
}

// The contract lane, as npm run contract runs it, with the given environment.
function runContract({ env }) {
  const result = spawnSync(process.execPath, [path.join(ROOT, CONTRACT)], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: CONTRACT_MS,
    maxBuffer: OUTPUT_BYTES,
  });
  return {
    status: result.error ? null : result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? result.error.message : ""}`,
  };
}

function currentPin() {
  const pin = PIN.exec(fs.readFileSync(path.join(ROOT, PIN_FILE), "utf8"));
  if (!pin) throw new Error(`${PIN_FILE} names no CODEX_VERSION_RANGE`);
  return JSON.parse(pin[2]);
}

function encodedLabel(file, before, value) {
  if (file.endsWith(".json") || before === '"') return JSON.stringify(value).slice(1, -1);
  if (file === "src/cli/options.mjs" || file === "tools/distribution.mjs")
    return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
  if (file.endsWith(".md")) return value.replace(/[\\`*_{}\[\]<>|]/g, "\\$&");
  return value;
}

// Rewrites every hand-written pin from old to version. Every anchor is found
// before the first file is written, or none is.
function rewritePins(old, version) {
  const files = new Map();
  const read = (file) => {
    if (!files.has(file)) files.set(file, fs.readFileSync(path.join(ROOT, file), "utf8"));
    return files.get(file);
  };
  files.set(
    PIN_FILE,
    read(PIN_FILE).replace(
      PIN,
      () =>
        `CODEX_VERSION_RANGE = Object.freeze({ min: ${JSON.stringify(version)}, maxTested: ${JSON.stringify(version)} })`,
    ),
  );
  for (const [file, before, after] of PINS) {
    // An opaque CLI label is not necessarily an npm package version.
    if (before === "@openai/codex@" && !semver(version)) continue;
    const pattern = new RegExp(
      `${escape(before)}${escape(encodedLabel(file, before, old))}${after ? escape(after) : END}`,
      "g",
    );
    const text = read(file);
    if (!text.match(pattern))
      throw new Error(`missing tested-baseline anchor in ${file}; nothing was changed`);
    files.set(
      file,
      text.replace(pattern, () => `${before}${encodedLabel(file, before, version)}${after}`),
    );
  }
  for (const [file, text] of files) writeFile(path.join(ROOT, file), text);
  return [...files.keys()];
}

// docs/DEVELOPMENT.md's procedure: plannedFiles({ paths: baseline.paths })
// from install.mjs, hashed by target basename. Returns whether a hash changed,
// and the catalogue's first model.
function regenerateBaseline(env) {
  const file = path.join(ROOT, BASELINE);
  const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
  const installer = pathToFileURL(path.join(ROOT, "install.mjs")).href;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", RENDER_SCRIPT, installer, JSON.stringify(baseline.paths)],
    {
      cwd: ROOT,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: PROBE_MS,
      maxBuffer: OUTPUT_BYTES,
    },
  );
  if (result.error || result.status !== EXIT.COMPLETED)
    throw new Error(
      `cannot render the agents and skill: ${result.error?.message ?? result.stderr}`,
    );
  const { sha256, model } = JSON.parse(result.stdout);
  writeFile(file, `${JSON.stringify({ ...baseline, sha256 }, null, 2)}\n`);
  return { changed: JSON.stringify(sha256) !== JSON.stringify(baseline.sha256), model };
}

// Every line of this copy that still names version, as "file:line: text".
function mentionsOf(version) {
  const found = [];
  const pattern = mention(version);
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
      if (SCAN_SKIP.has(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile() && fs.statSync(path.join(ROOT, name)).size <= SCAN_MAX_BYTES)
        fs.readFileSync(path.join(ROOT, name), "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (pattern.test(line))
              found.push(`${name}:${index + 1}: ${line.trim().slice(0, EXCERPT_CHARS)}`);
          });
    }
  };
  walk("");
  return found;
}

// The one real smoke call: a read-only launch of this copy's entry in a
// scratch workspace, with its own state and results folders, on exactly the
// pinned executable. The scratch root is made now, so the printed command
// runs as it stands.
function smokeCall(codexPath, model) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), SMOKE.prefix));
  const prompt = path.join(root, "prompt.md");
  fs.writeFileSync(prompt, SMOKE.prompt);
  const env = {
    [ENV.STATE]: path.join(root, "state"),
    [ENV.RESULTS]: path.join(root, "results"),
    [ENV.PATH]: codexPath,
  };
  for (const folder of [env[ENV.STATE], env[ENV.RESULTS]]) fs.mkdirSync(folder);
  const args = [
    path.join(ROOT, ENTRY),
    "--model",
    model,
    "--effort",
    SMOKE.effort,
    "--prompt-file",
    prompt,
    "--scratch-workspace",
  ];
  const command = [
    ...Object.entries(env).map(([name, value]) => `${name}=${shellWord(value)}`),
    shellWord(process.execPath),
    ...args.map(shellWord),
  ].join(" ");
  return { root, env, args, command };
}

function runSmoke(call) {
  const result = spawnSync(process.execPath, call.args, {
    cwd: call.root,
    env: { ...process.env, ...call.env },
    stdio: "inherit",
    windowsHide: true,
    timeout: SMOKE_MS,
  });
  return result.error || result.status === null ? EXIT.FAILURE : result.status;
}

export async function repin(
  { version, codexPath, smoke = false, env = process.env, write = (line) => console.log(line) },
  { contract = runContract, smokeRunner = runSmoke, render = regenerateBaseline } = {},
) {
  if (!validCodexVersion(version))
    throw new Error(
      `${USAGE}\nThe tested version must be a nonempty label without whitespace or control characters.`,
    );
  if (typeof codexPath !== "string" || !path.isAbsolute(codexPath))
    throw new Error(`${USAGE}\n--codex-path must be an absolute path.`);
  const codex = await selectCodex({ ...env, [ENV.PATH]: codexPath }, ROOT, PROBE_MS);
  const reported = codex.version;
  if (reported !== version)
    throw new Error(
      `Codex at ${codexPath} reports ${reported ?? "no version"}, not ${version}; nothing was changed`,
    );
  write(`codex=${version} path=${codexPath}`);
  const lane = await contract({ env: { ...env, [ENV.PATH]: codex.realPath } });
  if (lane.output) write(lane.output.trimEnd());
  if (lane.status !== EXIT.COMPLETED)
    throw new Error(`the contract lane failed against codex-cli ${version}; nothing was changed`);
  assertCodexIdentity(codex, env);
  write(`contract=passed codex=${version}`);
  const old = currentPin();
  if (old === version) write(`pin=${version} unchanged`);
  else {
    const files = rewritePins(old, version);
    write(`pin=${old}->${version} files=${files.length}`);
  }
  const rendered = render(env);
  write(`baseline=${BASELINE} ${rendered.changed ? "regenerated" : "unchanged"}`);
  const left = old === version ? [] : mentionsOf(old);
  if (left.length) {
    write(`Left for review, not rewritten (unlisted mentions of ${old}):`);
    for (const line of left) write(`  ${line}`);
  }
  const call = smokeCall(codex.realPath, rendered.model);
  write(
    `Smoke, one real ${rendered.model} call from this copy with a scratch state root${smoke ? "" : "; it runs only with --smoke"}:`,
  );
  write(`  ${call.command}`);
  write(`Remove ${call.root} afterwards.`);
  if (!smoke) return EXIT.COMPLETED;
  assertCodexIdentity(codex, env);
  return smokeRunner(call);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  try {
    process.exitCode = await repin(parseRepinArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = EXIT.FAILURE;
  }
}
