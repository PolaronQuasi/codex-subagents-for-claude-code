#!/usr/bin/env node
// The suite's one test discovery: every *.test.mjs under test/,
// recursively, with fixture folders left out (they hold sample data and fake
// executables, never this repository's tests). npm test, the pre-push hook,
// tools/ci.mjs and the release tool's syntax walk all use it, so a nested
// test is run and checked like any other.
//   node tools/test-files.mjs        prints the test files, one per line
//   node tools/test-files.mjs run    runs them with node --test
// run passes the options after it to node --test, before the files, and test
// files named after it (relative to the repository, where npm runs it)
// replace the discovery: npm test -- --test-name-pattern=paths, or
// npm test -- test/paths.test.mjs. An argument that does not start with -
// must name an existing file, so an option's value goes after =; any other is
// refused, and node --test's own discovery, which would run the fixtures
// too, never runs.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT } from "../src/shared/errors.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
export const ROOT = path.dirname(path.dirname(SCRIPT));
// The folders that hold tests, the name of a folder that holds fixtures, and
// how many test files node runs at once.
const TEST_FOLDERS = ["test"];
const FIXTURES = "fixtures";
const TEST_CONCURRENCY = 2;
const USAGE = "usage: node tools/test-files.mjs [run [node --test options] [test files]]";

// Every .mjs file under folder of root, recursively, as sorted POSIX paths
// relative to root; folders named in skip are left out at any depth.
export function moduleFiles(root, folder, { skip = [] } = {}) {
  const found = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, folder, relative), { withFileTypes: true });
    } catch (error) {
      if (relative === "" && !fs.existsSync(path.join(root, folder))) return;
      throw error;
    }
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skip.includes(entry.name)) walk(name);
      } else if (entry.isFile() && entry.name.endsWith(".mjs")) found.push(`${folder}/${name}`);
    }
  };
  walk("");
  return found.sort();
}

// The test files of root: *.test.mjs under test/, recursively,
// fixture folders left out.
export const testFiles = (root = ROOT) =>
  TEST_FOLDERS.flatMap((folder) => moduleFiles(root, folder, { skip: [FIXTURES] }))
    .filter((file) => file.endsWith(".test.mjs"))
    .sort();

// The arguments that run root's suite: node --test with the options given,
// then the test files given, or else every one the discovery finds. A given
// file that does not exist (an option's value given without =, a mistyped
// path) throws: node --test would take it for a pattern and, matching
// nothing, fall back to its own discovery.
export function testArguments(root = ROOT, given = []) {
  const options = given.filter((argument) => argument.startsWith("-"));
  const files = given.filter((argument) => !argument.startsWith("-"));
  const unknown = files.filter(
    (file) => !fs.statSync(path.resolve(root, file), { throwIfNoEntry: false })?.isFile(),
  );
  if (unknown.length)
    throw new Error(`no such test file: ${unknown.join(", ")} (an option's value goes after =)`);
  return [
    "--test",
    `--test-concurrency=${TEST_CONCURRENCY}`,
    `--import=${new URL("../test/support/hermetic.mjs", import.meta.url).href}`,
    ...options,
    ...(files.length ? files : testFiles(root)),
  ];
}

// Node loads the main module from its real path, so through a directory
// junction or symlink process.argv[1] names another path to this same file.
const sameFile = (a, b) => {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
};
if (
  process.argv[1] &&
  (path.resolve(process.argv[1]) === SCRIPT || sameFile(process.argv[1], SCRIPT))
) {
  const [command, ...given] = process.argv.slice(2);
  if (command === undefined) console.log(testFiles().join("\n"));
  else if (command === "run") {
    let args = null;
    try {
      args = testArguments(ROOT, given);
    } catch (error) {
      console.error(`${error.message}\n${USAGE}`);
      process.exitCode = EXIT.FAILURE;
    }
    if (args) {
      const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
      if (result.error) console.error(result.error.message);
      process.exitCode = result.status ?? EXIT.FAILURE;
    }
  } else {
    console.error(USAGE);
    process.exitCode = EXIT.FAILURE;
  }
}
