// The suite a planted clone runs on itself (test/hermetic.test.mjs): the clone
// lies in its profile's .claude folder, as the live installation does, so the
// guard must let it read its own tree and refuse the folders above and beside
// it. It fails anywhere else.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(import.meta.url);
const clone = path.dirname(path.dirname(file));
const claude = path.dirname(clone);

test("planted clone reads its own tree inside the profile's .claude folder", () => {
  assert.equal(claude, path.join(os.homedir(), ".claude"));
  assert.ok(fs.readdirSync(path.dirname(file)).includes(path.basename(file)));
  assert.ok(fs.statSync(fs.realpathSync.native(clone)).isDirectory());
  if (process.platform === "win32") assert.ok(fs.existsSync(clone.toUpperCase()));
  for (const target of [
    claude,
    path.join(claude, "settings.json"),
    path.join(clone, "..", "agents"),
    `${clone}-state`,
    path.join(`${clone}-state`, "runs.json"),
    path.join(claude, "plugins", "cache", "openai-codex"),
    path.join(os.homedir(), ".codex"),
  ])
    assert.throws(() => fs.statSync(target), /test attempted profile filesystem access/, target);
});
