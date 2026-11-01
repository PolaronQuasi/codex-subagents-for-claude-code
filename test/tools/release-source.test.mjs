// The copy install takes a release from: how the release is named, which copies it refuses, and
// which files it copies.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { gitEnvironment, initRepository } from "../support/git-environment.mjs";
import {
  flipPointer,
  ignoreRules,
  install,
  publishRelease,
  readPointer,
  ROOT,
  samePath,
  SOURCES,
} from "../../tools/release.mjs";
import { ERRNO, EXIT } from "../../src/shared/errors.mjs";
import {
  IS_WINDOWS,
  RUNNER,
  stub,
  scratch,
  IDENTITY,
  gitIn,
  lines,
  devCopy,
  installEnv,
} from "../support/release-fixture.mjs";

test("install names the untracked files that would be missing from the release, apart from uncommitted changes", (t) => {
  const root = scratch(t);
  const source = path.join(root, "dev");
  devCopy(source, "7.7.8");
  initRepository(source, IDENTITY);
  gitIn(source, "add", "-A");
  gitIn(source, "commit", "-q", "-m", "7.7.8");
  const env = installEnv(root);
  const attempt = () =>
    install({ fromDir: source, target: path.join(root, "live"), env, write: () => {} });
  // A new module not yet added, which the release would miss.
  fs.writeFileSync(path.join(source, "src", "forgotten.mjs"), "export const x = 1;\n");
  assert.throws(
    attempt,
    /^Error: the development copy has untracked files: src\/forgotten\.mjs; commit, ignore or remove them first, so the release holds every file its commit would$/,
  );
  for (let index = 0; index < 11; index++)
    fs.writeFileSync(path.join(source, `note-${String(index).padStart(2, "0")}.txt`), "x\n");
  assert.throws(attempt, /untracked files: note-00\.txt, .*note-09\.txt and 2 more; commit/);
  fs.writeFileSync(path.join(source, ".gitignore"), "note-*.txt\nsrc/forgotten.mjs\n");
  gitIn(source, "add", ".gitignore");
  gitIn(source, "commit", "-q", "-m", "ignore the notes");
  assert.equal(attempt(), EXIT.COMPLETED, "ignored files block nothing");
  fs.appendFileSync(path.join(source, "src", "delivery", "usage.mjs"), "// edited\n");
  assert.throws(attempt, /the development copy has uncommitted changes; commit them first/);
});

test("a release from a git checkout is named after its commit, a dirty checkout is refused, and a release folder is never overwritten", (t) => {
  const root = scratch(t);
  const source = path.join(root, "dev"),
    target = path.join(root, "live");
  devCopy(source, "7.7.7");
  fs.mkdirSync(target);
  initRepository(source, IDENTITY);
  gitIn(source, "add", "-A");
  gitIn(source, "commit", "-q", "-m", "7.7.7");
  const commit = gitIn(source, "rev-parse", "--short=7", "HEAD");
  const env = installEnv(root);
  assert.equal(install({ fromDir: source, target, env, write: () => {} }), 0);
  assert.equal(readPointer(target), `7.7.7-${commit}`);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(target, "releases", "v7.7.7.json"), "utf8")).commit,
    commit,
  );
  fs.appendFileSync(path.join(source, "src", "delivery", "usage.mjs"), "// edited\n");
  assert.throws(
    () => install({ fromDir: source, target, env, write: () => {} }),
    /uncommitted changes/,
  );
  assert.equal(
    readPointer(target),
    `7.7.7-${commit}`,
    "a refused install leaves the pointer alone",
  );
  // The same id with other content is never overwritten; a broken module never
  // becomes a release, and no staging folder is left behind.
  assert.throws(
    () =>
      publishRelease(
        target,
        `7.7.7-${commit}`,
        new Map([["src/version.mjs", Buffer.from(stub("7.7.7"))]]),
      ),
    /never overwritten/,
  );
  assert.equal(
    fs.existsSync(path.join(target, "dist", `7.7.7-${commit}`, "src", "delivery", "usage.mjs")),
    true,
    "the installed release is intact",
  );
  assert.throws(
    () =>
      publishRelease(
        target,
        "7.7.8-abcdef0",
        new Map([["src/version.mjs", Buffer.from("export const = ;\n")]]),
      ),
    /fails node --check/,
  );
  assert.deepEqual(
    fs.readdirSync(path.join(target, "dist")).filter((name) => name.startsWith(".staging")),
    [],
  );
  assert.equal(fs.existsSync(path.join(target, "dist", "7.7.8-abcdef0")), false);
  assert.throws(() => publishRelease(target, "not-a-release", new Map()), /invalid release id/);
  assert.throws(() => flipPointer(target, "../elsewhere"), /invalid release id/);
});

