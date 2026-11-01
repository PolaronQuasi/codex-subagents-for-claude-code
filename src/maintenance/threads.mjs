// Reversible Codex history hygiene. Never delete threads, infer ownership from
// a name alone, or archive a retained run through the orphan command.
import fs from "node:fs";
import path from "node:path";
import { CodexSession } from "../codex/session.mjs";
import { selectCodex, requireSupportedCodex } from "../codex/cli.mjs";
import { historyPages, historyBudget } from "../codex/history.mjs";
import { readDriver } from "../state/job-store.mjs";
import { acquireRunLock } from "../state/state.mjs";
import { readThreadOwner, rememberThread } from "../state/thread-owners.mjs";
import { namedRun, threadName } from "../shared/thread-name.mjs";
import { requireDirectory, writeOutput } from "../shared/io.mjs";
import {
  RPC,
  CODEX_VALUE,
  APP_SERVER_MODE,
  MCP_MODE,
  CODEX_IDENTITY_FIELDS,
  THREAD_ID,
  THREAD_NAME_PREFIX,
  ARCHIVABLE_THREAD_STATES,
  RUN_LOCK_OUTCOME,
  TRANSCRIPT_MAX_BYTES,
  THREAD_ARCHIVE_FAILED,
} from "../shared/constants.mjs";
import { ERRNO, EXIT } from "../shared/errors.mjs";

const present = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === ERRNO.ENOENT) return false;
    throw error;
  }
};
function retained(stateBase, key) {
  return present(path.join(stateBase, key)) || present(path.join(stateBase, "quarantine", key));
}
const idle = (thread) => ARCHIVABLE_THREAD_STATES.has(thread?.status?.type);
async function probe(parentEnv, cwd) {
  const codex = requireSupportedCodex(await selectCodex(parentEnv, cwd), parentEnv);
  return new CodexSession(
    { codex, cwd, mode: APP_SERVER_MODE.PROBE, mcp: MCP_MODE.OFF },
    { env: parentEnv },
  );
}

// Called only after the run's identity-bound driver shutdown, while its lock
// is held. A failed archive keeps a receipt for explicit orphan cleanup.
export async function archiveRunThread(run, context) {
  const driver = run.jobId ? readDriver(context.stateDir, run.jobId) : null;
  const threadId = run.result?.threadId ?? driver?.threadId ?? run.contextThreadId;
  if (!THREAD_ID.test(threadId ?? "")) return;
  const name = driver?.threadName ?? threadName(run.runKey, run.model) ?? "";
  let recorded = false,
    session;
  try {
    recorded = rememberThread(run, context, { threadId, name });
  } catch {
    /* Report below if archive fails. */
  }
  try {
    context.signal?.throwIfAborted();
    const cwd = fs.existsSync(run.cwd) ? run.cwd : context.stateDir;
    session = await probe(context.parentEnv, cwd);
    if (CODEX_IDENTITY_FIELDS.some((field) => session.plan.codex[field] !== run.codex[field]))
      throw new Error("pinned CLI changed");
    await session.open();
    const { thread } = await session.request(RPC.THREAD_READ, { threadId, includeTurns: false });
    if (thread?.id !== threadId || !idle(thread))
      throw new Error("thread is active or unidentified");
    await session.request(RPC.THREAD_ARCHIVE, { threadId });
    try {
      rememberThread(run, context, { threadId, name, archived: true });
    } catch {
      /* An archive is already durable in Codex. */
    }
  } catch {
    context.signal?.throwIfAborted();
    await context.warn(
      `Codex thread ${threadId} was not archived; ${recorded ? "ownership receipt kept for --list --codex / --archive-orphans" : "use Codex history to archive it explicitly"}. Local cleanup continues.`,
    );
  } finally {
    await session?.close();
  }
}

