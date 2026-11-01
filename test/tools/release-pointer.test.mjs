// The release tool's pointer and entry: the flip and its retries, the entry's replacement, the
// read-only rule, and the entry loading the release dist/current names.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  flipPointer,
  isReadOnly,
  modeIsReadOnly,
  readPointer,
  replaceRunner,
  ROOT,
  sha256,
} from "../../tools/release.mjs";
import { ERRNO, EXIT } from "../../src/shared/errors.mjs";
import { IS_WINDOWS, RUNNER, stub, node, scratch } from "../support/release-fixture.mjs";

test("pointer retry pauses preserve complete old and new values for both writer and shim reader", async (t) => {
  const root = scratch(t);
  const before = "9.8.0-aaaaaaa",
    after = "9.9.9-bbbbbbb";
  flipPointer(root, before);
  const pointer = path.join(root, "dist", "current");
  const rename = fs.renameSync;
  let writes = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === pointer && writes++ === 0) {
      assert.equal(readPointer(root), before);
      throw Object.assign(new Error("busy"), { code: ERRNO.EBUSY });
    }
    return rename(from, to);
  });
  flipPointer(root, after);
  assert.equal(writes, 2);
  assert.equal(readPointer(root), after);
  const source = path.join(root, "dist", after, "src");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "index.mjs"), stub("9.9.9"));
  const entry = path.join(root, RUNNER);
  fs.copyFileSync(path.join(ROOT, RUNNER), entry);
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === pointer && reads++ === 0)
      throw Object.assign(new Error("busy"), { code: ERRNO.EPERM });
    return read(file, ...args);
  });
  const loaded = await import(pathToFileURL(entry).href);
  assert.equal(loaded.RUNNER_VERSION, "9.9.9");
  assert.equal(reads, 2);
});

test("replaceRunner swaps the live entry in one rename, leaves it read-only, and refuses a broken stage without touching the old file", (t) => {
  const dir = scratch(t);
  const live = path.join(dir, RUNNER);
  fs.writeFileSync(live, stub("1.0.0"));
  fs.chmodSync(live, 0o444);
  const sha = replaceRunner(dir, stub("1.1.0"));
  assert.equal(fs.readFileSync(live, "utf8"), stub("1.1.0"));
  assert.equal(sha, sha256(live));
  assert.equal(isReadOnly(live), true);
  assert.equal(
    fs.existsSync(path.join(dir, "run-codex-task.next.mjs")),
    false,
    "no staged file is left behind",
  );
  assert.throws(() => replaceRunner(dir, "export const = ;\n"), /fails node --check/);
  assert.equal(fs.readFileSync(live, "utf8"), stub("1.1.0"), "the old runner stays");
  assert.equal(isReadOnly(live), true);
  assert.equal(fs.existsSync(path.join(dir, "run-codex-task.next.mjs")), false);
});

test("a file counts as read-only on POSIX only when nobody may write it, while Windows keeps its attribute in the owner's write bit", (t) => {
  const posix = false,
    windows = true;
  assert.equal(modeIsReadOnly(0o100444, posix), true);
  assert.equal(modeIsReadOnly(0o100555, posix), true);
  assert.equal(modeIsReadOnly(0o100464, posix), false, "writable by its group");
  assert.equal(modeIsReadOnly(0o100446, posix), false, "writable by others");
  assert.equal(modeIsReadOnly(0o100644, posix), false);
  assert.equal(modeIsReadOnly(0o100444, windows), true);
  assert.equal(modeIsReadOnly(0o100666, windows), false);
  assert.equal(modeIsReadOnly(0o100464, windows), true, "Windows reads the owner's bit only");
  if (IS_WINDOWS) return;
  const file = path.join(scratch(t), "group-writable.txt");
  fs.writeFileSync(file, "x\n");
  fs.chmodSync(file, 0o464);
  assert.equal(isReadOnly(file), false);
  fs.chmodSync(file, 0o444);
  assert.equal(isReadOnly(file), true);
});

