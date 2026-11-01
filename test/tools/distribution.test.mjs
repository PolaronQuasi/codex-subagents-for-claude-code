import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildBundle, digest, loadBundle, ROOT, smokeBundle } from "../../tools/distribution.mjs";
import { distributionFixture, trackedTree } from "../support/distribution-fixture.mjs";
import { gitEnvironment } from "../support/git-environment.mjs";
import { IS_WINDOWS } from "../support/release-fixture.mjs";

test("formatting is one script with its settings in the repository: both workflows run npm run format:check, and the print width comes from .prettierrc.json", () => {
  const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
  assert.deepEqual(JSON.parse(read(".prettierrc.json")), { printWidth: 100 });
  const { scripts } = JSON.parse(read("package.json"));
  const pinned = /^npx --yes prettier@(\d+\.\d+\.\d+) --(write|check) --ignore-unknown \.$/;
  const [, writeVersion, write] = pinned.exec(scripts.format) ?? [];
  const [, checkVersion, check] = pinned.exec(scripts["format:check"]) ?? [];
  assert.deepEqual([write, check], ["write", "check"], "format rewrites, format:check checks");
  assert.equal(writeVersion, checkVersion, "both scripts pin one Prettier version");
  for (const workflow of ["ci.yml", "release.yml"])
    assert.match(
      read(`.github/workflows/${workflow}`),
      /^\s+(?:run: )?npm run format:check$/m,
      workflow,
    );
});

