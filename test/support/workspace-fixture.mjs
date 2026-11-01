// A minimal temporary workspace for the tests that need no plugin: a root under
// the system's temporary folder with a workspace, another workspace, a state
// root, a results folder and an empty plugin scripts folder, all removed after
// the test. Tests that run the runner against the fake plugin use
// plugin-fixture.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagents-for-claude-code-workspace "));
  const folders = {
    work: path.join(root, "workspace with spaces"),
    other: path.join(root, "other workspace"),
    state: path.join(root, "state"),
    resultsDir: path.join(root, "results"),
  };
  for (const dir of Object.values(folders)) fs.mkdirSync(dir, { recursive: true });
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("codex-subagents-for-claude-code-workspace "));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, ...folders };
}
