import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { doctorDetails } from "../src/codex/diagnostics.mjs";
import { ROLES } from "../src/roles.mjs";
import { RUNNER_VERSION } from "../src/version.mjs";
import { runProcess, sameFolder } from "../src/shared/io.mjs";
import {
  RELEASE_ROOT,
  ensureRuntime,
  pluginInstallation,
  runtimeSnapshots,
} from "../src/shared/runtime-release.mjs";
import { fixture } from "./support/codex-fixture.mjs";

function releaseCopy(f, { plugin = true, relative = "release" } = {}) {
  const root = path.join(f.root, relative);
  fs.mkdirSync(root, { recursive: true });
  for (const name of ["run-codex-task.mjs", "LICENSE", "NOTICE"])
    fs.copyFileSync(path.join(RELEASE_ROOT, name), path.join(root, name));
  fs.cpSync(path.join(RELEASE_ROOT, "src"), path.join(root, "src"), { recursive: true });
  if (plugin) {
    fs.mkdirSync(path.join(root, ".claude-plugin"));
    fs.writeFileSync(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "codex-subagents" }),
    );
    fs.cpSync(path.join(RELEASE_ROOT, "agents"), path.join(root, "agents"), { recursive: true });
  }
  const env = {
    ...f.env,
    HOME: path.join(f.root, "home"),
    USERPROFILE: path.join(f.root, "home"),
    TEMP: f.root,
    TMP: f.root,
    TMPDIR: f.root,
  };
  delete env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR;
  const entry = path.join(root, "run-codex-task.mjs");
  const invoke = (args = ["--doctor", "--read-only"], options = {}) =>
    runProcess(process.execPath, [options.entry ?? entry, ...args], {
      env: options.env ?? env,
      cwd: f.work,
      timeoutMs: 30_000,
    });
  return { root, env, entry, invoke };
}

test("verbose doctor projects bounded fields and never emits config or hook secrets", async () => {
  const calls = [],
    lines = [],
    problems = [];
  const session = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "mcpServerStatus/list")
        return {
          data: [
            {
              name: "test",
              authStatus: "oAuth",
              tools: { a: { description: "SECRET" } },
              toolsError: "SECRET",
            },
          ],
          nextCursor: "MORE",
        };
      if (method === "hooks/list")
        return {
          data: [
            {
              cwd: "SECRET",
              hooks: [{ command: "SECRET", eventName: "stop", handlerType: "command" }],
              warnings: ["SECRET"],
              errors: [],
            },
          ],
        };
      if (method === "config/read")
        return {
          config: {
            model: "test-model",
            model_reasoning_effort: "low",
            developer_instructions: "SECRET",
            mcp_servers: { key: "SECRET" },
          },
          origins: { path: "SECRET" },
        };
      return {
        requirements: {
          allowedSandboxModes: ["read-only"],
          allowedApprovalPolicies: ["never"],
          otel: { headers: { key: "SECRET" } },
        },
      };
    },
  };
  await doctorDetails(session, {
    cwd: process.cwd(),
    put: (k, v) => lines.push(`${k}=${v}`),
    problems,
  });
  assert.equal(problems.length, 0);
  assert.equal(lines.length, 4);
  assert.doesNotMatch(lines.join("\n"), /SECRET|MORE/);
  assert.match(lines[0], /"truncated":true/);
  assert.equal(calls[0].params.threadId, undefined);
  assert.equal(calls[2].params.includeLayers, false);
});

test("diagnostic failures are independent and omit raw errors", async () => {
  const lines = [],
    problems = [];
  await doctorDetails(
    {
      request: async () => {
        throw new Error("SECRET");
      },
    },
    {
      cwd: process.cwd(),
      put: (k, v) => lines.push(`${k}=${v}`),
      problems,
    },
  );
  assert.equal(problems.length, 4);
  assert.equal(lines.length, 4);
  assert.doesNotMatch(lines.join() + problems.join(), /SECRET/);
});

