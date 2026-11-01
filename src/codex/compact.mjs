import {
  RPC,
  NOTIFICATION,
  TURN_STATUS,
  DRIVER_PHASE,
  COMPACTION_ITEM,
  COMPACTION_TIMEOUT_MS,
  COMPACTION_UNCERTAIN,
} from "../shared/constants.mjs";
import { CODES, RunnerError } from "../shared/errors.mjs";

// Manual compact has no client id and returns no turn id. It is its own
// operation, never an acknowledgement that the follow-up prompt was sent.
export async function compactThread(session) {
  if (!session.plan.threadId) throw new Error("compaction requires a continuation");
  const compact = { turnId: null, item: false };
  let timer;
  const done = new Promise((resolve, reject) => {
    compact.resolve = resolve;
    compact.reject = reject;
    timer = setTimeout(
      () =>
        reject(
          new RunnerError(
            CODES.SUBMISSION_UNCERTAIN,
            "Compaction outcome is uncertain; the follow-up prompt was not sent",
          ),
        ),
      COMPACTION_TIMEOUT_MS,
    );
  });
  done.catch(() => {});
  session.compacting = compact;
  session.compaction = { status: DRIVER_PHASE.DISPATCHING, turnId: null };
  session.checkpoint({
    phase: DRIVER_PHASE.DISPATCHING,
    dispatching: true,
    clientUserMessageId: null,
    compaction: session.compaction,
  });
  try {
    await session.request(RPC.THREAD_COMPACT, { threadId: session.threadId });
    const ended = await Promise.race([done, session.completion]);
    if (ended.status !== TURN_STATUS.COMPLETED || !compact.item)
      throw new RunnerError(
        CODES.CODEX_RPC_ERROR,
        "Compaction did not complete; the follow-up prompt was not sent",
      );
    session.compaction = { status: TURN_STATUS.COMPLETED, turnId: compact.turnId };
    session.checkpoint({ turnId: null, compaction: session.compaction });
  } catch (error) {
    if (session.compaction.status !== TURN_STATUS.COMPLETED)
      session.compaction = { ...session.compaction, status: COMPACTION_UNCERTAIN };
    session.checkpoint({ compaction: session.compaction });
    session.failure = new RunnerError(
      CODES.SUBMISSION_UNCERTAIN,
      `${CODES.SUBMISSION_UNCERTAIN}: Compaction was not confirmed; the follow-up prompt was not sent and compaction will not be retried automatically`,
      { cause: error },
    );
    throw session.failure;
  } finally {
    clearTimeout(timer);
    session.compacting = null;
    session.turnId = null;
  }
}

export function compactNotification(session, method, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const state = session.compacting;
  if (!state || params.threadId !== session.threadId) return false;
  const turnId = params.turnId ?? params.turn?.id;
  if (method === NOTIFICATION.TURN_STARTED && !state.turnId && turnId) {
    state.turnId = turnId;
    session.turnId = turnId;
    session.compaction.turnId = turnId;
    session.checkpoint({ compaction: session.compaction });
  }
  if (!state.turnId || turnId !== state.turnId) return true;
  if (
    method === NOTIFICATION.THREAD_COMPACTED ||
    (method === NOTIFICATION.ITEM_COMPLETED && params.item?.type === COMPACTION_ITEM)
  )
    state.item = true;
  if (method === NOTIFICATION.TURN_COMPLETED) {
    if (
      Array.isArray(params.turn?.items) &&
      params.turn.items.some((item) => item?.type === COMPACTION_ITEM)
    )
      state.item = true;
    if (
      [TURN_STATUS.COMPLETED, TURN_STATUS.FAILED, TURN_STATUS.INTERRUPTED].includes(
        params.turn?.status,
      )
    )
      state.resolve(params.turn);
  }
  if (method === NOTIFICATION.ERROR && params.willRetry === false)
    state.reject(new Error("compaction failed"));
  return true;
}
