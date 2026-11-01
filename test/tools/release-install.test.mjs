// install: the release it publishes under dist/, its steps and their failure boundaries, the
// manifest it writes, and the bits and hooks it sets up.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initRepository } from "../support/git-environment.mjs";
import {
  flipPointer,
  install,
  isReadOnly,
  readPointer,
  ROOT,
  runnerVersion,
  setup,
  sha256,
} from "../../tools/release.mjs";
import { ROLES } from "../../run-codex-task.mjs";
import { byCodeUnit } from "../../tools/distribution.mjs";
import { ERRNO, EXIT } from "../../src/shared/errors.mjs";
import {
  IS_WINDOWS,
  RUNNER,
  stub,
  node,
  scratch,
  IDENTITY,
  gitIn,
  lines,
  modules,
  versionModule,
  devCopy,
  installEnv,
  hashOf,
} from "../support/release-fixture.mjs";

test("manifest replacement failure keeps old JSON, cleans its stage and leaves the activated release current", (t) => {
  const root = scratch(t);
  const source = path.join(root, "dev"),
    target = path.join(root, "live");
  devCopy(source, "9.9.9");
  const dir = path.join(target, "releases");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "v9.9.9.json");
  const previous = '{"previous":true}\n';
  fs.writeFileSync(file, previous);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === file) {
      assert.equal(fs.readFileSync(file, "utf8"), previous);
      assert.equal(JSON.parse(fs.readFileSync(from, "utf8")).version, "9.9.9");
      throw new Error("manifest rename denied");
    }
    return rename(from, to);
  });
  assert.throws(
    () => install({ fromDir: source, target, env: installEnv(root), write() {} }),
    /manifest rename denied/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), previous);
  assert.deepEqual(fs.readdirSync(dir), ["v9.9.9.json"]);
  assert.match(readPointer(target), /^9\.9\.9-/);
});

