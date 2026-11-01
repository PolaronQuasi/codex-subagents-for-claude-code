// verify and rollback: the installed release against HEAD, flat and nested layouts, and links
// where a release file can be.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initRepository } from "../support/git-environment.mjs";
import {
  check,
  checkedFiles,
  flipPointer,
  install,
  isReadOnly,
  publishRelease,
  readPointer,
  releaseFilesFromTag,
  rollback,
  ROOT,
  verify,
} from "../../tools/release.mjs";
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
  versionModule,
  devCopy,
  installEnv,
  hashOf,
} from "../support/release-fixture.mjs";

test("verify compares the entry and the installed release with HEAD; rollback flips the pointer to a tagged current release", (t) => {
  const root = scratch(t);
  const repo = path.join(root, "live"),
    source = path.join(root, "dev");
  // The live checkout: a one-file 0.9.0 runner, then the modular 1.0.0 and 1.1.0, each committed and tagged.
  fs.mkdirSync(repo);
  initRepository(repo, IDENTITY);
  fs.writeFileSync(path.join(repo, RUNNER), stub("0.9.0"));
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "0.9.0");
  gitIn(repo, "tag", "-a", "v0.9.0", "-m", "Runner 0.9.0");
  devCopy(repo, "1.0.0");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "1.0.0");
  gitIn(repo, "tag", "-a", "v1.0.0", "-m", "Runner 1.0.0");
  fs.writeFileSync(path.join(repo, "src", "version.mjs"), versionModule("1.1.0"));
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "codex-subagents-for-claude-code", version: "1.1.0", type: "module" }),
  );
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "1.1.0");
  gitIn(repo, "tag", "-a", "v1.1.0", "-m", "Runner 1.1.0");
  devCopy(source, "1.1.0");
  const env = installEnv(root);
  assert.equal(install({ fromDir: source, target: repo, env, write: () => {} }), 0);
  const id = readPointer(repo);
  let out = lines();
  assert.equal(verify({ target: repo, write: out.write }), 0, out.text());
  assert.match(
    out.text(),
    /^live=1\.1\.0 release=1\.1\.0-[0-9a-f]{7} entry-sha256=[0-9a-f]{12} read-only=true head=[0-9a-f]+ tags=v1\.1\.0 matches-head=yes untagged=-$/,
  );
  // A manifest whose release was installed but never tagged.
  fs.writeFileSync(path.join(repo, "releases", "v1.2.0.json"), '{ "version": "1.2.0" }\n');
  out = lines();
  assert.equal(verify({ target: repo, write: out.write }), 1);
  assert.match(out.text(), /^live=1\.1\.0 .* matches-head=yes untagged=1\.2\.0$/m);
  assert.match(
    out.text(),
    /^problem: releases\/v1\.2\.0\.json has no tag v1\.2\.0: release 1\.2\.0 was installed but never tagged; tag its manifest commit \(node tools\/release\.mjs tag, run at that commit\)$/m,
  );
  fs.rmSync(path.join(repo, "releases", "v1.2.0.json"));
  const license = path.join(repo, "dist", id, "LICENSE");
  fs.chmodSync(license, 0o644);
  fs.appendFileSync(license, "changed\n");
  out = lines();
  assert.equal(verify({ target: repo, write: out.write }), 1);
  assert.match(out.text(), /LICENSE differs from HEAD/);
  fs.writeFileSync(license, fs.readFileSync(path.join(repo, "LICENSE")));
  fs.chmodSync(license, 0o444);
  // A module of the release edited in place.
  const edited = path.join(repo, "dist", id, "src", "delivery", "usage.mjs");
  fs.chmodSync(edited, 0o644);
  fs.appendFileSync(edited, "// edited\n");
  out = lines();
  assert.equal(verify({ target: repo, write: out.write }), 1);
  assert.match(out.text(), /^live=1\.1\.0 .*matches-head=no untagged=-$/m);
  assert.match(
    out.text(),
    /problem: release 1\.1\.0-[0-9a-f]{7}: src\/delivery\/usage\.mjs differs from HEAD/,
  );
  assert.match(out.text(), /problem: release .*: src\/delivery\/usage\.mjs is writable/);
  fs.writeFileSync(edited, fs.readFileSync(path.join(repo, "src", "delivery", "usage.mjs")));
  fs.chmodSync(edited, 0o444);
  // An old backup in the entry's place, as on 2026-10-23: reported, not a crash.
  fs.chmodSync(path.join(repo, RUNNER), 0o644);
  fs.writeFileSync(path.join(repo, RUNNER), "// not a runner\n");
  out = lines();
  assert.equal(verify({ target: repo, write: out.write }), 1);
  assert.match(out.text(), /problem: the entry run-codex-task\.mjs is not the committed one/);
  assert.match(out.text(), /problem: the entry run-codex-task\.mjs is writable/);
  fs.writeFileSync(path.join(repo, RUNNER), fs.readFileSync(path.join(ROOT, RUNNER)));
  fs.chmodSync(path.join(repo, RUNNER), 0o444);
  // A pointer at a missing release, an invalid pointer, no pointer at all.
  flipPointer(repo, "1.1.0-0000000");
  out = lines();
  assert.equal(verify({ target: repo, write: out.write }), 1);
  assert.match(out.text(), /^live=- release=1\.1\.0-0000000 /m);
  assert.match(
    out.text(),
    /problem: release 1\.1\.0-0000000, named by dist\/current, is missing under dist\//,
  );
  fs.writeFileSync(path.join(repo, "dist", "current"), "../../elsewhere\n");
  out = lines();
  assert.equal(verify({ target: repo, write: out.write }), 1);
  assert.match(out.text(), /problem: dist\/current names no release/);
  fs.rmSync(path.join(repo, "dist", "current"));
  out = lines();
  assert.equal(verify({ target: repo, write: out.write }), 1);
  assert.match(out.text(), /problem: no release is installed \(dist\/current is missing\)/);
  flipPointer(repo, id);
  assert.equal(verify({ target: repo, write: () => {} }), 0);
  // Rollback to 1.0.0: materialized from the tag, the pointer flipped, the
  // installed release kept; the entry then runs 1.0.0 and verify says so.
  out = lines();
  assert.equal(rollback("1.0.0", { target: repo, write: out.write }), 0, out.text());
  assert.match(
    out.text(),
    /rolled back dist\/current to 1\.0\.0-[0-9a-f]{7} \(materialized from the tag\); README, tests and agents stay at HEAD/,
  );
  assert.match(readPointer(repo), /^1\.0\.0-[0-9a-f]{7}$/);
  const help = node([path.join(repo, RUNNER), "--help"]);
  assert.equal(help.status, EXIT.COMPLETED, help.stderr);
  assert.match(help.stdout, /^run-codex-task 1\.0\.0\n/);
  assert.equal(
    fs.existsSync(path.join(repo, "dist", id, "src", "version.mjs")),
    true,
    "the release rolled back from stays under dist/",
  );
  out = lines();
  assert.equal(verify({ target: repo, write: out.write }), 1);
  assert.match(
    out.text(),
    /^live=1\.0\.0 release=1\.0\.0-[0-9a-f]{7} .*matches-head=no untagged=-$/m,
  );
  // Forward again: the folder already under dist/ is reused, whatever it was named after,
  // and it and the unchanged entry are read-only again even when made writable meanwhile.
  fs.chmodSync(path.join(repo, "dist", id, "src", "delivery", "usage.mjs"), 0o644);
  fs.chmodSync(path.join(repo, RUNNER), 0o644);
  out = lines();
  assert.equal(rollback("1.1.0", { target: repo, write: out.write }), 0, out.text());
  assert.match(
    out.text(),
    /rolled back dist\/current to 1\.1\.0-[0-9a-f]{7} \(already under dist\/\)/,
  );
  assert.match(out.text(), /entry .*run-codex-task\.mjs unchanged read-only=true/);
  assert.equal(isReadOnly(path.join(repo, "dist", id, "src", "delivery", "usage.mjs")), true);
  assert.equal(readPointer(repo), id);
  assert.equal(verify({ target: repo, write: () => {} }), 0);
  assert.throws(() => rollback("2.0.0", { target: repo, write: () => {} }), /no tag v2\.0\.0/);
  assert.throws(() => rollback("latest", { target: repo, write: () => {} }), /needs a version/);
});

