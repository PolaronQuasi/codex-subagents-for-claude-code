#!/usr/bin/env node
// The offline gates, locally and in both forge workflows: check and the suite,
// with agents rendered to a temporary folder.
// Formatting is the separate `npm run format:check` script, which the
// workflows run before this one; it fetches the pinned Prettier, so it is
// not part of these offline checks.
import path from "node:path";
import { ROOT, command } from "./distribution.mjs";
import { testArguments } from "./test-files.mjs";
import { EXIT } from "../src/shared/errors.mjs";
import { createScratch } from "./scratch.mjs";
import { printTestSummary } from "./ci-test-report.mjs";

// Windows process identity probes make the complete suite slower than a
// packaging command. Keep its own bound below the hosted job's deadline.
const IS_WINDOWS = process.platform === "win32";
const SUITE_MS = (IS_WINDOWS ? 60 : 20) * 60 * 1000;

const temporary = createScratch("codex-subagents-for-claude-code-ci-");
const scratch = temporary.directory;
try {
  const env = {
    ...process.env,
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR: path.join(scratch, "agents"),
    CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR: path.join(scratch, "skill"),
  };
  command(process.execPath, ["install.mjs"], { env, inherit: true });
  command(process.execPath, ["tools/release.mjs", "check"], { env, inherit: true });
  // Keep assertion details in hosted logs even when Node selects a terse reporter.
  const report = path.join(scratch, "suite.tap");
  try {
    command(
      process.execPath,
      testArguments(ROOT, [
        "--test-reporter=tap",
        "--test-reporter-destination=stdout",
        "--test-reporter=tap",
        `--test-reporter-destination=${report}`,
      ]),
      {
        env,
        inherit: true,
        timeoutMs: SUITE_MS,
      },
    );
  } finally {
    printTestSummary(report);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = EXIT.FAILURE;
} finally {
  temporary.remove();
}
