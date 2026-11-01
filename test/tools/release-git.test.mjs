// How the release tool asks git: the environment it keeps, an inherited GIT_DIR, and git
// failures, never taken for an answer.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { initRepository } from "../support/git-environment.mjs";
import {
  check,
  install,
  isReadOnly,
  readPointer,
  releaseFilesFromTag,
  rollback,
  tag,
  verify,
} from "../../tools/release.mjs";
import { cleanGitEnvironment } from "../../tools/distribution.mjs";
import { ERRNO, EXIT, SIGNALS } from "../../src/shared/errors.mjs";
import {
  SCRIPT,
  RUNNER,
  stub,
  scratch,
  IDENTITY,
  gitIn,
  lines,
  devCopy,
  installEnv,
  taggableRepo,
} from "../support/release-fixture.mjs";

test("the release tool's git keeps the variables that choose git's configuration files, so a release function called in-process reads the suite's private global file", (t) => {
  assert.deepEqual(
    Object.keys(
      cleanGitEnvironment({
        PATH: "path",
        GIT_DIR: "dir",
        GIT_WORK_TREE: "tree",
        GIT_INDEX_FILE: "index",
        GIT_COMMITTER_NAME: "name",
        GIT_CONFIG_PARAMETERS: "'log.showsignature=true'",
        GIT_CONFIG_GLOBAL: "global",
        GIT_CONFIG_SYSTEM: "system",
        git_config_nosystem: "1",
      }),
    ).sort(),
    ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "PATH", "git_config_nosystem"],
  );
  const root = scratch(t);
  const repo = path.join(root, "repo");
  const env = taggableRepo(root, repo, "8.8.9");
  // No identity of its own: the tagger comes from the global file git reads.
  gitIn(repo, "config", "--unset", "user.name");
  gitIn(repo, "config", "--unset", "user.email");
  const global = path.join(root, "suite.gitconfig");
  fs.writeFileSync(global, "[user]\n\tname = Suite Global\n\temail = suite-global@localhost\n");
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = global;
  try {
    assert.equal(tag({ root: repo, env, write: () => {} }), EXIT.COMPLETED);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = before;
  }
  assert.equal(
    gitIn(repo, "for-each-ref", "refs/tags/v8.8.9", "--format=%(taggername) %(taggeremail)"),
    "Suite Global <suite-global@localhost>",
  );
});

test("the release tool ignores an inherited GIT_DIR: tag, install and verify act on their own repository and leave the exported one unchanged", (t) => {
  const root = scratch(t);
  // The repository a hook, a wrapper or an agent shell exported: its refs and config stay as they are.
  const sentinel = path.join(root, "sentinel");
  fs.mkdirSync(sentinel);
  initRepository(sentinel, IDENTITY);
  fs.writeFileSync(path.join(sentinel, "sentinel.txt"), "sentinel\n");
  gitIn(sentinel, "add", "-A");
  gitIn(sentinel, "commit", "-q", "-m", "sentinel");
  const snapshot = () => ({
    refs: gitIn(sentinel, "for-each-ref", "--format=%(refname) %(objectname)"),
    config: fs.readFileSync(path.join(sentinel, ".git", "config"), "utf8"),
    status: gitIn(sentinel, "status", "--porcelain"),
  });
  const before = snapshot();
  const repo = path.join(root, "repo");
  const env = { ...taggableRepo(root, repo, "8.8.8"), GIT_DIR: path.join(sentinel, ".git") };
  const release = (...args) =>
    spawnSync(process.execPath, [path.join(repo, "tools", "release.mjs"), ...args], {
      encoding: "utf8",
      windowsHide: true,
      env,
    });
  const head = gitIn(repo, "rev-parse", "--short", "HEAD");
  const tagged = release("tag");
  assert.equal(tagged.status, EXIT.COMPLETED, tagged.stderr);
  assert.equal(tagged.stdout.trim(), `tagged v8.8.8 at ${head}`);
  assert.equal(
    gitIn(repo, "cat-file", "-t", "v8.8.8"),
    "tag",
    "the tool's own repository is tagged",
  );
  // A git checkout is named after its own commit; a copy that is no checkout after its content.
  const commit = gitIn(repo, "rev-parse", "--short=7", "HEAD");
  const live = path.join(root, "live");
  const fromRepo = release("install", "--from-dir", repo, "--target", live);
  assert.equal(fromRepo.status, EXIT.COMPLETED, fromRepo.stderr);
  assert.equal(readPointer(live), `8.8.8-${commit}`);
  const manifest = () =>
    JSON.parse(fs.readFileSync(path.join(live, "releases", "v8.8.8.json"), "utf8"));
  assert.equal(manifest().commit, commit);
  const plain = path.join(root, "plain");
  devCopy(plain, "8.8.8");
  const fromPlain = release("install", "--from-dir", plain, "--target", live);
  assert.equal(fromPlain.status, EXIT.COMPLETED, fromPlain.stderr);
  assert.equal(manifest().commit, null, "a copy outside any checkout names no commit");
  assert.match(readPointer(live), /^8\.8\.8-[0-9a-f]{7}$/);
  assert.notEqual(readPointer(live), `8.8.8-${commit}`);
  const verified = release("verify", "--target", repo);
  assert.match(verified.stdout, new RegExp(`head=${head} tags=v8\\.8\\.8 `), verified.stderr);
  assert.deepEqual(snapshot(), before, "the exported repository is unchanged");
});