test("verbose doctor is explicit and never starts or resumes a thread", async (t) => {
  const f = fixture(t);
  const r = await f.invoke(["--doctor", "--read-only", "--verbose"]);
  assert.match(r.stdout, /codex-mcp=/);
  assert.match(r.stdout, /codex-hooks=/);
  assert.doesNotMatch(r.stdout, /codex-(mcp|hooks|defaults|requirements)=unavailable/);
  const calls = f
    .events()
    .filter((e) => e.direction === "in")
    .map((e) => e.method);
  assert.ok(calls.includes("configRequirements/read"));
  assert.equal(
    calls.some((m) => ["thread/start", "thread/resume", "turn/start"].includes(m)),
    false,
  );
  assert.equal((await f.invoke(["--verbose"])).code, 1);
});

test("doctor reports the running plugin's definitions and manifest namespace, never inherited plugin roots or Claude loading", async (t) => {
  const f = fixture(t),
    p = releaseCopy(f);
  fs.writeFileSync(
    path.join(p.root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "alternate-name" }),
  );
  p.env.CLAUDE_PLUGIN_ROOT = path.join(f.root, "unrelated-plugin");
  const r = await p.invoke();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^installation-mode=plugin$/m);
  assert.match(r.stdout, /^agent-namespace=alternate-name$/m);
  assert.match(r.stdout, /^agents-available=8\/8$/m);
  assert.match(r.stdout, /^agents-required=yes$/m);
  assert.match(r.stdout, /^claude-agents-loaded=unverified$/m);
  assert.ok(sameFolder(/^agents-dir=(.+)$/m.exec(r.stdout)?.[1], path.join(p.root, "agents")));
  assert.doesNotMatch(r.stdout, /agent-.*=missing|unrelated-plugin/);
});

test("plugin missing, stale and unreadable definitions fail doctor; explicit agents overrides still win", async (t) => {
  const f = fixture(t),
    p = releaseCopy(f);
  const roles = Object.keys(ROLES);
  fs.unlinkSync(path.join(p.root, "agents", `${roles[0]}.md`));
  fs.writeFileSync(path.join(p.root, "agents", `${roles[1]}.md`), "stale");
  fs.unlinkSync(path.join(p.root, "agents", `${roles[2]}.md`));
  fs.mkdirSync(path.join(p.root, "agents", `${roles[2]}.md`));
  const broken = await p.invoke();
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.stdout, /^agents-available=5\/8$/m);
  for (const [role, status] of [
    [roles[0], "missing"],
    [roles[1], "stale"],
    [roles[2], "unreadable"],
  ])
    assert.ok(broken.stdout.includes(`problem=agent definition ${role}.md is ${status}`));

  // Even malformed plugin metadata cannot override the explicitly selected directory.
  fs.writeFileSync(path.join(p.root, ".claude-plugin", "plugin.json"), "invalid");
  const selected = f.env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR;
  const overridden = await p.invoke(undefined, {
    env: { ...p.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: selected },
  });
  assert.equal(overridden.status, 0, overridden.stdout + overridden.stderr);
  assert.match(overridden.stdout, /^installation-mode=agents-override$/m);
  assert.match(overridden.stdout, /^agent-namespace=none$/m);
  assert.match(overridden.stdout, /^agents-available=0\/8$/m);
  assert.match(overridden.stdout, /^agents-required=no$/m);
  assert.ok(overridden.stdout.includes(`agents-dir=${selected}`));
  const invalid = await p.invoke();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /^installation-mode=invalid$/m);
});

test("snapshot doctor retains captured plugin evidence after its source disappears and prepare reuses the snapshot", async (t) => {
  const f = fixture(t),
    p = releaseCopy(f);
  const prepared = await p.invoke(["--prepare", "gpt-6-1-sol"]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const entry = /^runner: (.+)$/m.exec(prepared.stdout)?.[1];
  assert.ok(entry);
  const snapshots = runtimeSnapshots(f.state);
  fs.renameSync(p.root, path.join(f.root, "old-plugin"));
  p.env.CLAUDE_PLUGIN_ROOT = p.root;
  const r = await p.invoke(undefined, { entry });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^installation-mode=plugin-snapshot$/m);
  assert.match(r.stdout, /^agent-namespace=codex-subagents$/m);
  assert.match(r.stdout, /^agents-evidence=captured-at-prepare$/m);
  assert.match(r.stdout, /^agents-available=8\/8$/m);
  assert.match(r.stdout, /^claude-agents-loaded=unverified$/m);
  assert.match(r.stdout, /current plugin files and Claude loading are unverified/);
  const again = await p.invoke(["--prepare", "gpt-6-1-sol"], { entry });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(/^runner: (.+)$/m.exec(again.stdout)?.[1], entry);
  assert.deepEqual(runtimeSnapshots(f.state), snapshots);
});

