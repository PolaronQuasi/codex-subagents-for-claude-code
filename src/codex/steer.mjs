// One authenticated request references one private file. Durable dispatch intent
// fences duplicates across connections, timeouts and recovery; never retry RPC.
import { readSteer, validSteerNumber } from "../state/job-store.mjs";
import { STEER_STATUS, STEER_FILES } from "../shared/constants.mjs";
import { CODES } from "../shared/errors.mjs";

export function steerHandler({ stateDir, getRecord, checkpoint, session }) {
  const save = (entry) =>
    checkpoint({
      steers: [
        ...(getRecord().steers ?? []).filter((previous) => previous.n !== entry.n),
        entry,
      ].sort((a, b) => a.n - b.n),
    });
  const answer = (entry) => ({ n: entry.n, status: entry.status, code: entry.code ?? null });
  return async (payload) => {
    if (!payload || Object.keys(payload).length !== 1 || !validSteerNumber(payload.n))
      return { status: STEER_STATUS.REJECTED, code: CODES.STEER_INVALID };
    const { n } = payload;
    const prior = getRecord().steers?.find((entry) => entry.n === n);
    if (prior) return answer(prior); // Even dispatching/uncertain is never resent.
    let entry = { n, status: STEER_STATUS.REJECTED, code: CODES.STEER_INVALID };
    let dispatched = false;
    try {
      const record = getRecord();
      const input = readSteer(stateDir, record, n);
      const clientUserMessageId = `${record.jobId}/${STEER_FILES.PREFIX}${n}`;
      entry = {
        n,
        expectedTurnId: input.expectedTurnId,
        clientUserMessageId,
        status: STEER_STATUS.DISPATCHING,
        at: new Date().toISOString(),
      };
      await session.steer({
        ...input,
        clientUserMessageId,
        beforeDispatch: () => {
          save(entry);
          dispatched = true;
        },
      });
      entry = { ...entry, status: STEER_STATUS.ACCEPTED };
    } catch (error) {
      // RPC errors may echo input. No raw message, data or path reaches IPC or progress.
      const known = [CODES.STEER_NOT_RUNNING, CODES.STEER_TURN_CHANGED, CODES.STEER_INVALID];
      entry = {
        ...entry,
        status: dispatched && !error.rpcError ? STEER_STATUS.UNCERTAIN : STEER_STATUS.REJECTED,
        code: dispatched
          ? error.rpcError
            ? CODES.STEER_REJECTED
            : CODES.SUBMISSION_UNCERTAIN
          : known.includes(error.code)
            ? error.code
            : CODES.STEER_INVALID,
      };
    }
    try {
      entry.observed = getRecord().steers?.find((previous) => previous.n === n)?.observed ?? false;
      if (entry.observed) entry = { ...entry, status: STEER_STATUS.ACCEPTED, code: null };
      save(entry);
    } catch {
      return { n, status: STEER_STATUS.UNCERTAIN, code: CODES.SUBMISSION_UNCERTAIN };
    }
    return answer(entry);
  };
}