// A live checkout with the tags rollback knows: the one-file runner v0.9.0,
// then the modular v1.0.0 and v1.1.0, with release 1.1.0 installed, so verify
// passes. Returns the checkout and the installed release's id.
function releasedRepo(root) {
  const repo = path.join(root, "live"),
    source = path.join(root, "dev");
  fs.mkdirSync(repo);
  initRepository(repo, IDENTITY);
  fs.writeFileSync(path.join(repo, RUNNER), stub("0.9.0"));
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "0.9.0");
  gitIn(repo, "tag", "-a", "v0.9.0", "-m", "Runner 0.9.0");
  for (const version of ["1.0.0", "1.1.0"]) {
    devCopy(repo, version);
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-q", "-m", version);
    gitIn(repo, "tag", "-a", `v${version}`, "-m", `Runner ${version}`);
  }
  devCopy(source, "1.1.0");
  assert.equal(install({ fromDir: source, target: repo, env: installEnv(root), write() {} }), 0);
  return { repo, id: readPointer(repo) };
}
// Overwrites a loose object of a fixture repository with bytes git cannot
// unpack; returns the function that puts it back.
function corruptObject(repo, object) {
  const file = path.join(repo, ".git", "objects", object.slice(0, 2), object.slice(2));
  assert.ok(fs.existsSync(file), `${object} is a loose object`);
  const bytes = fs.readFileSync(file);
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, "not a git object\n");
  return () => fs.writeFileSync(file, bytes);
}