export async function orphanThreads(options, context) {
  const { stateBase, resultsDir, parentEnv, cwd, stdout, signal, commandMs } = context;
  let session;
  try {
    session = await probe(parentEnv, cwd);
    await session.open();
    const page = await historyPages(
      session,
      RPC.THREAD_LIST,
      {
        archived: false,
        searchTerm: THREAD_NAME_PREFIX,
        sourceKinds: [CODEX_VALUE.APP_SERVER],
        useStateDbOnly: true,
      },
      historyBudget(signal),
    );
    if (page.truncated)
      throw new Error("Codex thread listing exceeds its bound; no orphan archives attempted");
    const candidates = [],
      seen = new Set();
    for (const thread of page.data) {
      const owner = namedRun(thread?.name);
      if (!owner || !THREAD_ID.test(thread.id ?? "") || seen.has(thread.id)) continue;
      seen.add(thread.id);
      if (retained(stateBase, owner.runKey)) continue;
      const receipt = readThreadOwner(resultsDir, thread.id, stateBase);
      candidates.push({
        thread,
        owner,
        receipt: receipt?.runKey === owner.runKey ? receipt : null,
      });
    }
    // All output metadata is constrained; no preview, prompt, account or free
    // thread fields are copied. Bound the whole report before mutating history.
    const rows = candidates.map(({ thread, owner, receipt }) => ({
      threadId: thread.id,
      ...owner,
      ownership: receipt ? "confirmed" : "unconfirmed",
      action: "candidate",
    }));
    if (Buffer.byteLength(JSON.stringify(rows)) > TRANSCRIPT_MAX_BYTES / 2)
      throw new Error("orphan report exceeds its bound; no archives attempted");
    let failures = 0;
    if (options.mode === "archive-orphans") {
      for (const [index, candidate] of candidates.entries()) {
        const row = rows[index],
          { thread, owner, receipt } = candidate;
        signal?.throwIfAborted();
        if (!receipt) {
          row.action = "skipped-unconfirmed";
          continue;
        }
        if (
          retained(stateBase, owner.runKey) ||
          present(path.join(stateBase, `${owner.runKey}.lock`))
        ) {
          row.action = "skipped-retained-or-locked";
          continue;
        }
        let lock;
        try {
          if (options["dry-run"]) {
            row.action = idle(thread) ? "would-archive" : "skipped-active-or-unknown";
            continue;
          }
          fs.mkdirSync(stateBase, { recursive: true, mode: 0o700 });
          requireDirectory(stateBase);
          lock = await acquireRunLock(owner.runKey, {
            stateBase,
            deadline: Date.now(),
            mode: "attach",
            signal,
          });
          if (lock.kind !== RUN_LOCK_OUTCOME.LOCKED || retained(stateBase, owner.runKey)) {
            row.action = "skipped-retained-or-locked";
            continue;
          }
          const proof = readThreadOwner(resultsDir, thread.id, stateBase);
          if (!proof || proof.runKey !== owner.runKey) {
            row.action = "skipped-unconfirmed";
            continue;
          }
          const fresh = (
            await session.request(RPC.THREAD_READ, { threadId: thread.id, includeTurns: false })
          ).thread;
          if (
            fresh?.id !== thread.id ||
            namedRun(fresh.name)?.runKey !== owner.runKey ||
            !idle(fresh)
          ) {
            row.action = "skipped-active-or-changed";
            continue;
          }
          await session.request(RPC.THREAD_ARCHIVE, { threadId: thread.id });
          row.action = "archived";
          rememberThread(
            { runKey: owner.runKey },
            { stateBase, resultsDir, stateDir: path.join(stateBase, owner.runKey) },
            { threadId: thread.id, name: fresh.name, archived: true },
          );
        } catch {
          row.action = THREAD_ARCHIVE_FAILED;
          failures++;
        } finally {
          lock?.releaseRunLock?.();
        }
      }
    }
    const output =
      rows
        .map(
          (r) =>
            `codex-thread: thread=${r.threadId} run=${r.runKey} role=${r.role} ownership=${r.ownership} action=${r.action}\n`,
        )
        .join("") || "No named orphan Codex threads found.\n";
    await writeOutput(stdout, output, { signal, timeoutMs: commandMs });
    return failures ? EXIT.FAILURE : EXIT.COMPLETED;
  } finally {
    await session?.close();
  }
}
