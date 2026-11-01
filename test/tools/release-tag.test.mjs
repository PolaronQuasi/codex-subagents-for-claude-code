// tag: the manifest commit it marks, what it refuses, and the warnings for untagged manifests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { check, install, ROOT, tag, verify } from "../../tools/release.mjs";
import {
  scratch,
  IDENTITY,
  gitIn,
  lines,
  installEnv,
  writeManifest,
  taggableRepo,
} from "../support/release-fixture.mjs";

test("tag refuses uncommitted changes to tracked files, staged or not, and ignores untracked files", (t) => {
  const root = scratch(t);
  const repo = path.join(root, "repo");
  const env = taggableRepo(root, repo, "8.8.8");
  const readme = path.join(repo, "README.md"),
    committed = fs.readFileSync(readme);
  fs.appendFileSync(readme, "edited\n");
  assert.throws(
    () => tag({ root: repo, env, write: () => {} }),
    /a tracked file has uncommitted changes; commit first/,
  );
  gitIn(repo, "add", "README.md");
  assert.throws(
    () => tag({ root: repo, env, write: () => {} }),
    /a tracked file has uncommitted changes/,
    "a staged change blocks it too",
  );
  gitIn(repo, "reset", "-q");
  fs.writeFileSync(readme, committed);
  assert.equal(gitIn(repo, "tag", "--list"), "", "a refused tag creates none");
  // An untracked file, such as someone's report beside the sources, no longer blocks the tag.
  fs.writeFileSync(path.join(repo, "REPORT.md"), "not ours\n");
  const out = lines();
  assert.equal(tag({ root: repo, env, write: out.write }), 0, out.text());
  assert.match(out.text(), /^tagged v8\.8\.8 at [0-9a-f]{7,}$/);
  assert.equal(gitIn(repo, "tag", "--list"), "v8.8.8");
  assert.equal(gitIn(repo, "cat-file", "-t", "v8.8.8"), "tag", "an annotated tag");
  assert.equal(
    fs.readFileSync(path.join(repo, "REPORT.md"), "utf8"),
    "not ours\n",
    "the untracked file is left alone",
  );
  assert.equal(gitIn(repo, "status", "--porcelain"), "?? REPORT.md");
});

test("tag marks only the manifest commit: refused without the version's manifest at HEAD, with another version in it, or after a later commit", (t) => {
  const root = scratch(t);
  const repo = path.join(root, "repo");
  const env = taggableRepo(root, repo, "8.8.8", { manifest: false });
  const refused = (pattern, why) =>
    assert.throws(() => tag({ root: repo, env, write() {} }), pattern, why);
  refused(
    /^Error: releases\/v8\.8\.8\.json is not at HEAD: install release 8\.8\.8 \(install --from-dir\), commit its manifest, then tag that commit$/,
    "no manifest at HEAD",
  );
  writeManifest(repo, "8.8.8");
  refused(/releases\/v8\.8\.8\.json is not at HEAD/, "a manifest not yet committed");
  writeManifest(repo, "8.8.8", "8.8.7");
  gitIn(repo, "add", "releases");
  gitIn(repo, "commit", "-q", "-m", "A manifest of another version");
  refused(/releases\/v8\.8\.8\.json at HEAD records version "8\.8\.7", not 8\.8\.8/);
  writeManifest(repo, "8.8.8");
  gitIn(repo, "add", "releases");
  gitIn(repo, "commit", "-q", "-m", "Release manifest 8.8.8");
  const manifestCommit = gitIn(repo, "rev-parse", "HEAD");
  fs.appendFileSync(path.join(repo, "docs", "MANUAL.md"), "A later change.\n");
  gitIn(repo, "commit", "-q", "-am", "A later change");
  refused(
    new RegExp(
      `HEAD is not the manifest commit of 8\\.8\\.8: releases/v8\\.8\\.8\\.json last changed in ${manifestCommit.slice(0, 7)}; tag right after the manifest commit`,
    ),
  );
  assert.equal(gitIn(repo, "tag", "--list"), "", "a refused tag creates none");
  gitIn(repo, "checkout", "-q", "--detach", manifestCommit);
  const out = lines();
  assert.equal(tag({ root: repo, env, write: out.write }), 0, out.text());
  assert.equal(gitIn(repo, "rev-parse", "v8.8.8^{commit}"), manifestCommit);
});

