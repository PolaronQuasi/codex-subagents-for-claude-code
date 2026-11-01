import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import {
  selectCodex,
  resolveExecutable,
  requireSupportedCodex,
  codexSupports,
  codexEnvironment,
  appServerArgs,
  compareVersions,
  codexLaunch,
} from "../src/codex/cli.mjs";
import {
  CODEX_ENV,
  CODEX_VERSION_RANGE,
  PLATFORM,
  CODEX_COMMAND,
  IS_WINDOWS,
} from "../src/shared/constants.mjs";
import { CODES } from "../src/shared/errors.mjs";

test("CLI identifies the configured fake native payload by path, version and build, then probes help", async (t) => {
  const f = fixture(t);
  const selected = await selectCodex(f.env, f.work);
  assert.equal(selected.path, f.executable);
  assert.equal(selected.dir, fs.realpathSync.native(f.bin));
  assert.equal(selected.version, CODEX_VERSION_RANGE.min);
  assert.match(selected.build, /^[0-9a-f]{64}$/);
  assert.equal(requireSupportedCodex(selected), selected);
  assert.equal(await codexSupports(selected, f.env, f.work), true);
  assert.deepEqual(f.events(), [], "only fake version/help probes, no server session");
});

test("private desktop and sandbox copies are excluded for explicit paths, PATH and directory links", (t) => {
  const f = fixture(t);
  for (const folder of [
    path.join(f.root, "WindowsApps", "package"),
    path.join(f.root, "local", "OpenAI", "Codex", "bin", "build"),
    path.join(f.root, ".codex", ".sandbox-bin"),
  ]) {
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, path.basename(f.executable));
    fs.copyFileSync(f.executable, file);
    if (!IS_WINDOWS) fs.chmodSync(file, 0o700);
    const env = { ...f.env, LOCALAPPDATA: path.join(f.root, "local"), [CODEX_ENV.PATH]: file };
    assert.throws(() => resolveExecutable(env), /private.*excluded/);
    delete env[CODEX_ENV.PATH];
    delete env[CODEX_ENV.DIRECTORY];
    env.PATH = `${folder}${path.delimiter}${f.bin}`;
    assert.equal(resolveExecutable(env), f.executable);
    const link = path.join(f.root, `link-${path.basename(path.dirname(folder))}`);
    fs.symlinkSync(folder, link, IS_WINDOWS ? "junction" : "dir");
    assert.throws(
      () => resolveExecutable({ ...env, [CODEX_ENV.PATH]: path.join(link, path.basename(file)) }),
      /excluded/,
    );
  }
});

test("private desktop exclusion resolves an aliased LOCALAPPDATA before comparing executable paths", (t) => {
  const f = fixture(t);
  const local = path.join(f.root, "local");
  const folder = path.join(local, "OpenAI", "Codex", "bin", "build");
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, path.basename(f.executable));
  fs.copyFileSync(f.executable, file);
  if (!IS_WINDOWS) fs.chmodSync(file, 0o700);
  const alias = path.join(f.root, "local-alias");
  fs.symlinkSync(local, alias, IS_WINDOWS ? "junction" : "dir");
  const env = { ...f.env, LOCALAPPDATA: alias, [CODEX_ENV.PATH]: file };
  assert.throws(() => resolveExecutable(env), /private.*excluded/);
  delete env[CODEX_ENV.PATH];
  delete env[CODEX_ENV.DIRECTORY];
  env.PATH = `${folder}${path.delimiter}${f.bin}`;
  assert.equal(resolveExecutable(env), f.executable);
  assert.deepEqual(f.events(), [], "excluded payload is never probed or launched");
});

test("semantic version ordering remains numeric and stable releases follow their prereleases", () => {
  const ordered = ["1.0.0-alpha.2", "1.0.0-alpha.10", "1.0.0-beta", "1.0.0", "1.0.10", "1.1.0"];
  assert.deepEqual([...ordered].reverse().sort(compareVersions), ordered);
  assert.equal(compareVersions("1.0.0+build.2", "1.0.0+build.10"), 0);
});

