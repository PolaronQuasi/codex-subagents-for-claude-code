// check and the hooks' gates: the release-file rule, machine paths, text hygiene, the skill's
// role list, the scanned files, and the pre-commit and pre-push gates.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { initRepository } from "../support/git-environment.mjs";
import {
  check,
  checkedFiles,
  contentDigest,
  isReleaseFile,
  machinePaths,
  pluginProblems,
  preCommit,
  prePush,
  ROOT,
  skillRoles,
  sourceHygiene,
  sourceInventory,
} from "../../tools/release.mjs";
import { ROLES, RUNNER_VERSION } from "../../run-codex-task.mjs";
import { byCodeUnit } from "../../tools/distribution.mjs";
import { EXIT } from "../../src/shared/errors.mjs";
import {
  node,
  scratch,
  IDENTITY,
  gitIn,
  lines,
  devCopy,
  installEnv,
  hookEnv,
  gitTry,
  taggableRepo,
} from "../support/release-fixture.mjs";

test("the pre-commit hook judges what is committed: a file check reads with unstaged changes, or untracked, is refused, and commit -a of the same change passes", (t) => {
  const root = scratch(t);
  const repo = path.join(root, "repo");
  taggableRepo(root, repo, "8.8.8");
  gitIn(repo, "config", "core.hooksPath", ".githooks");
  const env = hookEnv(root);
  const commit = (...args) => gitTry(repo, ["commit", "-q", ...args], env);
  const commits = () => gitIn(repo, "rev-list", "--count", "HEAD");
  fs.appendFileSync(path.join(repo, "README.md"), "Unstaged.\n");
  fs.appendFileSync(path.join(repo, "NOTICE"), "Staged.\n");
  gitIn(repo, "add", "NOTICE");
  let result = commit("-m", "Only NOTICE staged");
  assert.notEqual(result.status, 0, "refused");
  assert.match(
    result.stdout + result.stderr,
    /problem: README\.md has unstaged changes: stage them \(git add\) or stash them/,
  );
  assert.equal(commits(), "1", "nothing was committed");
  // commit -a hands the hook a temporary index that holds README.md too.
  result = commit("-a", "-m", "Both");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(commits(), "2");
  // An untracked file among the checked paths is refused; one outside them is not.
  fs.writeFileSync(path.join(repo, "src", "extra.mjs"), "export const extra = 1;\n");
  fs.appendFileSync(path.join(repo, "docs", "MANUAL.md"), "More.\n");
  result = commit("-a", "-m", "With an untracked module beside it");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /problem: src\/extra\.mjs is untracked: add it, or move it out of the checked paths/,
  );
  assert.equal(commits(), "2");
  fs.rmSync(path.join(repo, "src", "extra.mjs"));
  fs.writeFileSync(path.join(repo, "REPORT.md"), "Someone's notes.\n");
  result = commit("-a", "-m", "With a report outside the checked paths");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(commits(), "3");
});

test("the pre-push gate passes HEAD, or commits the remote already has, and only while the checked files equal HEAD's", (t) => {
  const root = scratch(t);
  const repo = path.join(root, "repo");
  const env = taggableRepo(root, repo, "8.8.8");
  const base = gitIn(repo, "rev-parse", "HEAD");
  fs.appendFileSync(path.join(repo, "docs", "MANUAL.md"), "Later.\n");
  gitIn(repo, "commit", "-q", "-am", "Later");
  const head = gitIn(repo, "rev-parse", "HEAD");
  gitIn(repo, "tag", "-a", "v8.8.8", "-m", "Runner 8.8.8");
  const zero = "0".repeat(40);
  const push = (refs) => {
    const out = lines();
    const code = prePush({ root: repo, env, remote: "origin", refs, write: out.write });
    return { code, text: out.text() };
  };
  let result = push([`refs/heads/side ${base} refs/heads/side ${zero}`]);
  assert.equal(result.code, EXIT.FAILURE);
  assert.match(
    result.text,
    new RegExp(
      `problem: refs/heads/side pushes ${base.slice(0, 7)}, not HEAD ${head.slice(0, 7)}: the hook checks the working tree at HEAD`,
    ),
  );
  // HEAD, a tag on it, a deletion and a commit the remote already has all pass.
  gitIn(repo, "update-ref", "refs/remotes/origin/main", base);
  result = push([
    `refs/heads/main ${head} refs/heads/main ${base}`,
    `refs/tags/v8.8.8 ${gitIn(repo, "rev-parse", "v8.8.8")} refs/tags/v8.8.8 ${zero}`,
    `(delete) ${zero} refs/heads/old ${base}`,
    `refs/heads/side ${base} refs/heads/side ${zero}`,
  ]);
  assert.equal(result.code, EXIT.COMPLETED, result.text);
  // The checked files must equal HEAD's: a staged change and an untracked module are refused.
  fs.appendFileSync(path.join(repo, "README.md"), "Staged.\n");
  gitIn(repo, "add", "README.md");
  fs.writeFileSync(path.join(repo, "src", "extra.mjs"), "export const extra = 1;\n");
  result = push([`refs/heads/main ${head} refs/heads/main ${base}`]);
  assert.equal(result.code, EXIT.FAILURE);
  assert.match(
    result.text,
    /problem: README\.md differs from HEAD: commit or stash it before pushing/,
  );
  assert.match(result.text, /problem: src\/extra\.mjs is untracked/);
  // Through git itself, the hook refuses before anything reaches the remote.
  const remote = path.join(root, "remote.git");
  gitIn(root, "init", "-q", "--bare", remote);
  gitIn(repo, "remote", "add", "origin", remote);
  gitIn(repo, "config", "core.hooksPath", ".githooks");
  const pushed = gitTry(repo, ["push", "-q", "origin", "main"], hookEnv(root));
  assert.notEqual(pushed.status, 0);
  assert.match(pushed.stdout + pushed.stderr, /problem: README\.md differs from HEAD/);
  assert.equal(gitIn(remote, "for-each-ref"), "", "nothing reached the remote");
});