test("the release workflow validates its tag and imports that tag's own publisher from its checked-out tree", (t) => {
  const { root, scratch, git, options, bundle } = distributionFixture(t);
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /- name: Check formatting\n        run: npm run format:check\n/);
  const publisher = /        run: node (tools\/publish-github\.mjs) release-artifacts/.exec(
    workflow,
  )?.[1];
  assert.ok(publisher, "upload uses the publisher inside the selected source tree");
  const step =
    /      - name: Validate the triggering tag and exact commit\n[\s\S]*?        run: \|\n([\s\S]*?)(?=      - uses:)/.exec(
      workflow,
    )?.[1];
  assert.ok(step, "execute the workflow's actual tag validation");
  const script = step
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
  fs.appendFileSync(
    path.join(root, publisher),
    '\nthrow new Error("untagged publisher must not run");\n',
  );
  git("add", publisher);
  git("commit", "-m", "Untagged publisher fixture");
  const untagged = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", untagged);
  const envFile = path.join(scratch, "workflow-env");
  const env = {
    ...gitEnvironment(),
    GITHUB_ENV: envFile.replaceAll("\\", "/"),
    RELEASE_REF: `refs/tags/${options.tag}`,
    RELEASE_SHA: bundle.manifest.commit,
  };
  // Windows' bare bash may be WSL; use the Bash bundled with this Git.
  const bash = IS_WINDOWS ? path.resolve(git("--exec-path"), "../../..", "bin/bash.exe") : "bash";
  const select = (extra) =>
    spawnSync(bash, ["-c", script], {
      cwd: root,
      env: { ...env, ...extra },
      encoding: "utf8",
      windowsHide: true,
    });
  const refused = select({ RELEASE_REF: "refs/heads/main" });
  assert.notEqual(refused.status, 0);
  assert.equal(git("rev-parse", "HEAD"), untagged, "invalid input cannot change the checkout");
  assert.equal(fs.existsSync(envFile), false);
  const wrongCheckout = select({});
  assert.notEqual(wrongCheckout.status, 0, "a valid tag cannot authorize an untagged publisher");
  assert.equal(git("rev-parse", "HEAD"), untagged);
  assert.equal(fs.existsSync(envFile), false);
  git("checkout", "--detach", options.tag);
  const selected = select({});
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  assert.equal(git("rev-parse", "HEAD"), bundle.manifest.commit);
  assert.ok(fs.readFileSync(envFile, "utf8").includes(`RELEASE_TAG=${options.tag}`));
  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const publisher = await import(${JSON.stringify(pathToFileURL(path.join(root, publisher)).href)}); console.log(typeof publisher.publishDraft);`,
    ],
    { cwd: root, env: gitEnvironment(), encoding: "utf8", windowsHide: true },
  );
  assert.equal(imported.status, 0, imported.stdout + imported.stderr);
  assert.equal(imported.stdout.trim(), "function", "imports only; no CLI or API call");
});

test("portable release archives are complete, reproducible, isolated and installable", (t) => {
  // Machine-local files that a careless commit could hold: the package leaves both out.
  const { scratch, options, bundle } = distributionFixture(t, {
    files: {
      "results/private.txt": "local result\n",
      "ci/gitea/.env": "EXAMPLE=private-fixture\n",
      "docs/local/evidence.md": "local diagnostic evidence\n",
    },
  });
  const files = bundle.manifest.files.map((file) => file.path);
  const notes = fs.readFileSync(path.join(bundle.directory, "RELEASE-NOTES.md"), "utf8");
  assert.ok(notes.startsWith(`# Codex subagents for Claude Code ${bundle.manifest.version}\n`));
  assert.ok(notes.includes(`Commit: \`${bundle.manifest.commit}\``));
  assert.match(notes, /Requires Node\.js 22\+, Git, Claude Code/);
  for (const name of [
    "LICENSE",
    "NOTICE",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "SUPPORT.md",
    "ci/gitea/compose.yml",
    "docs/diagrams/README.md",
    "src/index.mjs",
    "install.mjs",
    "docs/DEVELOPMENT.md",
    ".prettierrc.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "agents/gpt-6-1-sol.md",
    "skills/codex-subagents-for-claude-code/SKILL.md",
  ])
    assert.ok(files.includes(name), name);
  assert.ok(!files.some((name) => /^(results|releases|dist|\.git|\.gitea)\//.test(name)));
  assert.ok(!files.includes("ci/gitea/.env"));
  assert.ok(
    !files.some((name) => name.startsWith("docs/local/")),
    "local diagnostic files are source-only",
  );
  assert.ok(!files.some((name) => /^(deployment|diagrams|mcp-probe)\//.test(name)));
  const rebuilt = buildBundle({ ...options, output: path.join(scratch, "rebuilt") });
  for (const name of bundle.assets)
    assert.deepEqual(
      fs.readFileSync(path.join(bundle.directory, name)),
      fs.readFileSync(path.join(rebuilt.directory, name)),
      name,
    );
  assert.equal(smokeBundle(bundle.directory).manifest.commit, bundle.manifest.commit);
});

test("the publication fixture is this repository's tracked tree at a commit, byte for byte and with its modes, and holds an untracked file only when a test adds it", (t) => {
  const { root, git } = distributionFixture(t);
  const ours = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: ROOT,
    encoding: "utf8",
    env: gitEnvironment(),
    windowsHide: true,
  });
  assert.equal(ours.status, 0, ours.stderr);
  assert.equal(git("rev-parse", "HEAD^{tree}"), ours.stdout.trim(), "the same tree object");
  assert.equal(git("status", "--porcelain", "--ignored"), "", "nothing else in the copy");
  assert.deepEqual(
    trackedTree().map(({ name }) => name),
    git("ls-files", "-z").split("\0").filter(Boolean),
  );
  assert.equal(fs.existsSync(path.join(root, "results")), false);
});

test("packaging refuses dirty source, wrong commits, wrong versions and replacement", (t) => {
  const { root, options, git, bundle, scratch } = distributionFixture(t);
  assert.throws(() => buildBundle({ ...options, tag: "v01.0.1" }), /vMAJOR/);
  assert.throws(() => buildBundle(options), /output directory must be empty/);
  fs.appendFileSync(path.join(root, "NOTICE"), "changed\n");
  assert.throws(() => buildBundle(options), /clean tracked checkout/);
  git("restore", "NOTICE");
  git("tag", "v9.9.9");
  assert.throws(() => buildBundle({ ...options, tag: "v9.9.9" }), /must agree/);
  git("commit", "--allow-empty", "-m", "Later source");
  assert.throws(() => buildBundle(options), /check out the release tag/);
  git("checkout", "--detach", bundle.manifest.commit);
  git("checkout", "--orphan", "unrelated");
  git("commit", "-m", "Unrelated branch");
  git("checkout", "--detach", bundle.manifest.commit);
  assert.throws(
    () => buildBundle({ ...options, mainRef: "unrelated", output: path.join(scratch, "refused") }),
    /git failed/,
  );
});

test("bundle validation detects changed archives, duplicate checksums and unsafe file paths", (t) => {
  const { bundle } = distributionFixture(t);
  const archive = path.join(bundle.directory, bundle.manifest.archives[0].name);
  const original = fs.readFileSync(archive);
  fs.appendFileSync(archive, "tampered");
  assert.throws(() => loadBundle(bundle.directory), /checksum mismatch/);
  fs.writeFileSync(archive, original);
  const sumsPath = path.join(bundle.directory, "SHA256SUMS");
  const sums = fs.readFileSync(sumsPath, "utf8");
  fs.appendFileSync(sumsPath, sums.split("\n")[0] + "\n");
  assert.throws(() => loadBundle(bundle.directory), /complete and unique/);
  fs.writeFileSync(sumsPath, sums);
  const manifestPath = path.join(bundle.directory, "release-manifest.json");
  const invalid = structuredClone(bundle.manifest);
  invalid.files[0].path = "../outside";
  fs.writeFileSync(manifestPath, JSON.stringify(invalid));
  fs.writeFileSync(
    sumsPath,
    sums.replace(
      /^[0-9a-f]{64}(  release-manifest\.json)$/m,
      `${digest(fs.readFileSync(manifestPath))}$1`,
    ),
  );
  assert.throws(() => loadBundle(bundle.directory), /invalid file inventory/);
});