test("standalone CLI forwarders are optional, while partial checkout installations are diagnosed", async (t) => {
  const f = fixture(t),
    p = releaseCopy(f, { plugin: false });
  p.env.CLAUDE_PLUGIN_ROOT = RELEASE_ROOT;
  const empty = await p.invoke();
  assert.equal(empty.status, 0, empty.stdout + empty.stderr);
  assert.match(empty.stdout, /^installation-mode=standalone$/m);
  assert.match(empty.stdout, /^agent-namespace=none$/m);
  assert.match(empty.stdout, /^agents-required=no$/m);
  const agents = path.join(p.env.HOME, ".claude", "agents");
  fs.mkdirSync(agents, { recursive: true });
  const role = Object.keys(ROLES)[0];
  fs.writeFileSync(path.join(agents, `${role}.md`), `--role ${role} --task-file task.md`);
  const partial = await p.invoke();
  assert.equal(partial.status, 1, partial.stdout + partial.stderr);
  assert.match(partial.stdout, /^installation-mode=checkout$/m);
  assert.match(partial.stdout, /^agents-available=1\/8$/m);
  assert.match(partial.stdout, /^agents-required=yes$/m);
});

test("snapshot definition inventories affect the digest and preserve captured failures independently of live files", async (t) => {
  const f = fixture(t),
    p = releaseCopy(f);
  const args = { stateBase: f.state, entry: p.entry, version: RUNNER_VERSION, root: p.root };
  const first = ensureRuntime(args);
  const role = Object.keys(ROLES)[0],
    file = path.join(p.root, "agents", `${role}.md`);
  const original = fs.readFileSync(file);
  fs.unlinkSync(file);
  const second = ensureRuntime(args);
  assert.notEqual(first.id, second.id);
  fs.writeFileSync(file, original);
  assert.equal(ensureRuntime(args).id, first.id);
  assert.equal(pluginInstallation(first.dir).definitions[role], "ok");
  assert.equal(pluginInstallation(second.dir).definitions[role], "missing");
  const captured = await p.invoke(undefined, { entry: second.runner });
  assert.equal(captured.status, 1, captured.stdout + captured.stderr);
  assert.match(captured.stdout, /^installation-mode=plugin-snapshot$/m);
  assert.match(captured.stdout, /^agents-available=7\/8$/m);
  assert.ok(captured.stdout.includes(`problem=captured agent definition ${role}.md is missing`));
});

test("plugin discovery rejects linked definition directories and malformed namespaces", (t) => {
  const f = fixture(t),
    p = releaseCopy(f);
  const agents = path.join(p.root, "agents"),
    elsewhere = path.join(f.root, "elsewhere");
  fs.renameSync(agents, elsewhere);
  fs.symlinkSync(elsewhere, agents, process.platform === "win32" ? "junction" : "dir");
  assert.ok(
    Object.values(pluginInstallation(p.root).definitions).every((state) => state === "unreadable"),
  );
  fs.writeFileSync(
    path.join(p.root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "../unsafe" }),
  );
  assert.throws(() => pluginInstallation(p.root), /invalid plugin manifest name/);
  fs.writeFileSync(
    path.join(p.root, "runtime-installation.json"),
    JSON.stringify({ version: 1, namespace: "codex-subagents", definitions: {} }),
  );
  assert.throws(() => pluginInstallation(p.root), /invalid runtime installation inventory/);
});

