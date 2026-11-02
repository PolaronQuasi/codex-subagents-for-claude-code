import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { workspace } from "./support/workspace-fixture.mjs";
import {
  snapshotFiles,
  compareSnapshotFiles,
  snapshotControl,
  unchangedControl,
} from "../src/verification/files.mjs";

const originalId = 2n ** 53n;
const replacementId = originalId + 1n;

function withIdentity(stat, options, ino) {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
    ino: options?.bigint ? ino : Number(ino),
  });
}

test("verification distinguishes snapshot root IDs that round to the same number", async (t) => {
  const f = workspace(t);
  assert.equal(Number(originalId), Number(replacementId));
  let replaced = false;
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file, options) => {
    const stat = lstat(file, options);
    return file === f.work
      ? withIdentity(stat, options, replaced ? replacementId : originalId)
      : stat;
  });
  const before = await snapshotFiles(f.work);
  replaced = true;
  const after = await snapshotFiles(f.work);
  assert.deepEqual(compareSnapshotFiles(before, after).mutations, [
    "snapshot root identity changed",
  ]);
});

for (const phase of ["opening", "reading"]) {
  test(`verification rejects rounded file-ID collisions while ${phase} unchanged bytes`, async (t) => {
    const f = workspace(t);
    const file = path.join(f.work, "file.txt");
    fs.writeFileSync(file, "unchanged");
    const lstat = fs.lstatSync;
    const fstat = fs.fstatSync;
    let reads = 0;
    t.mock.method(fs, "lstatSync", (candidate, options) => {
      const stat = lstat(candidate, options);
      if (candidate !== file) return stat;
      const ino = phase === "reading" && reads++ > 0 ? replacementId : originalId;
      return withIdentity(stat, options, ino);
    });
    t.mock.method(fs, "fstatSync", (fd, options) =>
      withIdentity(fstat(fd, options), options, phase === "opening" ? replacementId : originalId),
    );
    await assert.rejects(
      snapshotFiles(f.work),
      phase === "opening" ? /identity changed while opening/ : /file changed during comparison/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "unchanged");
  });
}

for (const changedIdentity of ["directory", "file"]) {
  test(`verification detects rounded Git control ${changedIdentity} ID collisions`, (t) => {
    const f = workspace(t);
    const common = path.join(f.root, "repo.git");
    const directory = path.join(common, "worktrees", "verify");
    const link = path.join(f.work, ".git");
    const commit = "a".repeat(40);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(link, `gitdir: ${directory}\n`);
    fs.writeFileSync(path.join(directory, "HEAD"), `${commit}\n`);
    fs.writeFileSync(path.join(directory, "gitdir"), `${link}\n`);
    fs.writeFileSync(path.join(directory, "commondir"), "../..\n");
    const target = changedIdentity === "directory" ? fs.realpathSync.native(directory) : link;
    let replaced = false;
    const lstat = fs.lstatSync;
    t.mock.method(fs, "lstatSync", (file, options) => {
      const stat = lstat(file, options);
      return file === target
        ? withIdentity(stat, options, replaced ? replacementId : originalId)
        : stat;
    });
    const before = snapshotControl(f.work, common, commit);
    assert.equal(unchangedControl(before), true);
    replaced = true;
    assert.equal(unchangedControl(before), false, "unchanged bytes cannot prove file identity");
  });
}
