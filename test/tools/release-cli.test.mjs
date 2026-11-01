// The release tool's command line: arguments, options each command takes, and its usage.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { check, checkedFiles, ROOT } from "../../tools/release.mjs";
import { EXIT } from "../../src/shared/errors.mjs";
import { SCRIPT, node, scratch, lines, installEnv } from "../support/release-fixture.mjs";

test("release arguments preserve missing-value and unknown-option diagnostics", () => {
  for (const flag of ["--from-dir", "--target"]) {
    const missing = node([SCRIPT, "help", flag]);
    assert.equal(missing.status, EXIT.FAILURE);
    assert.equal(missing.stderr, `release: ${flag} needs a value\n`);
    const valid = node([SCRIPT, "help", flag, "directory with spaces"]);
    assert.equal(valid.status, EXIT.COMPLETED, valid.stderr);
    assert.match(valid.stdout, /^Usage:/);
  }
  const unknown = node([SCRIPT, "help", "--unknown"]);
  assert.equal(unknown.status, EXIT.FAILURE);
  assert.equal(unknown.stderr, "release: unknown option --unknown\n");
});

test("check, tag and setup refuse --target, only install takes --from-dir, and an argument a command does not take is refused before anything runs", (t) => {
  // A copy of the tool, with the modules it imports, outside any repository:
  // were a refusal missing, the command would act on nothing real.
  const root = scratch(t);
  fs.mkdirSync(path.join(root, "tools"));
  fs.mkdirSync(path.join(root, "src"));
  for (const name of [
    "tools/release.mjs",
    "tools/distribution.mjs",
    "tools/scratch.mjs",
    "tools/test-files.mjs",
    "tools/target-paths.mjs",
    "src/shared/errors.mjs",
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, name), path.join(root, name));
  }
  const refused = (args, message) => {
    const result = node([path.join(root, "tools", "release.mjs"), ...args]);
    assert.equal(result.status, EXIT.FAILURE, args.join(" "));
    assert.equal(result.stdout, "", `${args.join(" ")} runs nothing`);
    assert.match(result.stderr, message, args.join(" "));
  };
  for (const command of ["check", "tag", "setup"])
    refused(
      [command, "--target", root],
      new RegExp(
        `^release: ${command} takes no --target; it acts on the repository that holds this tool, .+; run that repository's own tools/release\\.mjs ${command}\\n$`,
      ),
    );
  for (const [command, usage] of [
    ["check", "check"],
    ["verify", "verify \\[--target DIR\\]"],
    ["tag", "tag"],
    ["rollback", "rollback VERSION \\[--target DIR\\]"],
    ["setup", "setup"],
  ])
    refused(
      [command, "--from-dir", root],
      new RegExp(
        `^release: ${command} takes no --from-dir; only install reads a development copy \\(usage: ${usage}\\)\\n$`,
      ),
    );
  refused(["check", "extra"], /^release: unexpected argument "extra" \(usage: check\)\n$/);
  refused(["verify", "elsewhere"], /^release: unexpected argument "elsewhere" \(usage: verify /);
  refused(
    ["rollback", "1.0.0", "1.0.1"],
    /^release: unexpected argument "1\.0\.1" \(usage: rollback /,
  );
  refused(
    ["install", "copy"],
    /^release: unexpected argument "copy" \(usage: install --from-dir DIR /,
  );
});

test("check passes on this repository and the CLI explains itself", (t) => {
  const root = scratch(t);
  const env = installEnv(root);
  const rendered = node([path.join(ROOT, "install.mjs")], { env });
  assert.equal(rendered.status, 0, rendered.stderr);
  const out = lines();
  assert.equal(check({ env, write: out.write }), 0, out.text());
  // A clone without tags (a CI checkout, a bundle) may add the untagged-manifest warning.
  const [summary, ...rest] = out.text().split("\n");
  assert.match(
    summary,
    new RegExp(`^runner=\\d+\\.\\d+\\.\\d+ checked=${checkedFiles().length} problems=0$`),
  );
  assert.ok(
    rest.every((line) => line.startsWith("warning: releases/v")),
    rest.join("\n"),
  );
  assert.ok(
    checkedFiles().length > 5 && checkedFiles().includes("src/version.mjs"),
    "every module under src/ is syntax-checked",
  );
  assert.ok(checkedFiles().includes("test/runner.test.mjs"));
  assert.ok(checkedFiles().includes("test/fixtures/codex/codex.mjs"));
  assert.ok(checkedFiles().includes("src/codex/rpc.mjs"));
  assert.ok(checkedFiles().includes("src/codex/driver.mjs"));
  fs.appendFileSync(path.join(root, "skill", "SKILL.md"), "drift\n");
  const drift = lines();
  assert.equal(check({ env, write: drift.write }), 1);
  assert.match(drift.text(), /installed agents or skill differ/);
  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", windowsHide: true });
  assert.equal(usage.status, EXIT.FAILURE);
  assert.match(usage.stdout, /^Usage:/);
  const unknown = spawnSync(process.execPath, [SCRIPT, "frobnicate"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(unknown.status, EXIT.FAILURE);
  assert.match(unknown.stderr, /unknown command frobnicate/);
  const stray = spawnSync(process.execPath, [SCRIPT, "verify", "--bogus"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(stray.status, EXIT.FAILURE);
  assert.match(stray.stderr, /unknown option --bogus/);
});
