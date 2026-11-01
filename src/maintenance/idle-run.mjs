import { observeRun } from "../run/progress.mjs";
import { isForkSeed } from "../shared/fork.mjs";
import { acquireRunLock, isDelivered } from "../state/state.mjs";
import { saveRun } from "../state/run-store.mjs";
import { readDriver } from "../state/job-store.mjs";
import { assertMaintenanceIdle } from "../state/maintenance-worker.mjs";
import { inspectDriver, inspectAppServer } from "../codex/driver-client.mjs";
import { selectCodex, requireSupportedCodex } from "../codex/cli.mjs";
import { CodexSession } from "../codex/session.mjs";
import { PROCESSES } from "../shared/process-stop.mjs";
import {
  APP_SERVER_MODE,
  MCP_MODE,
  CODEX_IDENTITY_FIELDS,
  CODEX_VALUE,
  RPC,
  JOB_READ_POLICY,
  isGoneWorkerState,
  RUN_LOCK_OUTCOME,
  ARCHIVABLE_THREAD_STATES,
} from "../shared/constants.mjs";

export async function withIdleRun(options, context, action, { resume = false } = {}) {
  const { stateBase, parentEnv, signal, commandMs, processes = PROCESSES } = context;
  const key = observeRun(options.key, stateBase, { allowSeed: true }).run.runKey;
  const lock = await acquireRunLock(key, {
    stateBase,
    deadline: Date.now(),
    mode: options.mode,
    signal,
  });
  if (lock.kind !== RUN_LOCK_OUTCOME.LOCKED)
    throw new Error("run is busy; collect or sleep it first");
  let session, run, stateDir;
  try {
    ({ run, stateDir } = observeRun(key, stateBase, { allowSeed: true }));
    assertMaintenanceIdle(run, processes);
    const driver = run.jobId
      ? readDriver(stateDir, run.jobId, { policy: JOB_READ_POLICY.STRICT })
      : null;
    if (
      (!isDelivered(run) && !isForkSeed(run)) ||
      run.result?.shutdownPending ||
      !run.dormant ||
      run.continuing ||
      run.launching ||
      !(run.result?.threadId ?? run.contextThreadId) ||
      (!isForkSeed(run) &&
        (!driver ||
          !isGoneWorkerState(inspectDriver(driver, { stateDir, processes })) ||
          (driver.appServer &&
            !isGoneWorkerState(inspectAppServer(driver.appServer, { processes })))))
    )
      throw new Error(
        "command requires a delivered, sleeping run; collect it with --run, then --sleep if needed",
      );
    const codex = requireSupportedCodex(
      await selectCodex(parentEnv, run.cwd, commandMs, signal),
      parentEnv,
    );
    if (CODEX_IDENTITY_FIELDS.some((k) => codex[k] !== run.codex[k]))
      throw new Error("the run's pinned Codex build changed");
    const save = () => saveRun(run, stateDir);
    session = new CodexSession(
      {
        ...run,
        codex,
        mode: APP_SERVER_MODE.PROBE,
        mcp: MCP_MODE.OFF,
        loadsThread: resume,
        write: false,
      },
      {
        env: parentEnv,
        processes,
        checkpoint: (patch) => {
          if (patch.appServer) {
            run.maintenanceWorker = patch.appServer;
            save();
          }
        },
      },
    );
    await session.open();
    signal?.throwIfAborted();
    const threadId = run.result?.threadId ?? run.contextThreadId;
    const read = await session.request(RPC.THREAD_READ, { threadId, includeTurns: false });
    if (read.thread?.id !== threadId || !ARCHIVABLE_THREAD_STATES.has(read.thread?.status?.type))
      throw new Error("Codex thread is active or unidentified; no maintenance performed");
    if (resume) {
      const reply = await session.request(RPC.THREAD_RESUME, {
        threadId,
        excludeTurns: true,
        model: run.model,
        cwd: run.cwd,
        approvalPolicy: CODEX_VALUE.NEVER,
        sandbox: CODEX_VALUE.READ_ONLY,
      });
      if (
        reply.thread?.id !== threadId ||
        reply.model !== run.model ||
        reply.approvalPolicy !== CODEX_VALUE.NEVER ||
        reply.sandbox?.type !== CODEX_VALUE.READ_ONLY_POLICY
      )
        throw new Error("maintenance resume returned different identity or safety settings");
    }
    return await action({ ...context, run, stateDir, driver, session, threadId, save });
  } finally {
    try {
      await session?.close();
      if (run?.maintenanceWorker) {
        assertMaintenanceIdle(run, processes);
        delete run.maintenanceWorker;
        saveRun(run, stateDir);
      }
    } finally {
      lock.releaseRunLock();
    }
  }
}
