// The plugin's slash commands, skills/codex-*/SKILL.md: skills only the user
// invokes, whose one shell command runs one runner mode that leaves nothing
// running, pre-approved by allowed-tools for exactly that command. And the
// plugin's hooks: none, since --prepare makes the runtime snapshot on demand.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../src/index.mjs";
import { SCRIPT } from "./support/cli-adapter.mjs";

const ROOT = path.dirname(SCRIPT);
const COMMANDS = {
  "codex-limits": { args: ["--limits"], mode: "limits" },
  "codex-list": { args: ["--list", "--mine"], mode: "list" },
  "codex-doctor": { args: ["--doctor", "--read-only"], mode: "doctor" },
};
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("each slash command runs one runner mode that starts nothing detached, pre-approves exactly that command and is invoked by the user only", () => {
  for (const [name, { args, mode }] of Object.entries(COMMANDS)) {
    const text = fs.readFileSync(path.join(ROOT, "skills", name, "SKILL.md"), "utf8");
    const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];
    assert.ok(front && body, name);
    const command = `node "\${CLAUDE_PLUGIN_ROOT}/run-codex-task.mjs" ${args.join(" ")}`;
    assert.match(front, new RegExp(`^name: ${name}$`, "m"));
    assert.match(front, /^description: .{20,}$/m);
    assert.match(front, /^disable-model-invocation: true$/m);
    assert.equal(
      front.split("\n").find((line) => line.startsWith("allowed-tools:")),
      `allowed-tools: 'Bash(${command})'`,
      name,
    );
    // The only injected command: the runner, then a read-only echo when it exits nonzero, so
    // the output still reaches the user (a failed injected command aborts the whole skill).
    const injected = [...body.matchAll(/!`([^`]*)`/g)].map((match) => match[1]);
    assert.equal(injected.length, 1, name);
    assert.match(
      injected[0],
      new RegExp(`^${escape(command)} \\|\\| echo "${name}: [^"$\`\\\\]+"$`),
    );
    assert.equal(parseArgs(args).mode, mode);
    assert.ok(!/\$ARGUMENTS|\$\d/.test(body), `${name} passes no user text to a shell`);
  }
  const skills = fs.readdirSync(path.join(ROOT, "skills")).sort();
  assert.deepEqual(skills, [...Object.keys(COMMANDS), "codex-subagents-for-claude-code"].sort());
});

test("the plugin registers no hook, monitor or MCP server: --prepare makes the runtime snapshot before every launch", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "hooks")), false, "no hooks/hooks.json");
  assert.equal(fs.existsSync(path.join(ROOT, "monitors")), false, "no monitors/monitors.json");
  assert.equal(fs.existsSync(path.join(ROOT, ".mcp.json")), false, "no .mcp.json");
  const manifest = (name) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", name), "utf8"));
  for (const declared of [manifest("plugin.json"), ...manifest("marketplace.json").plugins])
    for (const key of ["hooks", "mcpServers", "experimental", "settings"])
      assert.equal(declared[key], undefined, `${declared.name} declares no ${key}`);
  for (const folder of ["agents", "skills"])
    for (const name of fs.readdirSync(path.join(ROOT, folder), { recursive: true }))
      if (name.endsWith(".md")) {
        const text = fs.readFileSync(path.join(ROOT, folder, name), "utf8");
        const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
        assert.doesNotMatch(front, /^hooks:/m, `${folder}/${name} registers no hook`);
      }
});
