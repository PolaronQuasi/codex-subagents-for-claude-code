#!/usr/bin/env node
// One isolated Codex companion job, plus further turns on its thread, cancel,
// close, sleep, list, the manual sweeps (close-idle, collect-finished,
// sleep-idle) and doctor. Node >= 22; no npm dependencies.
// Exit: 0 completed (any delivered result with --relay, or a --detach receipt),
// 1 runner error, 2 failed/cancelled, 3 still running.
// Ctrl-C stops this waiter, not the detached job. See --help and docs/MANUAL.md.
//
// This entry is a shim over the runner's modules. A release installs them
// into an immutable folder dist/<version>-<commit>/src/ and names it in the
// one-line pointer dist/current (tools/release.mjs); the pointer is read once
// per invocation, so every invocation runs one complete release. Without a
// pointer, in a fresh clone, the modules under src/ run. The shim re-exports
// the runner's public surface, passes its own stable path into the commands
// the runner prints, and runs the command line when invoked as a script.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The shim chooses the release before it loads any runner module, so it names
// its own few literals here instead of importing src/shared/errors.mjs: the errno of
// a missing pointer (no release installed), the errnos of a pointer read that
// met a flip (Windows), how often and how far apart that read is retried, and
// the exit status of a runner that cannot be loaded.
const POINTER_MISSING = "ENOENT";
const POINTER_BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
const POINTER_RETRIES = 20;
const POINTER_RETRY_MS = 10;
const EXIT_FAILURE = 1;
const POINTER_DETAIL_CHARS = 80;

const SCRIPT = fileURLToPath(import.meta.url);
const HERE = path.dirname(SCRIPT);
// Node loads the main module from its real path, so through a directory
// junction or symlink process.argv[1] names another path to this same file.
const sameFile = (a, b) => {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
};
const asScript =
  Boolean(process.argv[1]) &&
  (path.resolve(process.argv[1]) === SCRIPT || sameFile(process.argv[1], SCRIPT));
// Pointer discovery precedes module loading, so its tiny retry pause cannot
// depend on helpers in the release we have not selected yet.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The folder whose src/ holds the modules to run: the release dist/current
// names, validated to lie under dist/, or this folder when there is no pointer.
// A release flips the pointer by renaming a new file over it; on Windows a
// read that meets that instant can be refused, so it is retried briefly.
function releaseRoot() {
  let text;
  for (let attempt = 0; ; attempt++) {
    try {
      text = fs.readFileSync(path.join(HERE, "dist", "current"), "utf8");
      break;
    } catch (error) {
      if (error.code === POINTER_MISSING) return HERE;
      if (attempt < POINTER_RETRIES && POINTER_BUSY.has(error.code)) {
        sleepSync(POINTER_RETRY_MS);
        continue;
      }
      throw error;
    }
  }
  const id = text.trim();
  if (!/^\d+\.\d+\.\d+-[0-9a-f]{7,40}$/.test(id)) {
    throw new Error(
      `dist/current names no release (${JSON.stringify(id.slice(0, POINTER_DETAIL_CHARS))}); run node tools/release.mjs rollback VERSION`,
    );
  }
  const root = path.join(HERE, "dist", id);
  if (!fs.existsSync(path.join(root, "src", "index.mjs"))) {
    throw new Error(
      `release ${id}, named by dist/current, is missing under dist/; run node tools/release.mjs rollback VERSION`,
    );
  }
  return root;
}

let runner;
try {
  runner = await import(pathToFileURL(path.join(releaseRoot(), "src", "index.mjs")).href);
} catch (error) {
  if (!asScript) throw error;
  process.stderr.write(`run-codex-task: ${error.message}\n`);
  process.exit(EXIT_FAILURE);
}

export const {
  RUNNER_VERSION,
  ROLES,
  DISPLAY,
  KNOWN_OPTIONS,
  parseArgs,
  parseTaskFile,
  parseDuration,
  applyDirectives,
  compareVersions,
  selectCodex,
  codexEnvironment,
  protocolUsage,
  runProcess,
  acquireLock,
  gitToplevel,
  workspaceId,
  acquireWriterLock,
  releaseWriterLock,
  claimRequest,
  releaseRequestClaim,
  listRuns,
  truncateOutput,
  fitOutput,
} = runner;
// The recovery, attach, continue and close commands the runner prints name this file.
export const main = (argv, io) => runner.main(argv, { ...io, script: SCRIPT });

if (asScript) await runner.runCli(SCRIPT);