test("a git failure during rollback, the tag listing or verify fails loudly and is never taken for a missing file", (t) => {
  const root = scratch(t);
  const { repo, id } = releasedRepo(root);
  const entry = fs.readFileSync(path.join(repo, RUNNER));
  const unchanged = (why) => {
    assert.equal(readPointer(repo), id, why);
    assert.deepEqual(fs.readFileSync(path.join(repo, RUNNER)), entry, why);
    assert.equal(isReadOnly(path.join(repo, RUNNER)), true, why);
    assert.deepEqual(fs.readdirSync(path.join(repo, "dist")).sort(), ["current", id].sort(), why);
  };
  const object = (spec) => gitIn(repo, "rev-parse", spec);
  // A version module git cannot read: the tag still holds one, so it is no
  // one-file runner tag, and nothing is rolled back.
  let restore = corruptObject(repo, object("v1.0.0:src/version.mjs"));
  const unreadable = /git cat-file --batch: could not read [0-9a-f]+ \([0-9a-f]+ missing\)/;
  const out = lines();
  assert.throws(() => rollback("1.0.0", { target: repo, write: out.write }), unreadable);
  assert.doesNotMatch(out.text(), /one-file runner/);
  unchanged("a blob git cannot read rolls nothing back");
  assert.throws(() => releaseFilesFromTag("refs/tags/v1.0.0", repo), unreadable);
  restore();
  // A tree git cannot read: the listing fails, it never comes back shorter.
  restore = corruptObject(repo, object("v1.0.0:src"));
  const listing =
    /^Error: git ls-tree -r -z refs\/tags\/v1\.0\.0 -- (?:run-codex-task\.mjs )?src LICENSE NOTICE: .+/;
  assert.throws(() => releaseFilesFromTag("refs/tags/v1.0.0", repo), listing);
  assert.throws(() => rollback("1.0.0", { target: repo, write() {} }), listing);
  unchanged("a tree git cannot read rolls nothing back");
  restore();
  // verify: HEAD's files git cannot read fail it; none is reported as a difference.
  for (const spec of ["HEAD:src/version.mjs", "HEAD:src"]) {
    restore = corruptObject(repo, object(spec));
    const verified = lines();
    assert.throws(
      () => verify({ target: repo, write: verified.write }),
      /^Error: git (?:cat-file --batch: could not read|ls-tree -r -z HEAD -- src LICENSE NOTICE: )/,
      spec,
    );
    assert.equal(verified.text(), "", `${spec}: no verdict is printed`);
    restore();
  }
  assert.equal(verify({ target: repo, write() {} }), EXIT.COMPLETED, "the repository reads again");
  assert.equal(rollback("1.0.0", { target: repo, write() {} }), EXIT.COMPLETED);
  assert.equal(rollback("1.1.0", { target: repo, write() {} }), EXIT.COMPLETED);
  assert.equal(readPointer(repo), id);
  // A folder git cannot read as a repository: a failure, not "no tag".
  const plain = path.join(root, "plain");
  fs.mkdirSync(plain);
  assert.throws(
    () => rollback("1.0.0", { target: plain, write() {} }),
    (error) => /not a git repository/i.test(error.message) && !/no tag/.test(error.message),
  );
});

test("git that cannot run fails the release commands with that reason, never as a missing tag, file or commit", (t) => {
  const root = scratch(t);
  const { repo, id } = releasedRepo(root);
  const entry = fs.readFileSync(path.join(repo, RUNNER));
  const noGit = path.join(root, "no-git");
  fs.mkdirSync(noGit);
  // The command line, with a PATH that holds no git.
  const env = installEnv(root);
  for (const name of Object.keys(env)) if (name.toUpperCase() === "PATH") delete env[name];
  env.PATH = noGit;
  for (const args of [
    ["rollback", "1.0.0", "--target", repo],
    ["verify", "--target", repo],
  ]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      windowsHide: true,
      env,
    });
    assert.equal(result.status, EXIT.FAILURE, args.join(" "));
    assert.match(result.stderr, /^release: git .+: could not run git: /, args.join(" "));
    assert.doesNotMatch(result.stderr, /no tag|differs from HEAD|one-file runner/, args.join(" "));
  }
  assert.equal(readPointer(repo), id);
  assert.deepEqual(fs.readFileSync(path.join(repo, RUNNER)), entry);
  // In-process: install from a checkout names git, not a broken checkout, and
  // check, which cannot list a checkout's tracked files without it, says so,
  // and that it could not ask about the tags.
  const dev = path.join(root, "checkout");
  const checkEnv = taggableRepo(root, dev, "8.8.8");
  const saved = process.env.PATH;
  process.env.PATH = noGit;
  try {
    assert.throws(
      () => install({ fromDir: dev, target: path.join(root, "target"), env: checkEnv, write() {} }),
      (error) =>
        /^git rev-parse --show-toplevel: could not run git: /.test(error.message) &&
        !/repair the checkout/.test(error.message),
    );
    const out = lines();
    assert.equal(check({ root: dev, env: checkEnv, write: out.write }), EXIT.FAILURE, out.text());
    assert.match(out.text(), /^problem: git ls-files --stage -z -- .+: could not run git: /m);
    assert.match(
      out.text(),
      /^warning: could not tell whether the newest release manifest has its tag: git tag --list v\*: could not run git: /m,
    );
  } finally {
    process.env.PATH = saved;
  }
  assert.equal(fs.existsSync(path.join(root, "target")), false, "nothing was installed");
});

