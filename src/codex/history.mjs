// Bounded, explicit history reads. No turn submission and no automatic retry.
import {
  RECOVERY_MAX_PAGES,
  RECOVERY_PAGE_SIZE,
  HISTORY_MAX_BYTES,
  HISTORY_READ_MS,
} from "../shared/constants.mjs";

export function historyBudget(signal) {
  return { bytes: 0, pages: 0, deadline: Date.now() + HISTORY_READ_MS, signal };
}

export async function historyPages(session, method, params, budget) {
  const data = [],
    seen = new Set();
  let cursor = null;
  while (budget.pages < RECOVERY_MAX_PAGES && budget.bytes < HISTORY_MAX_BYTES) {
    budget.signal?.throwIfAborted();
    const remaining = budget.deadline - Date.now();
    if (remaining <= 0) return { data, truncated: true };
    budget.pages++;
    const result = await session.request(
      method,
      { ...params, cursor, limit: RECOVERY_PAGE_SIZE },
      remaining,
    );
    if (
      !Array.isArray(result?.data) ||
      (result.nextCursor != null && (typeof result.nextCursor !== "string" || !result.nextCursor))
    )
      throw new Error("invalid Codex history page");
    budget.bytes += Buffer.byteLength(JSON.stringify(result));
    if (budget.bytes > HISTORY_MAX_BYTES) return { data, truncated: true };
    data.push(...result.data);
    if (result.nextCursor == null) return { data, truncated: false };
    if (seen.has(result.nextCursor)) throw new Error("repeated Codex history cursor");
    cursor = result.nextCursor;
    seen.add(cursor);
  }
  return { data, truncated: true };
}
