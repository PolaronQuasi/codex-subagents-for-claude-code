import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parseArgs, RUNNER_VERSION, runProcess } from "../src/index.mjs";

import { sink } from "./support/capture.mjs";
import { SCRIPT } from "./support/cli-adapter.mjs";
import { fixture } from "./support/runner-fixture.mjs";
import { ERRNO, EXIT } from "../src/shared/errors.mjs";

test("module surfaces keep implementation details private", async () => {
  for (const [file, names] of [
    ["shared/workspace", ["toplevels", "GIT_MS"]],
    ["run/launch", ["modeLabel"]],
    ["cli/task-input", ["editDistance", "nearDirective"]],
    ["state/state", ["GUARD_RETRIES", "GUARD_RETRY_MS", "validResult"]],
  ]) {
    const module = await import(`../src/${file}.mjs`);
    for (const name of names) assert.equal(Object.hasOwn(module, name), false, `${file}: ${name}`);
  }
});

test("entry exports match the source public API except the source-only CLI adapter", async () => {
  const source = await import("../src/index.mjs");
  const entry = await import("../run-codex-task.mjs");
  // runCli is intentionally consumed by the shim rather than exported by it.
  assert.deepEqual(
    Object.keys(entry).sort(),
    Object.keys(source)
      .filter((name) => name !== "runCli")
      .sort(),
  );
  for (const name of Object.keys(entry)) {
    assert.equal(typeof entry[name], typeof source[name], name);
    assert.notEqual(entry[name], undefined, name);
  }
});

test("source imports bypass an installed release while the entry honors its pointer", async (t) => {
  const f = fixture(t);
  const copy = path.join(f.root, "copy");
  fs.mkdirSync(copy);
  fs.cpSync(new URL("../src/", import.meta.url), path.join(copy, "src"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(copy, "run-codex-task.mjs"));
  const release = path.join(copy, "dist", "0.0.0-abcdef0", "src");
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(
    path.join(release, "index.mjs"),
    'export const RUNNER_VERSION = "installed-sentinel";\n',
  );
  fs.writeFileSync(path.join(copy, "dist", "current"), "0.0.0-abcdef0\n");
  const source = await import(pathToFileURL(path.join(copy, "src", "index.mjs")).href);
  const entry = await import(pathToFileURL(path.join(copy, "run-codex-task.mjs")).href);
  assert.equal(source.RUNNER_VERSION, RUNNER_VERSION);
  assert.equal(entry.RUNNER_VERSION, "installed-sentinel");
  const out = sink();
  assert.equal(await source.main(["--help"], { stdout: out.stream, script: SCRIPT }), 0);
  assert.ok(out.text().startsWith(`run-codex-task ${RUNNER_VERSION}\n`));
});

test("help is usable without an installed Codex", async (t) => {
  const f = fixture(t);
  const result = await f.cli(["--help"], {
    env: {
      ...f.env,
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH: "missing",
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_DIR: "missing",
    },
  });
  assert.equal(result.status, EXIT.COMPLETED);
  assert.match(result.stdout, /Usage:/);
  for (const mode of [
    "--continue",
    "--cancel",
    "--close",
    "--list",
    "--doctor",
    "--keep-state",
    "--scratch-workspace",
    "--worktree",
    "--quiet",
    "--max-stdout-lines",
    "--max-stdout-bytes",
    "--task-file",
    "--role",
    "--request-id",
    "--worktree-ref",
    "--wait",
    "--detach",
    "--relay",
    "codex-subagents-for-claude-code-launched:",
    "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR",
    "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR",
    `run-codex-task ${RUNNER_VERSION}`,
  ]) {
    assert.ok(result.stdout.includes(mode), mode);
  }
  // The byte cap names both of its exceptions, in its own option entry.
  const bytes =
    /^ {2}--max-stdout-bytes N[\s\S]*?(?=^ {2}--)/m.exec(result.stdout)?.[0].replace(/\s+/g, " ") ??
    "";
  assert.match(bytes, /The footer and the omission line are never cut/, bytes);
  assert.match(bytes, /Nothing is cut when the durable copy could not be written/, bytes);
  assert.deepEqual(f.events(), []);
});

test("every definition of this session says it covers the session's subagents, and to close by key", async () => {
  const { HELP } = await import("../src/cli/options.mjs");
  const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
  for (const [name, text] of [
    ["--help", HELP],
    ["MANUAL", read("../docs/MANUAL.md")],
    ["OPERATIONS", read("../docs/OPERATIONS.md")],
    ["skill", read("../claude/skills/codex-subagents-for-claude-code/SKILL.md")],
  ]) {
    const flat = text.replace(/\s+/g, " ");
    assert.match(
      flat,
      /CLAUDE_CODE_SESSION_ID[^.]*subagent|subagent[^.]*CLAUDE_CODE_SESSION_ID/,
      `${name}: the session ID is shared with subagents`,
    );
    assert.match(flat, /close (?:its|your) own runs by key/, `${name}: close by key`);
  }
});

test("the README's Usage shows the one-message background call, with placeholders, and the runner accepts it", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const usage = readme.split("\n## Usage\n")[1]?.split("\n## ")[0] ?? "";
  assert.match(
    usage,
    /one message can Write the task to a new file and call Bash with\s+`run_in_background: true`/,
  );
  const args = [
    "--role",
    "gpt-6-1-sol",
    "--task-file",
    "<task file>",
    "--quiet",
    "--wait",
    "--relay",
    "--max-stdout-bytes",
    "6000",
  ];
  const command = `node "<runner path>" ${args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ")}`;
  assert.ok(usage.includes(`\n${command}\n`), `the command, verbatim: ${command}`);
  const options = parseArgs(args);
  assert.deepEqual(
    [options.mode, options["wait-ms"], options.quiet, options.relay, options["max-stdout-bytes"]],
    ["task", Infinity, true, true, 6000],
  );
});

test("the entry, the installer and the release tool run as scripts when reached through a directory junction or symlink", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagents-for-claude-code-link "));
  const link = path.join(root, "linked folder");
  // Remove the link itself first, so the cleanup never reaches into this folder.
  t.after(() => {
    try {
      fs.unlinkSync(link);
    } catch (error) {
      if (error.code !== ERRNO.ENOENT) throw error;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.symlinkSync(path.dirname(SCRIPT), link, process.platform === "win32" ? "junction" : "dir");
  const run = (file, ...args) =>
    runProcess(process.execPath, [path.join(link, file), ...args], {
      cwd: root,
      timeoutMs: 30_000,
    });
  const help = await run("run-codex-task.mjs", "--help");
  assert.equal(help.status, EXIT.COMPLETED, help.stderr);
  assert.ok(
    help.stdout.startsWith(`run-codex-task ${RUNNER_VERSION}\n`) && help.stdout.includes("Usage:"),
    `the help, not silence: ${JSON.stringify(help.stdout.slice(0, 120))}`,
  );
  const installer = await run("install.mjs", "--no-such-flag");
  assert.equal(installer.status, 1, installer.stdout);
  assert.match(
    installer.stderr,
    /^usage: node install\.mjs \[--plugin \| --uninstall\] \[--check\]/,
  );
  const release = await run(path.join("tools", "release.mjs"), "help");
  assert.equal(release.status, EXIT.COMPLETED, release.stderr);
  assert.match(release.stdout, /^Usage:\n {2}node tools\/release\.mjs check/);
});
