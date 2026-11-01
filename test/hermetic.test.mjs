import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { profileRule } from "./support/hermetic.mjs";
import { ROOT } from "../tools/test-files.mjs";
import { EXIT } from "../src/shared/errors.mjs";

test("tests cannot read or probe either forbidden plugin tree or profile configuration", async () => {
  for (const name of ["cache", "marketplaces"]) {
    const target = path.join(
      os.homedir(),
      ".claude",
      "plugins",
      name,
      "openai-codex",
      "never-read",
    );
    for (const read of [
      fs.readFileSync,
      fs.readdirSync,
      fs.statSync,
      fs.existsSync,
      fs.realpathSync.native,
    ])
      assert.throws(() => read(target), /test attempted profile filesystem access/);
    await assert.rejects(fs.promises.readFile(target), /test attempted profile filesystem access/);
  }
  assert.throws(
    () => fs.readdirSync(path.join(os.homedir(), ".claude", "agents")),
    /profile filesystem access/,
  );
  // The rest of Claude Code's and Codex's profile folders, the state root
  // beside the live installation included.
  for (const target of [
    path.join(os.homedir(), ".claude"),
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".claude", "codex-subagents-for-claude-code-state"),
    path.join(os.homedir(), ".codex", "config.toml"),
  ])
    assert.throws(() => fs.statSync(target), /profile filesystem access/, target);
  const otherProfile = path.join(
    os.tmpdir(),
    "other-profile",
    ".claude",
    "plugins",
    "cache",
    "openai-codex",
    "never-read",
  );
  assert.throws(() => fs.createReadStream(otherProfile), /profile filesystem access/);
});

test("the rule allows the repository's own tree inside the profile's .claude folder, never the folders above or beside it", () => {
  // Each target with whether the rule refuses it, against what it should.
  const expect = (refused, allowed, denied) =>
    assert.deepEqual(
      Object.fromEntries([...allowed, ...denied].map((target) => [target, refused(target)])),
      Object.fromEntries([
        ...allowed.map((target) => [target, false]),
        ...denied.map((target) => [target, true]),
      ]),
    );
  // The live installation's shape: a clone in the profile's .claude folder,
  // with the temporary folder in the profile too, as on Windows.
  const home = "D:\\Profiles\\Tester";
  const live = `${home}\\.claude\\codex-subagents-for-claude-code`;
  const temporary = `${home}\\AppData\\Local\\Temp`;
  expect(
    profileRule({ platform: "win32", profile: [home], allowed: [live, temporary] }),
    [
      live,
      `${live}\\test\\audit.test.mjs`,
      "d:/profiles/tester/.CLAUDE/Codex-Subagents-For-Claude-Code/src/index.mjs",
      `\\\\?\\${live}\\package.json`,
      `${temporary}\\fixture\\.claude\\agents\\gpt-6-1-sol.md`,
      `${home}\\.codex-cli\\codex.exe`,
      `${home}\\Documents\\notes.md`,
    ],
    [
      `${home}\\.claude`,
      `${live}-state\\runs`,
      `${live}\\..\\agents\\gpt-6-1-sol.md`,
      `${home}\\.claude\\settings.json`,
      `\\\\?\\${home}\\.claude\\skills`,
      `${home}\\.codex\\config.toml`,
      `${live}\\.claude\\plugins\\cache\\openai-codex\\never-read`,
      `${temporary}\\other\\.claude\\plugins\\marketplaces\\openai-codex`,
    ],
  );
  // On Linux case tells folders apart; on macOS, as on Windows, it does not.
  const posix = "/profiles/tester";
  const clone = `${posix}/.claude/codex-subagents-for-claude-code`;
  const rule = (platform) => profileRule({ platform, profile: [posix], allowed: [clone, "/tmp"] });
  expect(
    rule("linux"),
    [`${clone}/test/audit.test.mjs`, "/tmp/fixture", `${posix}/.codex-cli/codex`],
    [
      `${posix}/.claude`,
      `${clone}-state/runs`,
      `${posix}/.claude/Codex-Subagents-For-Claude-Code/test`,
      `${posix}/.codex/config.toml`,
    ],
  );
  expect(rule("darwin"), [`${posix}/.claude/Codex-Subagents-For-Claude-Code/test`], []);
  // An allowed folder that holds the profile folders opens none of them.
  expect(
    profileRule({ platform: "linux", profile: [posix], allowed: [posix] }),
    [`${posix}/test/audit.test.mjs`],
    [`${posix}/.claude/agents`, `${posix}/.codex`],
  );
});

test("a clone inside the profile's .claude folder, as the live installation is, runs its own suite", (t) => {
  const profile = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagents-for-claude-code-profile-")),
  );
  t.after(() =>
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  const claude = path.join(profile, ".claude");
  const clone = path.join(claude, "codex-subagents-for-claude-code");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  // The suite's launcher, with the one runner module it imports, the guard and
  // the clone's one test, which checks what the guard lets it read.
  for (const name of ["tools/test-files.mjs", "src/shared/errors.mjs", "test/support/hermetic.mjs"])
    write(path.join(clone, name), fs.readFileSync(path.join(ROOT, name)));
  write(
    path.join(clone, "test", "clone.test.mjs"),
    fs.readFileSync(path.join(ROOT, "test", "fixtures", "hermetic-clone.test.mjs")),
  );
  // Live neighbours, so a refusal is the guard's and not a missing file.
  write(path.join(`${clone}-state`, "runs.json"), "{}\n");
  write(path.join(claude, "settings.json"), "{}\n");
  write(path.join(claude, "agents", "gpt-6-1-sol.md"), "agent\n");
  // npm test in the clone, with this profile: HOME on POSIX, USERPROFILE on
  // Windows. A nested test runner reports to its parent in another format
  // when it inherits NODE_TEST_CONTEXT.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:HOME|USERPROFILE|NODE_TEST_CONTEXT)$/i.test(name),
    ),
  );
  env.HOME = env.USERPROFILE = profile;
  const ran = spawnSync(process.execPath, [path.join(clone, "tools", "test-files.mjs"), "run"], {
    cwd: clone,
    env,
    encoding: "utf8",
  });
  assert.equal(ran.status, EXIT.COMPLETED, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /planted clone reads its own tree inside the profile's \.claude folder/);
});
