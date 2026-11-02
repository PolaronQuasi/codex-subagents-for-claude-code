import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createScratch } from "../../tools/scratch.mjs";
import { IS_WINDOWS } from "../support/release-fixture.mjs";

const parent = (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-subagents-for-claude-code-scratch-test-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test("scratch cleanup accepts equivalent native, slash and dot spellings of its parent", (t) => {
  const root = parent(t);
  for (const spelling of [root, root.replaceAll("\\", "/"), `${root}${path.sep}.`]) {
    const scratch = createScratch("codex-subagents-for-claude-code-check-", spelling);
    assert.equal(path.dirname(scratch.directory), fs.realpathSync.native(root));
    fs.writeFileSync(path.join(scratch.directory, "owned"), "temporary");
    scratch.remove();
    assert.equal(fs.existsSync(scratch.directory), false);
  }
  assert.throws(() => createScratch("../outside-", root), /invalid scratch prefix/);
});

test("scratch cleanup refuses a replacement directory while preserving both its contents and the original", (t) => {
  const root = parent(t);
  const scratch = createScratch("codex-subagents-for-claude-code-check-", root);
  const original = `${scratch.directory}-original`;
  assert.equal(path.dirname(original), fs.realpathSync.native(root));
  fs.renameSync(scratch.directory, original);
  fs.mkdirSync(scratch.directory);
  fs.writeFileSync(path.join(scratch.directory, "keep"), "replacement");
  assert.throws(() => scratch.remove(), /unexpected temporary path or identity/);
  assert.equal(fs.readFileSync(path.join(scratch.directory, "keep"), "utf8"), "replacement");
  assert.ok(fs.existsSync(original));
});

test("scratch cleanup refuses a substituted symlink or junction without following it", (t) => {
  const root = parent(t);
  const scratch = createScratch("codex-subagents-for-claude-code-check-", root);
  const other = path.join(root, "other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "keep"), "unrelated");
  fs.rmdirSync(scratch.directory);
  fs.symlinkSync(other, scratch.directory, IS_WINDOWS ? "junction" : "dir");
  assert.throws(() => scratch.remove(), /unexpected temporary path or identity/);
  assert.equal(fs.readFileSync(path.join(other, "keep"), "utf8"), "unrelated");
});

for (const changedIdentity of ["directory", "parent"]) {
  test(`scratch cleanup distinguishes large ${changedIdentity} identities that round to the same number`, (t) => {
    const root = parent(t);
    const base = fs.realpathSync.native(root);
    const prefix = "codex-subagents-for-claude-code-check-";
    const first = 2n ** 53n;
    const replacement = first + 1n;
    assert.equal(Number(first), Number(replacement), "numeric stats lose this distinction");
    let replaced = false;
    const lstat = fs.lstatSync;
    t.mock.method(fs, "lstatSync", (file, options) => {
      const stat = lstat(file, options);
      const directory = path.dirname(file) === base && path.basename(file).startsWith(prefix);
      if (file !== base && !directory) return stat;
      const changed = changedIdentity === "directory" ? directory : file === base;
      const ino = changed && replaced ? replacement : first;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        ino: options?.bigint ? ino : Number(ino),
      });
    });
    const scratch = createScratch(prefix, root);
    const original = `${scratch.directory}-original`;
    fs.renameSync(scratch.directory, original);
    fs.mkdirSync(scratch.directory);
    fs.writeFileSync(path.join(scratch.directory, "keep"), "replacement");
    replaced = true;
    assert.throws(() => scratch.remove(), /unexpected temporary path or identity/);
    assert.equal(fs.readFileSync(path.join(scratch.directory, "keep"), "utf8"), "replacement");
    assert.ok(fs.existsSync(original));
  });
}