test("source hooks isolate definition checks from configured installations and clean temporary files on success and rendering failure", (t) => {
  const root = scratch(t);
  const repo = path.join(root, "repo");
  const env = taggableRepo(root, repo, "8.8.8");
  const trace = path.join(root, "hook-rendering.jsonl");
  env.HOOK_TEST_TRACE = trace;
  // An installed definition can differ because it belongs to another checkout.
  const installed = path.join(env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR, "SKILL.md");
  fs.writeFileSync(installed, "keep the user's installed skill\n");
  const installer = path.join(repo, "install.mjs");
  fs.appendFileSync(
    installer,
    "\n" +
      [
        "fs.appendFileSync(process.env.HOOK_TEST_TRACE, JSON.stringify({",
        "  agents: process.env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR,",
        "  skill: process.env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR,",
        '}) + "\\n");',
        'if (process.env.HOOK_TEST_FAIL === "yes") throw new Error("fixture render failed");',
        "",
      ].join("\n"),
  );
  gitIn(repo, "add", "install.mjs");
  gitIn(repo, "commit", "-q", "-m", "Instrument rendering");
  for (const gate of [preCommit, prePush]) {
    for (const fail of [false, true]) {
      fs.writeFileSync(trace, "");
      const out = lines();
      const code = gate({
        root: repo,
        env: { ...env, HOOK_TEST_FAIL: fail ? "yes" : "no" },
        write: out.write,
      });
      assert.equal(code, fail ? EXIT.FAILURE : EXIT.COMPLETED, out.text());
      if (fail)
        assert.match(
          out.text(),
          /temporary agent\/skill rendering failed.*\n.*fixture render failed/s,
        );
      const calls = fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(
        calls.length,
        fail ? 1 : 2,
        "render then check; rendering failure stops the gate",
      );
      for (const call of calls) {
        assert.notEqual(call.agents, env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR);
        assert.notEqual(call.skill, env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR);
        assert.equal(path.dirname(call.agents), path.dirname(call.skill));
        assert.equal(
          fs.existsSync(path.dirname(call.agents)),
          false,
          "owned temporary root cleaned",
        );
      }
      assert.equal(fs.readFileSync(installed, "utf8"), "keep the user's installed skill\n");
    }
  }
});

