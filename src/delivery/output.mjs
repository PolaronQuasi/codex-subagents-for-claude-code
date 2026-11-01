import { FOOTER_FIELDS } from "../shared/constants.mjs";
// What the runner prints and writes: the recovery commands (which name the
// stable entry path, passed in), the --detach receipt, truncation, the footer,
// the progress line, the durable copies' names and lookup, and the replay of
// a copy.

import fs from "node:fs";
import path from "node:path";
import {
  AUDIT_TRANSITION,
  MAX_OUTPUT_BYTES,
  MAX_FOOTER_BYTES,
  MAX_DURABLE_BYTES,
  RUN_KEY,
  validJobId,
  MAX_AUDIT_BYTES,
  JOB_STATUS,
  OUTCOME,
  MAX_PROGRESS_CHARS,
  MAX_TOUCHED_LINES,
  REQUEST_DIGEST_VERSION,
  REQUEST_ID,
  SECOND_MS,
  TERMINAL,
  PROGRESS_KIND,
  PLAN_STATUS,
  CODEX_ITEM,
  PROGRESS_TAIL_LINES,
} from "../shared/constants.mjs";
import { readLimited, writeOutput } from "../shared/io.mjs";
import { ERRNO, EXIT, isMissing } from "../shared/errors.mjs";
import { limitField, quotaLine, tokensField } from "./usage.mjs";
import { modelEventLine } from "../shared/model-events.mjs";
import { auditDirectory } from "../shared/audit.mjs";