// A tag with a smaller public surface and a checker that also requires an
// export HEAD does not have. The live checkout starts with only HEAD installed.
function crossVersionFixture(t, { checker = true, change = () => {} } = {}) {
  const root = scratch(t);
  const dev = path.join(root, "dev");
  devCopy(dev, "2.0.0");
  const index = path.join(dev, "src", "index.mjs");
  fs.writeFileSync(
    index,
    fs.readFileSync(index, "utf8").replace(", selectCodex, codexEnvironment", "") +
      "export function legacyStageExport() {}\n",
  );
  fs.appendFileSync(path.join(dev, RUNNER), "// entry from the older tag\n");
  const oldEntry = fs.readFileSync(path.join(dev, RUNNER));
  const currentChecker = fs.readFileSync(path.join(ROOT, "tools", "check-stage.mjs"), "utf8");
  if (checker) {
    fs.mkdirSync(path.join(dev, "tools"));
    fs.writeFileSync(
      path.join(dev, "tools", "check-stage.mjs"),
      currentChecker
        .replace('  selectCodex: "function",', '  legacyStageExport: "function",')
        .replace('  codexEnvironment: "function",\n', ""),
    );
  }
  change(dev);
  initRepository(dev, IDENTITY);
  gitIn(dev, "add", "-A");
  gitIn(dev, "commit", "-q", "-m", "older exports");
  gitIn(dev, "tag", "-a", "v2.0.0", "-m", "older release");
  const older = gitIn(dev, "rev-parse", "--short=7", "HEAD");
  devCopy(dev, "3.0.0");
  fs.mkdirSync(path.join(dev, "tools"), { recursive: true });
  fs.writeFileSync(path.join(dev, "tools", "check-stage.mjs"), currentChecker);
  gitIn(dev, "add", "-A");
  gitIn(dev, "commit", "-q", "-m", "current exports");
  gitIn(dev, "tag", "-a", "v3.0.0", "-m", "current release");
  const live = path.join(root, "live");
  gitIn(root, "clone", "-q", dev, live);
  const env = installEnv(root);
  assert.equal(install({ fromDir: dev, target: live, env, write() {} }), EXIT.COMPLETED);
  assert.equal(verify({ target: live, write() {} }), EXIT.COMPLETED);
  return { live, env, oldEntry, older, current: readPointer(live) };
}

