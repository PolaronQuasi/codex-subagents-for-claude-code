import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { failureSummary, printTestSummary } from "../tools/ci-test-report.mjs";

test("CI repeats actual Node assertion diagnostics after a completed TAP run", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csfcc-ci-report-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "failure.mjs");
  const report = path.join(root, "suite.tap");
  fs.writeFileSync(
    file,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("passing sentinel", () => {});',
      'test("failing sentinel", () => assert.equal("actual-value", "expected-value"));',
    ].join("\n"),
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-reporter-destination=stdout",
      "--test-reporter=tap",
      `--test-reporter-destination=${report}`,
      file,
    ],
    { env, encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /not ok 2 - failing sentinel/);
  const printed = [];
  printTestSummary(report, (line) => printed.push(line));
  const summary = printed.join("\n");
  assert.match(summary, /not ok 2 - failing sentinel/);
  assert.match(summary, /actual-value/);
  assert.match(summary, /expected-value/);
  assert.match(summary, /ERR_ASSERTION/);
  assert.match(summary, /# fail 1/);
  assert.doesNotMatch(summary, /passing sentinel|incomplete/);
});

test("CI retains prior failures in an interrupted report and bounds excessive diagnostics", () => {
  const tap = [
    "TAP version 13",
    "not ok 1 - earlier failure",
    "  ---",
    "  error: recorded before timeout",
    "  ...",
    "# Subtest: later test has not finished",
  ].join("\n");
  const summary = failureSummary(tap);
  assert.match(summary, /earlier failure[\s\S]*recorded before timeout/);
  assert.match(summary, /report is incomplete/);
  assert.doesNotMatch(summary, /later test/);
  const excessive = Array.from(
    { length: 101 },
    (_, i) => `not ok ${i + 1} - failure\n  error: ${"x".repeat(4000)}\n  ...`,
  ).join("\n");
  const bounded = failureSummary(excessive);
  assert.ok(bounded.length < 257 * 1024);
  assert.match(bounded, /more failures/);
  assert.doesNotMatch(bounded, /x{2049}/);
});