test("dual-use source archives and checkouts distinguish installed forwarders from bundled plugin candidates", async (t) => {
  const f = fixture(t),
    p = releaseCopy(f);
  fs.writeFileSync(
    path.join(p.root, "install.mjs"),
    "// Source installer marker; never executed.\n",
  );
  // A full source archive without .git is still a checkout installation source.
  const empty = await p.invoke();
  assert.equal(empty.status, 0, empty.stdout + empty.stderr);
  assert.match(empty.stdout, /^installation-mode=ambiguous$/m);
  assert.match(empty.stdout, /^agents-available=0\/8$/m);
  assert.match(empty.stdout, /^agents-required=no$/m);
  assert.match(empty.stdout, /^bundled-agents-available=8\/8$/m);
  assert.match(empty.stdout, /^bundled-agent-namespace=codex-subagents$/m);
  assert.match(empty.stdout, /^claude-agents-loaded=unverified$/m);
  assert.equal(fs.existsSync(path.join(p.root, ".git")), false);

  fs.mkdirSync(path.join(p.root, ".git"));
  const agents = path.join(p.env.HOME, ".claude", "agents");
  fs.mkdirSync(agents, { recursive: true });
  for (const role of Object.keys(ROLES))
    fs.writeFileSync(path.join(agents, `${role}.md`), `--role ${role} --task-file task.md`);
  const role = Object.keys(ROLES)[0];
  fs.unlinkSync(path.join(p.root, "agents", `${role}.md`));
  p.env.CLAUDE_PLUGIN_ROOT = path.join(f.root, "unrelated-plugin");
  const installed = await p.invoke();
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.match(installed.stdout, /^installation-mode=ambiguous$/m);
  assert.match(installed.stdout, /^agent-namespace=none$/m);
  assert.match(installed.stdout, /^agents-available=8\/8$/m);
  assert.match(installed.stdout, /^bundled-agents-available=7\/8$/m);
  assert.ok(installed.stdout.includes(`agents-dir=${agents}`));

  // A local --plugin-dir invocation can bind its hint to the exact loaded root.
  const plugin = await p.invoke(undefined, { env: { ...p.env, CLAUDE_PLUGIN_ROOT: p.root } });
  assert.equal(plugin.status, 1, plugin.stdout + plugin.stderr);
  assert.match(plugin.stdout, /^installation-mode=plugin$/m);
  assert.match(plugin.stdout, /^agent-namespace=codex-subagents$/m);
  assert.match(plugin.stdout, /^agents-available=7\/8$/m);
  assert.match(plugin.stdout, /^agents-required=yes$/m);
  assert.ok(plugin.stdout.includes(`problem=agent definition ${role}.md is missing`));
});

test("native plugin cache layout identifies a plugin even when its package includes checkout tooling", (t) => {
  const f = fixture(t),
    p = releaseCopy(f, {
      relative: path.join(
        "home",
        ".claude",
        "plugins",
        "cache",
        "fixture-market",
        "codex-subagents",
        "1.0.0",
      ),
    });
  fs.writeFileSync(path.join(p.root, "install.mjs"), "// Never executed.\n");
  assert.equal(
    pluginInstallation(p.root, { CLAUDE_PLUGIN_ROOT: path.join(f.root, "unrelated") }).mode,
    "plugin",
  );
});

test("snapshot inventories preserve ambiguous versus explicitly selected plugin provenance", async (t) => {
  const f = fixture(t),
    p = releaseCopy(f);
  fs.writeFileSync(path.join(p.root, "install.mjs"), "// Never executed.\n");
  const args = { stateBase: f.state, entry: p.entry, version: RUNNER_VERSION, root: p.root };
  const ambiguous = ensureRuntime(args);
  const plugin = ensureRuntime({ ...args, env: { CLAUDE_PLUGIN_ROOT: p.root } });
  assert.notEqual(ambiguous.id, plugin.id);
  assert.equal(pluginInstallation(ambiguous.dir).mode, "ambiguous");
  assert.equal(pluginInstallation(plugin.dir).mode, "plugin-snapshot");
  fs.renameSync(p.root, path.join(f.root, "removed-source"));
  const r = await p.invoke(undefined, { entry: ambiguous.runner });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^installation-mode=ambiguous$/m);
  assert.match(r.stdout, /^agents-available=0\/8$/m);
  assert.match(r.stdout, /^bundled-agents-available=8\/8$/m);
  assert.match(r.stdout, /^bundled-agents-evidence=captured-at-prepare$/m);
  assert.equal(
    ensureRuntime({ ...args, root: ambiguous.dir, entry: ambiguous.runner }).id,
    ambiguous.id,
  );
});