test("one rule names a release's files, every module under src/ at any depth and the legal files, and every inventory and digest is in code-unit order", () => {
  for (const name of [
    "src/version.mjs",
    "src/process/stop.mjs",
    "src/a/b/c.mjs",
    "src/.hidden.mjs",
    "LICENSE",
    "NOTICE",
  ])
    assert.equal(isReleaseFile(name), true, name);
  for (const name of [
    "src",
    "src/README.md",
    "src/a.js",
    "src/../outside.mjs",
    "src/./version.mjs",
    "srcx/a.mjs",
    "test/a.mjs",
    "run-codex-task.mjs",
    "docs/LICENSE",
  ])
    assert.equal(isReleaseFile(name), false, name);
  // The digest of a copy that is no checkout: names and bytes in code-unit
  // order, whatever order the files came in.
  const digestIn = (order) => {
    const hash = crypto.createHash("sha256");
    for (const [name, bytes] of order) hash.update(name).update("\0").update(bytes).update("\0");
    return hash.digest("hex");
  };
  const files = new Map([
    ["src/d.mjs", Buffer.from("d")],
    ["src/ch.mjs", Buffer.from("ch")],
    ["NOTICE", Buffer.from("n")],
    ["src/c-h.mjs", Buffer.from("c-h")],
    ["LICENSE", Buffer.from("l")],
    ["src/Z.mjs", Buffer.from("Z")],
  ]);
  const codeUnits = [...files].sort(([a], [b]) => byCodeUnit(a, b));
  assert.deepEqual(
    codeUnits.map(([name]) => name),
    ["LICENSE", "NOTICE", "src/Z.mjs", "src/c-h.mjs", "src/ch.mjs", "src/d.mjs"],
  );
  assert.equal(contentDigest(files), digestIn(codeUnits));
  assert.equal(contentDigest(new Map([...files].reverse())), contentDigest(files));
  // A locale's collation would make the name machine-dependent: Czech sorts
  // "ch" after "h", English folds case.
  if (Intl.Collator.supportedLocalesOf(["cs"]).length) {
    const czech = [...files].sort(([a], [b]) => a.localeCompare(b, "cs"));
    assert.notDeepEqual(czech, codeUnits);
    assert.notEqual(contentDigest(files), digestIn(czech));
  }
  // For this repository's own release files, English collation and code-unit
  // order agree; the independent fixture above proves where they differ.
  const own = new Map(
    [...checkedFiles().filter((name) => name.startsWith("src/")), "LICENSE", "NOTICE"].map(
      (name) => [name, fs.readFileSync(path.join(ROOT, name))],
    ),
  );
  assert.equal(contentDigest(own), digestIn([...own].sort(([a], [b]) => a.localeCompare(b, "en"))));
});

test("check names a module under src/ whose .mjs is in another case, which Windows and macOS load but no release holds", (t) => {
  const root = scratch(t);
  const copy = path.join(root, "copy");
  devCopy(copy, "9.9.9");
  fs.mkdirSync(path.join(copy, "src", "nested"));
  fs.writeFileSync(path.join(copy, "src", "Extra.MJS"), "export const EXTRA = 1;\n");
  fs.writeFileSync(path.join(copy, "src", "nested", "other.Mjs"), "export const OTHER = 1;\n");
  // Look-alikes: a module in its case, at any depth, files that are no module,
  // and one outside src/.
  fs.writeFileSync(path.join(copy, "src", "nested", "fine.mjs"), "export const FINE = 1;\n");
  fs.writeFileSync(path.join(copy, "src", "notes.md"), "# notes\n");
  fs.writeFileSync(path.join(copy, "src", "data.mjson"), "{}\n");
  fs.writeFileSync(path.join(copy, "TOP.MJS"), "export const TOP = 1;\n");
  const out = lines();
  assert.equal(check({ root: copy, env: installEnv(root), write: out.write }), EXIT.FAILURE);
  assert.deepEqual(
    out
      .text()
      .split("\n")
      .filter((line) => line.includes("in another case")),
    [
      "problem: src/Extra.MJS ends in .mjs in another case: a release holds only *.mjs, so it would be missing from it; rename it",
      "problem: src/nested/other.Mjs ends in .mjs in another case: a release holds only *.mjs, so it would be missing from it; rename it",
    ],
  );
  assert.ok(checkedFiles(copy).includes("src/nested/fine.mjs"), "a nested module in its case");
  assert.equal(isReleaseFile("src/Extra.MJS"), false, "the release rule tells case");
});

test("check refuses a user-profile path in a tracked source, accepts ~, $HOME and placeholders, and scans only the tracked sources", (t) => {
  const root = scratch(t);
  // Built from parts so this test file itself holds no such path.
  const windows = ["C:", "Users", "someone", ".claude"].join("/");
  const backslashed = ["C:", "Users", "someone", "x"].join("\\");
  const posix = ["", "home", "someone", "x"].join("/");
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "results"));
  fs.writeFileSync(
    path.join(root, "README.md"),
    `ok: ~/.claude/codex-subagents-for-claude-code\nok: "$HOME/.claude"\nok: {{runner}}\nok: C:/Users/<you>/.claude\nbad: ${windows}\n`,
  );
  fs.writeFileSync(path.join(root, "docs", "MANUAL.md"), `bad: ${backslashed}\nbad: ${posix}\n`);
  fs.writeFileSync(
    path.join(root, "results", "old.md"),
    `a result copy may name anything: ${windows}\n`,
  );
  const found = machinePaths(root);
  assert.deepEqual(
    found.map((entry) => entry.split(": ")[0]),
    ["README.md:5", "docs/MANUAL.md:1", "docs/MANUAL.md:2"],
  );
  const out = lines();
  assert.equal(check({ root, write: out.write }), 1);
  assert.match(out.text(), /problem: a machine-specific path in a tracked source .*README\.md:5/);
});

