import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  ROOT,
  INVENTORY,
  PLUGIN_SOURCE,
  buildPluginPackage,
  pluginPackageFiles,
  pluginPackageProblems,
} from "../../tools/plugin-package.mjs";
import { createScratch } from "../../tools/scratch.mjs";

const IS_WINDOWS = process.platform === "win32";

const write = (root, name, content) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (root, name) => fs.readFileSync(path.join(root, name), "utf8");
const temporary = (t) => {
  const scratch = createScratch("codex-plugin-package-");
  t.after(() => scratch.remove());
  return scratch.directory;
};
const fixture = (t) => {
  const root = temporary(t);
  const inputs = {
    "package.json": JSON.stringify({ version: "1.0.0" }),
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "codex-subagents",
      version: "1.0.0",
      icon: "./assets/icon.svg",
    }),
    ".claude-plugin/marketplace.json": JSON.stringify({
      plugins: [{ name: "codex-subagents", source: PLUGIN_SOURCE }],
    }),
    "assets/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"/>\n',
    "run-codex-task.mjs": 'export * from "./src/index.mjs";\n',
    "src/index.mjs": 'export * from "./version.mjs";\n',
    "src/version.mjs": 'export const RUNNER_VERSION = "1.0.0";\n',
    "agents/gpt-example.md": "Run `${CLAUDE_PLUGIN_ROOT}/run-codex-task.mjs`.\n",
    "skills/example/SKILL.md": "Read `${CLAUDE_PLUGIN_ROOT}/docs/MANUAL.md`.\n",
    LICENSE: "Example license\n",
    NOTICE: "Example notice\n",
    "SECURITY.md": "Security\n",
    "SUPPORT.md": "Support\n",
    "CONTRACT.md": "Contract\n",
    "docs/MANUAL.md":
      "[examples](EXAMPLES.md) [installation](../README.md#installation)\n[release]: DEVELOPMENT.md#release\n",
    "docs/EXAMPLES.md": "Examples\n",
    "docs/OPERATIONS.md": "Operations\n",
    "docs/COMPATIBILITY.md": "Compatibility\n",
    "README.md": "# Installation\n",
    "docs/DEVELOPMENT.md": "# Release\n",
  };
  for (const [name, bytes] of Object.entries(inputs)) write(root, name, bytes);
  return root;
};