test("cross-version rollback checks tagged exports, with import/version fallback only for tags without a checker", (t) => {
  for (const checker of [true, false]) {
    const { live, env, oldEntry, older, current } = crossVersionFixture(t, { checker });
    for (const source of ["materialized from the tag", "already under dist/"]) {
      const out = lines();
      assert.equal(rollback("2.0.0", { target: live, write: out.write }), EXIT.COMPLETED);
      assert.ok(out.text().includes(`(${source})`), out.text());
      assert.equal(readPointer(live), `2.0.0-${older}`);
      assert.deepEqual(fs.readFileSync(path.join(live, RUNNER)), oldEntry);
      assert.equal(isReadOnly(path.join(live, RUNNER)), true);
      const release = path.join(live, "dist", readPointer(live));
      for (const [name, bytes] of releaseFilesFromTag("refs/tags/v2.0.0", live)) {
        assert.deepEqual(fs.readFileSync(path.join(release, name)), bytes, name);
        assert.equal(isReadOnly(path.join(release, name)), true, name);
      }
      const help = node([path.join(live, RUNNER), "--help"], { env });
      assert.equal(help.status, EXIT.COMPLETED, help.stderr);
      assert.match(help.stdout, /^run-codex-task 2\.0\.0\n/);
      const mismatch = lines();
      assert.equal(verify({ target: live, write: mismatch.write }), EXIT.FAILURE);
      assert.match(mismatch.text(), /^live=2\.0\.0 .* matches-head=no untagged=-$/m);
      assert.match(mismatch.text(), /the entry run-codex-task\.mjs is not the committed one/);
      assert.match(mismatch.text(), /src\/index\.mjs differs from HEAD/);
      assert.deepEqual(
        fs.readdirSync(path.join(live, "dist")).sort(),
        [`2.0.0-${older}`, current, "current"].sort(),
        "temporary checker files are removed and the newer release is retained",
      );
    }
  }
});