test("install publishes the modules as a read-only release under dist/, flips the pointer, replaces the entry, copies the sources, renders the agents and writes a manifest", (t) => {
  const root = scratch(t);
  const source = path.join(root, "dev"),
    target = path.join(root, "live");
  devCopy(source, "9.9.9");
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(source, "test", "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(source, "test", "sample.test.mjs"), "// sample\n");
  fs.writeFileSync(path.join(source, "test", "fixtures", "sample.mjs"), "// fixture\n");
  fs.mkdirSync(path.join(source, "docs", "diagrams"));
  fs.writeFileSync(path.join(source, "docs", "diagrams", "README.md"), "# Diagrams\n");
  fs.writeFileSync(path.join(source, ".prettierrc.json"), '{ "printWidth": 100 }\n');
  fs.writeFileSync(path.join(target, "custom-notes.md"), "user notes\n");
  fs.chmodSync(path.join(target, "custom-notes.md"), 0o444);
  // The live folder holds a one-file runner, read-only.
  fs.writeFileSync(path.join(target, RUNNER), stub("9.8.0"));
  fs.chmodSync(path.join(target, RUNNER), 0o444);
  // A read-only file in the target that the release changes, and one it leaves alone.
  fs.mkdirSync(path.join(source, "tools"), { recursive: true });
  fs.mkdirSync(path.join(target, "tools"));
  fs.writeFileSync(path.join(source, "tools", "changed.md"), "new\n");
  fs.writeFileSync(path.join(target, "tools", "changed.md"), "old\n");
  fs.chmodSync(path.join(target, "tools", "changed.md"), 0o444);
  fs.writeFileSync(path.join(source, "tools", "same.md"), "same\n");
  fs.writeFileSync(path.join(target, "tools", "same.md"), "same\n");
  fs.chmodSync(path.join(target, "tools", "same.md"), 0o444);
  const env = installEnv(root);
  const out = lines();
  assert.equal(install({ fromDir: source, target, env, write: out.write }), 0, out.text());
  const id = readPointer(target);
  assert.match(
    id,
    /^9\.9\.9-[0-9a-f]{7}$/,
    "a copy that is no git checkout is named after its content",
  );
  const release = path.join(target, "dist", id, "src");
  assert.deepEqual(
    fs
      .readdirSync(release, { recursive: true })
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => name.split(path.sep).join("/"))
      .sort(),
    modules(),
    "every module is installed",
  );
  for (const name of modules())
    assert.equal(isReadOnly(path.join(release, name)), true, `${name} is read-only`);
  assert.equal(runnerVersion(path.join(release, "version.mjs")), "9.9.9");
  for (const name of ["LICENSE", "NOTICE"]) {
    const bytes = fs.readFileSync(path.join(source, name));
    assert.deepEqual(fs.readFileSync(path.join(target, name)), bytes);
    assert.deepEqual(fs.readFileSync(path.join(release, "..", name)), bytes);
    assert.equal(isReadOnly(path.join(release, "..", name)), true);
  }
  assert.equal(
    fs.readFileSync(path.join(target, RUNNER), "utf8"),
    fs.readFileSync(path.join(ROOT, RUNNER), "utf8"),
    "the entry is the copy's",
  );
  assert.equal(isReadOnly(path.join(target, RUNNER)), true);
  const help = node([path.join(target, RUNNER), "--help"]);
  assert.equal(help.status, EXIT.COMPLETED, help.stderr);
  assert.match(
    help.stdout,
    /^run-codex-task 9\.9\.9\n/,
    "the installed entry runs the release the pointer names",
  );
  assert.equal(
    fs.readFileSync(path.join(target, "src", "version.mjs"), "utf8"),
    versionModule("9.9.9"),
    "src/ is copied too, for a clone without a pointer",
  );
  assert.equal(
    fs.readFileSync(path.join(target, "README.md"), "utf8"),
    "# dev copy (runner 9.9.9)\n",
  );
  assert.equal(
    fs.readFileSync(path.join(target, "docs", "MANUAL.md"), "utf8"),
    "# manual\n",
    "docs/ is released too",
  );
  assert.equal(
    fs.readFileSync(path.join(target, "docs", "diagrams", "README.md"), "utf8"),
    "# Diagrams\n",
  );
  assert.equal(
    fs.readFileSync(path.join(target, ".prettierrc.json"), "utf8"),
    '{ "printWidth": 100 }\n',
    "the formatting settings the package scripts rely on are released too",
  );
  assert.equal(
    fs.readFileSync(path.join(target, "tools", "changed.md"), "utf8"),
    "new\n",
    "a read-only file that changed is replaced",
  );
  assert.equal(
    isReadOnly(path.join(target, "tools", "same.md")),
    true,
    "an unchanged file is not touched",
  );
  assert.ok(fs.existsSync(path.join(target, "claude", "agents", "forwarder.template.md")));
  const installedAgents = fs.readdirSync(path.join(root, "agents")).sort();
  const receipts = installedAgents.filter((name) =>
    /^\.codex-subagents-install-[0-9a-f]{64}\.json$/.test(name),
  );
  assert.equal(receipts.length, 1, "one ownership receipt accompanies the definitions");
  assert.deepEqual(
    installedAgents,
    [...Object.keys(ROLES).map((role) => `${role}.md`), ...receipts].sort(),
    "one agent per role and only its ownership receipt",
  );
  assert.ok(fs.existsSync(path.join(root, "skill", "SKILL.md")));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(target, "releases", "v9.9.9.json"), "utf8"),
  );
  assert.equal(manifest.version, "9.9.9");
  assert.equal(manifest.release, id);
  assert.equal(manifest.commit, null);
  assert.equal(manifest.entrySha256, sha256(path.join(target, RUNNER)));
  assert.deepEqual(
    Object.keys(manifest.files).sort(),
    [...modules().map((name) => `src/${name}`), "LICENSE", "NOTICE"].sort(),
  );
  assert.equal(manifest.files["src/version.mjs"], sha256(path.join(release, "version.mjs")));
  assert.equal(manifest.node, process.version);
  assert.equal(
    fs.readFileSync(path.join(target, "custom-notes.md"), "utf8"),
    "user notes\n",
    "unrelated user files are preserved",
  );
  assert.equal(isReadOnly(path.join(target, "custom-notes.md")), true);
  assert.deepEqual(Object.keys(manifest.tests), [
    "test/fixtures/sample.mjs",
    "test/sample.test.mjs",
  ]);
  for (const [name, digest] of Object.entries(manifest.tests))
    assert.equal(digest, sha256(path.join(target, name)));
  assert.equal("host" in manifest, false, "a manifest names no machine");
  assert.match(out.text(), /release 9\.9\.9-[0-9a-f]{7}: \d+ files installed read-only/);
  assert.match(out.text(), /replaced .*run-codex-task\.mjs sha256=[0-9a-f]{12} read-only=true/);
  assert.match(out.text(), /pointer dist\/current: - -> 9\.9\.9-[0-9a-f]{7}/);
  // The same copy again: the release folder is reused and the entry is left alone, all of
  // them read-only again even when someone made them writable meanwhile.
  for (const file of [
    path.join(release, "delivery", "usage.mjs"),
    path.join(release, "..", "LICENSE"),
    path.join(target, RUNNER),
  ])
    fs.chmodSync(file, 0o644);
  const again = lines();
  assert.equal(install({ fromDir: source, target, env, write: again.write }), 0, again.text());
  assert.match(again.text(), /already under dist\/, reused/);
  assert.match(again.text(), /entry .* unchanged read-only=true/);
  assert.equal(readPointer(target), id);
  for (const name of [...modules().map((module) => `src/${module}`), "LICENSE", "NOTICE"])
    assert.equal(isReadOnly(path.join(release, "..", name)), true, `${name} is read-only again`);
  assert.equal(isReadOnly(path.join(target, RUNNER)), true);
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "9.9.8" }));
  assert.throws(
    () => install({ fromDir: source, target, env, write: () => {} }),
    /disagree on the version/,
  );
  assert.throws(
    () => install({ fromDir: target, target, env, write: () => {} }),
    /is the target itself/,
  );
  assert.throws(() => install({ target, env, write: () => {} }), /needs --from-dir/);
});

