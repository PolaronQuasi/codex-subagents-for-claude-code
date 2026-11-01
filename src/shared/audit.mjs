import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AUDIT_TRANSITION,
  RUN_KEY,
  SESSION_ID,
  validJobId,
  MAX_KEPT_LOG_BYTES,
  JOB_READ_POLICY,
} from "./constants.mjs";
import { jobPaths, readTurn, readDriver } from "../state/job-store.mjs";
import { atomicWrite, pathError, readTail } from "./io.mjs";
import { PromptRedactor } from "./prompt-redactor.mjs";
import { jobPromptRedactor } from "../state/prompt-inputs.mjs";

export function auditDirectory(resultsDir, key) {
  return path.join(resultsDir, "audit", RUN_KEY.test(key ?? "") ? key : "_unassigned");
}

export function createAudit({ resultsDir, session, warn }) {
  const id = `${process.pid}-${crypto.randomUUID()}`;
  const owner = SESSION_ID.test(session ?? "") ? session : null;
  let record = null,
    file = null,
    failed = false;
  return {
    bind(run) {
      record = run;
    },
    async emit(transition, run) {
      if (run) record = run;
      if (failed) return;
      if (transition === AUDIT_TRANSITION.ERROR && !record) return;
      const key = RUN_KEY.test(record?.runKey ?? "") ? record.runKey : null;
      const event = {
        transition,
        time: new Date().toISOString(),
        pid: process.pid,
        session: owner,
        run: key,
        turn: key ? (Array.isArray(record?.turns) ? record.turns.length : 0) + 1 : null,
        job: validJobId(record?.jobId) ? record.jobId : null,
      };
      try {
        file ??= path.join(auditDirectory(resultsDir, key), `${id}.jsonl`);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      } catch (error) {
        failed = true;
        // Even a broken warning sink must not turn an audit failure into a
        // failed delivery. Report at most once per invocation.
        try {
          await warn(
            `Could not write the invocation audit log: ${pathError(error, resultsDir, "results directory (CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR)").message}`,
          );
        } catch {
          /* best effort */
        }
      }
    },
  };
}

export function promptScrubber(prompt) {
  const redactor = new PromptRedactor("<prompt omitted>");
  for (const input of Array.isArray(prompt) ? prompt : [prompt]) {
    redactor.addPrompt(input);
    if (Buffer.byteLength(input) > MAX_KEPT_LOG_BYTES)
      redactor.addPrompt(Buffer.from(input).subarray(-MAX_KEPT_LOG_BYTES).toString("utf8"));
  }
  return (text) => redactor.redact(text);
}

// Driver evidence outlives the run. Neither driver.json (the launch plan) nor
// final.txt is an audit input. Redact prompt text even from a CLI's stderr.
export async function keepDriverDiagnostics(run, { stateDir, resultsDir, warn = async () => {} }) {
  if (!resultsDir) return null;
  const dir = auditDirectory(resultsDir, run.runKey);
  try {
    const files = jobPaths(stateDir, run.jobId);
    const driver = readDriver(stateDir, run.jobId, { policy: JOB_READ_POLICY.STRICT });
    const redactor = jobPromptRedactor(stateDir, driver, { marker: "<prompt omitted>" });
    if (redactor.blocked) throw new Error("prompt inputs unavailable; diagnostic text withheld");
    const scrub = (text) => redactor.redact(text);
    const scrubRecord = (value) =>
      typeof value === "string"
        ? scrub(value)
        : Array.isArray(value)
          ? value.map(scrubRecord)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [key, scrubRecord(entry)]),
              )
            : value;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stem = path.join(dir, `worker-death-${run.jobId}`);
    const turn = readTurn(stateDir, run.jobId);
    if (turn) atomicWrite(`${stem}.turn.json`, JSON.stringify(scrubRecord(turn), null, 2));
    for (const [name, file] of [
      ["events.jsonl", files.eventsFile],
      ["driver.log", files.logFile],
    ]) {
      const tail = readTail(file, MAX_KEPT_LOG_BYTES + 1);
      if (tail !== null) {
        // A clipped first line may be a prompt suffix followed by stderr.
        // Keep complete tail lines so that partial input cannot evade scrub.
        // driver.log can already have been clipped to this same byte cap.
        const clipped = tail.length >= MAX_KEPT_LOG_BYTES;
        const boundary = clipped ? tail.indexOf("\n") : -1;
        const complete = clipped ? tail.subarray(boundary < 0 ? tail.length : boundary + 1) : tail;
        atomicWrite(`${stem}.${name}`, scrub(complete.toString("utf8")));
      }
    }
    return dir;
  } catch (error) {
    await warn(`Could not keep driver diagnostics for job ${run.jobId}: ${error.message}`);
    return null;
  }
}