test("rollback rejects failed tagged checks and failed, wrong-version or hung fallback imports before activation", (t) => {
  for (const [checker, change, expected] of [
    [
      true,
      (dev) => {
        const index = path.join(dev, "src", "index.mjs");
        fs.writeFileSync(
          index,
          fs.readFileSync(index, "utf8").replace("export function legacyStageExport() {}\n", ""),
        );
      },
      /required export legacyStageExport must be function/,
    ],
    [
      true,
      (dev) =>
        fs.appendFileSync(
          path.join(dev, "tools", "check-stage.mjs"),
          'throw new Error("tagged checker refused");\n',
        ),
      /tagged checker refused/,
    ],
    [
      false,
      (dev) => fs.appendFileSync(path.join(dev, "src", "index.mjs"), 'import "./missing.mjs";\n'),
      /missing\.mjs/,
    ],
    [
      false,
      (dev) => {
        const index = path.join(dev, "src", "index.mjs");
        fs.writeFileSync(
          index,
          fs
            .readFileSync(index, "utf8")
            .replace(
              'export { RUNNER_VERSION } from "./version.mjs";',
              'export const RUNNER_VERSION = "1.0.0";',
            ),
        );
      },
      /RUNNER_VERSION is 1\.0\.0, expected 2\.0\.0/,
    ],
    [
      false,
      (dev) =>
        fs.appendFileSync(
          path.join(dev, "src", "index.mjs"),
          "await new Promise(() => setInterval(() => {}, 1000));\n",
        ),
      new RegExp(ERRNO.ETIMEDOUT),
    ],
  ]) {
    const { live, current } = crossVersionFixture(t, { checker, change });
    const entry = fs.readFileSync(path.join(live, RUNNER));
    assert.throws(() => rollback("2.0.0", { target: live, write() {} }), expected);
    assert.equal(readPointer(live), current);
    assert.deepEqual(fs.readFileSync(path.join(live, RUNNER)), entry);
    assert.deepEqual(fs.readdirSync(path.join(live, "dist")).sort(), [current, "current"].sort());
  }
});