test("CLI selects the first PATH executable, configured paths take precedence, and no cwd search occurs", (t) => {
  const f = fixture(t);
  assert.equal(resolveExecutable({ PATH: f.bin }), f.executable);
  assert.equal(resolveExecutable({ Path: f.bin }), f.executable);
  if (IS_WINDOWS) assert.equal(resolveExecutable({ Path: `"${f.bin}"` }), f.executable);
  assert.equal(resolveExecutable({ PATH: "", [CODEX_ENV.PATH]: f.executable }), f.executable);
  assert.throws(() => resolveExecutable({ PATH: `.${path.delimiter}${f.work}` }), {
    code: CODES.CODEX_UNSUPPORTED,
  });
  assert.throws(
    () => resolveExecutable({ PATH: f.bin, [CODEX_ENV.PATH]: path.join(f.root, "missing") }),
    { code: CODES.CODEX_UNSUPPORTED },
  );
  assert.throws(() => resolveExecutable({ [CODEX_ENV.PATH]: "relative/codex" }), /absolute path/);
  assert.throws(() => resolveExecutable({ [CODEX_ENV.DIRECTORY]: f.work, PATH: f.bin }), {
    code: CODES.CODEX_UNSUPPORTED,
  });
  if (IS_WINDOWS) {
    const native = path.join(f.bin, "codex.exe");
    fs.writeFileSync(native, "fixture resolver sentinel");
    assert.equal(
      resolveExecutable({ [CODEX_ENV.DIRECTORY]: f.bin }),
      native,
      "native executable is preferred to a shim in the same directory",
    );
  }
});

test("CLI admits arbitrary printable version labels without an override", async (t) => {
  const f = fixture(t);
  for (const version of [
    "0.153.2",
    "1.0.0",
    "0.166.0-alpha.01",
    "0.166.0+other",
    "nightly-custom",
  ]) {
    const candidate = { version };
    assert.equal(requireSupportedCodex(candidate, {}), candidate);
    f.configure({ version });
    assert.equal((await selectCodex(f.env, f.work)).version, version);
  }
  for (const version of [null, "", "x\ny", "x\u001by", "x y"])
    assert.throws(() => requireSupportedCodex({ version }), { code: CODES.CODEX_UNSUPPORTED });
});

test("CLI build identity changes when the selected executable is replaced, even at the same version", async (t) => {
  const f = fixture(t);
  const before = await selectCodex(f.env, f.work);
  fs.appendFileSync(
    f.executable,
    IS_WINDOWS ? "\r\nrem replacement build\r\n" : "\n# replacement build\n",
  );
  const after = await selectCodex(f.env, f.work);
  assert.equal(before.path, after.path);
  assert.equal(before.version, after.version);
  assert.notEqual(before.build, after.build);
  assert.throws(() => codexLaunch(before, ["--version"], f.env), /payload changed/);
  f.configure({ version: "" });
  await assert.rejects(selectCodex(f.env, f.work), { code: CODES.CODEX_UNSUPPORTED });
});

test("CLI probe keeps shell metacharacters inside an explicitly selected path", async (t) => {
  const f = fixture(t);
  const folder = path.join(f.root, "bin & inert");
  fs.mkdirSync(folder);
  const executable = path.join(folder, path.basename(f.executable));
  fs.copyFileSync(f.executable, executable);
  if (!IS_WINDOWS) fs.chmodSync(executable, 0o700);
  const selected = await selectCodex({ ...f.env, [CODEX_ENV.PATH]: executable }, f.work);
  assert.equal(selected.path, executable);
});

