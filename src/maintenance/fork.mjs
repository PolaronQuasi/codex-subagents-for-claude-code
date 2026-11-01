import path from "node:path";
import { withIdleRun } from "./idle-run.mjs";
import { completeHistory } from "./history-edit.mjs";
import { launchRun } from "../run/launch.mjs";
import { saveRun } from "../state/run-store.mjs";
import { jobPromptRedactor } from "../state/prompt-inputs.mjs";
import { rememberThread } from "../state/thread-owners.mjs";
import { assertMaintenanceIdle } from "../state/maintenance-worker.mjs";
import { observeRun } from "../run/progress.mjs";
import { forkReceipt } from "../shared/fork.mjs";
import { threadName } from "../shared/thread-name.mjs";
import { atomicWrite, writeOutput, sameFolder } from "../shared/io.mjs";
import {
  RPC,
  CODEX_VALUE,
  FORK_STATE,
  FORK_REDACTION_FILE,
  LAUNCH_OUTCOME,
  THREAD_ID,
  MAX_PROMPT_BYTES,
} from "../shared/constants.mjs";
import { EXIT } from "../shared/errors.mjs";

export async function fork(options, context) {
  let prepared;
  try {
    return await withIdleRun(
      options,
      context,
      async (source) => {
        const { run, session, threadId, stateDir, driver, signal, stdout, commandMs } = source;
        if (run.historyOperation)
          throw new Error("reconcile the pending history mutation before forking");
        if (run.write && !run.worktree && !run.scratchWorkspace)
          throw new Error(
            "forking a shared-checkout write run is refused; use an isolated worktree run",
          );
        const turns = await completeHistory(session, threadId, signal);
        const at = options.at ?? turns.length;
        if (!turns[at - 1])
          throw new Error("no such persisted turn; use --transcript for turn numbers");
        const through = turns[at - 1].id;
        let commit = run.result?.commit ?? run.worktree?.startCommit;
        if (run.worktree?.branch && (options.at !== undefined || at !== turns.length)) {
          commit = [...(run.turns ?? []), run].find((t) => t.result?.turnId === through)?.result
            ?.commit;
          if (!commit)
            throw new Error(
              "this worktree history point has no recorded delivered commit; choose a delivered turn",
            );
        }
        const target = {
          model: run.model,
          effort: run.effort,
          write: Boolean(run.write),
          "keep-state": true,
          "scratch-workspace": Boolean(run.scratchWorkspace),
          worktree: Boolean(run.worktree),
          ...(run.worktree ? { "worktree-ref": commit } : {}),
          mcp: run.mcp,
          summary: run.summary,
          progress: run.progress,
          "quota-floor": run.quotaFloor,
          "request-id": options["request-id"],
          forkedFrom: { runKey: run.runKey, threadId, turnId: through, at },
        };
        const info = (text) => writeOutput(stdout, `${text}\n`, { signal, timeoutMs: commandMs });
        const launch = await launchRun(target, Buffer.alloc(0), {
          ...context,
          base: run.worktree?.base ?? run.cwd,
          delivery: {
            quiet: run.quiet,
            relay: run.relay,
            maxLines: run.maxStdoutLines,
            maxBytes: run.maxStdoutBytes,
          },
          deadline: Date.now(),
          info,
          warn: info,
          script: context.script,
        });
        if (launch.kind !== LAUNCH_OUTCOME.PREPARED) {
          if (launch.kind !== LAUNCH_OUTCOME.ATTACH)
            throw new Error(
              "fork request already exists or was delivered; inspect its retained run or use a new request ID",
            );
          const existing = observeRun(launch.key, context.stateBase, { allowSeed: true }).run;
          if (existing.forkState !== FORK_STATE.READY)
            throw new Error(`fork ${existing.runKey} is unconfirmed; no fork request was resent`);
          await info(forkReceipt(existing).trimEnd());
          return EXIT.COMPLETED;
        }
        prepared = launch;
        const child = launch.run;
        const save = () => saveRun(child, launch.stateDir);
        child.maintenanceWorker = run.maintenanceWorker;
        save();
        const scrubber = jobPromptRedactor(
          stateDir,
          driver ?? { forkRedaction: run.forkRedaction },
        );
        let redaction = JSON.stringify({
          blocked: scrubber.blocked,
          fragments: [...scrubber.fragments],
        });
        if (Buffer.byteLength(redaction) > MAX_PROMPT_BYTES)
          redaction = JSON.stringify({ blocked: true, fragments: [] });
        atomicWrite(path.join(launch.stateDir, FORK_REDACTION_FILE), redaction);
        child.forkState = FORK_STATE.DISPATCHING;
        save();
        try {
          const reply = await session.request(RPC.THREAD_FORK, {
            threadId,
            lastTurnId: through,
            excludeTurns: true,
            model: child.model,
            cwd: child.cwd,
            approvalPolicy: CODEX_VALUE.NEVER,
            sandbox: child.write ? CODEX_VALUE.WORKSPACE_WRITE : CODEX_VALUE.READ_ONLY,
            ephemeral: false,
          });
          if (
            !THREAD_ID.test(reply.thread?.id ?? "") ||
            reply.thread.id === threadId ||
            reply.thread.forkedFromId !== threadId ||
            reply.model !== child.model ||
            reply.approvalPolicy !== CODEX_VALUE.NEVER ||
            reply.sandbox?.type !==
              (child.write ? CODEX_VALUE.WORKSPACE_WRITE_POLICY : CODEX_VALUE.READ_ONLY_POLICY) ||
            !sameFolder(reply.cwd ?? "", child.cwd) ||
            !sameFolder(reply.thread.cwd ?? "", child.cwd)
          )
            throw new Error("fork identity or safety settings mismatch");
          child.contextThreadId = reply.thread.id;
          save();
          const name = threadName(child.runKey, child.model);
          rememberThread(
            child,
            { ...context, stateDir: launch.stateDir },
            { threadId: child.contextThreadId, name },
          );
          try {
            await session.request(RPC.THREAD_NAME_SET, { threadId: child.contextThreadId, name });
          } catch {
            await info("Fork created but thread naming failed; its identity receipt is retained.");
          }
          child.forkState = FORK_STATE.READY;
          child.dormant = true;
          save();
          await info(forkReceipt(child).trimEnd());
          return EXIT.COMPLETED;
        } catch {
          throw new Error(
            `fork ${child.runKey} not confirmed; inspect its retained state. No model turn was sent and no fork request will be resent automatically`,
          );
        }
      },
      { resume: true },
    );
  } finally {
    if (prepared) {
      try {
        assertMaintenanceIdle(prepared.run, context.processes);
        delete prepared.run.maintenanceWorker;
        saveRun(prepared.run, prepared.stateDir);
      } finally {
        prepared.releaseRunLock();
      }
    }
  }
}