// Moves src/shared/process-stop.mjs to src/process/stop.mjs in a copy, its own
// imports and its importers' rewritten, and adds src/process/deep/marker.mjs,
// which nothing imports: the nested layout a later release has.
function nestModules(root) {
  const src = path.join(root, "src");
  const before = path.join(src, "shared", "process-stop.mjs");
  const after = path.join(src, "process", "stop.mjs");
  const files = fs.readdirSync(src, { recursive: true }).filter((name) => name.endsWith(".mjs"));
  fs.mkdirSync(path.dirname(after), { recursive: true });
  for (const name of files) {
    const file = path.join(src, name);
    const destination = file === before ? after : file;
    const text = fs
      .readFileSync(file, "utf8")
      .replace(/(["'])(\.[^"'\n]+\.mjs)(["'])/g, (all, quote, relative, end) => {
        const target = path.resolve(path.dirname(file), relative);
        if (target !== before && file !== before) return all;
        const next = path
          .relative(path.dirname(destination), target === before ? after : target)
          .split(path.sep)
          .join("/");
        return quote + (next.startsWith(".") ? next : `./${next}`) + end;
      });
    fs.writeFileSync(destination, text);
  }
  fs.rmSync(before);
  fs.mkdirSync(path.join(src, "process", "deep"), { recursive: true });
  fs.writeFileSync(
    path.join(src, "process", "deep", "marker.mjs"),
    'export const DEPTH = "two";\n',
  );
}
// Removes a release folder under dist/, whose files are read-only.
function removeRelease(target, id) {
  const root = path.join(target, "dist", id);
  for (const name of fs.readdirSync(root, { recursive: true })) {
    const file = path.join(root, name);
    if (fs.lstatSync(file).isFile()) fs.chmodSync(file, 0o644);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

test("current nested releases install, verify and roll back through reuse and tag materialization; failed nested staging leaves nothing", (t) => {
  const root = scratch(t);
  const env = installEnv(root);
  // The development copy: a flat 1.0.0, then 2.0.0 with src/process/stop.mjs
  // and src/process/deep/marker.mjs, each committed and tagged.
  const dev = path.join(root, "dev");
  devCopy(dev, "1.0.0");
  initRepository(dev, IDENTITY);
  const release = (version, why) => {
    gitIn(dev, "add", "-A");
    gitIn(dev, "commit", "-q", "-m", why);
    gitIn(dev, "tag", "-a", `v${version}`, "-m", `Runner ${version}`);
  };
  release("1.0.0", "1.0.0, flat");
  fs.writeFileSync(path.join(dev, "src", "version.mjs"), versionModule("2.0.0"));
  fs.writeFileSync(
    path.join(dev, "package.json"),
    JSON.stringify({
      name: "codex-subagents-for-claude-code",
      version: "2.0.0",
      type: "module",
      license: "Apache-2.0",
    }),
  );
  fs.writeFileSync(path.join(dev, "README.md"), "# dev copy (runner 2.0.0)\n");
  nestModules(dev);
  release("2.0.0", "2.0.0, nested");
  assert.ok(
    checkedFiles(dev).includes("src/process/deep/marker.mjs"),
    "check reads nested modules",
  );
  // The live checkout, a clone moved to each release's commit before its install.
  const live = path.join(root, "live");
  gitIn(root, "clone", "-q", dev, live);
  const help = () => {
    const result = node([path.join(live, RUNNER), "--help"]);
    assert.equal(result.status, EXIT.COMPLETED, result.stderr);
    return result.stdout.split("\n")[0];
  };
  const verified = () => {
    const out = lines();
    return { code: verify({ target: live, write: out.write }), text: out.text() };
  };
  const ids = {};
  for (const [version, layout] of [
    ["1.0.0", "flat"],
    ["2.0.0", "nested"],
  ]) {
    gitIn(dev, "checkout", "-q", `v${version}`);
    gitIn(live, "checkout", "-q", `v${version}`);
    const out = lines();
    assert.equal(install({ fromDir: dev, target: live, env, write: out.write }), 0, out.text());
    const id = (ids[layout] = readPointer(live));
    const folder = path.join(live, "dist", id);
    assert.equal(help(), `run-codex-task ${version}`, `${layout}: the entry runs it`);
    // The manifest records exactly the tag's release files, in inventory order.
    const tagged = releaseFilesFromTag(`refs/tags/v${version}`, live);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(live, "releases", `v${version}.json`), "utf8"),
    );
    assert.deepEqual(Object.keys(manifest.files), [...tagged.keys()], layout);
    for (const [name, bytes] of tagged) {
      assert.equal(manifest.files[name], hashOf(bytes), `${layout}: ${name}`);
      assert.deepEqual(fs.readFileSync(path.join(folder, name)), bytes, `${layout}: ${name}`);
      assert.equal(isReadOnly(path.join(folder, name)), true, `${layout}: ${name}`);
    }
    const nested = ["src/process/stop.mjs", "src/process/deep/marker.mjs"];
    if (layout === "nested") {
      for (const name of nested) assert.ok(tagged.has(name), name);
      assert.equal(tagged.has("src/shared/process-stop.mjs"), false);
    } else assert.ok(tagged.has("src/shared/process-stop.mjs") && !tagged.has(nested[0]));
    let result = verified();
    assert.equal(result.code, EXIT.COMPLETED, result.text);
    assert.match(
      result.text,
      new RegExp(`^live=${version} release=${id} .* tags=v${version} matches-head=yes untagged=-$`),
    );
    // Reused, every file read-only again, the nested ones too.
    const deepest = layout === "nested" ? nested[1] : "src/delivery/usage.mjs";
    fs.chmodSync(path.join(folder, deepest), 0o644);
    const again = lines();
    assert.equal(install({ fromDir: dev, target: live, env, write: again.write }), 0, again.text());
    assert.match(again.text(), /already under dist\/, reused/);
    assert.equal(readPointer(live), id);
    assert.equal(isReadOnly(path.join(folder, deepest)), true, `${layout}: read-only again`);
    result = verified();
    assert.equal(result.code, EXIT.COMPLETED, result.text);
  }
  const everything = () => fs.readdirSync(path.join(live, "dist")).sort();
  const before = everything();
  assert.deepEqual(before, ["current", ids.flat, ids.nested].sort());
  // A stage that fails partway through a nested write: the nested folders and
  // the files before it are written, then the write of src/process/stop.mjs
  // fails. Nothing is left behind and the pointer stays.
  const files = releaseFilesFromTag("refs/tags/v2.0.0", live);
  const write = fs.writeFileSync;
  const written = [];
  const failing = t.mock.method(fs, "writeFileSync", (file, ...rest) => {
    if (String(file).includes(".staging-")) {
      if (String(file).endsWith(path.join("process", "stop.mjs"))) throw new Error("disk full");
      written.push(path.basename(String(file)));
    }
    return write(file, ...rest);
  });
  assert.throws(() => publishRelease(live, "2.0.0-abcdef0", files), /disk full/);
  failing.mock.restore();
  assert.ok(written.includes("marker.mjs") && written.includes("options.mjs"), written);
  assert.deepEqual(everything(), before, "no staging folder and no release are left");
  assert.equal(readPointer(live), ids.nested);
  // Rollback, from nested to flat and back, first from the folders already
  // under dist/, then materialized from the tags.
  for (const source of ["already under dist/", "materialized from the tag"]) {
    if (source.startsWith("materialized"))
      for (const id of Object.values(ids)) removeRelease(live, id);
    let out = lines();
    assert.equal(rollback("1.0.0", { target: live, write: out.write }), 0, out.text());
    assert.ok(out.text().includes(`(${source})`), out.text());
    assert.match(readPointer(live), /^1\.0\.0-[0-9a-f]{7}$/);
    assert.equal(help(), "run-codex-task 1.0.0");
    // HEAD is still 2.0.0: verify names the layouts' difference.
    let result = verified();
    assert.equal(result.code, EXIT.FAILURE);
    assert.match(result.text, /^live=1\.0\.0 .* matches-head=no /m);
    assert.match(
      result.text,
      /problem: release 1\.0\.0-[0-9a-f]{7}: src\/shared\/process-stop\.mjs differs from HEAD/,
    );
    assert.match(
      result.text,
      /problem: release 1\.0\.0-[0-9a-f]{7}: src\/process\/stop\.mjs is committed but not installed/,
    );
    out = lines();
    assert.equal(rollback("2.0.0", { target: live, write: out.write }), 0, out.text());
    assert.ok(out.text().includes(`(${source})`), out.text());
    assert.equal(help(), "run-codex-task 2.0.0");
    result = verified();
    assert.equal(result.code, EXIT.COMPLETED, result.text);
    for (const name of ["src/process/stop.mjs", "src/process/deep/marker.mjs"])
      assert.equal(isReadOnly(path.join(live, "dist", readPointer(live), name)), true, name);
  }
});