test("Apache releases require their license and notice-only changes publish a distinct immutable bundle", (t) => {
  const root = scratch(t),
    source = path.join(root, "dev"),
    target = path.join(root, "live");
  devCopy(source, "9.9.9");
  const env = installEnv(root);
  fs.unlinkSync(path.join(source, "LICENSE"));
  assert.throws(
    () => install({ fromDir: source, target, env, write: () => {} }),
    /missing LICENSE/,
  );
  assert.equal(readPointer(target), null);
  fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(source, "LICENSE"));
  install({ fromDir: source, target, env, write: () => {} });
  const first = readPointer(target);
  const original = fs.readFileSync(path.join(target, "dist", first, "NOTICE"));
  fs.appendFileSync(
    path.join(source, "NOTICE"),
    "\nAdditional attribution for the test fixture.\n",
  );
  install({ fromDir: source, target, env, write: () => {} });
  const next = readPointer(target);
  assert.notEqual(next, first, "legal-file bytes participate in the release digest");
  assert.deepEqual(fs.readFileSync(path.join(target, "dist", first, "NOTICE")), original);
  assert.deepEqual(
    fs.readFileSync(path.join(target, "dist", next, "NOTICE")),
    fs.readFileSync(path.join(source, "NOTICE")),
  );
});

test("staged imports, required exports and version are checked before any activation", async (t) => {
  const { REQUIRED_EXPORTS } = await import("../../tools/check-stage.mjs");
  const sourceExports = await import("../../src/index.mjs");
  assert.deepEqual(Object.keys(REQUIRED_EXPORTS).sort(), Object.keys(sourceExports).sort());
  const root = scratch(t);
  const target = path.join(root, "live");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, RUNNER), "old entry\n");
  flipPointer(target, "1.0.0-aaaaaaa");
  for (const [name, change, expected] of [
    [
      "import",
      (source) =>
        fs.appendFileSync(path.join(source, "src", "index.mjs"), 'import "./missing.mjs";\n'),
      /fails import check:.*missing/s,
    ],
    [
      "export",
      (source) => {
        const file = path.join(source, "src", "index.mjs");
        fs.writeFileSync(
          file,
          fs.readFileSync(file, "utf8").replace("export { main }", "export { main as wrong }"),
        );
      },
      /required export main/,
    ],
    [
      "version",
      (source) => {
        const file = path.join(source, "src", "index.mjs");
        fs.writeFileSync(
          file,
          fs
            .readFileSync(file, "utf8")
            .replace(
              'export { RUNNER_VERSION } from "./version.mjs";',
              'export const RUNNER_VERSION = "0.0.0";',
            ),
        );
      },
      /RUNNER_VERSION is 0\.0\.0, expected 9\.9\.9/,
    ],
  ]) {
    const source = path.join(root, name);
    devCopy(source, "9.9.9");
    change(source);
    assert.throws(
      () => install({ fromDir: source, target, env: installEnv(root), write: () => {} }),
      expected,
    );
    assert.equal(readPointer(target), "1.0.0-aaaaaaa");
    assert.equal(fs.readFileSync(path.join(target, RUNNER), "utf8"), "old entry\n");
    assert.deepEqual(
      fs.readdirSync(path.join(target, "dist")),
      ["current"],
      "failed staging is discarded",
    );
  }
});

