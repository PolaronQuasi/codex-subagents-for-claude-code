import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { inspectTargetFile } from "../../src/shared/install-paths.mjs";
import { install, isReadOnly } from "../../tools/release.mjs";
import { ERRNO, EXIT } from "../../src/shared/errors.mjs";
import { IS_WINDOWS, scratch, devCopy, installEnv } from "../support/release-fixture.mjs";

const put = (root, name, bytes) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
};

test(
  "system directory aliases preserve target spelling and inspect the entire physical path",
  { skip: IS_WINDOWS },
  (t) => {
    const directory = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
    const link = { ...directory, isSymbolicLink: () => true, uid: 0 };
    const regular = { ...directory, isDirectory: () => false, isFile: () => true, nlink: 1 };
    const entries = new Map();
    const destinations = new Map();
    const visited = [];
    t.mock.method(fs, "lstatSync", (file) => {
      visited.push(file);
      if (!entries.has(file)) throw Object.assign(new Error("missing"), { code: ERRNO.ENOENT });
      return entries.get(file);
    });
    t.mock.method(fs, "readlinkSync", (file) => destinations.get(file));
    for (const name of ["var", "tmp", "etc"]) {
      const alias = `/${name}`;
      const physical = `/private/${name}`;
      const target = `${alias}/target`;
      entries.clear();
      entries.set(alias, link);
      entries.set("/private", directory);
      entries.set(physical, directory);
      entries.set(`${physical}/target`, directory);
      entries.set(`${physical}/target/file`, regular);
      for (const destination of [physical, physical.slice(1)]) {
        destinations.set(alias, destination);
        visited.length = 0;
        assert.deepEqual(inspectTargetFile(target, "file"), {
          file: `${target}/file`,
          stat: regular,
        });
        assert.deepEqual(visited, [
          alias,
          "/private",
          physical,
          `${physical}/target`,
          `${physical}/target/file`,
        ]);
        assert.deepEqual(inspectTargetFile(target, "missing/leaf"), {
          file: `${target}/missing/leaf`,
          stat: null,
        });
      }
      const refused = (label) =>
        assert.equal(inspectTargetFile(target, "file"), null, `${alias}: ${label}`);
      for (const destination of [
        "/elsewhere",
        "/private/other/../" + name,
        physical + "/",
        "../private/" + name,
      ]) {
        destinations.set(alias, destination);
        refused("unexpected alias destination");
      }
      destinations.set(alias, physical);
      entries.set(alias, { ...link, uid: 501 });
      refused("alias is not owned by root");
      entries.set(alias, link);
      for (const ancestor of ["/private", physical, `${physical}/target`]) {
        for (const unsafe of [link, regular]) {
          entries.set(ancestor, unsafe);
          refused("unsafe physical ancestor " + ancestor);
        }
        entries.set(ancestor, directory);
      }
      for (const unsafe of [link, directory, { ...regular, nlink: 2 }]) {
        entries.set(`${physical}/target/file`, unsafe);
        refused("unsafe leaf");
      }
      entries.set(`${physical}/target/file`, regular);
      assert.equal(inspectTargetFile("/", name), null, "an alias is never a writable leaf");
      entries.set("/custom", link);
      destinations.set("/custom", physical);
      assert.equal(
        inspectTargetFile("/custom/target", "file"),
        null,
        "arbitrary root aliases are refused",
      );
    }
  },
);

test("install freezes current source and target ignores before replacing root and nested .gitignore files", (t) => {
  const root = scratch(t);
  const source = path.join(root, "source"),
    target = path.join(root, "target");
  devCopy(source, "9.9.9");
  put(source, ".gitignore", "docs/source-only.md\n");
  put(source, "docs/.gitignore", "");
  put(target, ".gitignore", "docs/root-private.md\n");
  put(target, "docs/.gitignore", "nested-private.md\n");
  for (const name of ["source-only.md", "root-private.md", "nested-private.md"]) {
    put(source, `docs/${name}`, "source bytes\n");
    const local = put(target, `docs/${name}`, "customized bytes\n");
    fs.chmodSync(local, 0o444);
  }
  assert.equal(
    install({ fromDir: source, target, env: installEnv(root), write() {} }),
    EXIT.COMPLETED,
  );
  assert.equal(fs.readFileSync(path.join(target, ".gitignore"), "utf8"), "docs/source-only.md\n");
  assert.equal(fs.readFileSync(path.join(target, "docs/.gitignore"), "utf8"), "");
  for (const name of ["source-only.md", "root-private.md", "nested-private.md"]) {
    const local = path.join(target, "docs", name);
    assert.equal(fs.readFileSync(local, "utf8"), "customized bytes\n");
    assert.equal(isReadOnly(local), true);
  }
});

