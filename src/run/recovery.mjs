// Recovery reads history; it never sends a turn. Unknown submission is a
// durable failed outcome, with its thread retained for a later explicit turn.
import { keepDriverDiagnostics } from "../shared/audit.mjs";
import { jobPromptRedactor } from "../state/prompt-inputs.mjs";
import { modelEvents } from "../shared/model-events.mjs";
import { CodexSession, foldItems } from "../codex/session.mjs";
import { inspectAppServer, inspectDriver } from "../codex/driver-client.mjs";
import { readDriver, readTurn, settleJob, writeDriver, abandonedJob } from "../state/job-store.mjs";
import { PROCESSES } from "../shared/process-stop.mjs";
import { REAL_TIMING } from "../shared/timing.mjs";
import { selectCodex, requireSupportedCodex } from "../codex/cli.mjs";
import {
  RPC,
  CODEX_IDENTITY_FIELDS,
  CODEX_VALUE,
  TURN_STATUS,
  JOB_STATUS,
  JOB_READ_POLICY,
  WORKER_STATE,
  isGoneWorkerState,
  DRIVER_TEXT,
  DRIVER_PHASE,
  RECOVERY_MAX_PAGES,
  RECOVERY_PAGE_SIZE,
  RECOVERY_SORT,
  APP_SERVER_EXIT_MS,
  DRIVER_POLL_MS,
  DETAIL_CHARS,
  STEER_STATUS,
  COMPACTION_UNCERTAIN,
} from "../shared/constants.mjs";
import { CODES, RunnerError } from "../shared/errors.mjs";

const strict = { policy: JOB_READ_POLICY.STRICT };
const failure = (code, message) => {
  const text =
    code === CODES.SUBMISSION_UNCERTAIN && !message.startsWith(`${code}:`)
      ? `${code}: ${message}`
      : message;
  return {
    status: JOB_STATUS.FAILED,
    text,
    tokenUsage: null,
    rateLimits: null,
    touchedFiles: [],
    error: { code, message: text },
  };
};
const refused = () => new RunnerError(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.STOP);

export function reconcileSteers(steers, turn) {
  return steers.map((entry) => {
    if (![STEER_STATUS.DISPATCHING, STEER_STATUS.UNCERTAIN].includes(entry.status)) return entry;
    const matches =
      turn?.id === entry.expectedTurnId
        ? (turn.items ?? []).filter(
            (item) =>
              item.type === CODEX_VALUE.USER_MESSAGE && item.clientId === entry.clientUserMessageId,
          )
        : [];
    return matches.length === 1 || (entry.observed === true && matches.length < 2)
      ? { ...entry, status: STEER_STATUS.ACCEPTED, observed: true, code: null }
      : { ...entry, status: STEER_STATUS.UNCERTAIN, code: CODES.SUBMISSION_UNCERTAIN };
  });
}

async function pages(session, method, params) {
  const data = [],
    seen = new Set();
  let cursor = null;
  for (let page = 0; page < RECOVERY_MAX_PAGES; page++) {
    const result = await session.request(method, { ...params, cursor, limit: RECOVERY_PAGE_SIZE });
    if (!Array.isArray(result.data))
      throw new RunnerError(CODES.SUBMISSION_UNCERTAIN, DRIVER_TEXT.UNCERTAIN);
    data.push(...result.data);
    if (!result.nextCursor) return data;
    if (seen.has(result.nextCursor)) break;
    cursor = result.nextCursor;
    seen.add(cursor);
  }
  throw new RunnerError(CODES.SUBMISSION_UNCERTAIN, DRIVER_TEXT.UNCERTAIN);
}

export async function lookupTurn(
  record,
  { parentEnv = process.env, processes = PROCESSES, timing = REAL_TIMING } = {},
) {
  // review/start has no client message ID. Never guess from timing or position.
  if (record.review && !record.turnId) return null;
  if (record.compact && !record.clientUserMessageId) return null;
  const codex = requireSupportedCodex(await selectCodex(parentEnv, record.cwd), parentEnv);
  if ([...CODEX_IDENTITY_FIELDS].some((key) => codex[key] !== record.codex?.[key]))
    throw new RunnerError(CODES.CODEX_UNSUPPORTED, DRIVER_TEXT.CLI_CHANGED);
  const session = new CodexSession(record, { env: parentEnv, processes, timing });
  try {
    await session.open();
    const resumed = await session.request(RPC.THREAD_RESUME, {
      threadId: record.threadId,
      excludeTurns: true,
      cwd: record.cwd,
      model: record.model,
      approvalPolicy: CODEX_VALUE.NEVER,
      sandbox: record.write ? CODEX_VALUE.WORKSPACE_WRITE : CODEX_VALUE.READ_ONLY,
    });
    if (resumed.thread?.id !== record.threadId) return null;
    const turns = await pages(session, RPC.THREAD_TURNS_LIST, {
      threadId: record.threadId,
      sortDirection: RECOVERY_SORT,
      itemsView: CODEX_VALUE.FULL,
    });
    for (const turn of turns) {
      if (turn.itemsView !== CODEX_VALUE.FULL) {
        const items = await pages(session, RPC.THREAD_ITEMS_LIST, {
          threadId: record.threadId,
          turnId: turn.id,
        });
        turn.items = items.filter((entry) => entry.turnId === turn.id).map((entry) => entry.item);
      }
    }
    const found = record.review
      ? turns.filter((turn) => turn.id === record.turnId)
      : turns.filter((turn) =>
          turn.items?.some(
            (item) => item.type === CODEX_VALUE.USER_MESSAGE && item.clientId === record.jobId,
          ),
        );
    return found.length === 1 ? found[0] : null;
  } finally {
    await session.close();
  }
}