test("install fails before publishing when git cannot read the source index", (t) => {
  const root = scratch(t);
  const source = path.join(root, "dev"),
    target = path.join(root, "live");
  devCopy(source, "9.9.9");
  initRepository(source, IDENTITY);
  gitIn(source, "add", "-A");
  gitIn(source, "commit", "-q", "-m", "fixture");
  fs.appendFileSync(path.join(source, "src", "version.mjs"), "// uncommitted\n");
  fs.writeFileSync(path.join(source, ".git", "index"), "corrupt index\n");
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: source,
    encoding: "utf8",
    windowsHide: true,
    env: gitEnvironment(),
  });
  assert.notEqual(status.status, 0);
  assert.throws(
    () => install({ fromDir: source, target, env: installEnv(root), write() {} }),
    /cannot establish source cleanliness: git status/,
  );
  assert.equal(fs.existsSync(target), false);
});

test("install rejects a linked source directory before following its files", (t) => {
  const root = scratch(t);
  const source = path.join(root, "dev"),
    target = path.join(root, "live");
  const external = path.join(root, "external-src");
  devCopy(source, "9.9.9");
  initRepository(source, IDENTITY);
  gitIn(source, "add", "-A");
  gitIn(source, "commit", "-q", "-m", "fixture");
  fs.renameSync(path.join(source, "src"), external);
  fs.symlinkSync(external, path.join(source, "src"), IS_WINDOWS ? "junction" : "dir");
  try {
    assert.throws(
      () => install({ fromDir: source, target, env: installEnv(root), write() {} }),
      /source entry must be a regular file or directory/,
    );
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.unlinkSync(path.join(source, "src"));
  }
});

test("install rejects a clean committed symlink even when its external target changes", (t) => {
  const root = scratch(t);
  const source = path.join(root, "dev"),
    target = path.join(root, "live");
  const external = path.join(root, "external.mjs"),
    link = path.join(source, "src", "roles.mjs");
  devCopy(source, "9.9.9");
  fs.copyFileSync(link, external);
  fs.unlinkSync(link);
  try {
    fs.symlinkSync(external, link, "file");
  } catch (error) {
    if (IS_WINDOWS && [ERRNO.EPERM, ERRNO.EACCES].includes(error.code)) {
      t.skip("file symlinks require Windows privileges");
      return;
    }
    throw error;
  }
  try {
    initRepository(source, IDENTITY);
    gitIn(source, "config", "core.symlinks", "true");
    gitIn(source, "add", "-A");
    gitIn(source, "commit", "-q", "-m", "fixture");
    fs.appendFileSync(external, "\nexport const outsideChange = true;\n");
    assert.equal(gitIn(source, "status", "--porcelain"), "");
    assert.throws(
      () => install({ fromDir: source, target, env: installEnv(root), write() {} }),
      /source entry must be a regular file or directory/,
    );
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.unlinkSync(link);
  }
});

test("install rejects a tracked symlink mode even when checked out as a regular file", (t) => {
  const root = scratch(t);
  const source = path.join(root, "dev"),
    target = path.join(root, "live");
  devCopy(source, "9.9.9");
  initRepository(source, IDENTITY);
  gitIn(source, "config", "core.symlinks", "false");
  fs.writeFileSync(path.join(source, "src", "roles.mjs"), "external.mjs");
  gitIn(source, "add", "-A");
  const blob = gitIn(source, "hash-object", "-w", "src/roles.mjs");
  gitIn(source, "update-index", "--cacheinfo", `120000,${blob},src/roles.mjs`);
  gitIn(source, "commit", "-q", "-m", "fixture");
  assert.equal(gitIn(source, "status", "--porcelain"), "");
  assert.throws(
    () => install({ fromDir: source, target, env: installEnv(root), write() {} }),
    /tracked source must be a regular file: src\/roles\.mjs/,
  );
  assert.equal(fs.existsSync(target), false);
});