test("post-activation installer failure leaves the new release active", (t) => {
  const root = scratch(t),
    source = path.join(root, "dev"),
    target = path.join(root, "live");
  devCopy(source, "9.9.9");
  fs.mkdirSync(target);
  fs.writeFileSync(
    path.join(source, "install.mjs"),
    'throw new Error("injected installer failure");\n',
  );
  assert.throws(
    () => install({ fromDir: source, target, env: installEnv(root), write: () => {} }),
    /injected installer failure/,
  );
  assert.match(readPointer(target), /^9\.9\.9-/);
  assert.equal(node([path.join(target, RUNNER), "--help"]).status, 0);
  assert.equal(fs.existsSync(path.join(target, "releases", "v9.9.9.json")), false);
});

test("install's steps fail at their boundaries as their comments say: a failed copy leaves the new release inert, a failed entry keeps the old one, a refused pointer flip keeps the previous release current", (t) => {
  const root = scratch(t);
  const env = installEnv(root);
  const old = path.join(root, "old"),
    next = path.join(root, "next");
  devCopy(old, "9.9.8");
  devCopy(next, "9.9.9");
  // Each case starts from a target where 9.9.8 is installed.
  const installed = (name) => {
    const target = path.join(root, name);
    assert.equal(install({ fromDir: old, target, env, write() {} }), EXIT.COMPLETED);
    return { target, id: readPointer(target), entry: fs.readFileSync(path.join(target, RUNNER)) };
  };
  const text = (target, name) => fs.readFileSync(path.join(target, name), "utf8");
  const releases = (target) => fs.readdirSync(path.join(target, "dist")).sort();
  // Stage: the copy of the other sources fails partway (at package.json, after README.md).
  let { target, id, entry } = installed("copy-fails");
  const write = fs.writeFileSync;
  const copying = t.mock.method(fs, "writeFileSync", (file, ...rest) => {
    if (file === path.join(target, "package.json")) throw new Error("copy refused");
    return write(file, ...rest);
  });
  assert.throws(() => install({ fromDir: next, target, env, write() {} }), /copy refused/);
  copying.mock.restore();
  assert.equal(readPointer(target), id, "the previous release stays current");
  assert.deepEqual(fs.readFileSync(path.join(target, RUNNER)), entry);
  const staged = releases(target).filter((name) => name.startsWith("9.9.9-"));
  assert.equal(staged.length, 1, "the new release folder is published, inert");
  assert.equal(text(target, "README.md"), "# dev copy (runner 9.9.9)\n", "copied so far");
  assert.match(text(target, "package.json"), /"version":"9\.9\.8"/, "not copied");
  assert.equal(fs.existsSync(path.join(target, "releases", "v9.9.9.json")), false);
  // Activate: an entry that fails node --check keeps the old entry and pointer.
  ({ target, id, entry } = installed("entry-fails"));
  const broken = path.join(root, "broken");
  devCopy(broken, "9.9.9");
  fs.writeFileSync(path.join(broken, RUNNER), "export const = ;\n");
  assert.throws(
    () => install({ fromDir: broken, target, env, write() {} }),
    /staged runner fails node --check/,
  );
  assert.equal(readPointer(target), id);
  assert.deepEqual(fs.readFileSync(path.join(target, RUNNER)), entry);
  assert.equal(isReadOnly(path.join(target, RUNNER)), true);
  assert.equal(fs.existsSync(path.join(target, "run-codex-task.next.mjs")), false);
  assert.equal(text(target, "README.md"), "# dev copy (runner 9.9.9)\n", "the stage was done");
  assert.equal(fs.existsSync(path.join(target, "releases", "v9.9.9.json")), false);
  // Activate: a pointer flip refused even after its retries keeps the previous
  // release current, with the new entry in place, and runs it.
  ({ target, id, entry } = installed("pointer-fails"));
  const changed = path.join(root, "changed");
  devCopy(changed, "9.9.9");
  fs.appendFileSync(path.join(changed, RUNNER), "// a changed entry\n");
  const pointer = path.join(target, "dist", "current");
  const rename = fs.renameSync;
  const flipping = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === pointer) throw Object.assign(new Error("pointer busy"), { code: ERRNO.EPERM });
    return rename(from, to);
  });
  assert.throws(
    () => install({ fromDir: changed, target, env, write() {} }),
    /could not flip dist\/current to 9\.9\.9-[0-9a-f]{7}: pointer busy; the previous release stays current/,
  );
  flipping.mock.restore();
  assert.equal(readPointer(target), id);
  assert.deepEqual(
    fs.readFileSync(path.join(target, RUNNER)),
    fs.readFileSync(path.join(changed, RUNNER)),
    "the new entry is in place",
  );
  assert.deepEqual(
    releases(target).filter((name) => name.startsWith("current")),
    ["current"],
    "no pointer stage is left",
  );
  const help = node([path.join(target, RUNNER), "--help"]);
  assert.match(help.stdout, /^run-codex-task 9\.9\.8\n/, "the new entry runs the previous release");
  assert.equal(fs.existsSync(path.join(target, "releases", "v9.9.9.json")), false);
});

