// Explicit bounded history, under the common idle-run and owned-probe guard.
import { withIdleRun } from "./idle-run.mjs";
import { jobPromptRedactor } from "../state/prompt-inputs.mjs";
import { historyPages, historyBudget } from "../codex/history.mjs";
import { writeOutput } from "../shared/io.mjs";
import {
  CODEX_VALUE,
  CODEX_ITEM,
  RPC,
  HISTORY_SORT,
  TRANSCRIPT_MAX_BYTES,
  TRANSCRIPT_META_BYTES,
  TRANSCRIPT_FIELD_BYTES,
  PROGRESS_MAX_PARTS,
} from "../shared/constants.mjs";
import { EXIT } from "../shared/errors.mjs";

// Allowlisted fields only: no user messages, raw reasoning, dynamic arguments,
// MCP results or future item payloads. Explicit command output is bounded and
// scrubbed against this thread's saved prompts and steers before rendering.
export function transcriptItem(item, redactor, note) {
  const text = (value) => {
    if (typeof value !== "string") return "";
    if (Buffer.byteLength(value) > TRANSCRIPT_FIELD_BYTES) note();
    return redactor.redact(value, TRANSCRIPT_FIELD_BYTES);
  };
  const finite = (n) => (Number.isFinite(n) ? n : null);
  const out = {
    type:
      Object.values(CODEX_ITEM).includes(item?.type) || item?.type === CODEX_VALUE.USER_MESSAGE
        ? item.type
        : "other",
    id: text(item?.id),
  };
  switch (out.type) {
    case CODEX_ITEM.COMMAND:
      Object.assign(out, {
        command: text(item.command),
        exitCode: finite(item.exitCode),
        durationMs: finite(item.durationMs),
        output: text(item.aggregatedOutput),
      });
      break;
    case CODEX_ITEM.FILE_CHANGE:
      if (item.changes?.length > PROGRESS_MAX_PARTS) note();
      out.paths = (Array.isArray(item.changes) ? item.changes : [])
        .slice(0, PROGRESS_MAX_PARTS)
        .map((c) => text(c?.path));
      break;
    case CODEX_ITEM.AGENT_MESSAGE:
      out.text = text(item.text);
      break;
    case CODEX_ITEM.REVIEW_ENTERED:
    case CODEX_ITEM.REVIEW_EXITED:
      out.review = text(item.review);
      break;
    case CODEX_ITEM.REASONING:
      if (item.summary?.length > PROGRESS_MAX_PARTS) note();
      out.summary = (Array.isArray(item.summary) ? item.summary : [])
        .slice(0, PROGRESS_MAX_PARTS)
        .map(text);
      break;
    case CODEX_ITEM.SEARCH:
      out.query = text(item.query);
      break;
    case CODEX_ITEM.MCP:
      Object.assign(out, { server: text(item.server), tool: text(item.tool) });
      break;
    default:
      out.omitted = true;
  }
  return out;
}

export async function readTranscript(session, threadId, { turn, redactor, signal } = {}) {
  const budget = historyBudget(signal);
  const page = await historyPages(
    session,
    RPC.THREAD_TURNS_LIST,
    {
      threadId,
      sortDirection: HISTORY_SORT,
      itemsView: CODEX_VALUE.FULL,
    },
    budget,
  );
  if (turn && turn > page.data.length)
    throw new Error(
      page.truncated
        ? "requested turn is beyond the bounded history read"
        : "no such transcript turn",
    );
  const result = { threadId, turns: [], truncated: page.truncated };
  const ids = new Set();
  let bytes = TRANSCRIPT_META_BYTES;
  const note = () => {
    result.truncated = true;
  };
  for (const [index, entry] of page.data.entries()) {
    if (typeof entry?.id !== "string" || !entry.id || ids.has(entry.id))
      throw new Error("invalid or duplicate history turn identity");
    ids.add(entry.id);
    if (turn && turn !== index + 1) continue;
    let items = entry.items;
    if (entry.itemsView !== CODEX_VALUE.FULL) {
      const loaded = await historyPages(
        session,
        RPC.THREAD_ITEMS_LIST,
        { threadId, turnId: entry.id, sortDirection: HISTORY_SORT },
        budget,
      );
      if (loaded.data.some((row) => row.turnId !== entry.id))
        throw new Error("history item belongs to a different turn");
      items = loaded.data.map((row) => row.item);
      result.truncated ||= loaded.truncated;
    }
    if (!Array.isArray(items)) throw new Error("history turn has no item list");
    const row = {
      number: index + 1,
      id: redactor.redact(entry.id, TRANSCRIPT_FIELD_BYTES),
      status: redactor.redact(entry.status, TRANSCRIPT_FIELD_BYTES),
      items: [],
    };
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes >= TRANSCRIPT_MAX_BYTES) {
      note();
      break;
    }
    result.turns.push(row);
    for (const item of items) {
      const value = transcriptItem(item, redactor, note);
      bytes += Buffer.byteLength(JSON.stringify(value)) + 1;
      if (bytes >= TRANSCRIPT_MAX_BYTES) {
        note();
        break;
      }
      row.items.push(value);
    }
    if (bytes >= TRANSCRIPT_MAX_BYTES) break;
  }
  return result;
}

export async function transcript(options, context) {
  return withIdleRun(
    options,
    context,
    async ({ run, stateDir, driver, session, threadId, stdout, signal, commandMs }) => {
      const redactor = jobPromptRedactor(stateDir, driver ?? { forkRedaction: run.forkRedaction });
      const data = {
        runKey: run.runKey,
        ...(await readTranscript(session, threadId, { turn: options.turn, redactor, signal })),
      };
      const output = options.json
        ? JSON.stringify(data) + "\n"
        : `Transcript run=${run.runKey} thread=${data.threadId} truncated=${data.truncated ? "yes" : "no"}\n` +
          data.turns
            .map(
              (turn) =>
                `Turn ${turn.number} id=${JSON.stringify(turn.id)} status=${JSON.stringify(turn.status)}\n` +
                turn.items.map((item) => JSON.stringify(item) + "\n").join(""),
            )
            .join("");
      if (Buffer.byteLength(output) > TRANSCRIPT_MAX_BYTES)
        throw new Error("transcript exceeds its output bound");
      await writeOutput(stdout, output, { signal, timeoutMs: commandMs });
      return EXIT.COMPLETED;
    },
    { resume: true },
  );
}
