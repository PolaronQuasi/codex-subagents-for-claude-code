import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { KNOWN_OPTIONS, parseArgs, ROLES, runProcess } from "../src/index.mjs";
import { EFFORTS } from "../src/shared/constants.mjs";
import { shellWord } from "../src/shared/shell.mjs";

import { sha256 } from "./support/capture.mjs";
import { SCRIPT } from "./support/cli-adapter.mjs";

// Installer checks do not launch Codex. Keep os.tmpdir's spelling so macOS
// also exercises the fixed /var -> /private/var system alias policy.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-installer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return {
    root,
    env: {
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: path.join(root, "agents"),
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: path.join(root, "skill"),
    },
  };
}

test("the shared role catalogue preserves public values and every rendered definition byte", async () => {
  const { DISPLAY, plannedFiles } = await import("../install.mjs");
  const baseline = JSON.parse(
    fs.readFileSync(new URL("./fixtures/role-rendering.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(ROLES, baseline.ROLES);
  assert.deepEqual(DISPLAY, baseline.DISPLAY);
  const files = plannedFiles({ paths: baseline.paths });
  const hashes = Object.fromEntries(
    files.map(({ target, text }) => [path.basename(target), sha256(text)]),
  );
  assert.deepEqual(hashes, baseline.sha256);
});

test("the forwarder and the skill name every effort the runner accepts, in order, and the skill the quota line and --limits", () => {
  const source = (...parts) =>
    fs.readFileSync(path.join(path.dirname(SCRIPT), "claude", ...parts), "utf8");
  const forwarder = source("agents", "forwarder.template.md");
  const skill = source("skills", "codex-subagents-for-claude-code", "SKILL.md");
  const levels = /^Task effort levels are (.+)\.$/m.exec(forwarder)?.[1] ?? "";
  assert.deepEqual(
    [...levels.matchAll(/`([a-z]+)`/g)].map((match) => match[1]),
    [...EFFORTS],
  );
  assert.ok(forwarder.includes("preserve `effort: max` and\n`effort: ultra` exactly"));
  assert.deepEqual(
    [...skill.matchAll(/^\| `([a-z]+)` +\|/gm)].map((match) => match[1]),
    [...EFFORTS],
    "the skill's effort table",
  );
  assert.match(
    skill,
    /`none` and `minimal` for the listed models\. Treat this as a dated observation/,
  );
  assert.match(skill, /the current catalogue and backend determine availability/);
  assert.ok(skill.includes("`codex-subagents-for-claude-code-quota: used= remaining= resets="));
  assert.ok(skill.includes("`--limits` prints the account's Codex quota"));
});

test("rendered agent definitions match the runner's roles and options", async (t) => {
  const f = fixture(t);
  const { install } = await import("../install.mjs");
  assert.equal(install({ env: f.env, write: () => {} }), 0);
  const dir = f.env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR;
  const files = Object.keys(ROLES)
    .map((role) => path.join(dir, `${role}.md`))
    .filter((file) => fs.existsSync(file));
  assert.equal(files.length, Object.keys(ROLES).length);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const role = path.basename(file, ".md");
    assert.ok(text.includes(`--role ${role} --task-file`), `${role} uses task-file mode`);
    for (const flag of new Set(text.match(/--[a-z][a-z-]*/g) ?? [])) {
      assert.ok(
        KNOWN_OPTIONS.includes(flag.slice(2)),
        `${role} mentions an option the runner does not accept: ${flag}`,
      );
    }
    assert.doesNotThrow(() => parseArgs(["--role", role, "--task-file", "t.md"]));
  }
});

test("install.mjs renders one forwarder per runner role and the skill, and --check finds drift", async (t) => {
  const { DISPLAY, install, plannedFiles, renderAgent, renderSkill } =
    await import("../install.mjs");
  assert.deepEqual(
    Object.keys(DISPLAY).sort(),
    Object.keys(ROLES).sort(),
    "every runner role has an agent display entry",
  );
  const warnings = [];
  assert.equal(
    renderAgent("{{role}}: {{model}} {{alias}}", "gpt-0-unknown", undefined, {
      warn: (line) => warnings.push(line),
    }),
    'gpt-0-unknown: GPT-0-Unknown ("gpt-0-unknown")',
    "a role without display data still renders",
  );
  assert.match(warnings.join("\n"), /role gpt-0-unknown has no display entry/);
  assert.throws(
    () => renderSkill("Runner {{runner}}, owner {{owner}}"),
    /left the placeholder \{\{owner\}\} unfilled/,
  );
  assert.equal(
    renderSkill("{{runner}} {{tmp}}", {
      runner: "R/run-codex-task.mjs",
      manual: "R/docs/MANUAL.md",
      tmp: "T",
    }),
    "R/run-codex-task.mjs T",
  );
  const { root } = fixture(t);
  const defaults = plannedFiles({ env: {}, home: root });
  assert.equal(
    defaults.at(-1).target,
    path.join(root, ".claude", "skills", "codex-subagents-for-claude-code", "SKILL.md"),
  );
  assert.match(defaults.at(-1).text, /^name: codex-subagents-for-claude-code$/m);
  const env = {
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: path.join(root, "agents"),
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: path.join(root, "skill"),
  };
  const lines = [];
  assert.equal(
    install({ check: true, env, write: (line) => lines.push(line) }),
    1,
    "nothing installed yet",
  );
  assert.ok(
    lines.every((line) => line.startsWith("missing ")),
    lines.join("\n"),
  );
  lines.length = 0;
  assert.equal(install({ env, write: (line) => lines.push(line) }), 0);
  assert.equal(
    lines.filter((line) => line.startsWith("installed ")).length,
    Object.keys(ROLES).length + 1,
  );
  const here = path.dirname(SCRIPT).split(path.sep).join("/");
  const tmp = os.tmpdir().split(path.sep).join("/");
  for (const role of Object.keys(ROLES)) {
    const text = fs.readFileSync(path.join(root, "agents", `${role}.md`), "utf8");
    assert.ok(
      text.startsWith(`---\nname: "${role}"\n`) &&
        text.includes(`--role ${role} --task-file`) &&
        !text.includes("{{"),
      role,
    );
    assert.ok(
      text.includes(`node ${shellWord(here + "/run-codex-task.mjs")} --role ${role}`),
      `${role} names this folder's runner`,
    );
    assert.ok(
      text.includes(`${tmp}/codex-subagents-for-claude-code/${role}-`),
      `${role} writes its task files to the temporary folder`,
    );
  }
  const skill = fs.readFileSync(path.join(root, "skill", "SKILL.md"), "utf8");
  assert.ok(
    !skill.includes("{{") &&
      skill.includes(`node ${shellWord(here + "/run-codex-task.mjs")}`) &&
      skill.includes(`${here}/docs/MANUAL.md`),
    "the skill is rendered",
  );
  assert.equal(install({ check: true, env, write: () => {} }), 0, "a fresh install has no drift");
  fs.appendFileSync(path.join(root, "skill", "SKILL.md"), "edited\n");
  lines.length = 0;
  assert.equal(install({ check: true, env, write: (line) => lines.push(line) }), 1);
  assert.ok(
    lines.some((line) => line.startsWith("differs ") && line.endsWith("SKILL.md")),
    lines.join("\n"),
  );
});

test("the installer takes roles and their display names from one catalogue, and a role without one still installs", async (t) => {
  const { DISPLAY, plannedFiles } = await import("../install.mjs");
  const paths = { runner: "R/run-codex-task.mjs", manual: "R/docs/MANUAL.md", tmp: "T" };
  const roles = { ...ROLES, "gpt-9-test": { model: "gpt-9.1-test", effort: "low" } };
  const display = { ...DISPLAY, "gpt-0-gone": { model: "GPT-0 Gone", alias: '("gone")' } };
  delete display["gpt-6-sol"];
  const warnings = [];
  const files = plannedFiles({
    env: {
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: "A",
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: "S",
    },
    paths,
    roles,
    display,
    warn: (line) => warnings.push(line),
  });
  const agents = Object.fromEntries(
    files
      .filter(({ target }) => path.dirname(target) === "A")
      .map(({ target, text }) => [path.basename(target, ".md"), text]),
  );
  assert.deepEqual(Object.keys(agents).sort(), Object.keys(roles).sort(), "one agent per role");
  assert.match(
    agents["gpt-9-test"],
    /OpenAI GPT-9\.1-Test through codex-subagents-for-claude-code/,
  );
  assert.match(agents["gpt-9-test"], /GPT-9\.1-Test \("gpt-9-test"\) is requested by name/);
  assert.match(agents["gpt-6-sol"], /OpenAI GPT-6-Sol through codex-subagents-for-claude-code/);
  assert.match(
    agents["gpt-6-1-sol"],
    /OpenAI GPT-6\.1-Sol through codex-subagents-for-claude-code/,
  );
  assert.deepEqual(
    warnings.map((line) => /role (\S+) has no display entry/.exec(line)?.[1]).sort(),
    ["gpt-6-sol", "gpt-9-test"],
  );
});

test("the installer follows the release the entry loads and refuses missing release display data", async (t) => {
  const { root: scratch } = fixture(t);
  const root = path.join(scratch, "checkout");
  fs.mkdirSync(root);
  const here = path.dirname(SCRIPT);
  for (const name of ["install.mjs", "run-codex-task.mjs"])
    fs.copyFileSync(path.join(here, name), path.join(root, name));
  for (const dir of ["src", "claude"])
    fs.cpSync(path.join(here, dir), path.join(root, dir), { recursive: true });
  const release = path.join(root, "dist", "9.9.9-abcdef0");
  fs.cpSync(path.join(here, "src"), path.join(release, "src"), { recursive: true });
  const catalogue = path.join(release, "src", "roles.mjs");
  const original = fs.readFileSync(catalogue, "utf8");
  // The release knows a role this checkout does not.
  const added = original.replace(
    "const CATALOGUE = {",
    'const CATALOGUE = {\n  "gpt-9-test": { model: "gpt-9-test", effort: "low", display: "GPT-9 Test", alias: \'("9 test")\' },',
  );
  fs.writeFileSync(path.join(root, "dist", "current"), "9.9.9-abcdef0\n");
  const run = (variant, args = []) => {
    const env = {
      ...process.env,
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: path.join(scratch, variant, "agents"),
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: path.join(scratch, variant, "skill"),
    };
    return runProcess(process.execPath, [path.join(root, "install.mjs"), ...args], {
      cwd: root,
      env,
      timeoutMs: 30_000,
    });
  };
  const agent = (variant) =>
    fs.readFileSync(path.join(scratch, variant, "agents", "gpt-9-test.md"), "utf8");
  fs.writeFileSync(catalogue, added);
  const described = await run("described");
  assert.equal(described.status, 0, described.stderr);
  assert.match(agent("described"), /OpenAI GPT-9 Test through codex-subagents-for-claude-code/);
  assert.equal(described.stderr, "");
  const removed = await run("described", ["--uninstall"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(
    fs.readdirSync(path.join(scratch, "described", "agents")),
    [],
    "the trusted selected catalogue can own a role absent from this checkout's source catalogue",
  );
  assert.deepEqual(fs.readdirSync(path.join(scratch, "described", "skill")), []);
  // An incomplete selected catalogue must not borrow display facts from the checkout.
  fs.writeFileSync(catalogue, added.replace("export const DISPLAY", "const DISPLAY"));
  const bare = await run("bare");
  assert.notEqual(bare.status, 0);
  assert.match(
    bare.stderr,
    /selected release has no matching role\/display catalogue|does not provide an export named 'DISPLAY'/,
  );
  assert.equal(fs.existsSync(path.join(scratch, "bare")), false, "no partial agent installation");
});

test("installer cleans failed stages while preserving the prior installed file", async (t) => {
  const { install, plannedFiles } = await import("../install.mjs");
  const f = fixture(t);
  const env = {
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: path.join(f.root, "agents"),
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: path.join(f.root, "skill"),
  };
  assert.equal(install({ env, write() {} }), 0);
  const target = plannedFiles({ env })[0].target;
  fs.writeFileSync(target, "old complete agent\n");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === target) throw new Error("rename denied");
    return rename(from, to);
  });
  assert.throws(() => install({ env, write() {} }), /rename denied/);
  assert.equal(fs.readFileSync(target, "utf8"), "old complete agent\n");
  assert.equal(
    fs.readdirSync(path.dirname(target)).some((name) => name.endsWith(".next")),
    false,
  );
});

test("install.mjs fills placeholders literally, so a path containing $&, $', $`, $1 or $$ renders as written", async () => {
  const { renderAgent, renderSkill } = await import("../install.mjs");
  const paths = {
    runner: "D:/a$&b/run-codex-task.mjs",
    manual: "D:/a$'b/docs/MANUAL.md",
    tmp: "D:/t$`u$1v$$w",
  };
  assert.equal(
    renderSkill("runner {{runner}}, manual {{manual}}, tmp {{tmp}}", paths),
    `runner ${paths.runner}, manual ${paths.manual}, tmp ${paths.tmp}`,
  );
  assert.equal(
    renderAgent(
      'name: {{role}}\nrun: node "{{runner}}" --role {{role}}\ntask: {{tmp}}/codex-subagents-for-claude-code/{{role}}-x.md\n',
      "gpt-6-astra",
      paths,
    ),
    `name: gpt-6-astra\nrun: node "${paths.runner}" --role gpt-6-astra\ntask: ${paths.tmp}/codex-subagents-for-claude-code/gpt-6-astra-x.md\n`,
  );
});

test("install.mjs holds its folder overrides to the runner's path rule and reports a refusal plainly", async (t) => {
  const { install } = await import("../install.mjs");
  // On Windows a Git Bash path, which would land under the current drive; elsewhere a relative one.
  const value = process.platform === "win32" ? "/c/agents" : "relative/agents";
  const written = [];
  assert.throws(
    () =>
      install({
        check: true,
        env: { CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: value },
        write: (line) => written.push(line),
      }),
    /CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR must be an absolute path/,
  );
  assert.deepEqual(written, [], "nothing was compared or written");
  const { root } = fixture(t);
  const cli = await runProcess(
    process.execPath,
    [fileURLToPath(new URL("../install.mjs", import.meta.url))],
    {
      cwd: root,
      env: {
        ...process.env,
        CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: value,
        CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: path.join(root, "skill"),
      },
      timeoutMs: 30_000,
    },
  );
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(
    cli.stderr,
    /^install\.mjs: CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR must be an absolute path/,
  );
  assert.deepEqual(fs.readdirSync(root), [], "nothing was installed");
});

test("the plugin's agents and skill are this folder's sources rendered with no machine path: each asks --prepare for its runner and task file", async () => {
  const { PLUGIN_PATHS, install, plannedFiles, plannedPluginFiles } =
    await import("../install.mjs");
  const here = path.dirname(SCRIPT);
  const files = plannedPluginFiles();
  const relative = (file) => path.relative(here, file).split(path.sep).join("/");
  const skillFile = "skills/codex-subagents-for-claude-code/SKILL.md";
  assert.deepEqual(
    files.map(({ target }) => relative(target)).sort(),
    [
      ...Object.keys(ROLES).map((role) => `agents/${role}.md`),
      skillFile,
      "agents/.generated.json",
    ].sort(),
  );
  assert.equal(
    install({ plugin: true, check: true, write: () => {} }),
    0,
    "node install.mjs --plugin",
  );
  const checkout = plannedFiles({
    paths: { runner: "R/run-codex-task.mjs", manual: "R/M", tmp: "T" },
  });
  for (const { target, text } of files) {
    assert.equal(fs.readFileSync(target, "utf8"), text, relative(target));
    if (path.basename(target) === ".generated.json") continue;
    assert.ok(!text.includes("{{"), relative(target));
    assert.doesNotMatch(
      text,
      /\b[A-Za-z]:[\\/]|(?<![\w.])\/(?:home|Users|tmp)\//,
      "no machine path",
    );
    assert.ok(text.includes(`${shellWord(PLUGIN_PATHS.entry)} --prepare `), relative(target));
    // The skill also names install.mjs's own --check.
    if (relative(target) !== skillFile)
      for (const flag of new Set(text.match(/--[a-z][a-z-]*/g) ?? []))
        assert.ok(KNOWN_OPTIONS.includes(flag.slice(2)), `${relative(target)} mentions ${flag}`);
    // The same source: the checkout's rendering differs only where a task file and the runner are named.
    const twin = checkout.find((file) => path.basename(file.target) === path.basename(target)).text;
    assert.equal(text.split("\n")[0], twin.split("\n")[0]);
  }
  for (const role of Object.keys(ROLES)) {
    const text = files.find(({ target }) => relative(target) === `agents/${role}.md`).text;
    assert.ok(text.startsWith(`---\nname: "${role}"\n`), role);
    assert.ok(text.includes(`\`node ${shellWord(PLUGIN_PATHS.entry)} --prepare ${role}\``), role);
    assert.ok(text.includes("create a new file named\n   `<task path>`"), role);
    assert.ok(
      text.includes(`\`node '<runner path>' --role ${role} --task-file "<that file>"`),
      role,
    );
    assert.doesNotThrow(() => parseArgs(["--prepare", role]));
  }
  const skill = files.find(({ target }) => relative(target) === skillFile).text;
  assert.ok(skill.includes("`subagent_type: codex-subagents:gpt-6-1-sol`"));
  assert.ok(checkout.at(-1).text.includes("`subagent_type: gpt-6-1-sol`"));
  assert.match(skill, /Forwarders are optional for direct\n  CLI use when none are installed/);
  assert.match(skill, /not whether Claude has loaded agents/);
  assert.match(skill, /^name: codex-subagents-for-claude-code$/m);
  assert.ok(skill.includes("Run it with `node '<runner path>'`"));
  assert.ok(skill.includes("`${CLAUDE_PLUGIN_ROOT}/docs/MANUAL.md`"));
  assert.ok(skill.includes(`\`node ${shellWord(PLUGIN_PATHS.entry)} --prepare <role>\``));
});

test("a disposable installation matches this folder's sources", async (t) => {
  const f = fixture(t);
  const { install } = await import("../install.mjs");
  const lines = [];
  assert.equal(install({ env: f.env, write: (line) => lines.push(line) }), 0);
  assert.equal(
    install({ check: true, env: f.env, write: (line) => lines.push(line) }),
    0,
    lines.join("\n"),
  );
});

// Close refuses uncertainty, a refused continue gives its reservation back
// (see the writer-lock test above), no silent drops, and Codex's token counts
// with the plan's limit for every turn.