test("only a copy that is itself a git checkout is named after a commit: an archive copy inside another repository, untracked or ignored there, is named after its content", (t) => {
  const root = scratch(t);
  const env = installEnv(root);
  const installed = (fromDir, name) => {
    const target = path.join(root, name);
    assert.equal(install({ fromDir, target, env, write: () => {} }), 0);
    const file = path.join(target, "releases", "v9.9.9.json");
    return { id: readPointer(target), commit: JSON.parse(fs.readFileSync(file, "utf8")).commit };
  };
  // The same copy outside any repository gives the content-digest name.
  const outside = path.join(root, "outside");
  devCopy(outside, "9.9.9");
  const expected = installed(outside, "live-outside");
  assert.equal(expected.commit, null);
  // The copy unpacked into a folder of another repository, as git archive | tar -x does.
  const outer = path.join(root, "outer");
  fs.mkdirSync(outer);
  initRepository(outer, IDENTITY);
  fs.writeFileSync(path.join(outer, "outer.txt"), "outer\n");
  gitIn(outer, "add", "-A");
  gitIn(outer, "commit", "-q", "-m", "outer");
  const copy = path.join(outer, "copy");
  devCopy(copy, "9.9.9");
  assert.deepEqual(installed(copy, "live-untracked"), expected, "untracked there: not refused");
  // Ignored there, the enclosing repository looks clean, and its HEAD still does not name the copy.
  fs.writeFileSync(path.join(outer, ".gitignore"), "copy/\n");
  gitIn(outer, "add", ".gitignore");
  gitIn(outer, "commit", "-q", "-m", "Ignore the copy");
  assert.equal(gitIn(outer, "status", "--porcelain"), "");
  assert.deepEqual(installed(copy, "live-ignored"), expected, "ignored there: not its HEAD");
  // A linked worktree, the usual development copy, is a checkout of its own.
  const dev = path.join(root, "dev");
  devCopy(dev, "9.9.9");
  initRepository(dev, IDENTITY);
  gitIn(dev, "add", "-A");
  gitIn(dev, "commit", "-q", "-m", "9.9.9");
  const worktree = path.join(root, "worktree");
  gitIn(dev, "worktree", "add", "-q", "-b", "copy", worktree);
  const commit = gitIn(worktree, "rev-parse", "--short=7", "HEAD");
  assert.deepEqual(installed(worktree, "live-worktree"), { id: `9.9.9-${commit}`, commit });
  fs.appendFileSync(path.join(worktree, "src", "delivery", "usage.mjs"), "// edited\n");
  assert.throws(
    () => install({ fromDir: worktree, target: path.join(root, "live-dirty"), env, write() {} }),
    /uncommitted changes/,
    "a dirty worktree is still refused",
  );
});

test("install stops at a copy whose .git git cannot read as its own checkout, rather than naming the release after its content", (t) => {
  const root = scratch(t);
  const target = path.join(root, "live");
  const refused = (fromDir, pattern) => {
    assert.throws(() => install({ fromDir, target, env: installEnv(root), write() {} }), pattern);
    assert.equal(fs.existsSync(target), false, "nothing was installed");
  };
  // A .git file that points nowhere, as a worktree whose repository moved.
  const moved = path.join(root, "moved");
  devCopy(moved, "9.9.9");
  fs.writeFileSync(
    path.join(moved, ".git"),
    `gitdir: ${path.join(root, "gone", "worktrees", "moved")}\n`,
  );
  refused(
    moved,
    /moved has a \.git, but git cannot inspect it \(git rev-parse --show-toplevel: .+\); repair the checkout, or install from a copy without \.git/,
  );
  // An empty .git folder inside another repository: git reads the outer one.
  const outer = path.join(root, "outer");
  fs.mkdirSync(outer);
  initRepository(outer, IDENTITY);
  fs.writeFileSync(path.join(outer, "outer.txt"), "outer\n");
  gitIn(outer, "add", "-A");
  gitIn(outer, "commit", "-q", "-m", "outer");
  const inner = path.join(outer, "inner");
  devCopy(inner, "9.9.9");
  fs.mkdirSync(path.join(inner, ".git"));
  refused(inner, /inner has a \.git, but git reads it as part of .*outer; repair the checkout/);
  // A checkout without a commit yet.
  const fresh = path.join(root, "fresh");
  devCopy(fresh, "9.9.9");
  initRepository(fresh, IDENTITY);
  refused(
    fresh,
    /fresh has a \.git with no commit at HEAD; commit the copy first, so the release names its commit/,
  );
});

