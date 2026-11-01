import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { codexVersion, install } from "../../tools/release.mjs";
import { fixture } from "../support/codex-fixture.mjs";
import { scratch, devCopy, installEnv } from "../support/release-fixture.mjs";

test("release CLI identification uses only the selected fake's version command", (t) => {
  const f = fixture(t);
  assert.equal(codexVersion(f.env), "0.166.0");
  assert.deepEqual(f.events(), []);
  assert.equal(
    codexVersion({
      ...f.env,
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH: path.join(f.root, "absent"),
    }),
    null,
  );
});

test("release manifest records codex instead of plugin and needs no installed CLI", (t) => {
  const root = scratch(t),
    source = path.join(root, "source"),
    target = path.join(root, "target");
  devCopy(source, "9.9.8");
  assert.equal(install({ fromDir: source, target, env: installEnv(root), write() {} }), 0);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(target, "releases", "v9.9.8.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(manifest, "plugin"), false);
  assert.equal(Object.hasOwn(manifest, "codex"), true);
  assert.equal(manifest.codex, null);
});
