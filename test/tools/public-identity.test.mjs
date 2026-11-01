import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildBundle, digest, loadBundle, ROOT } from "../../tools/distribution.mjs";
import { distributionFixture } from "../support/distribution-fixture.mjs";
import { gitEnvironment } from "../support/git-environment.mjs";
import { IS_WINDOWS } from "../support/release-fixture.mjs";
import { publishDraft } from "../../tools/publish-gitea.mjs";

test("public archives and metadata share the new identity while installed names and executable modes remain current", (t) => {
  const { bundle } = distributionFixture(t);
  assert.equal(bundle.manifest.project, "codex-subagents-for-claude-code");
  assert.deepEqual(
    bundle.manifest.archives.map((asset) => asset.name),
    [
      `codex-subagents-for-claude-code-${bundle.manifest.version}.zip`,
      `codex-subagents-for-claude-code-${bundle.manifest.version}.tar.gz`,
    ],
  );
  for (const [name, mode] of [
    [".githooks/pre-commit", "100755"],
    [".githooks/pre-push", "100755"],
    ["run-codex-task.mjs", "100644"],
    ["install.mjs", "100644"],
    ["tools/distribution.mjs", "100644"],
  ])
    assert.equal(bundle.manifest.files.find((file) => file.path === name).mode, mode, name);
  const files = bundle.manifest.files.map((file) => file.path);
  assert.ok(files.includes("claude/skills/codex-subagents-for-claude-code/SKILL.md"));
  assert.ok(!files.some((file) => /^(?:releases|docs\/history|\.github|\.gitea)\//.test(file)));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json")));
  assert.equal(pkg.private, true);
  assert.equal(pkg.name, "codex-subagents-for-claude-code");
  const repository = new URL(pkg.repository.url);
  assert.ok(
    repository.protocol === "https:" ||
      (repository.protocol === "http:" && repository.hostname === "localhost"),
  );
  assert.equal(repository.username + repository.password + repository.search + repository.hash, "");
  assert.match(repository.pathname, /^\/[^/]+\/codex-subagents-for-claude-code\.git$/);
  const home = repository.origin + repository.pathname.replace(/\.git$/, "/");
  assert.equal(pkg.homepage, home);
  assert.equal(pkg.bugs.url, home + "issues");
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin/plugin.json")));
  assert.equal(plugin.repository, pkg.repository.url);
  assert.equal(plugin.homepage, home);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test("packaging and both forge identities fail closed on an obsolete package or manifest project", async (t) => {
  const { bundle, root, git, options } = distributionFixture(t);
  await assert.rejects(
    publishDraft({
      directory: bundle.directory,
      repository: "example/unrelated-project",
      server: "https://forge.example.invalid",
      token: "fixture",
      fetchImpl() {
        assert.fail("wrong project must not make network requests");
      },
    }),
    /project identity/,
  );
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath));
  pkg.name = "unrelated-project";
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  git("add", "package.json");
  git("commit", "-m", "Wrong package fixture");
  git("tag", "-f", options.tag);
  assert.throws(() => buildBundle(options), /project name/);
  const manifestPath = path.join(bundle.directory, "release-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.project = "unrelated-project";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const sumsPath = path.join(bundle.directory, "SHA256SUMS");
  fs.writeFileSync(
    sumsPath,
    fs
      .readFileSync(sumsPath, "utf8")
      .replace(
        /^[a-f0-9]+  release-manifest.json$/m,
        `${digest(fs.readFileSync(manifestPath))}  release-manifest.json`,
      ),
  );
  assert.throws(() => loadBundle(bundle.directory), /manifest identity/);
});

test("GitHub tag gate executes literal event data safely and refuses mismatched commits and ancestry", (t) => {
  const { root, scratch, git, options, bundle } = distributionFixture(t);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
  const block = /        run: \|\n([\s\S]*?)(?=      - uses:)/.exec(workflow)?.[1];
  assert.ok(block);
  const script = block
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
  const envFile = path.join(scratch, "github-env");
  const bash = IS_WINDOWS ? path.resolve(git("--exec-path"), "../../..", "bin/bash.exe") : "bash";
  const run = (extra = {}) =>
    spawnSync(bash, ["-c", script], {
      cwd: root,
      env: {
        ...gitEnvironment(),
        GITHUB_ENV: envFile.replaceAll("\\", "/"),
        RELEASE_REF: `refs/tags/${options.tag}`,
        RELEASE_SHA: bundle.manifest.commit,
        ...extra,
      },
      encoding: "utf8",
      windowsHide: true,
    });
  for (const extra of [
    { RELEASE_REF: "refs/heads/main" },
    { RELEASE_REF: "refs/tags/v1.0.0; touch injected" },
    { RELEASE_SHA: "0".repeat(40) },
  ]) {
    const result = run(extra);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(envFile), false);
    assert.equal(fs.existsSync(path.join(root, "injected")), false);
  }
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.equal(fs.readFileSync(envFile, "utf8").trim(), `RELEASE_TAG=${options.tag}`);
  git("update-ref", "-d", "refs/remotes/origin/main");
  assert.notEqual(run().status, 0);
});