test("a folder whose native real path cannot be read still compares as itself", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagents-for-claude-code-same-path-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // As on a RAM disk or a volume mounted without a drive letter.
  t.mock.method(fs.realpathSync, "native", () => {
    throw Object.assign(new Error("native real path unavailable"), { code: ERRNO.EISDIR });
  });
  assert.equal(samePath(dir, path.join(dir, ".")), true, "a checkout is still its own top level");
  assert.equal(samePath(dir, path.dirname(dir)), false);
});

test("a release copies every tracked top-level entry but the entry, so the live checkout matches the release commit", (t) => {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    env: gitEnvironment(),
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    t.skip("not a git checkout");
    return;
  }
  const entries = [
    ...new Set(
      listed.stdout
        .split("\0")
        .filter(Boolean)
        .map((file) => file.split("/")[0]),
    ),
  ];
  assert.ok(entries.includes("src") && entries.includes(RUNNER), entries.join(" "));
  // A tracked entry install does not copy shows as deleted after the release's git steps.
  assert.deepEqual(
    entries.filter((name) => name !== RUNNER && !SOURCES.includes(name)),
    [],
  );
  assert.equal(SOURCES.includes(RUNNER), false, "install replaces the entry on its own");
});
test("install copies a checkout's tracked files only and never writes a file .gitignore excludes; a copy without git leaves its ignored files behind", (t) => {
  const root = scratch(t);
  const env = installEnv(root);
  const ignores = fs.readFileSync(path.join(ROOT, ".gitignore"));
  const localEnv = "GITEA_RUNNER_TOKEN=machine-local\n";
  const prepare = (dir) => {
    devCopy(dir, "9.9.9");
    fs.writeFileSync(path.join(dir, ".gitignore"), ignores);
    fs.mkdirSync(path.join(dir, "ci", "gitea"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ci", "gitea", "compose.yml"), "services: {}\n");
    fs.writeFileSync(path.join(dir, "ci", "gitea", ".env"), "GITEA_RUNNER_TOKEN=copy\n");
    fs.mkdirSync(path.join(dir, "docs", "history", "mcp-probe"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", "history", "mcp-probe", "sleep-server.log"), "a log\n");
    fs.writeFileSync(path.join(dir, "src", "leftover.next.mjs"), "export const staged = 1;\n");
  };
  // A live folder whose ci/gitea/.env holds this machine's settings.
  const live = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "ci", "gitea"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ci", "gitea", ".env"), localEnv);
    return dir;
  };
  const installed = (target, ...names) =>
    names.filter((name) => fs.existsSync(path.join(target, name)));
  const ignored = ["docs/local/sleep-server.log", "src/leftover.next.mjs"];
  // A checkout: its ignored files are untracked, so it is clean and they are no sources.
  const checkout = path.join(root, "checkout");
  prepare(checkout);
  initRepository(checkout, IDENTITY);
  gitIn(checkout, "add", "-A");
  gitIn(checkout, "commit", "-q", "-m", "fixture");
  assert.equal(gitIn(checkout, "status", "--porcelain"), "");
  const fromCheckout = live("live-checkout");
  assert.equal(install({ fromDir: checkout, target: fromCheckout, env, write() {} }), 0);
  const envFile = (target) => fs.readFileSync(path.join(target, "ci", "gitea", ".env"), "utf8");
  assert.equal(envFile(fromCheckout), localEnv);
  assert.equal(
    fs.readFileSync(path.join(fromCheckout, "ci", "gitea", "compose.yml"), "utf8"),
    "services: {}\n",
  );
  assert.deepEqual(installed(fromCheckout, ...ignored), []);
  const release = path.join(fromCheckout, "dist", readPointer(fromCheckout), "src");
  assert.equal(fs.existsSync(path.join(release, "leftover.next.mjs")), false);
  // Tracked by mistake (added by force), the copy's .env still never replaces the target's.
  gitIn(checkout, "add", "-f", "ci/gitea/.env");
  gitIn(checkout, "commit", "-q", "-m", "Track a machine-local file by mistake");
  const out = lines();
  assert.equal(install({ fromDir: checkout, target: fromCheckout, env, write: out.write }), 0);
  assert.match(out.text(), /^left 1 ignored file alone: ci\/gitea\/\.env$/m);
  assert.equal(envFile(fromCheckout), localEnv);
  // A copy without git: the files its .gitignore excludes stay behind.
  const copy = path.join(root, "copy");
  prepare(copy);
  const fromCopy = live("live-copy");
  assert.equal(install({ fromDir: copy, target: fromCopy, env, write() {} }), 0);
  assert.equal(envFile(fromCopy), localEnv);
  assert.deepEqual(installed(fromCopy, ...ignored), []);
  assert.equal(fs.existsSync(path.join(fromCopy, "ci", "gitea", "compose.yml")), true);
});

test("the .gitignore reader of copies without git agrees with git check-ignore", (t) => {
  const root = scratch(t);
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    [
      fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"),
      "/rooted.txt",
      "doc/**/*.tmp",
      "**/cache",
      "logs/**",
      "*.log",
      "!keep.log",
      "a?c.txt",
      "[xy]z.md",
      "[!q]w.md",
      "\\#hash",
      "nested/inner/",
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(
    path.join(root, "sub", ".gitignore"),
    "local.txt\n/only-here.txt\n!important.log\n",
  );
  const names = [
    "results/a.md",
    "x/results/a.md",
    "node_modules/p/index.js",
    "docs/local/sleep-server.log",
    "docs/local/other.md",
    "src/run.next.mjs",
    "dist/current",
    "ci/gitea/.env",
    "ci/gitea/.env.example",
    "ci/.env",
    "rooted.txt",
    "sub/rooted.txt",
    "doc/a/b/c.tmp",
    "doc/c.tmp",
    "other/doc/c.tmp",
    "cache/x",
    "a/b/cache/y",
    "logs/x/y.txt",
    "x/logs/y.txt",
    "app.log",
    "keep.log",
    "abc.txt",
    "abbc.txt",
    "xz.md",
    "zz.md",
    "qw.md",
    "rw.md",
    "#hash",
    "nested/inner/file",
    "sub/local.txt",
    "sub/deeper/local.txt",
    "local.txt",
    "sub/only-here.txt",
    "sub/deeper/only-here.txt",
    "sub/important.log",
    "important.log",
    "src/index.mjs",
    "README.md",
  ];
  initRepository(root, IDENTITY);
  const checked = spawnSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
    cwd: root,
    input: `${names.join("\0")}\0`,
    encoding: "utf8",
    windowsHide: true,
    env: gitEnvironment(),
  });
  assert.equal(checked.error, undefined);
  const byGit = new Set(checked.stdout.split("\0").filter(Boolean));
  const ignored = ignoreRules(root);
  assert.deepEqual(
    names.filter((name) => ignored(name)),
    names.filter((name) => byGit.has(name)),
  );
  assert.ok(byGit.has("ci/gitea/.env") && byGit.size > 10, [...byGit].join(" "));
});

test("no file this repository tracks is one its .gitignore excludes, so install never leaves a release file behind", (t) => {
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: gitEnvironment(),
      windowsHide: true,
    },
  );
  if (listed.status !== 0) {
    t.skip("not a git checkout");
    return;
  }
  assert.equal(listed.stdout, "");
});
