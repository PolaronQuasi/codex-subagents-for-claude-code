import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixture } from "../support/codex-fixture.mjs";
import { runProcess } from "../../src/shared/io.mjs";
import { CODEX_VERSION_RANGE } from "../../src/shared/constants.mjs";
import { ROLES } from "../../src/roles.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TOOL = path.join(REPO, "tools", "repin-codex.mjs");
const SMOKE_MODEL = Object.values(ROLES)[0].model;
const PIN = CODEX_VERSION_RANGE.maxTested;
const NEXT = PIN.replace(/\d+$/, (patch) => String(Number(patch) + 1));
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// What the tool reads, rewrites and runs, copied into the fixture's folder.
const COPIED = [
  ".claude-plugin",
  "agents",
  "skills",
  ".github",
  "claude",
  "docs",
  "src",
  "test",
  "tools",
  "CONTRACT.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "install.mjs",
  "package.json",
  "run-codex-task.mjs",
];

// A disposable copy of this repository and its own re-pin tool.
async function copy(f) {
  const root = path.join(f.root, "copy");
  for (const name of COPIED)
    fs.cpSync(path.join(REPO, name), path.join(root, name), { recursive: true });
  const tool = await import(pathToFileURL(path.join(root, "tools", "repin-codex.mjs")).href);
  return { root, tool, read: (file) => fs.readFileSync(path.join(root, file), "utf8") };
}
const snapshot = (root) =>
  Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true })
      .filter((name) => fs.statSync(path.join(root, name)).isFile())
      .map((name) => [
        name,
        crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(root, name)))
          .digest("hex"),
      ]),
  );