test("a link where a release file can be is never followed: check names it, a release folder holding one is not reused, and a tag holding one is not rolled back to", (t) => {
  const root = scratch(t);
  const env = installEnv(root);
  const external = path.join(root, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "outside.mjs"), "export const OUTSIDE = 1;\n");
  const link = (at) => fs.symlinkSync(external, at, IS_WINDOWS ? "junction" : "dir");
  // A copy whose src/ holds a linked folder: check names it.
  const copy = path.join(root, "copy");
  devCopy(copy, "9.9.9");
  link(path.join(copy, "src", "linked"));
  try {
    const out = lines();
    assert.equal(check({ root: copy, env, write: out.write }), EXIT.FAILURE);
    assert.match(out.text(), /^problem: src\/linked is no regular file \(a link or a junction\)/m);
    assert.equal(checkedFiles(copy).includes("src/linked/outside.mjs"), false, "never followed");
  } finally {
    fs.unlinkSync(path.join(copy, "src", "linked"));
  }
  // An installed release folder that someone linked a folder into: not the
  // same release any more, so it is not reused and never overwritten.
  const target = path.join(root, "live");
  assert.equal(install({ fromDir: copy, target, env, write() {} }), 0);
  const id = readPointer(target);
  link(path.join(target, "dist", id, "src", "linked"));
  try {
    assert.throws(
      () => install({ fromDir: copy, target, env, write() {} }),
      /already exists under dist\/ with different content and is never overwritten/,
    );
  } finally {
    fs.unlinkSync(path.join(target, "dist", id, "src", "linked"));
  }
  // A tag that records a module as a link: refused, not read as its target path.
  const repo = path.join(root, "repo");
  devCopy(repo, "9.9.9");
  initRepository(repo, IDENTITY);
  gitIn(repo, "config", "core.symlinks", "false");
  gitIn(repo, "add", "-A");
  const blob = gitIn(repo, "hash-object", "-w", "--stdin");
  gitIn(repo, "update-index", "--add", "--cacheinfo", `120000,${blob},src/linked.mjs`);
  gitIn(repo, "commit", "-q", "-m", "9.9.9");
  gitIn(repo, "tag", "-a", "v9.9.9", "-m", "Runner 9.9.9");
  assert.throws(
    () => releaseFilesFromTag("refs/tags/v9.9.9", repo),
    /refs\/tags\/v9\.9\.9 holds src\/linked\.mjs as a link or a submodule; a release holds regular files only/,
  );
  assert.throws(() => rollback("9.9.9", { target: repo, write() {} }), /as a link or a submodule/);
  assert.equal(fs.existsSync(path.join(repo, "dist")), false, "nothing was rolled back");
});
