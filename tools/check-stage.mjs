// Isolated child-process import check; no CLI execution or model calls.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXIT } from "../src/shared/errors.mjs";

export const REQUIRED_EXPORTS = Object.freeze({
  RUNNER_VERSION: "string",
  ROLES: "object",
  DISPLAY: "object",
  KNOWN_OPTIONS: "object",
  parseArgs: "function",
  parseDuration: "function",
  parseTaskFile: "function",
  applyDirectives: "function",
  runProcess: "function",
  compareVersions: "function",
  selectCodex: "function",
  codexEnvironment: "function",
  protocolUsage: "function",
  acquireLock: "function",
  acquireWriterLock: "function",
  releaseWriterLock: "function",
  claimRequest: "function",
  releaseRequestClaim: "function",
  gitToplevel: "function",
  workspaceId: "function",
  truncateOutput: "function",
  fitOutput: "function",
  listRuns: "function",
  main: "function",
  runCli: "function",
});

export async function checkStage(root, version) {
  const module = await import(pathToFileURL(path.join(root, "src", "index.mjs")).href);
  for (const [name, type] of Object.entries(REQUIRED_EXPORTS)) {
    if (typeof module[name] !== type) throw new Error(`required export ${name} must be ${type}`);
  }
  if (module.RUNNER_VERSION !== version)
    throw new Error(`RUNNER_VERSION is ${module.RUNNER_VERSION}, expected ${version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkStage(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = EXIT.FAILURE;
  }
}
