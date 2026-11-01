import { withIdleRun } from "./idle-run.mjs";
import { historyPages, historyBudget } from "../codex/history.mjs";
import { digest, writeOutput } from "../shared/io.mjs";
import {
  RPC,
  HISTORY_SORT,
  HISTORY_EDIT_MAX,
  HISTORY_ITEMS_OMITTED,
  THREAD_ID,
  TURN_STATUS,
  TRANSCRIPT_MAX_TURNS,
} from "../shared/constants.mjs";
import { EXIT } from "../shared/errors.mjs";

export async function completeHistory(session, threadId, signal) {
  const page = await historyPages(
    session,
    RPC.THREAD_TURNS_LIST,
    { threadId, sortDirection: HISTORY_SORT, itemsView: HISTORY_ITEMS_OMITTED },
    historyBudget(signal),
  );
  if (
    page.truncated ||
    page.data.length > TRANSCRIPT_MAX_TURNS ||
    page.data.some(
      (t) =>
        !THREAD_ID.test(t?.id ?? "") ||
        ![TURN_STATUS.COMPLETED, TURN_STATUS.FAILED, TURN_STATUS.INTERRUPTED].includes(t.status),
    ) ||
    new Set(page.data.map((t) => t.id)).size !== page.data.length
  )
    throw new Error("history is incomplete, active or ambiguous; no mutation performed");
  return page.data;
}
const idsHash = (turns) => digest(JSON.stringify(turns.map((t) => t.id)));

export async function revert(options, context) {
  return withIdleRun(
    options,
    context,
    async ({ run, session, threadId, save, stdout, signal, commandMs }) => {
      const history = await completeHistory(session, threadId, signal);
      let op = run.historyOperation;
      if (op) {
        if (options["before-turn"] !== op.beforeTurn)
          throw new Error(
            "repeat the original --before-turn value to reconcile the pending revert",
          );
        if (op.prefixHash !== idsHash(history))
          throw new Error(
            "earlier revert is unconfirmed; history does not prove its expected prefix. No mutation was resent",
          );
      } else {
        if ((run.historyEdits?.length ?? 0) >= HISTORY_EDIT_MAX)
          throw new Error("history edit record limit reached; fork or start a new run");
        const index = options["before-turn"] - 1;
        if (!history[index])
          throw new Error("no such persisted turn; use --transcript to see turn numbers");
        op = {
          at: new Date().toISOString(),
          beforeTurn: options["before-turn"],
          beforeTurnId: history[index].id,
          prefixHash: idsHash(history.slice(0, index)),
          removedTurnIds: history.slice(index).map((t) => t.id),
        };
        run.historyOperation = op;
        save(); // intent before any destructive RPC bytes
        try {
          const reply = await session.request(RPC.THREAD_REVERT, {
            threadId,
            beforeTurnId: op.beforeTurnId,
          });
          if (reply.thread?.id !== threadId) throw new Error("revert identity mismatch");
          if (idsHash(await completeHistory(session, threadId, signal)) !== op.prefixHash)
            throw new Error("unexpected history prefix");
        } catch {
          throw new Error(
            "revert not confirmed; state retained. Repeat --revert to reconcile by reading history; the mutation will not be resent",
          );
        }
      }
      const removed = new Set(op.removedTurnIds);
      for (const turn of [...(run.turns ?? []), run])
        if (removed.has(turn.result?.turnId)) turn.result.contextRevertedAt = op.at;
      const { removedTurnIds, ...receipt } = op;
      (run.historyEdits ??= []).push({
        ...receipt,
        removedCount: removedTurnIds.length,
        confirmedAt: new Date().toISOString(),
      });
      delete run.historyOperation;
      save();
      await writeOutput(
        stdout,
        `codex-subagents-for-claude-code-revert: run=${run.runKey} before-turn=${op.beforeTurn} retained=${op.beforeTurn - 1}. Conversation history changed; files and commits are unchanged. Local delivery records are retained.\n`,
        { signal, timeoutMs: commandMs },
      );
      return EXIT.COMPLETED;
    },
    { resume: true },
  );
}