function quotedScript(script) {
  return `'${script.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
}

export function resumeCommand(run, script) {
  return `node ${quotedScript(script)}${run.jobId ? ` --attach ${run.jobId}` : ""} --run ${run.runKey}`;
}

// The line a replay prefixes to a durable copy delivered earlier.
export const requestReplay = (id) =>
  `codex-subagents-for-claude-code-replay: request ${id} was delivered earlier; not relaunched\n`;
export const jobReplay = (jobId) =>
  `codex-subagents-for-claude-code-replay: job ${jobId} was delivered earlier; not relaunched\n`;
export function launchedLine(run, script, existing = false) {
  return (
    `codex-subagents-for-claude-code-launched: run=${run.runKey} turn=${(run.turns?.length ?? 0) + 1} job=${run.jobId ?? "-"}` +
    ` model=${run.model ?? "-"} effort=${run.effort ?? "-"} mode=${run.write ? "workspace-write" : "read-only"}` +
    ` request=${run.requestId ?? "-"}${existing ? " existing=yes" : ""} attach=${resumeCommand(run, script)}\n`
  );
}

export function continueCommand(run, script) {
  return `node ${quotedScript(script)} --continue ${run.runKey} --prompt-file FILE`;
}

export function closeCommand(run, script) {
  return `node ${quotedScript(script)} --close ${run.runKey}`;
}

// Durable copies of request-ID runs carry the ID and the full request digest,
// so a replay can tell the same task from a reused ID.
// Unsupported same-request copies are refused rather than hidden from duplicate checks.
export function findResultsByRequestId(resultsDir, requestId) {
  let names = [];
  try {
    names = fs.readdirSync(resultsDir);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const escaped = requestId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidates = new RegExp(`-rq-${escaped}-h[^/]*\\.md$`);
  const found = [];
  for (const name of names.filter((name) => candidates.test(name)).sort()) {
    const file = path.join(resultsDir, name);
    let identity;
    try {
      identity = readDurableCopy(file).identity;
    } catch (cause) {
      throw new Error(
        "request " +
          requestId +
          " has an unsupported digest copy or invalid footer; state retained",
        { cause },
      );
    }
    // IDs may themselves contain -h2 or -rq-. The current footer identifies
    // the complete request and job; a filename substring cannot do that.
    if (identity) {
      const { job, request } = identity;
      if (request === "-" && name.endsWith(`-${job}.md`)) continue;
      if (REQUEST_ID.test(request)) {
        const exact = request.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = new RegExp(
          `-${job}-rq-${exact}-h(${REQUEST_DIGEST_VERSION})-([0-9a-f]{64})\\.md$`,
        ).exec(name);
        if (match) {
          if (request === requestId)
            found.push({ file, digest: match[2], version: Number(match[1]), turn: identity.turn });
          continue;
        }
      }
    }
    throw new Error(
      `request ${requestId} has an unsupported digest copy or ambiguous request identity; state retained`,
    );
  }
  return found
    .sort((a, b) => a.turn - b.turn || (a.file < b.file ? -1 : 1))
    .map(({ turn, ...copy }) => copy);
}

// Durable copies are named <stamp>-<model>-<job ID>[-rq-...].md, so a job's
// latest copy can answer a waiter whose run another waiter delivered and removed.
// Filenames are only candidates: a request ID can itself contain a job ID.
export function findResultByJob(resultsDir, jobId, runKey = null) {
  let names = [];
  try {
    names = fs.readdirSync(resultsDir);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const candidates = names
    .filter(
      (entry) =>
        entry.endsWith(".md") &&
        (entry.endsWith(`-${jobId}.md`) || entry.includes(`-${jobId}-rq-`)),
    )
    .sort()
    .reverse();
  for (const name of candidates) {
    const file = path.join(resultsDir, name);
    try {
      const { identity } = readDurableCopy(file);
      if (identity.job === jobId && (!runKey || identity.run === runKey)) return file;
    } catch (error) {
      if (!isMissing(error) && error.code !== ERRNO.EISDIR) throw error;
    }
  }
  return null;
}

// The latest durable copy delivered for a run, found through the job of the
// run's last "deliver" audit row, for a waiter that arrives after another one
// delivered and removed the run without knowing its job. Null without one.
export function findResultByRun(resultsDir, runKey) {
  const dir = auditDirectory(resultsDir, runKey);
  let latest = null;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return null;
  }
  for (const name of names) {
    let text = "";
    try {
      text = readLimited(path.join(dir, name), MAX_AUDIT_BYTES).toString("utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      let row = null;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        row?.transition === AUDIT_TRANSITION.DELIVER &&
        row.run === runKey &&
        validJobId(row.job) &&
        Number.isSafeInteger(row.turn) &&
        row.turn > 0 &&
        !(
          latest &&
          (latest.turn > row.turn || (latest.turn === row.turn && latest.time >= row.time))
        )
      )
        latest = row;
    }
  }
  const file = latest ? findResultByJob(resultsDir, latest.job, runKey) : null;
  return file ? { file, jobId: latest.job } : null;
}

export function resultFileName(run) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const model = String(run.model ?? "codex").replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (
    run.requestId &&
    (run.requestDigestVersion !== REQUEST_DIGEST_VERSION ||
      !/^[0-9a-f]{64}$/.test(run.requestDigest ?? ""))
  )
    throw new Error("invalid current request digest; state retained");
  const request = run.requestId
    ? `-rq-${run.requestId}-h${REQUEST_DIGEST_VERSION}-${run.requestDigest}`
    : "";
  return `${stamp}-${model}-${run.jobId}${request}.md`;
}

function countLines(text) {
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}

// Keep the first maxLines lines and at most maxBytes bytes (each 0 = no cap),
// cutting at a line end where one exists; never split a UTF-8 sequence.
export function truncateOutput(text, maxLines = 0, maxBytes = 0) {
  let shown = text,
    partial = false;
  if (maxLines) {
    let index = -1,
      count = 0;
    while (count < maxLines && (index = shown.indexOf("\n", index + 1)) !== -1) count++;
    if (index !== -1 && index + 1 < shown.length) shown = shown.slice(0, index + 1);
  }
  if (maxBytes && Buffer.byteLength(shown) > maxBytes) {
    const buffer = Buffer.from(shown);
    let end = buffer.lastIndexOf(0x0a, maxBytes - 1) + 1;
    if (end <= 0) {
      end = maxBytes;
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      partial = true;
    }
    shown = buffer.subarray(0, end).toString("utf8");
    if (partial) shown += "\n";
  }
  // A cut line counts as omitted, so omitted is never 0 when anything is missing.
  const omitted = Math.max(0, countLines(text) - countLines(shown) + (partial ? 1 : 0));
  return { text: shown, omitted, partial, truncated: shown !== text };
}

// What stdout shows of a delivered result. maxLines caps the text's lines;
// maxBytes caps everything printed: prefix, text, omission line and footer, so
// a caller whose tool shows only N characters still sees the footer. The footer
// and omission line are never cut: when they alone exceed maxBytes, no text is
// shown. Nothing is cut without a durable copy for the omission line to name.
export function fitOutput(
  text,
  { maxLines = 0, maxBytes = 0, resultFile = null, footer, prefix = "" },
) {
  const notice = (omitted, partial) =>
    omitted
      ? `codex-subagents-for-claude-code-omitted: ${omitted} lines not shown${partial ? " (the last shown line is cut)" : ""}; full text in ${resultFile}\n`
      : "";
  const render = (shown, omitted, partial) =>
    `${prefix}${shown}${notice(omitted, partial)}${footer(omitted)}`;
  const whole = render(text, 0, false);
  const lines = countLines(text);
  if (
    !resultFile ||
    ((!maxLines || lines <= maxLines) && (!maxBytes || Buffer.byteLength(whole) <= maxBytes))
  )
    return whole;
  // Reserve room for the longest omission line and footer this cut can need,
  // and for the newline truncateOutput adds after a cut inside a line.
  const budget = maxBytes
    ? maxBytes - Buffer.byteLength(`${prefix}${notice(lines + 1, true)}${footer(lines + 1)}`) - 1
    : 0;
  if (maxBytes && budget <= 0) return render("", lines, false);
  const { text: shown, omitted, partial } = truncateOutput(text, maxLines, budget);
  return render(shown, omitted, partial);
}

export function splitFooter(text) {
  const marker = "codex-subagents-for-claude-code: status=";
  const at = text.lastIndexOf(marker);
  if (at < 0 || (at > 0 && text[at - 1] !== "\n")) return null;
  return { body: text.slice(0, at), footer: text.slice(at) };
}

// One grammar for discovery, replay and artifact consumers. The primary line
// has fixed ordered fields; result is last and may contain spaces.
export function parseFooter(footer) {
  const marker = "codex-subagents-for-claude-code: ";
  const line = footer.split("\n", 1)[0].replace(/\r$/, "");
  const end = line.indexOf(" result=");
  if (!line.startsWith(marker) || end < 0) return null;
  const names = FOOTER_FIELDS;
  const words = line.slice(marker.length, end).split(" ");
  if (words.length !== names.length) return null;
  const value = {};
  for (let i = 0; i < names.length; i++) {
    if (!words[i].startsWith(names[i] + "=")) return null;
    value[names[i]] = words[i].slice(names[i].length + 1);
    if (!value[names[i]] || /\s/.test(value[names[i]])) return null;
  }
  if (
    !TERMINAL.has(value.status) ||
    !RUN_KEY.test(value.run) ||
    !validJobId(value.job) ||
    !/^[1-9]\d*$/.test(value.turn) ||
    !Number.isSafeInteger(Number(value.turn)) ||
    !/^\d+$/.test(value.touched) ||
    !/^\d+$/.test(value.omitted) ||
    !["workspace-write", "read-only"].includes(value.mode) ||
    !["yes", "no"].includes(value.keep) ||
    (value.request !== "-" && !REQUEST_ID.test(value.request))
  )
    return null;
  value.turn = Number(value.turn);
  value.result = line.slice(end + " result=".length);
  return value.result ? value : null;
}

export function readDurableCopy(file) {
  const parts = splitFooter(readLimited(file, MAX_DURABLE_BYTES).toString("utf8"));
  const identity = parts && parseFooter(parts.footer);
  if (
    !identity ||
    Buffer.byteLength(parts.footer) > MAX_FOOTER_BYTES ||
    Buffer.byteLength(parts.body) > MAX_OUTPUT_BYTES + 1
  )
    throw new Error("invalid current result footer or envelope; state retained");
  return { ...parts, identity };
}

export function renderFooter(run, resultFile, omitted = 0) {
  const result = run.result;
  const touched = result.touchedFiles ?? [];
  const duration =
    result.durationMs == null ? "-" : `${Math.round(result.durationMs / SECOND_MS)}s`;
  const lines = [
    `codex-subagents-for-claude-code: status=${result.status} run=${run.runKey} turn=${(run.turns?.length ?? 0) + 1} job=${run.jobId}` +
      ` thread=${result.threadId ?? "-"} model=${run.model ?? "-"} effort=${run.effort ?? "-"}` +
      ` mode=${run.write ? "workspace-write" : "read-only"} duration=${duration} touched=${touched.length} omitted=${omitted}` +
      ` request=${run.requestId ?? "-"} branch=${run.worktree?.branch ?? "-"} commit=${result.commit ?? "-"}` +
      ` keep=${run.keepState || !resultFile || result.shutdownPending ? "yes" : "no"} tokens=${tokensField(result.usage)} limit=${limitField(result.usage)} result=${resultFile ?? "-"}`,
  ];
  if (result.shutdownPending || run.shutdownUnconfirmedAcceptedAt)
    lines.push(shutdownMarker(run.shutdownUnconfirmedAcceptedAt));
  for (const file of touched.slice(0, MAX_TOUCHED_LINES))
    lines.push(`codex-subagents-for-claude-code-touched: ${file}`);
  if (touched.length > MAX_TOUCHED_LINES)
    lines.push(
      `codex-subagents-for-claude-code-touched: +${touched.length - MAX_TOUCHED_LINES} more`,
    );
  // Additive: the first line and the touched lines stay as they were.
  lines.push(quotaLine(result.usage));
  const observedModelLine = modelEventLine(result.modelEvents);
  if (result.compaction)
    lines.push(`codex-subagents-for-claude-code-compaction: status=${result.compaction.status}`);
  if (run.tier !== undefined)
    lines.push(`codex-subagents-for-claude-code-tier: requested=${run.tier}`);
  if (observedModelLine) lines.push(observedModelLine);
  if (run.outputSchema !== undefined)
    lines.push(
      `codex-subagents-for-claude-code-schema: schema=${result.schema ?? "invalid"} json=${resultFile ? (result.jsonFile ?? "-") : "-"}`,
    );
  const footer = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(footer) > MAX_FOOTER_BYTES)
    throw new Error("result footer exceeds its byte bound; state retained");
  return footer;
}

export const shutdownMarker = (acceptedAt = null) =>
  `codex-subagents-for-claude-code-shutdown: confirmed=no accepted-at=${acceptedAt ?? "-"} reason=unknown-process-tree`;

export function renderProgressEntries(entries = []) {
  const quote = (text) => JSON.stringify(String(text ?? ""));
  const plan = entries.findLast((entry) => entry.kind === PROGRESS_KIND.PLAN)?.plan;
  const lines = [];
  if (Array.isArray(plan)) {
    const current = plan.find((step) => step.status === PLAN_STATUS.ACTIVE);
    lines.push(
      `plan=${plan.filter((step) => step.status === PLAN_STATUS.DONE).length}/${plan.length} ${quote(current?.step)}`,
    );
  }
  for (const entry of entries
    .filter((entry) => entry.kind === PROGRESS_KIND.ITEM)
    .slice(-PROGRESS_TAIL_LINES)) {
    switch (entry.type) {
      case CODEX_ITEM.COMMAND:
        lines.push(
          `cmd=${quote(entry.command)} exit=${entry.exitCode ?? "-"} duration-ms=${entry.durationMs ?? "-"}`,
        );
        break;
      case CODEX_ITEM.FILE_CHANGE:
        lines.push(`files=${entry.paths.length} paths=${entry.paths.map(quote).join(",")}`);
        break;
      case CODEX_ITEM.SEARCH:
        lines.push(`search=${quote(entry.query)}`);
        break;
      case CODEX_ITEM.MCP:
        lines.push(`mcp=${quote(entry.server)} tool=${quote(entry.tool)}`);
        break;
      case CODEX_ITEM.REASONING:
        lines.push(`summary=${entry.summary.map(quote).join(" ")}`);
        break;
    }
  }
  return lines.map((line) => `codex-subagents-for-claude-code-progress: ${line}\n`).join("");
}

export function renderProgress(job) {
  const clean = (value) =>
    String(value ?? "-")
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .trim()
      .slice(0, MAX_PROGRESS_CHARS) || "-";
  const preview = Array.isArray(job.progressPreview) ? job.progressPreview : [];
  const last = preview
    .map((line) => clean(line))
    .filter((line) => line !== "-")
    .at(-1);
  return (
    `codex-subagents-for-claude-code-progress: phase=${clean(job.phase).replace(/\s+/g, "-")} elapsed=${clean(job.elapsed).replace(/\s+/g, "")}` +
    `${last ? ` last=${last}` : ""}\n` +
    renderProgressEntries(job.progress)
  );
}

// Replays a durable copy: its text behind prefix (a codex-subagents-for-claude-code-replay: line),
// cut as a fresh delivery would be, with the footer's omitted= count adjusted.
// Returns the exit code of the replayed result: 0 for completed or with relay,
// else 2.
export async function replayCopy(
  copy,
  prefix,
  { stdout, maxLines, maxBytes, relay, commandMs, signal, onOutcome },
) {
  const parts = readDurableCopy(copy);
  const { status, keep } = parts.identity;
  await writeOutput(
    stdout,
    fitOutput(parts.body, {
      maxLines,
      maxBytes,
      resultFile: copy,
      prefix,
      footer: (omitted) =>
        parts.footer
          .replace(/ omitted=\d+ /, ` omitted=${omitted} `)
          .replace(/ result=[^\r\n]*/, () => ` result=${copy}`),
    }),
    { signal, timeoutMs: commandMs },
  );
  onOutcome?.({
    kind: OUTCOME.DELIVERED,
    status,
    keep,
    resultFile: copy,
  });
  return status === JOB_STATUS.COMPLETED || relay ? EXIT.COMPLETED : EXIT.NOT_COMPLETED;
}
