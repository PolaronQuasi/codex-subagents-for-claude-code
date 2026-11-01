// Detached per-turn entry. No imports of run-store, no writes to run.json.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CodexSession } from "./session.mjs";
import { steerHandler } from "./steer.mjs";
import { jobPromptRedactor } from "../state/prompt-inputs.mjs";
import { serveIpc, readIpcSecret } from "./ipc.mjs";
import { processStart } from "../shared/process-identity.mjs";
import { readLimited } from "../shared/io.mjs";
import { REAL_TIMING } from "../shared/timing.mjs";
import {
  readDriver,
  writeDriver,
  writeFinal,
  writeTurn,
  appendEvent,
  appendLog,
  writeProgress,
  jobPaths,
  readCancelIntent,
} from "../state/job-store.mjs";
import {
  DRIVER_ARG,
  DRIVER_FILES,
  DRIVER_GATE_MS,
  DRIVER_POLL_MS,
  DRIVER_PHASE,
  DRIVER_IPC,
  DRIVER_TEXT,
  JOB_STATUS,
  JOB_READ_POLICY,
  MAX_PROMPT_BYTES,
  JOB_MAX_RECORD_BYTES,
  STEER_STATUS,
} from "../shared/constants.mjs";
import { CODES, ERRNO, EXIT, RunnerError } from "../shared/errors.mjs";

export async function runDriver(
  stateDir,
  jobId,
  { timing = REAL_TIMING, gateMs = DRIVER_GATE_MS } = {},
) {
  let record = readDriver(stateDir, jobId, { policy: JOB_READ_POLICY.STRICT });
  const paths = jobPaths(stateDir, jobId);
  const start = processStart(process.pid);
  const deadline = timing.now() + gateMs;
  let server, session;
  const checkpoint = (patch) => {
    record = writeDriver(stateDir, jobId, { ...record, ...patch });
  };
  const publish = (result) => {
    // Missing acknowledgement is not immutable terminal evidence. Leave the
    // dispatch checkpoint for history reconciliation after this driver exits.
    if (result.error?.code === CODES.SUBMISSION_UNCERTAIN) {
      appendEvent(stateDir, jobId, { code: CODES.SUBMISSION_UNCERTAIN });
      return;
    }
    const { text, ...metadata } = result;
    const finalSha256 = writeFinal(stateDir, jobId, text);
    writeTurn(stateDir, jobId, {
      ...metadata,
      finalSha256,
      startedAt: record.startedAt,
      completedAt: new Date().toISOString(),
    });
    checkpoint({ phase: DRIVER_PHASE.TERMINAL });
  };
  try {
    let admitted = false;
    while (timing.now() < deadline) {
      try {
        const gate = JSON.parse(
          readLimited(path.join(paths.directory, DRIVER_FILES.GATE), JOB_MAX_RECORD_BYTES).toString(
            "utf8",
          ),
        );
        record = readDriver(stateDir, jobId, { policy: JOB_READ_POLICY.STRICT });
        if (
          start === null ||
          gate.jobId !== jobId ||
          gate.pid !== process.pid ||
          gate.processStart !== start ||
          gate.generation !== record.generation ||
          record.pid !== process.pid ||
          record.processStart !== start
        )
          throw new RunnerError(CODES.IPC_AUTH_FAILED, DRIVER_TEXT.AUTH);
        admitted = true;
        break;
      } catch (error) {
        if (error.code !== ERRNO.ENOENT) throw error;
      }
      await timing.sleep(DRIVER_POLL_MS);
    }
    if (!admitted) {
      const latest = readDriver(stateDir, jobId, { policy: JOB_READ_POLICY.STRICT });
      if (latest.generation === record.generation && (!latest.pid || latest.pid === process.pid)) {
        record = latest;
        checkpoint({ pid: process.pid, processStart: start });
      }
      throw new RunnerError(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.GATE);
    }
    checkpoint({ phase: DRIVER_PHASE.STARTING });
    const acceptCancelIntent = () => {
      const intent = readCancelIntent(stateDir, jobId);
      if (intent?.generation === record.generation) {
        session.cancelRequested = true;
        checkpoint({ cancelRequestedAt: intent.requestedAt });
      }
    };
    session = new CodexSession(record, {
      checkpoint,
      beforeDispatch: acceptCancelIntent,
      event: (event) => appendEvent(stateDir, jobId, event),
      log: (text) => appendLog(stateDir, jobId, text),
      progress: (update) => writeProgress(stateDir, jobId, update),
      steerObserved: (clientId) =>
        checkpoint({
          steers: (record.steers ?? []).map((entry) =>
            entry.clientUserMessageId === clientId && entry.expectedTurnId === session.turnId
              ? { ...entry, observed: true, status: STEER_STATUS.ACCEPTED, code: null }
              : entry,
          ),
        }),
    });
    acceptCancelIntent();
    const steer = steerHandler({ stateDir, getRecord: () => record, checkpoint, session });
    server = await serveIpc(record, readIpcSecret(stateDir, jobId), async (method, payload) => {
      if (method === DRIVER_IPC.STEER) return steer(payload);
      if (method === DRIVER_IPC.STATUS)
        return {
          phase: record.phase,
          threadId: record.threadId ?? null,
          turnId: record.turnId ?? null,
        };
      if (method === DRIVER_IPC.INTERRUPT) {
        checkpoint({ cancelRequestedAt: record.cancelRequestedAt ?? new Date().toISOString() });
        return session.interrupt({ cancel: true });
      }
      // Accept promptly. Closing the session begins on the next pass so the
      // signed acknowledgement can reach the client before sockets close.
      if (method === DRIVER_IPC.SHUTDOWN) {
        setImmediate(() => {
          session.cancelStopRequested = session.cancelRequested && !session.failure;
          session.fail(new RunnerError(CODES.CODEX_RPC_ERROR, DRIVER_TEXT.SHUTDOWN));
          void session.close().catch(() => {});
        });
        return { ok: true };
      }
      throw new RunnerError(CODES.IPC_AUTH_FAILED, DRIVER_TEXT.AUTH);
    });
    checkpoint({ ipcBound: true });
    const prompt = readLimited(path.join(stateDir, "prompt.txt"), MAX_PROMPT_BYTES).toString(
      "utf8",
    );
    const result = await session.run(prompt, jobPromptRedactor(stateDir, record, { prompt }));
    publish(result);
  } catch (error) {
    publish({
      status: JOB_STATUS.FAILED,
      text: error.message,
      threadId: record?.threadId ?? null,
      turnId: record?.turnId ?? null,
      tokenUsage: null,
      rateLimits: null,
      touchedFiles: [],
      error: { code: error.code ?? CODES.CODEX_RPC_ERROR, message: error.message },
    });
  } finally {
    try {
      await session?.close();
    } finally {
      // Give a settled control handler one event-loop pass to flush its signed
      // reply before closing the IPC socket.
      await new Promise(setImmediate);
      await server?.close();
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args[0] !== DRIVER_ARG.RUN || args[1] !== DRIVER_ARG.JOB || args[3] !== DRIVER_ARG.STATE)
    process.exitCode = EXIT.FAILURE;
  else {
    try {
      await runDriver(args[4], args[2]);
    } catch {
      process.exitCode = EXIT.FAILURE;
    }
  }
}
