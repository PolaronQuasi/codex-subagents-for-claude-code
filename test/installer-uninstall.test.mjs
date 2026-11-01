import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { install, installPaths, plannedFiles } from "../install.mjs";

const SOURCE = fileURLToPath(new URL("..", import.meta.url));
const quiet = () => {};
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-uninstall-"));
  t.after(() => {
    assert.ok(path.basename(root).startsWith("codex-uninstall-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const env = {
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: path.join(root, ".claude", "agents"),
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: path.join(
      root,
      ".claude",
      "skills",
      "codex-subagents-for-claude-code",
    ),
  };
  const files = plannedFiles({ env });
  const receipts = () =>
    [...new Set(files.map((file) => path.dirname(file.target)))].flatMap((dir) =>
      fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((name) => name.startsWith(".codex-subagents-install-"))
            .map((name) => path.join(dir, name))
        : [],
    );
  const run = (options = {}) => install({ env, write: quiet, ...options });
  const cli = (args, script = path.join(SOURCE, "install.mjs")) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
  return { root, env, files, receipts, run, cli };
}

function copyCheckout(root) {
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  for (const name of ["install.mjs", "run-codex-task.mjs"])
    fs.copyFileSync(path.join(SOURCE, name), path.join(checkout, name));
  for (const dir of ["src", "claude"])
    fs.cpSync(path.join(SOURCE, dir), path.join(checkout, dir), { recursive: true });
  return checkout;
}

test("checkout uninstall previews unchanged definitions, removes them and receipts, and repeats safely", (t) => {
  const f = fixture(t);
  assert.equal(f.run(), 0);
  const receipts = f.receipts();
  assert.equal(receipts.length, 2);
  const owned = [...f.files.map((file) => file.target), ...receipts];
  const before = owned.map((file) => fs.readFileSync(file));
  const lines = [];
  assert.equal(f.run({ uninstall: true, check: true, write: (line) => lines.push(line) }), 1);
  assert.equal(lines.filter((line) => line.startsWith("would-remove ")).length, owned.length);
  assert.deepEqual(
    owned.map((file) => fs.readFileSync(file)),
    before,
  );
  const removed = f.cli(["--uninstall"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(
    removed.stdout.split("\n").filter((line) => line.startsWith("removed ")).length,
    owned.length,
  );
  for (const file of owned) assert.equal(fs.existsSync(file), false, file);
  for (const dir of new Set(f.files.map((file) => path.dirname(file.target))))
    assert.ok(fs.statSync(dir).isDirectory(), "all shared directories remain");
  assert.equal(f.cli(["--uninstall"]).status, 0);
  assert.equal(f.run({ uninstall: true, check: true }), 0);
});

test("uninstall preserves edited and unrelated files, shared data, and checkout source", (t) => {
  const f = fixture(t);
  assert.equal(f.run(), 0);
  const edited = [f.files[0].target, f.files.at(-1).target];
  for (const file of edited) fs.appendFileSync(file, "\nuser edit\n");
  const kept = [
    ...edited,
    path.join(f.root, ".claude", "agents", "custom.md"),
    path.join(f.root, ".claude", "agents", "gpt-9-unrelated.md"),
    path.join(f.root, ".claude", "results", "answer.txt"),
    path.join(f.root, ".claude", "state", "run.json"),
    path.join(f.root, "checkout", ".git", "refs", "heads", "kept-branch"),
    path.join(f.root, "checkout", "run-codex-task.mjs"),
  ];
  for (const file of kept.slice(edited.length)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "keep exactly\n");
  }
  const before = kept.map((file) => fs.readFileSync(file));
  const source = fs.readFileSync(path.join(SOURCE, "install.mjs"));
  const lines = [];
  assert.equal(f.run({ uninstall: true, write: (line) => lines.push(line) }), 1);
  assert.equal(lines.filter((line) => line.endsWith("(edited or ownership unproven)")).length, 2);
  assert.deepEqual(
    kept.map((file) => fs.readFileSync(file)),
    before,
  );
  assert.equal(f.receipts().length, 2, "receipts remain as evidence for preserved edits");
  assert.deepEqual(fs.readFileSync(path.join(SOURCE, "install.mjs")), source);
  assert.equal(f.run({ uninstall: true }), 1);
  for (const file of f.files.filter((file) => !edited.includes(file.target)))
    assert.equal(fs.existsSync(file.target), false);
});

test("definitions without receipts are preserved even when their rendering matches exactly", (t) => {
  const f = fixture(t);
  for (const file of f.files) {
    fs.mkdirSync(path.dirname(file.target), { recursive: true });
    fs.writeFileSync(file.target, file.text);
  }
  fs.appendFileSync(f.files[0].target, "\ncustom instruction\n");
  assert.equal(f.receipts().length, 0);
  const before = f.files.map(({ target }) => fs.readFileSync(target));
  for (const check of [true, false]) {
    assert.equal(f.run({ uninstall: true, check }), 1);
    assert.deepEqual(
      f.files.map(({ target }) => fs.readFileSync(target)),
      before,
    );
  }
});

test("agent and skill overrides sharing a directory use one complete receipt", (t) => {
  const f = fixture(t);
  const env = {
    ...f.env,
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: f.env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR,
  };
  assert.equal(f.run({ env }), 0);
  const receipt = f.receipts()[0];
  const record = JSON.parse(fs.readFileSync(receipt, "utf8"));
  assert.equal(Object.keys(record.files).length, f.files.length);
  assert.ok(record.files["SKILL.md"]);
  assert.equal(f.run({ env, uninstall: true }), 0);
  assert.deepEqual(fs.readdirSync(env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR), []);
});

test("another checkout and its receipts survive even with stale receipts from this checkout", (t) => {
  const f = fixture(t);
  assert.equal(f.run(), 0);
  const other = path.join(f.root, "another-checkout");
  fs.mkdirSync(other);
  for (const name of ["install.mjs", "run-codex-task.mjs"])
    fs.copyFileSync(path.join(SOURCE, name), path.join(other, name));
  for (const dir of ["src", "claude"])
    fs.cpSync(path.join(SOURCE, dir), path.join(other, dir), { recursive: true });
  const result = f.cli([], path.join(other, "install.mjs"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.receipts().length, 4);
  const saved = [...f.files.map((file) => file.target), ...f.receipts()];
  const before = saved.map((file) => fs.readFileSync(file));
  assert.equal(f.run({ uninstall: true }), 1);
  assert.deepEqual(
    saved.map((file) => fs.readFileSync(file)),
    before,
  );
  const alternate = plannedFiles({
    env: f.env,
    // Node's module loader resolves links but retains Windows short-path spelling.
    paths: installPaths({ root: fs.realpathSync(other) }),
  });
  for (const file of alternate) assert.equal(fs.readFileSync(file.target, "utf8"), file.text);
});

test("receipts retain old renderings after an actual source update", (t) => {
  const f = fixture(t);
  const checkout = copyCheckout(f.root);
  const script = path.join(checkout, "install.mjs");
  const installed = f.cli([], script);
  assert.equal(installed.status, 0, installed.stderr);
  const owned = [...f.files.map((file) => file.target), ...f.receipts()];
  const before = owned.map((file) => fs.readFileSync(file));
  fs.appendFileSync(
    path.join(checkout, "claude", "agents", "forwarder.template.md"),
    "\nnew agent template\n",
  );
  fs.appendFileSync(
    path.join(checkout, "claude", "skills", "codex-subagents-for-claude-code", "SKILL.md"),
    "\nnew skill template\n",
  );
  const preview = f.cli(["--uninstall", "--check"], script);
  assert.equal(preview.status, 1, preview.stderr);
  assert.equal(
    preview.stdout.split("\n").filter((line) => line.startsWith("would-remove ")).length,
    owned.length,
  );
  assert.deepEqual(
    owned.map((file) => fs.readFileSync(file)),
    before,
  );
  const result = f.cli(["--uninstall"], script);
  assert.equal(result.status, 0, result.stderr);
  for (const file of owned) assert.equal(fs.existsSync(file), false, file);
});

test("a receipt cannot claim arbitrary gpt-named custom definitions", (t) => {
  const f = fixture(t);
  assert.equal(f.run(), 0);
  const receipt = f.receipts()[0];
  const foreign = path.join(path.dirname(receipt), "gpt-my-custom-agent.md");
  fs.writeFileSync(foreign, "foreign custom definition\n");
  const record = JSON.parse(fs.readFileSync(receipt, "utf8"));
  record.files[path.basename(foreign)] = hash(fs.readFileSync(foreign));
  fs.writeFileSync(receipt, JSON.stringify(record));
  const saved = [...f.files.map((file) => file.target), ...f.receipts(), foreign];
  const before = saved.map((file) => fs.readFileSync(file));
  for (const options of [
    {},
    { check: true },
    { uninstall: true },
    { uninstall: true, check: true },
  ]) {
    assert.throws(() => f.run(options), /invalid checkout ownership receipt/);
    assert.deepEqual(
      saved.map((file) => fs.readFileSync(file)),
      before,
    );
  }
});

test("a receipt mismatch preserves user edits even when an updated source renders the same bytes", (t) => {
  const f = fixture(t);
  const checkout = copyCheckout(f.root);
  const script = path.join(checkout, "install.mjs");
  const installed = f.cli([], script);
  assert.equal(installed.status, 0, installed.stderr);
  const edited = [f.files[0].target, f.files.at(-1).target];
  const edit = "\nuser change adopted by newer source\n";
  for (const file of edited) fs.appendFileSync(file, edit);
  fs.appendFileSync(path.join(checkout, "claude", "agents", "forwarder.template.md"), edit);
  fs.appendFileSync(
    path.join(checkout, "claude", "skills", "codex-subagents-for-claude-code", "SKILL.md"),
    edit,
  );
  const saved = [...edited, ...f.receipts()];
  const before = saved.map((file) => fs.readFileSync(file));
  for (const args of [["--uninstall", "--check"], ["--uninstall"]]) {
    const result = f.cli(args, script);
    assert.equal(result.status, 1, result.stderr);
    for (const file of edited)
      assert.ok(result.stdout.includes(`preserved ${file} (edited or ownership unproven)`));
    assert.deepEqual(
      saved.map((file) => fs.readFileSync(file)),
      before,
    );
  }
  for (const file of f.files.filter((file) => !edited.includes(file.target)))
    assert.equal(fs.existsSync(file.target), false, "unchanged old definitions still uninstall");
});

test("a missing per-file receipt entry preserves matching definitions and their receipts", (t) => {
  const f = fixture(t);
  assert.equal(f.run(), 0);
  for (const receipt of f.receipts()) {
    const record = JSON.parse(fs.readFileSync(receipt, "utf8"));
    delete record.files[path.basename(f.files[0].target)];
    delete record.files["SKILL.md"];
    fs.writeFileSync(receipt, JSON.stringify(record));
  }
  assert.equal(f.run({ uninstall: true, check: true }), 1);
  assert.equal(f.run({ uninstall: true }), 1);
  for (const file of [f.files[0], f.files.at(-1)])
    assert.equal(fs.readFileSync(file.target, "utf8"), file.text);
  for (const file of f.files.slice(1, -1)) assert.equal(fs.existsSync(file.target), false);
  assert.equal(f.receipts().length, 2);
});

test("invalid and escaping ownership receipts refuse before removing any definition", (t) => {
  const f = fixture(t);
  assert.equal(f.run(), 0);
  const receipt = f.receipts()[0];
  const original = JSON.parse(fs.readFileSync(receipt, "utf8"));
  for (const broken of [
    "{",
    JSON.stringify({ ...original, checkout: "another checkout" }),
    JSON.stringify({ ...original, files: { "../outside.md": "a".repeat(64) } }),
  ]) {
    fs.writeFileSync(receipt, broken);
    assert.throws(() => f.run({ uninstall: true }), /invalid checkout ownership receipt/);
    for (const file of f.files) assert.equal(fs.readFileSync(file.target, "utf8"), file.text);
  }
});

test("uninstall never creates missing directories, accepts overrides, and refuses invalid CLI combinations", (t) => {
  const f = fixture(t);
  assert.equal(f.run({ uninstall: true }), 0);
  assert.deepEqual(fs.readdirSync(f.root), []);
  for (const args of [
    ["--uninstall", "--plugin"],
    ["--uninstall", "--uninstall"],
    ["--uninstall", "--force"],
    ["--check", "--check"],
  ]) {
    const result = f.cli(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^usage: node install\.mjs/);
  }
  assert.throws(() => f.run({ uninstall: true, plugin: true }), /cannot be combined/);
  for (const name of Object.keys(f.env))
    assert.throws(
      () => f.run({ uninstall: true, env: { ...f.env, [name]: "relative" } }),
      /must be an absolute path/,
    );
  assert.deepEqual(fs.readdirSync(f.root), []);
});

for (const operation of [
  {},
  { check: true },
  { uninstall: true },
  { uninstall: true, check: true },
]) {
  test(`redirected directories and hardlinked definitions are refused before mutation ${JSON.stringify(operation)}`, (t) => {
    const f = fixture(t);
    assert.equal(f.run(), 0);
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    const link = path.join(f.root, "redirected");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    for (const name of Object.keys(f.env))
      assert.throws(
        () => f.run({ ...operation, env: { ...f.env, [name]: path.join(link, "nested") } }),
        /unsafe installation target/,
      );
    assert.deepEqual(fs.readdirSync(outside), []);
    const target = f.files.at(-1).target;
    const hardlink = path.join(outside, "shared.md");
    fs.linkSync(target, hardlink);
    assert.throws(() => f.run(operation), /unsafe installation target/);
    for (const file of f.files) assert.equal(fs.readFileSync(file.target, "utf8"), file.text);
  });
}

test("symbolic-link definitions and hardlinked receipts refuse uninstall", (t) => {
  const f = fixture(t);
  assert.equal(f.run(), 0);
  const receipt = f.receipts()[0];
  const linked = path.join(f.root, "receipt-link.json");
  fs.linkSync(receipt, linked);
  assert.throws(() => f.run({ uninstall: true }), /unsafe installation target/);
  fs.unlinkSync(linked);
  const file = f.files.at(-1);
  const external = path.join(f.root, "external.md");
  fs.renameSync(file.target, external);
  try {
    fs.symlinkSync(external, file.target, "file");
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    fs.renameSync(external, file.target);
    t.diagnostic(
      "file symlinks unavailable without Windows privilege; junction and hardlink cases still run",
    );
    return;
  }
  assert.throws(() => f.run({ uninstall: true }), /unsafe installation target/);
  assert.equal(fs.readFileSync(external, "utf8"), file.text);
  for (const item of f.files.slice(0, -1))
    assert.equal(fs.readFileSync(item.target, "utf8"), item.text);
});

test("source-tree overrides are refused before writes or removals", (t) => {
  const f = fixture(t);
  for (const options of [{}, { uninstall: true }])
    for (const name of Object.keys(f.env))
      assert.throws(
        () => f.run({ ...options, env: { ...f.env, [name]: path.join(SOURCE, "agents") } }),
        /outside the source tree/,
      );
});

test("a definition changed after preview planning is preserved on removal", (t) => {
  const f = fixture(t);
  assert.equal(f.run(), 0);
  const changed = f.files[1].target;
  assert.throws(
    () =>
      f.run({
        uninstall: true,
        write: (line) => {
          if (line === `removed ${f.files[0].target}`)
            fs.appendFileSync(changed, "\nconcurrent edit\n");
        },
      }),
    /destination changed; refusing removal/,
  );
  assert.ok(fs.readFileSync(changed, "utf8").endsWith("concurrent edit\n"));
  assert.equal(f.receipts().length, 2);
});

for (const kind of ["definition", "receipt"])
  for (const replacement of ["junction", "directory", "leaf", "edit"])
    test(`uninstall refuses ${kind} ${replacement} replacement after its final read closes`, (t) => {
      const f = fixture(t);
      assert.equal(f.run(), 0);
      const receipt = f.receipts()[0];
      const file =
        kind === "definition"
          ? f.files[0]
          : { target: receipt, text: fs.readFileSync(receipt, "utf8") };
      const originalStat = fs.lstatSync(file.target);
      const dir = path.dirname(file.target);
      const displaced = path.join(f.root, "displaced-agents");
      const outside = path.join(f.root, "foreign-agents");
      fs.mkdirSync(outside);
      const foreign = path.join(outside, path.basename(file.target));
      fs.writeFileSync(foreign, "foreign definition must survive\n");
      const open = fs.openSync,
        close = fs.closeSync;
      const watched = new Set();
      let reads = 0;
      let swapped = false;
      t.mock.method(fs, "openSync", (target, ...args) => {
        const fd = open(target, ...args);
        if (target === file.target) watched.add(fd);
        return fd;
      });
      t.mock.method(fs, "closeSync", (fd) => {
        const targetRead = watched.delete(fd);
        close(fd);
        // Planning reads once; removal reads once more, then closes its fd.
        if (!targetRead || ++reads !== 2) return;
        swapped = true;
        if (replacement === "junction") {
          fs.renameSync(dir, displaced);
          fs.symlinkSync(outside, dir, process.platform === "win32" ? "junction" : "dir");
        } else if (replacement === "directory") {
          const ancestor = path.dirname(dir);
          fs.renameSync(ancestor, displaced);
          fs.mkdirSync(ancestor);
          // Move its containing directory, preserving every leaf stat field.
          // Only the higher ancestor's identity changes.
          fs.renameSync(path.join(displaced, path.basename(dir)), dir);
        } else if (replacement === "leaf") {
          fs.renameSync(file.target, path.join(outside, "original.md"));
          fs.writeFileSync(file.target, file.text);
        } else {
          fs.appendFileSync(file.target, "\nlate user edit\n");
        }
      });
      assert.throws(
        () => f.run({ uninstall: true }),
        /unsafe installation target|destination changed; refusing removal/,
      );
      assert.ok(swapped, "fault injection ran after the removal read closed");
      assert.equal(fs.readFileSync(foreign, "utf8"), "foreign definition must survive\n");
      assert.equal(
        fs.readFileSync(file.target, "utf8"),
        replacement === "junction"
          ? "foreign definition must survive\n"
          : file.text + (replacement === "edit" ? "\nlate user edit\n" : ""),
      );
      if (replacement === "directory") {
        const after = fs.lstatSync(file.target);
        for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"])
          assert.equal(after[field], originalStat[field], `leaf ${field} stayed unchanged`);
      }
      // Remove the alias explicitly so fixture cleanup cannot traverse it.
      if (replacement === "junction") {
        fs.unlinkSync(dir);
        fs.renameSync(displaced, dir);
      }
    });