test("install preserves unrelated user files and directories through preflight, copy failure and successful activation", (t) => {
  const root = scratch(t);
  const source = path.join(root, "source"),
    target = path.join(root, "target");
  devCopy(source, "9.9.9");
  const user = put(target, "personal-notes/user.md", "customized bytes\n");
  fs.chmodSync(user, 0o444);
  fs.mkdirSync(path.join(target, "empty-user-folder"));
  const entry = path.join(source, "run-codex-task.mjs");
  const bytes = fs.readFileSync(entry);
  fs.unlinkSync(entry);
  const options = { fromDir: source, target, env: installEnv(root), write() {} };
  assert.throws(() => install(options), /has no run-codex-task.mjs/);
  assert.equal(fs.existsSync(path.join(target, "dist")), false);
  fs.writeFileSync(entry, bytes);
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (file === path.join(target, "docs/MANUAL.md")) throw new Error("source copy denied");
    return write(file, ...args);
  });
  assert.throws(() => install(options), /source copy denied/);
  assert.equal(fs.existsSync(path.join(target, "dist/current")), false);
  assert.equal(fs.readFileSync(user, "utf8"), "customized bytes\n");
  t.mock.restoreAll();
  assert.equal(install(options), EXIT.COMPLETED);
  assert.equal(fs.readFileSync(user, "utf8"), "customized bytes\n");
  assert.equal(isReadOnly(user), true);
  assert.deepEqual(fs.readdirSync(path.join(target, "empty-user-folder")), []);
});

test("install refuses a junction in a copied target's ancestors before writing any external or target file", (t) => {
  const root = scratch(t);
  const source = path.join(root, "source");
  devCopy(source, "9.9.9");
  const outside = path.join(root, "outside");
  put(outside, "MANUAL.md", "external user bytes\n");
  const target = path.join(root, "target");
  fs.mkdirSync(target);
  const linkType = IS_WINDOWS ? "junction" : "dir";
  fs.symlinkSync(outside, path.join(target, "docs"), linkType);
  assert.throws(
    () => install({ fromDir: source, target, env: installEnv(root), write() {} }),
    /unsafe installation target/,
  );
  assert.equal(fs.readFileSync(path.join(outside, "MANUAL.md"), "utf8"), "external user bytes\n");
  assert.deepEqual(fs.readdirSync(target), ["docs"], "preflight made no changes");
  const alias = path.join(root, "alias");
  fs.symlinkSync(target, alias, linkType);
  for (const destination of [alias, path.join(alias, "nested")]) {
    assert.throws(
      () => install({ fromDir: source, target: destination, env: installEnv(root), write() {} }),
      /unsafe installation target/,
    );
  }
  assert.deepEqual(fs.readdirSync(target), ["docs"]);
});

test("current installation targets reject escaping names, nonregular leaves, symlinks and hard links before any write", (t) => {
  const root = scratch(t);
  const source = path.join(root, "source");
  devCopy(source, "9.9.9");
  for (const name of [
    "../escape",
    "docs/../../escape",
    "/absolute",
    "docs\\file",
    "drive:file",
    "docs/./file",
    "docs//file",
  ]) {
    assert.equal(inspectTargetFile(root, name), null, name);
  }
  const external = put(root, "external.md", "external user bytes\n");
  fs.chmodSync(external, 0o444);
  const destinations = [
    "docs/MANUAL.md",
    "run-codex-task.mjs",
    "dist/current",
    "releases/v9.9.9.json",
  ];
  for (const [index, name] of destinations.entries()) {
    const target = path.join(root, `hardlink-${index}`);
    const file = path.join(target, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.linkSync(external, file);
    const before = fs.readdirSync(target, { recursive: true });
    assert.throws(
      () => install({ fromDir: source, target, env: installEnv(root), write() {} }),
      /unsafe installation target/,
    );
    assert.deepEqual(fs.readdirSync(target, { recursive: true }), before);
    assert.equal(fs.readFileSync(external, "utf8"), "external user bytes\n");
    assert.equal(isReadOnly(external), true);
  }
  const directoryTarget = path.join(root, "directory-leaf");
  fs.mkdirSync(path.join(directoryTarget, "docs/MANUAL.md"), { recursive: true });
  assert.throws(
    () => install({ fromDir: source, target: directoryTarget, env: installEnv(root), write() {} }),
    /unsafe installation target/,
  );
  const target = path.join(root, "file-link");
  const file = path.join(target, "docs/MANUAL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.symlinkSync(external, file, "file");
  } catch (error) {
    assert.ok(IS_WINDOWS && error.code === ERRNO.EPERM, error.message);
    t.diagnostic("file symlink creation unavailable; hard-link and directory cases still ran");
    return;
  }
  assert.throws(
    () => install({ fromDir: source, target, env: installEnv(root), write() {} }),
    /unsafe installation target/,
  );
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.equal(fs.readFileSync(external, "utf8"), "external user bytes\n");
  assert.equal(isReadOnly(external), true);
});