test("marketplace payload is deterministic, independently runnable and excludes development trees", (t) => {
  // Materialize the live source selection only in an owned temp root. --help
  // imports the complete runtime without launching Codex or touching a profile.
  const root = temporary(t);
  const files = pluginPackageFiles();
  for (const [name, bytes] of files) write(root, name, bytes);
  for (const prefix of ["test/", "ci/", "tools/", ".github/", ".githooks/", "claude/"])
    assert.equal(
      [...files.keys()].some((name) => name.startsWith(prefix)),
      false,
      prefix,
    );
  assert.ok(files.has("run-codex-task.mjs"));
  assert.ok(files.has("LICENSE"));
  assert.ok(files.has("NOTICE"));
  assert.ok(files.has("assets/icon.svg"));
  assert.ok(files.has("README.md"));
  assert.equal(files.has(".claude-plugin/marketplace.json"), false);
  assert.equal(files.has("install.mjs"), false);
  const manifest = JSON.parse(files.get(".claude-plugin/plugin.json"));
  assert.equal(manifest.icon, "./assets/icon.svg");
  const market = JSON.parse(read(ROOT, ".claude-plugin/marketplace.json"));
  assert.equal(market.plugins.find((entry) => entry.name === manifest.name).source, PLUGIN_SOURCE);
  const inventory = JSON.parse(files.get(INVENTORY));
  assert.equal(inventory.version, manifest.version);
  assert.deepEqual(
    inventory.files.map((entry) => entry.path),
    [...files.keys()].filter((name) => name !== INVENTORY),
  );
  for (const entry of inventory.files) {
    const bytes = files.get(entry.path);
    assert.equal(entry.size, bytes.length);
    assert.equal(entry.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  }
  const env = {
    ...process.env,
    CODEX_HOME: path.join(root, "codex-home"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude-home"),
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR: path.join(root, "state"),
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: path.join(root, "results"),
  };
  const result = spawnSync(process.execPath, [path.join(root, "run-codex-task.mjs"), "--help"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--prepare/);
});

test("build copies only the allowlist and keeps omitted documentation links canonical", (t) => {
  const root = fixture(t);
  for (const name of [
    "test/a.mjs",
    "ci/a",
    "tools/a.mjs",
    ".github/a",
    ".githooks/a",
    "src/local.txt",
  ])
    write(root, name, "not a runtime input\n");
  const first = buildPluginPackage({ root });
  const inventory = read(root, `plugin/${INVENTORY}`);
  const initialEntryModifiedTimeMs = fs.statSync(path.join(root, "plugin/src/index.mjs")).mtimeMs;
  assert.deepEqual(buildPluginPackage({ root }), first);
  assert.equal(read(root, `plugin/${INVENTORY}`), inventory);
  assert.equal(
    fs.statSync(path.join(root, "plugin/src/index.mjs")).mtimeMs,
    initialEntryModifiedTimeMs,
  );
  assert.deepEqual(pluginPackageProblems(root), []);
  assert.equal(first.source, "./plugin");
  assert.equal(first.files, 18);
  assert.ok(first.bytes > 0);
  assert.equal(fs.existsSync(path.join(root, "plugin/test")), false);
  assert.equal(fs.existsSync(path.join(root, "plugin/src/local.txt")), false);
  assert.match(read(root, "plugin/docs/MANUAL.md"), /\[examples\]\(EXAMPLES.md\)/);
  assert.match(
    read(root, "plugin/docs/MANUAL.md"),
    /https:\/\/github.com\/PolaronQuasi\/codex-subagents-for-claude-code\/blob\/main\/README.md#installation/,
  );
  assert.match(
    read(root, "plugin/docs/MANUAL.md"),
    /\[release\]: https:.*\/docs\/DEVELOPMENT.md#release/,
  );
  assert.match(read(root, "plugin/README.md"), /\/codex-subagents:codex-doctor/);
  assert.match(read(root, "plugin/README.md"), /\[manual\]\(docs\/MANUAL.md\)/);
});

test("check is read-only and catches edited source, output, missing files and extra content", (t) => {
  const root = fixture(t);
  buildPluginPackage({ root });
  write(root, "src/index.mjs", "// new source\n");
  assert.match(
    pluginPackageProblems(root).join("\n"),
    /plugin\/src\/index.mjs is missing or stale/,
  );
  assert.notEqual(read(root, "plugin/src/index.mjs"), "// new source\n");
  buildPluginPackage({ root });
  assert.deepEqual(pluginPackageProblems(root), []);
  fs.unlinkSync(path.join(root, "plugin/NOTICE"));
  assert.match(pluginPackageProblems(root).join("\n"), /plugin\/NOTICE is missing or stale/);
  buildPluginPackage({ root });
  write(root, "plugin/src/index.mjs", "// user edits\n");
  assert.match(
    pluginPackageProblems(root).join("\n"),
    /plugin\/src\/index.mjs is missing or stale/,
  );
  assert.throws(() => buildPluginPackage({ root }), /modified generated/);
  assert.equal(read(root, "plugin/src/index.mjs"), "// user edits\n");
});

test("an interrupted update resumes completed writes without accepting unrelated edits", (t) => {
  const root = fixture(t);
  buildPluginPackage({ root });
  const previousInventory = read(root, `plugin/${INVENTORY}`);

  // Interrupt after some payload writes, before publishing the new inventory.
  write(root, "LICENSE", "Updated license fixture\n");
  write(root, "src/added/new.mjs", "// new module\n");
  write(root, "src/index.mjs", "// updated entry\n");
  const originalWriteFileSync = fs.writeFileSync;
  const interruptedWrite = t.mock.method(fs, "writeFileSync", function (file, ...args) {
    if (file === path.join(root, "plugin/src/index.mjs")) {
      throw new Error("injected interrupted package write");
    }
    return originalWriteFileSync.call(this, file, ...args);
  });
  assert.throws(() => buildPluginPackage({ root }), /injected interrupted package write/);
  interruptedWrite.mock.restore();
  assert.equal(read(root, "plugin/LICENSE"), "Updated license fixture\n");
  assert.equal(read(root, "plugin/src/added/new.mjs"), "// new module\n");
  assert.equal(read(root, `plugin/${INVENTORY}`), previousInventory);

  // Neither an arbitrary edit nor an unknown path becomes owned by recovery.
  const originalNotice = read(root, "plugin/NOTICE");
  write(root, "plugin/NOTICE", "user edit\n");
  assert.throws(() => buildPluginPackage({ root }), /modified generated plugin\/NOTICE/);
  assert.equal(read(root, "plugin/NOTICE"), "user edit\n");
  write(root, "plugin/NOTICE", originalNotice);
  write(root, "plugin/private.txt", "keep\n");
  assert.throws(() => buildPluginPackage({ root }), /unowned/);
  assert.equal(read(root, "plugin/private.txt"), "keep\n");
  fs.unlinkSync(path.join(root, "plugin/private.txt"));

  // With unrelated edits removed, recovery finishes the interrupted update.
  buildPluginPackage({ root });
  assert.deepEqual(pluginPackageProblems(root), []);
  assert.equal(read(root, "plugin/src/index.mjs"), "// updated entry\n");
});

test("retired generated files are removed individually; unknown files and directories are preserved", (t) => {
  const root = fixture(t);
  write(root, "src/retired/module.mjs", "// retired\n");
  buildPluginPackage({ root });
  fs.unlinkSync(path.join(root, "src/retired/module.mjs"));
  buildPluginPackage({ root });
  assert.equal(fs.existsSync(path.join(root, "plugin/src/retired")), false);
  write(root, "plugin/private.txt", "keep\n");
  assert.match(pluginPackageProblems(root).join("\n"), /private.txt is unexpected/);
  assert.throws(() => buildPluginPackage({ root }), /unowned/);
  assert.equal(read(root, "plugin/private.txt"), "keep\n");
  fs.unlinkSync(path.join(root, "plugin/private.txt"));
  fs.mkdirSync(path.join(root, "plugin/private-directory"));
  assert.throws(() => buildPluginPackage({ root }), /unowned/);
  assert.ok(fs.existsSync(path.join(root, "plugin/private-directory")));
});

test("nonempty unowned output and unsafe inventory paths never authorize deletion", (t) => {
  const root = fixture(t);
  write(root, "plugin/user.txt", "preserved\n");
  assert.throws(() => buildPluginPackage({ root }), /nonempty plugin/);
  assert.equal(read(root, "plugin/user.txt"), "preserved\n");
  fs.unlinkSync(path.join(root, "plugin/user.txt"));
  buildPluginPackage({ root });
  const inventory = JSON.parse(read(root, `plugin/${INVENTORY}`));
  inventory.files[0].path = "../outside.txt";
  write(root, `plugin/${INVENTORY}`, JSON.stringify(inventory));
  write(root, "outside.txt", "preserved\n");
  assert.throws(() => buildPluginPackage({ root }), /invalid generated plugin inventory entry/);
  assert.equal(read(root, "outside.txt"), "preserved\n");
});

test("source and output junctions are refused without visiting the target", (t) => {
  const root = fixture(t);
  const outside = temporary(t);
  write(outside, "keep.txt", "preserved\n");
  const type = IS_WINDOWS ? "junction" : "dir";
  fs.symlinkSync(outside, path.join(root, "plugin"), type);
  assert.throws(() => buildPluginPackage({ root }), /link or junction/);
  fs.unlinkSync(path.join(root, "plugin"));
  fs.symlinkSync(outside, path.join(root, "src/linked"), type);
  assert.throws(() => buildPluginPackage({ root }), /link or junction/);
  assert.equal(read(outside, "keep.txt"), "preserved\n");
  fs.unlinkSync(path.join(root, "src/linked"));
  buildPluginPackage({ root });
  fs.symlinkSync(outside, path.join(root, "plugin/src/linked"), type);
  assert.throws(() => buildPluginPackage({ root }), /link or junction/);
  fs.unlinkSync(path.join(root, "plugin/src/linked"));
});

test("hardlinked output, oversized inputs and missing plugin-root references fail closed", (t) => {
  const root = fixture(t);
  buildPluginPackage({ root });
  fs.linkSync(path.join(root, "plugin/NOTICE"), path.join(root, "notice-copy"));
  assert.throws(() => buildPluginPackage({ root }), /unlinked regular file/);
  fs.unlinkSync(path.join(root, "notice-copy"));
  write(root, "src/huge.mjs", Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.throws(() => buildPluginPackage({ root }), /exceeds/);
  fs.unlinkSync(path.join(root, "src/huge.mjs"));
  write(root, "skills/example/SKILL.md", "Read `${CLAUDE_PLUGIN_ROOT}/missing.md`.\n");
  assert.throws(() => buildPluginPackage({ root }), /missing plugin-root target/);
});

test("broken doc links and manifest version/source/icon drift fail before output changes", (t) => {
  const root = fixture(t);
  buildPluginPackage({ root });
  const original = read(root, "docs/MANUAL.md");
  write(root, "docs/MANUAL.md", "[missing](MISSING.md)\n");
  assert.throws(() => buildPluginPackage({ root }), /broken package link/);
  write(root, "docs/MANUAL.md", original);
  const manifest = JSON.parse(read(root, ".claude-plugin/plugin.json"));
  for (const patch of [{ version: "2.0.0" }, { icon: "../escape.svg" }]) {
    write(root, ".claude-plugin/plugin.json", JSON.stringify({ ...manifest, ...patch }));
    assert.ok(pluginPackageProblems(root).length);
  }
  write(root, ".claude-plugin/plugin.json", JSON.stringify(manifest));
  write(
    root,
    ".claude-plugin/marketplace.json",
    JSON.stringify({ plugins: [{ name: manifest.name, source: "./" }] }),
  );
  assert.match(pluginPackageProblems(root).join("\n"), /marketplace must list/);
  assert.equal(JSON.parse(read(root, "plugin/.claude-plugin/plugin.json")).version, "1.0.0");
});

test("CLI rejects an arbitrary output destination without creating it", (t) => {
  const root = temporary(t);
  const output = path.join(root, "arbitrary-output");
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "tools/plugin-package.mjs"), "build", "--output", output],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 16384,
      windowsHide: true,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /output is always/);
  assert.equal(fs.existsSync(output), false);
});