export async function recoverJob(
  run,
  {
    stateDir,
    parentEnv,
    processes = PROCESSES,
    timing = REAL_TIMING,
    lookup = lookupTurn,
    resultsDir,
    warn,
  } = {},
) {
  const terminal = readTurn(stateDir, run.jobId, strict);
  if (terminal) {
    // Older drivers may have recorded an observation without settling a lost
    // acknowledgement. Only repair their record after identity proves exit.
    try {
      const ended = readDriver(stateDir, run.jobId);
      if (
        ended?.steers?.some(
          (entry) =>
            entry.observed &&
            [STEER_STATUS.UNCERTAIN, STEER_STATUS.DISPATCHING].includes(entry.status),
        ) &&
        isGoneWorkerState(inspectDriver(ended, { processes, stateDir, timing }))
      )
        writeDriver(stateDir, run.jobId, { ...ended, steers: reconcileSteers(ended.steers, null) });
    } catch {
      // Optional metadata repair must never hide the immutable terminal result.
    }
    return { terminal, retryable: false };
  }
  let driver = readDriver(stateDir, run.jobId, strict);
  const abandoned = abandonedJob(stateDir, run.jobId);
  if (!driver) {
    if (abandoned) driver = writeDriver(stateDir, run.jobId, abandoned);
  }
  if (!driver) throw refused();
  if (
    run.worker?.jobId === run.jobId &&
    (driver.pid !== run.worker.pid || driver.processStart !== run.worker.processStart)
  )
    throw refused();
  const inspect = (record) =>
    abandoned && JSON.stringify(record) === JSON.stringify(driver)
      ? WORKER_STATE.GONE
      : inspectDriver(record, { processes, stateDir, timing });
  if (!isGoneWorkerState(inspect(driver))) throw refused();
  // Driver death should drain stdin. Never join the thread while its prior
  // owned app-server might still be using it.
  if (driver.appServer) {
    const deadline = timing.now() + APP_SERVER_EXIT_MS;
    let state = inspectAppServer(driver.appServer, { processes });
    while (state === WORKER_STATE.WORKER && timing.now() < deadline) {
      await timing.sleep(DRIVER_POLL_MS);
      state = inspectAppServer(driver.appServer, { processes });
    }
    if (!isGoneWorkerState(state)) throw refused();
  }
  const dispatched = !(
    [DRIVER_PHASE.GATED, DRIVER_PHASE.STARTING].includes(driver.phase) &&
    driver.dispatching !== true &&
    !driver.turnId &&
    !driver.clientUserMessageId
  );
  let retryable = !dispatched;
  let patch = failure(CODES.CODEX_RPC_ERROR, DRIVER_TEXT.DIED);
  if (dispatched) {
    let turn = null;
    let lookupFailure = null;
    if (driver.threadId) {
      try {
        turn = await lookup(driver, { parentEnv, processes, timing });
      } catch (error) {
        // Keep the actionable cause without exposing prompt text a CLI may
        // echo. Losing history is never permission to resend the turn.
        const code = error.code ?? CODES.CODEX_RPC_ERROR;
        try {
          const redactor = jobPromptRedactor(stateDir, driver, { marker: "<prompt omitted>" });
          if (redactor.blocked) throw new Error("prompt inputs unavailable");
          lookupFailure = redactor.redact(`${code}: ${error.message}`).slice(0, DETAIL_CHARS);
        } catch {
          lookupFailure = `${code}: ${DRIVER_TEXT.HISTORY_REDACTED}`;
        }
      }
    }
    if (driver.steers?.length) {
      driver = writeDriver(stateDir, run.jobId, {
        ...driver,
        steers: reconcileSteers(driver.steers, turn),
      });
    }
    if (turn?.status === TURN_STATUS.COMPLETED) {
      const folded = foldItems(turn.items, { review: Boolean(driver.review) });
      if (folded.text !== null)
        patch = {
          status: JOB_STATUS.COMPLETED,
          text: folded.text,
          threadId: driver.threadId,
          turnId: turn.id,
          durationMs: turn.durationMs ?? null,
          touchedFiles: folded.touchedFiles,
          tokenUsage: null,
          rateLimits: null,
          error: null,
        };
      else patch = failure(CODES.SUBMISSION_UNCERTAIN, DRIVER_TEXT.UNCERTAIN);
    } else if (turn?.status === TURN_STATUS.INTERRUPTED || turn?.status === TURN_STATUS.FAILED) {
      // Even interrupted history is a crash when no terminal publication
      // survived. Only the live cancel path may synthesize cancellation.
      patch = { ...patch, turnId: turn.id };
    } else
      patch = failure(
        CODES.SUBMISSION_UNCERTAIN,
        lookupFailure
          ? `${DRIVER_TEXT.UNCERTAIN} ${DRIVER_TEXT.HISTORY_FAILURE} ${lookupFailure}`
          : DRIVER_TEXT.UNCERTAIN,
      );
  }
  if (driver.compaction) {
    patch.compaction = {
      status:
        driver.compaction.status === TURN_STATUS.COMPLETED
          ? TURN_STATUS.COMPLETED
          : COMPACTION_UNCERTAIN,
      turnId: typeof driver.compaction.turnId === "string" ? driver.compaction.turnId : null,
    };
  }
  const observedModelEvents = modelEvents(driver.modelEvents);
  if (observedModelEvents) patch.modelEvents = observedModelEvents;
  if (driver.progressWriteFailed === true) patch.progressWriteFailed = true;
  const settled = await settleJob(stateDir, run.jobId, patch, { inspect });
  await keepDriverDiagnostics(run, { stateDir, resultsDir, warn });
  retryable = retryable && settled.error?.message === DRIVER_TEXT.DIED;
  return { terminal: settled, retryable };
}
