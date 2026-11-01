import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ROOT, testArguments, testFiles } from "../../tools/test-files.mjs";
import { checkedFiles } from "../../tools/release.mjs";
import { EXIT } from "../../src/shared/errors.mjs";

const planted = (title) =>
  `import test from "node:test";\ntest(${JSON.stringify(title)}, () => {});\n`;
const TITLES = ["planted top-level test", "planted nested test", "planted tool test"];

// The discovery, with the one runner module it imports, beside a planted tree:
// a top-level, a nested and a tool test, a support module and a fixture test.
function plantTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagents-for-claude-code-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  };
  for (const name of ["tools/test-files.mjs", "src/shared/errors.mjs", "test/support/hermetic.mjs"])
    write(name, fs.readFileSync(path.join(ROOT, name)));
  write("test/top.test.mjs", planted(TITLES[0]));
  write("test/x/y.test.mjs", planted(TITLES[1]));
  write("test/x/support.mjs", "export const support = true;\n");
  write("test/fixtures/z.test.mjs", planted("planted fixture"));
  write("test/tools/q.test.mjs", planted(TITLES[2]));
  write("tools/excluded.test.mjs", planted("planted excluded test"));
  const env = { ...process.env };
  // A nested test runner reports to its parent in another format when it inherits this.
  delete env.NODE_TEST_CONTEXT;
  // The command npm test and the pre-push hook run, in the planted tree.
  const cli = path.join(root, "tools", "test-files.mjs");
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, cwd: root });
  return { root, run };
}

test("one discovery finds a nested test for every consumer: npm test, the pre-push hook, ci.mjs and the release tool's syntax walk", (t) => {
  const { root, run } = plantTree(t);
  const expected = ["test/tools/q.test.mjs", "test/top.test.mjs", "test/x/y.test.mjs"];
  assert.deepEqual(testFiles(root), expected, "nested tests found, fixture folders left out");
  // The command lists and runs the same files.
  const listed = run();
  assert.deepEqual(listed.stdout.trim().split("\n"), expected, listed.stderr);
  const ran = run("run");
  assert.equal(ran.status, EXIT.COMPLETED, ran.stdout + ran.stderr);
  for (const title of TITLES) assert.match(ran.stdout, new RegExp(title), title);
  assert.doesNotMatch(ran.stdout, /planted fixture|planted excluded test/);
  // The release tool's syntax walk checks every module at any depth, the
  // fixtures' too.
  const checked = checkedFiles(root);
  for (const name of [...expected, "test/x/support.mjs", "test/fixtures/z.test.mjs"])
    assert.ok(checked.includes(name), name);
  // Every consumer runs this discovery; none keeps a list or a glob of its own.
  const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
  assert.equal(JSON.parse(read("package.json")).scripts.test, "node tools/test-files.mjs run");
  assert.match(read(".githooks/pre-push"), /^exec node tools\/test-files\.mjs run$/m);
  assert.match(read("tools/ci.mjs"), /import \{ testArguments \} from "\.\/test-files\.mjs";/);
  assert.match(read("tools/ci.mjs"), /command\(\s*process\.execPath,\s*testArguments\(ROOT[,)]/);
  for (const name of ["package.json", ".githooks/pre-push", "tools/ci.mjs", "tools/release.mjs"])
    assert.doesNotMatch(read(name), /\*\.test\.mjs/, `${name} keeps no glob of its own`);
  for (const name of [".githooks/pre-push", "tools/ci.mjs"])
    assert.doesNotMatch(read(name), /node --test |"--test"/, `${name} runs no suite of its own`);
});

test("run passes its options to node --test before the files, and test files named after it replace the discovery", (t) => {
  const { root, run } = plantTree(t);
  const only = (result, title) => {
    assert.equal(result.status, EXIT.COMPLETED, result.stdout + result.stderr);
    for (const other of TITLES)
      (other === title ? assert.match : assert.doesNotMatch)(result.stdout, new RegExp(other));
  };
  // npm test -- --test-name-pattern=nested, and npm test -- test/tools/q.test.mjs
  only(run("run", "--test-name-pattern=nested"), TITLES[1]);
  only(run("run", "test/tools/q.test.mjs"), TITLES[2]);
  only(run("run", "test/top.test.mjs", "--test-name-pattern=top"), TITLES[0]);
  assert.deepEqual(
    testArguments(root, ["test/tools/q.test.mjs", "--test-name-pattern=tool"]).slice(3),
    ["--test-name-pattern=tool", "test/tools/q.test.mjs"],
    "the options first, then the files given",
  );
  assert.deepEqual(testArguments(root, ["--test-only"]).slice(3), [
    "--test-only",
    ...testFiles(root),
  ]);
});

test("run refuses an argument that names no test file, so node --test never falls back to its own discovery", (t) => {
  const { run } = plantTree(t);
  // An option's value given without =, which node --test would take for a
  // pattern and, matching nothing, run its own discovery: the fixtures too.
  const refused = run("run", "--test-name-pattern", "zzz");
  assert.equal(refused.status, EXIT.FAILURE, refused.stdout + refused.stderr);
  assert.equal(refused.stdout, "", "nothing ran");
  assert.match(refused.stderr, /^no such test file: zzz /m);
  assert.match(refused.stderr, /^usage: node tools\/test-files\.mjs /m);
  for (const name of ["test/missing.test.mjs", "test/x"])
    assert.equal(run("run", name).status, EXIT.FAILURE, `${name} is no test file`);
  // With its value after =, the option filters the discovered tests: none
  // is named zzz, and no fixture runs.
  const filtered = run("run", "--test-name-pattern=zzz");
  assert.equal(filtered.status, EXIT.COMPLETED, filtered.stdout + filtered.stderr);
  assert.doesNotMatch(filtered.stdout, /planted|fixtures/);
});
