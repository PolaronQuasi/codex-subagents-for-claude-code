// The state roots and the result copy's location (N-03, N-05, P-07/P-08).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { environmentPaths } from "../src/cli/options.mjs";
import { sameFolder } from "../src/shared/io.mjs";
import { LAUNCH, fixture } from "./support/runner-fixture.mjs";
import { EXIT } from "../src/shared/errors.mjs";

test("a close refused because an earlier copy lies inside the run's state names that file and says to move it out", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, EXIT.COMPLETED);
  const key = f.runs()[0];
  const inside = path.join(f.state, key, "copy.md");
  fs.writeFileSync(inside, "an earlier copy\n");
  const file = path.join(f.state, key, "run.json");
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...run, result: { ...run.result, resultFile: inside } }));
  const refused = await f.invoke(["--close", key]);
  assert.equal(refused.code, EXIT.FAILURE);
  assert.ok(
    refused.stderr.includes(
      `the result copy ${inside} lies inside ${path.join(f.state, key)}, which closing removes; move that file out of it first, then retry --close ${key}`,
    ),
    refused.stderr,
  );
  const moved = path.join(f.root, "copy.md");
  fs.renameSync(inside, moved);
  fs.writeFileSync(file, JSON.stringify({ ...run, result: { ...run.result, resultFile: moved } }));
  assert.equal((await f.invoke(["--close", key])).code, EXIT.COMPLETED);
});

test("configured state paths preserve real-path identity without historical-root warnings", async (t) => {
  const f = fixture(t);
  const link = path.join(f.root, "state-link");
  fs.symlinkSync(f.state, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(sameFolder(link, f.state), true);
  assert.equal(
    environmentPaths({ CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR: link }).stateBase,
    link,
  );
  const listed = await f.cli(["--list"], {
    env: { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR: link },
  });
  assert.equal(listed.status, EXIT.COMPLETED, listed.stderr);
  assert.equal(listed.stderr, "");
});
