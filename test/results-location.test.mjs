import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { environmentPaths } from "../src/cli/options.mjs";
import { fixture, LAUNCH, TEXT } from "./support/runner-fixture.mjs";

function privateHome(t, f) {
  const home = path.join(f.root, "home");
  fs.mkdirSync(home);
  t.mock.method(os, "homedir", () => home);
  const env = { ...f.env, HOME: home, USERPROFILE: home };
  delete env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR;
  return {
    home,
    env,
    fresh: path.join(home, ".claude", "codex-subagents-for-claude-code-data", "results"),
    unrelated: path.join(home, ".claude", "codex-subagents-for-claude-code", "results"),
  };
}

test("fresh results use a data-only default; resolution and read-only doctor create nothing", async (t) => {
  const f = fixture(t),
    p = privateHome(t, f);
  const defaults = environmentPaths(p.env);
  assert.equal(defaults.resultsDir, p.fresh);
  assert.equal(defaults.resultsSource, "data-default");
  assert.equal(defaults.stateBase, f.state);
  assert.deepEqual(fs.readdirSync(p.home), []);
  const r = await f.invoke(["--doctor", "--read-only"], { env: p.env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^results-source=data-default$/m);
  assert.ok(r.stdout.includes(`results=${p.fresh}`));
  assert.deepEqual(fs.readdirSync(p.home), []);
});

test("default results ignore unrelated folders and explicit overrides select their exact destination", async (t) => {
  const f = fixture(t),
    p = privateHome(t, f);
  fs.mkdirSync(path.dirname(p.unrelated), { recursive: true });
  fs.writeFileSync(p.unrelated, "leave this unrelated file alone");
  const paths = environmentPaths(p.env);
  assert.equal(paths.resultsDir, p.fresh);
  assert.equal(paths.resultsSource, "data-default");
  const doctor = await f.invoke(["--doctor", "--read-only"], { env: p.env });
  assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
  assert.equal(fs.readFileSync(p.unrelated, "utf8"), "leave this unrelated file alone");
  assert.equal(fs.existsSync(p.fresh), false);
  const explicit = environmentPaths({
    ...p.env,
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: f.resultsDir,
  });
  assert.equal(explicit.resultsDir, f.resultsDir);
  assert.equal(explicit.resultsSource, "override");
  const errors = [];
  const invalid = environmentPaths(
    { ...p.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: "relative" },
    (error) => errors.push(error),
  );
  assert.equal(invalid.resultsDir, null);
  assert.equal(errors.length, 1);
});

test("fresh delivery uses the data root and retained copies keep an explicit recorded destination", async (t) => {
  const f = fixture(t),
    p = privateHome(t, f);
  const done = await f.invoke([...LAUNCH, "--keep-state"], { env: p.env });
  assert.equal(done.code, 0, done.stdout + done.stderr);
  const original = f.metadata().result.resultFile;
  assert.equal(path.dirname(original), p.fresh);
  assert.equal(fs.existsSync(p.unrelated), false);
  const resumed = await f.invoke(f.resume(), { env: f.env });
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  assert.equal(f.metadata().result.resultFile, original);
  assert.ok(fs.readFileSync(original, "utf8").includes(TEXT.trim()));
});
