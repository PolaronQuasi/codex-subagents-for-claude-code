import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HELP, environmentPaths } from "../src/cli/options.mjs";
import { validateRun } from "../src/state/run-record.mjs";
import { gitInit, gitOut } from "./support/git-repos.mjs";
import { LAUNCH, fixture } from "./support/runner-fixture.mjs";
import { EXIT } from "../src/shared/errors.mjs";

// Launches keep their prompt file, so the next one can use it too.
const KEEP = [...LAUNCH, "--keep-prompt"];

test("the private default state root and an explicit override each select one root", () => {
  const defaults = environmentPaths({});
  assert.equal(
    defaults.stateBase,
    path.join(os.homedir(), ".claude", "codex-subagents-for-claude-code-state"),
  );
  assert.equal(
    defaults.resultsDir,
    path.join(os.homedir(), ".claude", "codex-subagents-for-claude-code", "results"),
  );
  assert.equal(defaults.codexHome, path.join(os.homedir(), ".codex"));
  assert.equal(Object.hasOwn(defaults, "pluginRoot"), false);
  assert.equal(Object.hasOwn(defaults, "legacyStateBase"), false);
  const explicit = path.join(os.tmpdir(), "codex-subagents-for-claude-code-elsewhere");
  assert.equal(
    environmentPaths({ CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR: explicit }).stateBase,
    explicit,
  );
  assert.equal(
    environmentPaths({ CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: explicit }).resultsDir,
    explicit,
  );
  assert.match(HELP, /~\/\.claude\/codex-subagents-for-claude-code-state/);
});

test("a worktree or scratch run whose record names another folder is refused as damaged", async (t) => {
  const f = fixture(t, { touchWorkspaceFile: "codex-output.txt" });
  await gitInit(f.work);
  const victim = path.join(f.root, "victim");
  fs.mkdirSync(victim);
  await gitInit(victim);
  const head = await gitOut(["rev-parse", "HEAD"], victim);
  assert.equal(
    (await f.invoke([...KEEP, "--keep-state", "--write", "--worktree"])).code,
    EXIT.COMPLETED,
  );
  assert.equal(
    (await f.invoke([...KEEP, "--keep-state", "--scratch-workspace"])).code,
    EXIT.COMPLETED,
  );
  for (const key of f.runs()) {
    const file = path.join(f.state, key, "run.json");
    const run = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(validateRun(run, key, path.join(f.state, key)), run, "as the runner made it");
    fs.writeFileSync(file, JSON.stringify({ ...run, cwd: victim }));
    for (const args of [
      ["--run", key],
      ["--close", key],
      ["--continue", key, "--prompt-file", "x"],
    ]) {
      const result = await f.invoke(args);
      assert.equal(result.code, EXIT.FAILURE, args.join(" "));
      assert.match(result.stderr, /has damaged or missing run\.json: invalid run metadata/);
    }
    const listed = await f.invoke(["--list"]);
    assert.match(listed.stdout, new RegExp(`^run=${key} status=damaged-metadata `, "m"));
  }
  assert.equal(await gitOut(["rev-parse", "HEAD"], victim), head, "no commit landed there");
  assert.equal(await gitOut(["status", "--porcelain"], victim), "");
  // The record's folder may be spelled differently, as long as it is the run's own.
  if (process.platform === "win32") {
    const key = f.runs()[0];
    const stateDir = path.join(f.state, key);
    const run = { ...f.metadata(key), cwd: path.join(stateDir.toUpperCase(), "worktree") };
    run.worktree ??= { base: f.work, branch: null, startRef: "HEAD", startCommit: null };
    delete run.scratchWorkspace;
    assert.equal(validateRun(run, key, stateDir), run);
  }
});