test("the entry runs the release dist/current names, falls back to src/ without a pointer, refuses a pointer that leaves dist/, and loads one complete release while the pointer flips", async (t) => {
  const root = scratch(t);
  const entry = path.join(root, RUNNER);
  fs.copyFileSync(path.join(ROOT, RUNNER), entry);
  // Stand-ins for the runner's modules: three files that must agree on their version.
  const fake = (dir, version) => {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.mjs"), `export const A = "${version}";\n`);
    fs.writeFileSync(path.join(dir, "src", "b.mjs"), `export const B = "${version}";\n`);
    fs.writeFileSync(
      path.join(dir, "src", "index.mjs"),
      [
        'import { A } from "./a.mjs";',
        'import { B } from "./b.mjs";',
        `export const RUNNER_VERSION = "${version}";`,
        "export const main = async () => [RUNNER_VERSION, A, B].join(' ');",
        "export async function runCli(script) { process.stdout.write([RUNNER_VERSION, A, B, script].join(' ') + '\\n'); }",
        "",
      ].join("\n"),
    );
  };
  fake(root, "0.0.1");
  fake(path.join(root, "dist", "1.0.0-aaaaaaa"), "1.0.0");
  fake(path.join(root, "dist", "2.0.0-bbbbbbb"), "2.0.0");
  const invoke = () => node([entry]);
  let result = invoke();
  assert.equal(result.status, EXIT.COMPLETED, result.stderr);
  assert.equal(
    result.stdout,
    `0.0.1 0.0.1 0.0.1 ${entry}\n`,
    "without a pointer the modules under src/ run, with the entry's own path",
  );
  flipPointer(root, "1.0.0-aaaaaaa");
  result = invoke();
  assert.equal(result.stdout, `1.0.0 1.0.0 1.0.0 ${entry}\n`);
  const imported = node([
    "--input-type=module",
    "-e",
    `import { RUNNER_VERSION, main } from ${JSON.stringify(pathToFileURL(entry).href)}; console.log(RUNNER_VERSION, typeof main);`,
  ]);
  assert.equal(imported.stdout.trim(), "1.0.0 function", imported.stderr);
  for (const bad of ["../../../etc", "1.0.0-aaaaaaa/../2.0.0-bbbbbbb", "3.0.0-ccccccc", ""]) {
    fs.writeFileSync(path.join(root, "dist", "current"), `${bad}\n`);
    result = invoke();
    assert.equal(result.status, EXIT.FAILURE, bad);
    assert.match(
      result.stderr,
      /^run-codex-task: (dist\/current names no release|release 3\.0\.0-ccccccc, named by dist\/current, is missing under dist\/)/,
      bad,
    );
  }
  // Invocations that read the pointer while it flips each load one release whole. A barrier
  // makes the overlap certain: each reader, once started, waits for a line on stdin, sent only
  // after the flipper has begun, and the flipper stops only when every reader has finished, so
  // every read falls between two flips. Batches repeat until both releases have been seen.
  const reader = path.join(root, "reader.mjs");
  fs.writeFileSync(
    reader,
    [
      'await new Promise((resolve) => process.stdin.once("data", resolve));',
      "process.stdin.destroy();",
      `const entry = await import(${JSON.stringify(pathToFileURL(entry).href)});`,
      "process.stdout.write(await entry.main([], {}));",
      "",
    ].join("\n"),
  );
  const startReader = () => {
    const child = spawn(process.execPath, [reader], { windowsHide: true });
    let out = "",
      err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, out, err })));
    return { child, done };
  };
  flipPointer(root, "1.0.0-aaaaaaa");
  const seen = new Set();
  for (let batch = 0; batch < 8 && seen.size < 2; batch++) {
    const readers = Array.from({ length: 8 }, startReader);
    let reading = true,
      flipsWhileReading = 0;
    const flipper = (async () => {
      for (let i = 0; reading; i++) {
        flipPointer(root, i % 2 ? "1.0.0-aaaaaaa" : "2.0.0-bbbbbbb");
        if (i) flipsWhileReading++;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    // The barrier: the flipper made its first flip before any reader may read.
    for (const { child } of readers) child.stdin.end("go\n");
    const results = await Promise.all(readers.map(({ done }) => done));
    reading = false;
    await flipper;
    assert.ok(flipsWhileReading > 0, "the pointer flipped while the readers read it");
    for (const { code, out, err } of results) {
      assert.equal(code, 0, err);
      const [version, a, b] = out.trim().split(" ");
      assert.ok(version === "1.0.0" || version === "2.0.0", out);
      assert.equal(a, version, out);
      assert.equal(b, version, out);
      seen.add(version);
    }
  }
  assert.deepEqual([...seen].sort(), ["1.0.0", "2.0.0"], "readers met both releases mid-flip");
});