test("text hygiene reports whitespace and newlines without linting JavaScript or scanning results", (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "results"));
  fs.writeFileSync(path.join(root, "README.md"), "one " + "\r\ntwo\t\r\nthree");
  fs.writeFileSync(path.join(root, "src", "example.mjs"), "const arbitraryStyle={works:true};\r\n");
  fs.writeFileSync(path.join(root, "results", "copy.md"), "untouched ");
  assert.deepEqual(sourceHygiene(root), [
    "README.md:1: trailing whitespace",
    "README.md:2: trailing whitespace",
    "README.md: missing final newline",
  ]);
  const out = lines();
  assert.equal(check({ root, write: out.write }), 1);
  assert.match(out.text(), /problem: README.md:1: trailing whitespace/);
  assert.match(out.text(), /problem: README.md: missing final newline/);
});

test("check reports a role the skill's role list lacks and a listed role the runner does not have", (t) => {
  const root = scratch(t);
  const repo = path.join(root, "repo");
  const env = taggableRepo(root, repo, "8.8.8");
  const skill = path.join(repo, "claude", "skills", "codex-subagents-for-claude-code", "SKILL.md");
  const original = fs.readFileSync(skill, "utf8");
  // Each variant is rendered too, so the role list is the only thing check can object to.
  const problems = (text) => {
    fs.writeFileSync(skill, text);
    const rendered = node([path.join(repo, "install.mjs")], { env });
    assert.equal(rendered.status, 0, rendered.stderr);
    const out = lines();
    check({ root: repo, env, write: out.write });
    return out
      .text()
      .split("\n")
      .filter((line) => line.startsWith("problem: "));
  };
  const listed = Object.keys(ROLES)[1];
  assert.ok(original.includes(`\`${listed}\`, `), "the skill lists the roles in one sentence");
  assert.deepEqual(problems(original), []);
  assert.deepEqual(problems(original.replace(`\`${listed}\`, `, "")), [
    `problem: claude/skills/codex-subagents-for-claude-code/SKILL.md does not list the role ${listed}, which the runner's ROLES has (src/roles.mjs)`,
  ]);
  assert.deepEqual(
    problems(original.replace(`\`${listed}\`, `, `\`${listed}\`, \`gpt-0-retired\`, `)),
    [
      "problem: claude/skills/codex-subagents-for-claude-code/SKILL.md lists the role gpt-0-retired, which the runner's ROLES does not have (src/roles.mjs)",
    ],
  );
});

test("check holds the plugin's version to the runner's and its marketplace entry to one listing from the repository root", (t) => {
  assert.deepEqual(pluginProblems(ROOT, RUNNER_VERSION), [], "this repository's plugin");
  const root = scratch(t);
  fs.mkdirSync(path.join(root, ".claude-plugin"));
  const write = (name, value) =>
    fs.writeFileSync(path.join(root, ".claude-plugin", name), JSON.stringify(value));
  const entry = { name: "codex-subagents", source: "./" };
  write("plugin.json", { name: "codex-subagents", version: "1.2.3" });
  write("marketplace.json", { name: "m", owner: { name: "o" }, plugins: [entry] });
  assert.deepEqual(pluginProblems(root, "1.2.3"), []);
  assert.deepEqual(pluginProblems(root, "1.2.4"), [
    ".claude-plugin/plugin.json says 1.2.3, the runner says 1.2.4",
  ]);
  for (const [plugins, problem] of [
    [[], /must list the plugin codex-subagents exactly once/],
    [[entry, entry], /must list the plugin codex-subagents exactly once/],
    [[{ ...entry, source: "./plugin" }], /lists codex-subagents from "\.\/plugin", not "\.\/"/],
    [[{ ...entry, version: "1.2.3" }], /sets a version for codex-subagents; .*plugin\.json alone/],
  ]) {
    write("marketplace.json", { name: "m", owner: { name: "o" }, plugins });
    assert.match(pluginProblems(root, "1.2.3").join("\n"), problem);
  }
  fs.writeFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "{");
  assert.match(pluginProblems(root, "1.2.3").join("\n"), /marketplace\.json is unreadable/);
});