// The scratch root a printed smoke command names, removed after the test.
function smokeRoot(t, lines) {
  const root = /^Remove (.+) afterwards\.$/.exec(lines.at(-1))?.[1];
  assert.ok(root && fs.existsSync(root), lines.join("\n"));
  const canonical = fs.realpathSync.native(root);
  const base = fs.realpathSync.native(os.tmpdir());
  const identity = fs.lstatSync(root);
  assert.equal(path.dirname(canonical), base);
  assert.ok(path.basename(canonical).startsWith("codex-repin-smoke-"));
  assert.equal(identity.isSymbolicLink(), false);
  t.after(() => {
    const current = fs.lstatSync(root);
    assert.equal(current.isSymbolicLink(), false);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    assert.equal(fs.realpathSync.native(root), canonical);
    assert.equal(fs.realpathSync.native(path.dirname(root)), base);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const never = (what) => () => assert.fail(`${what} must not run`);
// Focused tests never run the installer, full contract lane or a model.
const render = () => ({ model: SMOKE_MODEL, changed: false });
const pass = () => ({ status: 0, output: "fake certification" });

test("re-pin refuses a CLI that reports another version before any contract lane or edit", async (t) => {
  const f = fixture(t);
  const c = await copy(f);
  const before = snapshot(c.root);
  await assert.rejects(
    c.tool.repin(
      { version: NEXT, codexPath: f.executable, env: f.env, write: () => {} },
      { contract: never("the contract lane"), smokeRunner: never("the smoke call") },
    ),
    new RegExp(`reports ${escaped(PIN)}, not ${escaped(NEXT)}; nothing was changed`),
  );
  assert.deepEqual(snapshot(c.root), before);
});

test("re-pin changes nothing when the contract lane fails against the new CLI", async (t) => {
  const f = fixture(t);
  f.configure({ version: NEXT });
  const c = await copy(f);
  const before = snapshot(c.root);
  const lines = [];
  await assert.rejects(
    c.tool.repin(
      { version: NEXT, codexPath: f.executable, env: f.env, write: (line) => lines.push(line) },
      {
        contract: () => ({ status: 1, output: "fake schema generation failed" }),
        render: never("the renderer"),
        smokeRunner: never("the smoke call"),
      },
    ),
    /contract lane failed against codex-cli .*nothing was changed/,
  );
  assert.match(lines.join("\n"), /schema generation failed/);
  assert.deepEqual(snapshot(c.root), before);
});

test("certification updates tested references and offers smoke only after the exact native build passes", async (t) => {
  const f = fixture(t);
  f.configure({ version: NEXT });
  const c = await copy(f);
  const lanes = [],
    lines = [];
  const code = await c.tool.repin(
    { version: NEXT, codexPath: f.executable, env: f.env, write: (line) => lines.push(line) },
    {
      contract: async ({ env }) => {
        lanes.push(env);
        return { status: 0, output: "" };
      },
      smokeRunner: never("the smoke call"),
      render,
    },
  );
  assert.equal(code, 0);
  smokeRoot(t, lines);
  assert.equal(lanes.length, 1);
  assert.equal(
    lanes[0].CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH,
    fs.realpathSync.native(f.executable),
  );
  assert.equal(lanes[0].CODEX_SUBAGENTS_FOR_CLAUDE_CODE_ALLOW_CODEX, undefined);
  assert.match(
    c.read("src/shared/constants.mjs"),
    new RegExp(`min: "${escaped(NEXT)}", maxTested: "${escaped(NEXT)}"`),
  );
  for (const file of [
    ".claude-plugin/plugin.json",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "CONTRACT.md",
    "README.md",
    "SECURITY.md",
    "claude/skills/codex-subagents-for-claude-code/SKILL.md",
    "docs/COMPATIBILITY.md",
    "docs/MANUAL.md",
    "docs/OPERATIONS.md",
    "src/cli/options.mjs",
    "tools/distribution.mjs",
    "test/backend-launch.test.mjs",
    "test/codex-cli.test.mjs",
    "test/maintenance.test.mjs",
    "test/run-record.test.mjs",
    "test/tools/release-codex.test.mjs",
    "test/turn-transition.test.mjs",
  ]) {
    assert.ok(c.read(file).includes(NEXT), file);
    assert.equal(c.read(file).includes(`@openai/codex@${PIN}`), false, file);
    assert.equal(c.read(file).includes(`"${PIN}"`), false, file);
  }
  const command = lines.find((line) => line.includes("--scratch-workspace"));
  for (const part of [
    "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR=",
    "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR=",
    "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH=",
    f.executable,
    path.join(c.root, "run-codex-task.mjs"),
    `--model ${SMOKE_MODEL} --effort low --prompt-file`,
    "--scratch-workspace",
  ])
    assert.ok(command.includes(part), `${part} in ${command}`);
  // Again, now pinned: nothing to rewrite, and --smoke runs the printed call once.
  const pinned = snapshot(c.root);
  const again = [],
    calls = [];
  const smoked = await c.tool.repin(
    {
      version: NEXT,
      codexPath: f.executable,
      env: f.env,
      smoke: true,
      write: (line) => again.push(line),
    },
    {
      contract: async () => ({ status: 0, output: "" }),
      render,
      smokeRunner: (call) => {
        calls.push(call);
        return 0;
      },
    },
  );
  assert.equal(smoked, 0);
  smokeRoot(t, again);
  assert.deepEqual(snapshot(c.root), pinned);
  assert.ok(again.includes(`pin=${NEXT} unchanged`), again.join("\n"));
  assert.equal(calls.length, 1);
  assert.ok(again.includes(`  ${calls[0].command}`));
  assert.equal(
    calls[0].env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH,
    fs.realpathSync.native(f.executable),
  );
  assert.equal(fs.readFileSync(calls[0].args.at(-2), "utf8"), "Reply with exactly one word: ONE\n");
});

test("missing baseline anchors and payload replacement during certification cause no source edits", async (t) => {
  const f = fixture(t, { version: NEXT }),
    c = await copy(f);
  const options = { version: NEXT, codexPath: f.executable, env: f.env, write: () => {} };
  fs.writeFileSync(path.join(c.root, "SECURITY.md"), "unrecognized prerequisite wording\n");
  const before = snapshot(c.root);
  await assert.rejects(
    c.tool.repin(options, {
      contract: pass,
      render: never("render"),
      smokeRunner: never("smoke"),
    }),
    /missing tested-baseline anchor.*SECURITY.md/,
  );
  assert.deepEqual(snapshot(c.root), before);
  await assert.rejects(
    c.tool.repin(options, {
      contract: () => {
        fs.appendFileSync(f.executable, "replacement");
        return pass();
      },
      render: never("render"),
      smokeRunner: never("smoke"),
    }),
    /payload changed/,
  );
  assert.deepEqual(snapshot(c.root), before);
});

test("opaque labels remain literal in source and JSON without rewriting npm package versions", async (t) => {
  const version = 'nightly-"${notExecuted}\\build`';
  const f = fixture(t, { version }),
    c = await copy(f),
    lines = [];
  await c.tool.repin(
    { version, codexPath: f.executable, env: f.env, write: (line) => lines.push(line) },
    { contract: pass, render, smokeRunner: never("smoke") },
  );
  smokeRoot(t, lines);
  const constants = await import(
    `${pathToFileURL(path.join(c.root, "src/shared/constants.mjs")).href}?rewritten`
  );
  assert.equal(constants.CODEX_VERSION_RANGE.maxTested, version);
  assert.ok(JSON.parse(c.read(".claude-plugin/plugin.json")).description.includes(version));
  const { HELP } = await import(pathToFileURL(path.join(c.root, "src/cli/options.mjs")).href);
  assert.ok(HELP.includes(version));
  for (const file of ["tools/distribution.mjs", "test/codex-cli.test.mjs"]) {
    const checked = await runProcess(process.execPath, ["--check", path.join(c.root, file)]);
    assert.equal(checked.status, 0, checked.stderr);
  }
  assert.ok(c.read("README.md").includes(`@openai/codex@${PIN}`));
  const before = snapshot(c.root),
    again = [];
  await c.tool.repin(
    { version, codexPath: f.executable, env: f.env, write: (line) => again.push(line) },
    { contract: pass, render, smokeRunner: never("smoke") },
  );
  smokeRoot(t, again);
  assert.deepEqual(snapshot(c.root), before);
});

test("certification CLI rejects missing labels, relative paths and unknown switches before probing", async () => {
  for (const args of [
    [],
    ["--codex-path", path.resolve("codex")],
    [NEXT, "--codex-path", "codex"],
    ["bad label", "--codex-path", path.resolve("codex")],
    [NEXT, "--codex-path", path.resolve("codex"), "--other"],
  ]) {
    const result = await runProcess(process.execPath, [TOOL, ...args], { timeoutMs: 30_000 });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /usage: node tools\/repin-codex\.mjs/, args.join(" "));
  }
});