test("CLI environment removes local git and plugin state, normalizes PATH and keeps native login configuration", () => {
  const parent = {
    Path: "original",
    PATH: "last",
    SHELL: "/bin/bash",
    GIT_DIR: "other-repository",
    git_work_tree: "other-tree",
    GIT_CONFIG_GLOBAL: "private-config",
    CODEX_HOME: "native-home",
    CODEX_COMPANION_SESSION_ID: "old-session",
    codex_companion_endpoint: "old-endpoint",
    CLAUDE_PLUGIN_DATA: "old-data",
    CLAUDE_PLUGIN_ROOT: "old-root",
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_PLUGIN_DIR: "old-plugin-dir",
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_ALLOW_PLUGIN: "old-version",
    OPENAI_API_KEY: "fixture-canary",
  };
  const env = codexEnvironment(parent, "chosen", { platform: PLATFORM.WIN32 });
  assert.equal(env.PATH, "chosen;last");
  assert.equal(Object.keys(env).filter((name) => name.toUpperCase() === "PATH").length, 1);
  assert.equal(env.NoDefaultCurrentDirectoryInExePath, "1");
  assert.equal(env.SHELL, undefined);
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.git_work_tree, undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, "private-config");
  assert.equal(env.CODEX_HOME, "native-home");
  assert.equal(env.OPENAI_API_KEY, "fixture-canary");
  assert.equal(env.CLAUDE_PLUGIN_DATA, undefined);
  assert.equal(env.CLAUDE_PLUGIN_ROOT, undefined);
  assert.ok(Object.keys(env).every((name) => !/^codex_companion_/i.test(name)));
  assert.equal(codexEnvironment(parent, null, { platform: PLATFORM.LINUX }).SHELL, parent.SHELL);
  assert.equal(
    codexEnvironment(parent, null, { platform: PLATFORM.LINUX }).git_work_tree,
    "other-tree",
    "POSIX git variable names are case-sensitive",
  );
  assert.equal(parent.CLAUDE_PLUGIN_DATA, "old-data");
});

test("CLI app-server arguments use dedicated stdio with deterministic TOML overrides and no prompt", () => {
  assert.deepEqual(appServerArgs(), [
    CODEX_COMMAND.APP_SERVER,
    CODEX_COMMAND.LISTEN,
    CODEX_COMMAND.STDIO,
  ]);
  assert.deepEqual(appServerArgs({ config: { z: true, a: 'quoted "λ"', list: ["one", false] } }), [
    CODEX_COMMAND.APP_SERVER,
    CODEX_COMMAND.LISTEN,
    CODEX_COMMAND.STDIO,
    CODEX_COMMAND.CONFIG,
    'a="quoted \\"λ\\""',
    CODEX_COMMAND.CONFIG,
    'list=["one", false]',
    CODEX_COMMAND.CONFIG,
    "z=true",
  ]);
  assert.throws(() => appServerArgs({ config: { "bad\nkey": true } }), {
    code: CODES.CODEX_UNSUPPORTED,
  });
  assert.throws(() => appServerArgs({ config: { invalid: null } }), {
    code: CODES.CODEX_UNSUPPORTED,
  });
  assert.throws(() => appServerArgs({ config: { invalid: Infinity } }), {
    code: CODES.CODEX_UNSUPPORTED,
  });
});

test("launch uses the recorded native executable instead of a moving discovery path", async (t) => {
  const f = fixture(t),
    selected = await selectCodex(f.env, f.work);
  const vector = codexLaunch(
    { ...selected, path: path.join(f.root, "moving-launcher") },
    ["app-server", "--listen", "stdio://"],
    f.env,
  );
  assert.equal(vector.command, selected.realPath);
});

test("unresolved wrappers are refused before their version probe", async (t) => {
  const f = fixture(t);
  const shim = path.join(f.bin, IS_WINDOWS ? "unresolved.cmd" : "unresolved");
  fs.writeFileSync(
    shim,
    IS_WINDOWS ? "@echo codex-cli 0.166.0\r\n" : "#!/bin/sh\necho codex-cli 0.166.0\n",
    { mode: 0o700 },
  );
  await assert.rejects(
    selectCodex({ ...f.env, [CODEX_ENV.PATH]: shim }, f.work),
    /native Codex executable/,
  );
  assert.deepEqual(f.events(), []);
});