test("install refuses a copy without its entry in preflight: nothing in dist/ or in the target changes", (t) => {
  const root = scratch(t);
  const env = installEnv(root);
  const old = path.join(root, "old"),
    copy = path.join(root, "copy");
  devCopy(old, "9.9.8");
  devCopy(copy, "9.9.9");
  fs.rmSync(path.join(copy, RUNNER));
  const target = path.join(root, "live");
  assert.equal(install({ fromDir: old, target, env, write() {} }), EXIT.COMPLETED);
  // Every file of the target, dist/ included, with its bytes.
  const contents = () =>
    Object.fromEntries(
      fs
        .readdirSync(target, { recursive: true })
        .map((name) => path.join(target, name))
        .filter((file) => fs.lstatSync(file).isFile())
        .map((file) => [path.relative(target, file), hashOf(fs.readFileSync(file))])
        .sort(([a], [b]) => byCodeUnit(a, b)),
    );
  const before = contents();
  const refused =
    /^Error: .+copy has no run-codex-task\.mjs, the entry a release installs; restore it first$/;
  assert.throws(() => install({ fromDir: copy, target, env, write() {} }), refused);
  assert.deepEqual(contents(), before, "dist/ and the target are as they were");
  assert.equal(
    fs.readdirSync(path.join(target, "dist")).some((name) => name.startsWith("9.9.9-")),
    false,
  );
  // A target that does not exist yet is not even created.
  const fresh = path.join(root, "fresh");
  assert.throws(() => install({ fromDir: copy, target: fresh, env, write() {} }), refused);
  assert.equal(fs.existsSync(fresh), false);
});

test("install keeps the executable bits git records on POSIX, and setup points git at the hooks and makes them executable", (t) => {
  const root = scratch(t);
  const checkout = path.join(root, "checkout");
  devCopy(checkout, "9.9.9");
  fs.mkdirSync(path.join(checkout, ".githooks"));
  for (const name of ["pre-commit", "pre-push"])
    fs.writeFileSync(path.join(checkout, ".githooks", name), "#!/bin/sh\nexit 0\n");
  const executables = [RUNNER, "install.mjs", ".githooks/pre-commit", ".githooks/pre-push"];
  const posix = !IS_WINDOWS;
  if (posix) for (const name of executables) fs.chmodSync(path.join(checkout, name), 0o755);
  initRepository(checkout, IDENTITY);
  gitIn(checkout, "add", "-A");
  gitIn(checkout, "commit", "-q", "-m", "fixture");
  const out = lines();
  assert.equal(setup({ root: checkout, write: out.write }), 0);
  assert.equal(gitIn(checkout, "config", "--get", "core.hooksPath"), ".githooks");
  if (!posix) return;
  const mode = (dir, name) => fs.statSync(path.join(dir, name)).mode & 0o777;
  for (const name of executables)
    assert.match(gitIn(checkout, "ls-files", "-s", name), /^100755 /, name);
  // An earlier install wrote this hook without its bit; the bytes are the same.
  const live = path.join(root, "live");
  fs.mkdirSync(path.join(live, ".githooks"), { recursive: true });
  fs.writeFileSync(path.join(live, ".githooks", "pre-push"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(live, ".githooks", "pre-push"), 0o644);
  assert.equal(install({ fromDir: checkout, target: live, env: installEnv(root), write() {} }), 0);
  for (const name of executables)
    assert.equal(mode(live, name) & 0o111, 0o111, `${name} is executable`);
  assert.equal(isReadOnly(path.join(live, RUNNER)), true, "the entry is read-only and executable");
  assert.equal(mode(live, "README.md") & 0o111, 0, "a file git records as 100644 is not");
  // setup gives a hook that lost its bit back.
  fs.chmodSync(path.join(checkout, ".githooks", "pre-commit"), 0o644);
  const repaired = lines();
  assert.equal(setup({ root: checkout, write: repaired.write }), 0);
  assert.equal(mode(checkout, ".githooks/pre-commit") & 0o111, 0o111);
  assert.match(
    repaired.text(),
    /^repaired \.githooks\/pre-commit: it was not executable \(mode 644, now 7[57]5\)$/m,
  );
});