// spawnSync, answering every git call with answer() while fn runs. The release
// tool imports it by name, so the builtin's named export is synced to the mock
// and back (syncBuiltinESMExports); every other command runs as it would.
function gitAnswers(t, answer, fn) {
  const real = childProcess.spawnSync;
  const mocked = t.mock.method(childProcess, "spawnSync", (command, args, options) =>
    command === "git" ? answer() : real(command, args, options),
  );
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
}

test("a git that ran and was cut off, its output over the limit or killed, is a git failure; only one that could not start is git that cannot run", (t) => {
  const root = scratch(t);
  const repo = path.join(root, "repo");
  devCopy(repo, "7.7.7");
  initRepository(repo, IDENTITY);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "7.7.7");
  gitIn(repo, "tag", "-a", "v7.7.7", "-m", "Runner 7.7.7");
  const spawnError = (code) => () => ({
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: code === ERRNO.ENOBUFS ? SIGNALS.SIGTERM : null,
    error: Object.assign(new Error(`spawnSync git ${code}`), { code }),
  });
  const killed = () => ({
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: SIGNALS.SIGKILL,
  });
  const rolledBack = (answer) =>
    gitAnswers(t, answer, () => rollback("7.7.7", { target: repo, write() {} }));
  // Output over the limit (ENOBUFS): a failure with that reason, no "could not
  // run git", and never "no tag".
  assert.throws(
    () => rolledBack(spawnError(ERRNO.ENOBUFS)),
    new RegExp(
      `^Error: git rev-parse --verify --quiet refs/tags/v7\\.7\\.7: spawnSync git ${ERRNO.ENOBUFS}$`,
    ),
  );
  // Killed without a spawn error: the probe's status is no answer either.
  assert.throws(
    () => rolledBack(killed),
    new RegExp(
      `^Error: git rev-parse --verify --quiet refs/tags/v7\\.7\\.7: killed by ${SIGNALS.SIGKILL}$`,
    ),
  );
  // A git that could not start, not found or not allowed to run, is git that
  // cannot run.
  for (const code of [ERRNO.ENOENT, ERRNO.EACCES, ERRNO.EPERM])
    assert.throws(
      () => rolledBack(spawnError(code)),
      new RegExp(`: could not run git: spawnSync git ${code}$`),
      code,
    );
  // A step that explains git's failures in its own words explains a cut-off
  // git too, where it passes one that cannot run through unchanged.
  const dev = path.join(root, "dev");
  devCopy(dev, "7.7.8");
  initRepository(dev, IDENTITY);
  gitIn(dev, "add", "-A");
  gitIn(dev, "commit", "-q", "-m", "7.7.8");
  const installed = (answer) =>
    gitAnswers(t, answer, () =>
      install({ fromDir: dev, target: path.join(root, "live"), env: installEnv(root), write() {} }),
    );
  assert.throws(
    () => installed(spawnError(ERRNO.ENOBUFS)),
    new RegExp(
      `has a \\.git, but git cannot inspect it \\(git rev-parse --show-toplevel: spawnSync git ${ERRNO.ENOBUFS}\\); repair the checkout`,
    ),
  );
  assert.throws(
    () => installed(spawnError(ERRNO.ENOENT)),
    /^Error: git rev-parse --show-toplevel: could not run git: /,
  );
  assert.equal(fs.existsSync(path.join(root, "live")), false, "nothing was installed");
  // The mock is gone: the real git answers again.
  assert.equal(rollback("7.7.7", { target: repo, write() {} }), EXIT.COMPLETED);
});