test("check warns, without failing, while the newest release manifest has no tag; verify reports every untagged manifest", (t) => {
  const root = scratch(t);
  const repo = path.join(root, "repo");
  const env = taggableRepo(root, repo, "8.8.8");
  const warnings = () => {
    const out = lines();
    assert.equal(check({ root: repo, env, write: out.write }), 0, out.text());
    return out
      .text()
      .split("\n")
      .filter((line) => line.startsWith("warning: "));
  };
  assert.deepEqual(warnings(), [
    "warning: releases/v8.8.8.json has no tag v8.8.8: tag release 8.8.8 at its manifest commit (node tools/release.mjs tag)",
  ]);
  assert.equal(tag({ root: repo, env, write() {} }), 0);
  assert.deepEqual(warnings(), [], "a tagged newest manifest warns no more");
  // An older manifest without its tag: check looks at the newest only, verify at all of them.
  writeManifest(repo, "8.8.7");
  writeManifest(repo, "8.8.10");
  assert.deepEqual(warnings(), [
    "warning: releases/v8.8.10.json has no tag v8.8.10: tag release 8.8.10 at its manifest commit (node tools/release.mjs tag)",
  ]);
  const out = lines();
  assert.equal(verify({ target: repo, write: out.write }), 1);
  assert.match(out.text(), / untagged=8\.8\.7,8\.8\.10$/m);
  assert.match(
    out.text(),
    /^problem: releases\/v8\.8\.7\.json has no tag v8\.8\.7: release 8\.8\.7 was installed but never tagged; tag its manifest commit/m,
  );
  assert.match(out.text(), /^problem: releases\/v8\.8\.10\.json has no tag v8\.8\.10:/m);
  assert.doesNotMatch(out.text(), /v8\.8\.8\.json has no tag/);
});

test("tag accepts the manifest commit of a real install, whose manifest names the release commit, its parent", (t) => {
  const root = scratch(t);
  const env = installEnv(root);
  // The development copy at its release commit.
  const dev = path.join(root, "dev");
  taggableRepo(root, dev, "8.8.8", { manifest: false });
  fs.copyFileSync(path.join(ROOT, ".gitignore"), path.join(dev, ".gitignore"));
  gitIn(dev, "add", ".gitignore");
  gitIn(dev, "commit", "-q", "-m", "Ignore machine state");
  const releaseCommit = gitIn(dev, "rev-parse", "--short=7", "HEAD");
  // The live checkout at the same commit, as after the release's git steps.
  const live = path.join(root, "live");
  gitIn(root, "clone", "-q", dev, live);
  for (const [key, value] of [
    ["user.name", IDENTITY.name],
    ["user.email", IDENTITY.email],
    ["tag.gpgsign", "false"],
  ])
    gitIn(live, "config", key, value);
  assert.equal(install({ fromDir: dev, target: live, env, write() {} }), 0);
  assert.equal(
    gitIn(live, "status", "--porcelain", "--untracked-files=all"),
    "?? releases/v8.8.8.json",
  );
  gitIn(live, "add", "releases/v8.8.8.json");
  gitIn(live, "commit", "-q", "-m", "Release manifest 8.8.8");
  const manifestCommit = gitIn(live, "rev-parse", "HEAD");
  const manifest = JSON.parse(fs.readFileSync(path.join(live, "releases", "v8.8.8.json"), "utf8"));
  assert.equal(manifest.commit, releaseCommit, "the manifest names the release commit");
  assert.notEqual(manifestCommit.slice(0, 7), manifest.commit, "which is not HEAD");
  assert.equal(gitIn(live, "rev-parse", "--short=7", "HEAD~1"), releaseCommit);
  const out = lines();
  assert.equal(tag({ root: live, env, write: out.write }), 0, out.text());
  assert.equal(gitIn(live, "rev-parse", "v8.8.8^{commit}"), manifestCommit);
});
