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
  command(process.execPath, testArguments(ROOT), { env, inherit: true });
} catch (error) {
  console.error(error.message);
  process.exitCode = EXIT.FAILURE;
} finally {
  temporary.remove();
}
