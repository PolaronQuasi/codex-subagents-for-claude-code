// main(argv, io): the interface the tests drive and the entry runs. It parses
// the arguments, answers --help, resolves the folders from the environment,
// runs the maintenance modes (--list, --doctor and the sweeps) and hands every
// other mode to runCommand. Every error ends as one "run-codex-task:" line on
// stderr and exit 1.

import { HELP, SWEEPS, environmentPaths, parseArgs } from "../cli/options.mjs";
import { AUDIT_TRANSITION, OUTCOME, SESSION_ID } from "../shared/constants.mjs";
import { writeOutput } from "../shared/io.mjs";
import { doctor, limits, listRuns, prepare, sweep } from "../maintenance/commands.mjs";
import { runCommand } from "./runner.mjs";
import { printDiff } from "./progress.mjs";
import { steerRun } from "./steer.mjs";
import { createAudit } from "../shared/audit.mjs";
import { inspect } from "../maintenance/inspect.mjs";
import { transcript } from "../maintenance/transcript.mjs";
import { orphanThreads } from "../maintenance/threads.mjs";
import { bundle } from "../maintenance/bundle.mjs";
import { revert } from "../maintenance/history-edit.mjs";
import { fork } from "../maintenance/fork.mjs";
import { EXIT } from "../shared/errors.mjs";
import { readStdin } from "../cli/stdin.mjs";
import { artifacts } from "../maintenance/artifacts.mjs";
import { batch } from "../maintenance/batch.mjs";
import { verifyArtifact } from "../maintenance/verification.mjs";

// io: env and cwd of the invocation, stdout and stderr streams, an abort
// signal, requireDurableCopy (a delivery whose durable copy cannot be written
// fails and retains the run; the sweeps use it, since they keep nothing of
// what they capture) and script, the stable entry path the printed commands
// name. timing and processes replace the clock and the OS process queries and
// stops for policy tests (REAL_TIMING, PROCESSES). Returns the exit code.
/** @param {string[]} [argv] @param {import('../shared/types.mjs').RunnerIO} [io] @returns {Promise<number>} */
export async function main(
  argv = process.argv.slice(2),
  {
    env: parentEnv = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
    stdin = process.stdin,
    stderr = process.stderr,
    signal,
    requireDurableCopy = false,
    script,
    timing,
    processes,
    onOutcome,
  } = {},
) {
  const warn = (message) => writeOutput(stderr, `run-codex-task: ${message}\n`);
  let audit;
  try {
    const options = parseArgs(argv);
    if (options.mode === "help") {
      await writeOutput(stdout, HELP);
      return EXIT.COMPLETED;
    }
    const commandMs = options["command-timeout-ms"];
    if (options["task-file"] === "-" || options["prompt-file"] === "-")
      options.stdinBytes = await readStdin(stdin, { signal, timeoutMs: commandMs });
    if (options.mode === "doctor")
      return await doctor({
        parentEnv,
        cwd,
        commandMs,
        signal,
        stdout,
        readOnly: Boolean(options["read-only"]),
        verbose: Boolean(options.verbose),
      });
    if (options.mode === "limits")
      return await limits({ parentEnv, cwd, commandMs, signal, stdout, options });
    if (options.mode === "prepare")
      return await prepare({
        parentEnv,
        commandMs,
        signal,
        stdout,
        script,
        role: options.prepare,
      });
    const paths = environmentPaths(parentEnv);
    if (["verify-artifact", "verification"].includes(options.mode))
      return await verifyArtifact(options, { ...paths, parentEnv, cwd, stdout, signal, commandMs });
    if (["batch", "batch-run", "batch-cancel"].includes(options.mode))
      return await batch(options, {
        ...paths,
        parentEnv,
        cwd,
        stdout,
        signal,
        commandMs,
        warn,
        invoke: (args, io) => main(args, { ...io, script, timing, processes }),
      });
    if (["artifact", "finalize", "integrate", "discard"].includes(options.mode))
      return await artifacts(options, {
        ...paths,
        parentEnv,
        cwd,
        stdout,
        signal,
        commandMs,
        processes,
      });
    if (options.mode === "fork")
      return await fork(options, {
        ...paths,
        parentEnv,
        stdout,
        signal,
        commandMs,
        processes,
        script,
      });
    if (options.mode === "revert")
      return await revert(options, { ...paths, parentEnv, stdout, signal, commandMs, processes });
    if (options.mode === "bundle")
      return await bundle(options, { ...paths, parentEnv, stdout, signal, commandMs, processes });
    if (options.mode === "archive-orphans" || (options.mode === "list" && options.codex))
      return await orphanThreads(options, { ...paths, parentEnv, cwd, stdout, signal, commandMs });
    if (options.mode === "transcript")
      return await transcript(options, {
        ...paths,
        parentEnv,
        stdout,
        signal,
        commandMs,
        processes,
      });
    if (options.mode === "steer")
      return await steerRun(options, { ...paths, cwd, stdout, signal, commandMs });
    if (options.diff)
      return await printDiff(options, { ...paths, stdout, signal, commandMs, warn });
    if (options.mode === "inspect")
      return await inspect(options, { paths, stdout, signal, commandMs, script });
    if (options.mode === "list") {
      const mine = options.mine ? parentEnv.CLAUDE_CODE_SESSION_ID : null;
      if (options.mine && !SESSION_ID.test(mine ?? ""))
        throw new Error(
          "--mine needs CLAUDE_CODE_SESSION_ID, which Claude Code sets for its tool calls",
        );
      await writeOutput(
        stdout,
        listRuns(paths.stateBase, {
          session: mine,
          active: Boolean(options.active),
        }),
        { signal, timeoutMs: commandMs },
      );
      return EXIT.COMPLETED;
    }
    if (SWEEPS.includes(options.mode)) {
      if (!options["dry-run"]) {
        audit = createAudit({
          resultsDir: paths.resultsDir,
          session: parentEnv.CLAUDE_CODE_SESSION_ID,
          warn,
        });
        await audit.emit(AUDIT_TRANSITION.SWEEP);
      }
      // A sweep runs existing commands in this process; they print their own
      // commands with the same entry path.
      const invoke = (args, io) => main(args, { ...io, script, timing, processes });
      return await sweep(options.mode, {
        invoke,
        options,
        parentEnv,
        cwd,
        stateBase: paths.stateBase,
        stdout,
        signal,
        commandMs,
      });
    }
    audit = createAudit({
      resultsDir: paths.resultsDir,
      session: parentEnv.CLAUDE_CODE_SESSION_ID,
      warn,
    });
    return await runCommand(options, {
      parentEnv,
      cwd,
      stdout,
      signal,
      requireDurableCopy,
      script,
      paths,
      warn,
      timing,
      processes,
      audit,
      onOutcome,
    });
  } catch (error) {
    // An in-process collector gets the reason, as the one error line says it.
    onOutcome?.({ kind: OUTCOME.FAILED, reason: error.message ?? String(error) });
    await audit?.emit(AUDIT_TRANSITION.ERROR);
    await warn(error.message ?? String(error));
    return EXIT.FAILURE;
  }
}