test("the skill's role list is its sentence's role-shaped code spans, however the sentence wraps or ends", () => {
  const wrapped = [
    "Run `node run.mjs`. There is one role per model: `gpt-a-1`,",
    "`gpt-b-2` (shown as `GPT-B.2`) and",
    "`gpt-c-3`. Later text names `gpt-d-4`.",
    "",
  ];
  for (const newline of ["\n", "\r\n"])
    assert.deepEqual(skillRoles(wrapped.join(newline)), ["gpt-a-1", "gpt-b-2", "gpt-c-3"]);
  assert.deepEqual(
    skillRoles("There is one role per model: `gpt-a-1`\n\nThe next paragraph names `gpt-b-2`."),
    ["gpt-a-1"],
    "a blank line ends the list too",
  );
  assert.equal(skillRoles("# A skill without the sentence, `gpt-a-1`\n"), null);
  assert.deepEqual(
    skillRoles(
      fs.readFileSync(
        path.join(ROOT, "claude", "skills", "codex-subagents-for-claude-code", "SKILL.md"),
        "utf8",
      ),
    ),
    Object.keys(ROLES),
  );
});

test("check scans every file install copies, under .gitea and deployment too, in a checkout and in a copy without git", (t) => {
  const root = scratch(t);
  // Built from parts so this test file itself holds no such path.
  const windows = ["C:", "Users", "someone", "work"].join("/");
  const posix = ["", "home", "someone", "cache"].join("/");
  const container = ["", "home", "node", ".cache"].join("/");
  for (const kind of ["checkout", "copy"]) {
    const repo = path.join(root, kind);
    fs.mkdirSync(path.join(repo, ".gitea", "workflows"), { recursive: true });
    fs.mkdirSync(path.join(repo, "ci", "gitea"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".gitea", "workflows", "ci.yml"),
      `on: push\n# made in ${windows}\n`,
    );
    fs.writeFileSync(
      path.join(repo, "ci", "gitea", "compose.yml"),
      `volumes:\n  - ${posix}:/cache\n`,
    );
    // The runner image's own user lives at a container path, the same on every machine.
    fs.writeFileSync(path.join(repo, "ci", "gitea", "Dockerfile"), `RUN mkdir -p ${container}\n`);
    // A machine-local file is no source: never scanned.
    fs.writeFileSync(path.join(repo, ".gitignore"), "ci/gitea/.env\n");
    fs.writeFileSync(path.join(repo, "ci", "gitea", ".env"), `WORK=${windows}\n`);
    if (kind === "checkout") {
      initRepository(repo, IDENTITY);
      gitIn(repo, "add", "-A");
      gitIn(repo, "commit", "-q", "-m", "fixture");
    }
    assert.deepEqual(
      machinePaths(repo).map((entry) => entry.split(": ")[0]),
      [".gitea/workflows/ci.yml:2", "ci/gitea/compose.yml:2"],
      kind,
    );
    const out = lines();
    assert.equal(check({ root: repo, write: out.write }), 1);
    for (const where of [".gitea/workflows/ci.yml:2", "ci/gitea/compose.yml:2"])
      assert.ok(
        out
          .text()
          .includes(
            `problem: a machine-specific path in a tracked source (use ~, $HOME or an install.mjs placeholder): ${where}`,
          ),
        `${kind}: ${where}\n${out.text()}`,
      );
  }
});

test("this repository's own deployment and workflow files are scanned and pass: the runner image's node user home is a container path", (t) => {
  if (!fs.existsSync(path.join(ROOT, ".git"))) {
    t.skip("not a git checkout");
    return;
  }
  const scanned = sourceInventory().map(({ name }) => name);
  for (const name of [
    "ci/gitea/Dockerfile",
    "ci/gitea/compose.yml",
    "ci/gitea/config.yaml",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ])
    assert.ok(scanned.includes(name), `${name} is in the scan`);
  assert.ok(
    fs
      .readFileSync(path.join(ROOT, "ci", "gitea", "Dockerfile"), "utf8")
      .includes(["", "home", "node", ".cache"].join("/")),
    "the Dockerfile names the container path the exception is for",
  );
  assert.deepEqual(machinePaths(), []);
  assert.deepEqual(sourceHygiene(), []);
});