for (const layout of ["bundled", "hoisted", "nested"])
  test(`npm ${layout} launcher resolves and pins its native payload`, async (t) => {
    const f = fixture(t);
    const root = path.join(f.root, "npm", "node_modules", "@openai", "codex");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }),
    );
    const entry = path.join(root, "bin", "codex.js");
    fs.writeFileSync(
      entry,
      '#!/usr/bin/env node\nthrow new Error("must not run npm JavaScript");\n',
      { mode: 0o700 },
    );
    const cpu = process.arch === "arm64" ? "aarch64" : "x86_64";
    const target = {
      win32: `${cpu}-pc-windows-msvc`,
      linux: `${cpu}-unknown-linux-musl`,
      darwin: `${cpu}-apple-darwin`,
    }[process.platform];
    const platformPackage = `codex-${process.platform}-${process.arch}`;
    const payloadRoot =
      layout === "bundled"
        ? root
        : layout === "hoisted"
          ? path.join(path.dirname(root), platformPackage)
          : path.join(root, "node_modules", "@openai", platformPackage);
    const payload = path.join(
      payloadRoot,
      "vendor",
      target,
      layout === "bundled" ? "codex" : "bin",
      path.basename(f.executable),
    );
    fs.mkdirSync(path.dirname(payload), { recursive: true });
    fs.copyFileSync(f.executable, payload);
    if (!IS_WINDOWS) fs.chmodSync(payload, 0o700);
    const launcher = IS_WINDOWS ? path.join(f.root, "npm", "codex.cmd") : entry;
    if (IS_WINDOWS)
      fs.writeFileSync(
        launcher,
        '@echo off\r\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      );
    const env = { ...f.env, [CODEX_ENV.PATH]: launcher };
    const selected = await selectCodex(env, f.work);
    assert.equal(selected.path, launcher);
    assert.equal(selected.realPath, fs.realpathSync.native(payload));
    assert.equal(codexLaunch(selected, ["--version"], env).command, selected.realPath);
    assert.equal(await codexSupports(selected, env, f.work), true);
    fs.appendFileSync(payload, "replacement payload bytes");
    const changed = await selectCodex(env, f.work);
    assert.equal(changed.version, selected.version);
    assert.notEqual(changed.build, selected.build);
    assert.throws(() => codexLaunch(selected, ["app-server"], env), /payload changed/);
    assert.deepEqual(f.events(), []);
  });

test("a retained conversation refuses a replaced native payload at the same version", async (t) => {
  const f = fixture(t, { version: "nightly-custom" });
  const first = await f.invoke([
    ...LAUNCH.slice(0, -2),
    "--wait-ms",
    "10000",
    "--keep-state",
    "--keep-prompt",
  ]);
  assert.equal(first.code, 0, first.stderr);
  const before = f.metadata();
  fs.appendFileSync(f.executable, "replacement payload bytes");
  const next = await f.invoke([
    "--continue",
    before.runKey,
    "--prompt-file",
    "prompt.md",
    "--wait-ms",
    "10000",
  ]);
  assert.equal(next.code, 1, next.stderr);
  assert.match(next.stderr, /Codex.*changed/i);
  assert.equal(f.metadata().jobId, before.jobId);
  assert.equal(
    f.events().filter((e) => e.direction === "in" && e.method === "turn/start").length,
    1,
  );
});

test("doctor reports the tested baseline without denying a different version", async (t) => {
  const f = fixture(t, { version: "nightly-custom" });
  const report = await f.invoke(["--doctor", "--read-only"]);
  assert.match(report.stdout, /codex-tested-version=0\.166\.0\n/);
  assert.match(report.stdout, /codex-version-tested=no\n/);
  assert.match(report.stdout, /codex-supported=yes\n/);
  assert.doesNotMatch(report.stdout, /unsupported Codex nightly/);
  assert.equal(
    f.events().some((e) => e.direction === "in" && e.method === "turn/start"),
    false,
  );
  const broken = fixture(t, {
    version: "nightly-custom",
    rpcErrors: {
      initialize: { code: -32601, message: "unsupported initialize" },
    },
  });
  const failure = await broken.invoke(["--doctor", "--read-only"]);
  assert.equal(failure.code, 1);
  assert.match(failure.stdout, /codex-supported=no\n/);
});
