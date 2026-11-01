import { PROCESS_TABLE_MAX } from "./constants.mjs";
// PIDs can be reused. Compare the OS start time as well, when it is available,
// and the process's command line where the start time alone cannot decide.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { alive } from "./io.mjs";
import { COMMAND_PROBE_EXIT, SIGNALS } from "./errors.mjs";
import {
  COMMAND_LINE_QUERY_MS,
  GETCONF_OUTPUT_BYTES,
  PROBE_OUTPUT_BYTES,
  PROCESS_QUERY_MS,
  START_RETRY_MS,
  WORKER_STATE,
  isGoneWorkerState,
  validJobId,
  IS_LINUX,
  IS_WINDOWS,
  START_SKEW_MS,
  PLATFORM,
  JOB_STATUS,
  EPOCH_TICKS,
  SECOND_MS,
  TICKS_PER_MS,
  DEFAULT_CLOCK_TICKS,
  CODEX_COMMAND,
  PS_COMMAND_LINE,
} from "./constants.mjs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const POWERSHELL = path.join(
  process.env.SystemRoot || "C:/Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);

// The fields of /proc/<pid>/stat after the command name: [2] is the process
// group, [19] the start time in clock ticks since boot.
function procStat(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

let ownStart;
// The OS start time of the process holding pid, as an opaque string that
// stays the same for one process: Windows' UTC ticks, Linux's boot ID with the
// clock ticks since boot, ps's lstart elsewhere. Null when it cannot be read
// (denied, vanished, or the query took longer than timeoutMs).
export function processStart(pid, { timeoutMs = PROCESS_QUERY_MS } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid && ownStart !== undefined) return ownStart;
  let start = null;
  try {
    if (IS_LINUX) {
      const ticks = procStat(pid)[19];
      start = `${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
    } else {
      const windows = IS_WINDOWS;
      const result = spawnSync(
        windows ? POWERSHELL : "ps",
        windows
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
            ]
          : ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: PROBE_OUTPUT_BYTES },
      );
      if (!result.error && result.status === 0) start = result.stdout.trim() || null;
    }
  } catch {
    /* Denied or vanished: retain conservative PID-only ownership. */
  }
  if (pid === process.pid && start !== null) ownStart = start;
  return start;
}

// The start-time reader's PowerShell: a PID per line on stdin, answered on
// stdout as "<pid> <ticks>", the ticks read as processStart reads them, empty
// when the process cannot be read (gone, denied).
const START_READER_SCRIPT = [
  "while ($null -ne ($line = [Console]::In.ReadLine())) {",
  "  $id = 0; $ticks = ''",
  "  if ([int]::TryParse($line, [ref]$id) -and $id -gt 0) {",
  "    try { $ticks = [string](Get-Process -Id $id -ErrorAction Stop).StartTime.ToUniversalTime().Ticks } catch { $ticks = '' }",
  "  }",
  '  [Console]::Out.WriteLine("$id $ticks"); [Console]::Out.Flush()',
  "}",
].join("\n");

// A start-time reader for the queries of one launch (startReader): on Windows
// one PowerShell, started at once, answers each PID's start time over its
// stdin, so its start-up overlaps the launch and a query then takes a few
// milliseconds instead of a PowerShell's start. Its answers are matched to
// their queries by PID, and each is what processStart gives: the same ticks,
// or null for a process that cannot be read, or null when no answer came
// within PROCESS_QUERY_MS (after which the reader is given up on, as a
// one-shot query would time out). A reader that could not start, or ended, is
// replaced by processStart for every query, so the evidence is never weaker
// than a one-shot query's. close() ends the PowerShell: its stdin closes, and
// one still running PROCESS_QUERY_MS later is ended through its own handle,
// as runProcess ends its helpers. Elsewhere processStart answers at once
// (/proc on Linux, ps on macOS).
export function openStartReader() {
  if (!IS_WINDOWS) return { start: async (pid) => processStart(pid), close() {} };
  const pending = [];
  let child = null,
    usable = true,
    buffered = "",
    closed = false;
  // Every query still waiting gets undefined, for processStart to answer; once
  // the reader is closed, its launch has returned, and they get null.
  const giveUp = () => {
    usable = false;
    for (const entry of pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.resolve(closed ? null : undefined);
    }
  };
  try {
    child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", START_READER_SCRIPT], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    usable = false;
  }
  child?.once("error", giveUp);
  child?.once("exit", giveUp);
  child?.stdin.on("error", giveUp);
  child?.stdout.on("error", giveUp);
  child?.stdout.setEncoding("utf8");
  child?.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      // "<pid> <ticks>" or "<pid> " (Windows ends the line with \r too).
      const answer = /^(\d+) (\d*)$/.exec(buffered.slice(0, at).replace(/\r$/, ""));
      buffered = buffered.slice(at + 1);
      const index = answer ? pending.findIndex((entry) => entry.pid === Number(answer[1])) : -1;
      if (index < 0) continue;
      const [entry] = pending.splice(index, 1);
      clearTimeout(entry.timer);
      entry.resolve(answer[2] || null);
    }
  });
  const close = () => {
    if (closed || !child) return;
    closed = true;
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const timer = setTimeout(() => child.kill(SIGNALS.SIGKILL), PROCESS_QUERY_MS);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  };
  return {
    async start(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      if (!usable || closed || pid === process.pid) return processStart(pid);
      const answer = await new Promise((resolve) => {
        const entry = { pid, resolve };
        entry.timer = setTimeout(() => {
          // No answer in time: null, as a one-shot query that timed out; the
          // reader is given up on, so no late answer is ever taken.
          const at = pending.indexOf(entry);
          if (at >= 0) pending.splice(at, 1);
          resolve(null);
          giveUp();
          close();
        }, PROCESS_QUERY_MS);
        pending.push(entry);
        child.stdin.write(`${pid}\n`);
      });
      return answer === undefined ? processStart(pid) : answer;
    },
    close,
  };
}

// The start-time reader of a launch: the probe's own (PROCESS_PROBE.reader,
// openStartReader), or, for a probe without one (a test's), one that asks
// probe.start.
export const startReader = (probe = PROCESS_PROBE) =>
  probe.reader?.() ?? { start: async (pid) => probe.start(pid), close() {} };

// The command line of the process holding pid, but only while that process
// still has start time start, so the line is the identified process's; null
// when it cannot be read. Windows reads it through WMI while holding a handle
// on the process, so the PID cannot change hands in between.
export function processCommandLine(pid, start, { timeoutMs = COMMAND_LINE_QUERY_MS } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof start !== "string") return null;
  try {
    if (IS_WINDOWS) {
      if (!/^\d{1,20}$/.test(start)) return null;
      const result = spawnSync(
        POWERSHELL,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-Process -Id ${pid} -ErrorAction Stop; $null = $p.Handle; ` +
            `if ($p.StartTime.ToUniversalTime().Ticks -ne ${start}) { exit ${COMMAND_PROBE_EXIT.IDENTITY_CHANGED} }; ` +
            `$line = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${pid}" -Property CommandLine).CommandLine; ` +
            `if ($null -eq $line) { exit ${COMMAND_PROBE_EXIT.NO_COMMAND_LINE} }; [Console]::Out.Write($line)`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: PROBE_OUTPUT_BYTES },
      );
      return !result.error && result.status === 0 && result.stdout ? result.stdout : null;
    }
    let line;
    if (IS_LINUX) {
      line = fs
        .readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .replace(/\0+$/, "")
        .replace(/\0/g, " ");
    } else {
      const result = spawnSync("ps", [...PS_COMMAND_LINE, String(pid)], {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: PROBE_OUTPUT_BYTES,
      });
      if (result.error || result.status !== 0) return null;
      line = result.stdout.trim();
    }
    // Read after the line: an unchanged start time means the same process.
    return line && processStart(pid, { timeoutMs }) === start ? line : null;
  } catch {
    return null;
  }
}

// Whether pid leads its process group (Linux and macOS), so a signal to the
// group reaches its children; null when that cannot be read.
export function leadsProcessGroup(pid) {
  try {
    if (IS_LINUX) return Number(procStat(pid)[2]) === pid;
    const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
      encoding: "utf8",
      windowsHide: true,
      timeout: PROCESS_QUERY_MS,
      maxBuffer: PROBE_OUTPUT_BYTES,
    });
    if (result.error || result.status !== 0) return null;
    return Number(result.stdout.trim()) === pid;
  } catch {
    return null;
  }
}

// Capture descendants while the caller still owns the root's birth identity.
// A failed table read is unknown, never an empty tree. Captured identities are
// checked again before each signal, including after the group leader exits.
export function posixProcessAlive(pid) {
  if (IS_LINUX) {
    try {
      if (procStat(pid)[0] === "Z") return false;
    } catch {
      // Fall back to conservative OS liveness when /proc is unreadable.
    }
  }
  return alive(pid);
}

export function posixDescendants(pid) {
  const rows = [];
  const deadline = Date.now() + PROCESS_QUERY_MS;
  const limit = PROCESS_TABLE_MAX;
  try {
    if (IS_LINUX) {
      const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      for (const name of fs.readdirSync("/proc")) {
        if (Date.now() > deadline || rows.length >= limit) return null;
        if (!/^\d+$/.test(name)) continue;
        const child = Number(name);
        try {
          const stat = procStat(child);
          const start = boot + ":" + stat[19];
          if (start) rows.push({ pid: child, parent: Number(stat[1]), start, state: stat[0] });
        } catch {
          // A disappearing entry is normal; a still-live unreadable child is
          // handled by the bounded whole-table query on other POSIX hosts.
          if (alive(child)) return null;
        }
      }
    } else {
      const result = spawnSync("ps", ["-axo", "pid=,ppid=,lstart="], {
        encoding: "utf8",
        windowsHide: true,
        timeout: PROCESS_QUERY_MS,
        maxBuffer: PROBE_OUTPUT_BYTES,
      });
      if (result.error || result.status !== 0) return null;
      for (const line of result.stdout.trim().split("\n")) {
        if (Date.now() > deadline || rows.length >= limit) return null;
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (!match) return null;
        rows.push({ pid: Number(match[1]), parent: Number(match[2]), start: match[3] });
      }
    }
    const root = rows.find((row) => row.pid === pid);
    if (!root) return null;
    const known = new Map([[pid, root.start]]);
    const birth = (start) => (IS_LINUX ? Number(start.split(":").at(-1)) : Date.parse(start));
    const captured = [];
    for (;;) {
      if (Date.now() > deadline) return null;
      const next = rows.filter((row) => known.has(row.parent) && !known.has(row.pid));
      if (!next.length) break;
      for (const row of next) {
        // A child older than its apparent parent belongs to an earlier PID
        // incarnation. Ambiguous table evidence grants no stop authority.
        const parentBirth = birth(known.get(row.parent)),
          childBirth = birth(row.start);
        if (
          !Number.isFinite(parentBirth) ||
          !Number.isFinite(childBirth) ||
          childBirth < parentBirth
        )
          return null;
        known.set(row.pid, row.start);
        if (row.state !== "Z") captured.push({ pid: row.pid, start: row.start });
      }
    }
    return captured;
  } catch {
    return null;
  }
}
export function workerCommandPattern(jobId) {
  if (!validJobId(jobId)) throw new Error("invalid job identity");
  return `driver\\.mjs["']?\\s+run\\s+--job-id\\s+["']?${jobId}(?:["'\\s]|$)`;
}
// The arguments every app-server a driver starts is given, whatever the
// executable is called: npm's codex.js shim on macOS runs as node, and a
// Homebrew binary can carry its target's name. Any process showing them may be
// ours.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const APP_SERVER_ARGS = [CODEX_COMMAND.APP_SERVER, CODEX_COMMAND.LISTEN, CODEX_COMMAND.STDIO]
  .map(escapeRegExp)
  .join(`["']?\\s+["']?`);
export const APP_SERVER_COMMAND_PATTERN = `(?:^|[\\s"'])${APP_SERVER_ARGS}(?:["'\\s]|$)`;

// What a live process whose start time no longer reads as recorded is: another
// process on Windows and Linux, where one process's start time never changes.
// On macOS, ps's lstart is a local time that a time-zone or daylight-saving
// change rewrites, so a different start time proves nothing by itself: the
// process is another one only when its command line, read under its current
// start time, is not the one ours runs (pattern); otherwise it is unknown.
export function changedStartState(
  pid,
  start,
  pattern,
  { probe = PROCESS_PROBE, platform = probe.platform ?? process.platform } = {},
) {
  if (STABLE_START.has(platform)) return WORKER_STATE.REUSED;
  const line = pattern && probe.commandLine ? probe.commandLine(pid, start) : null;
  return typeof line === "string" && line && !new RegExp(pattern).test(line)
    ? WORKER_STATE.REUSED
    : WORKER_STATE.UNKNOWN;
}

let ticksPerSecond;
// CLK_TCK, the unit of the start time in /proc/<pid>/stat: DEFAULT_CLOCK_TICKS
// on common Linux, and taken when getconf cannot say.
function clockTicks() {
  if (ticksPerSecond === undefined) {
    const result = spawnSync("getconf", ["CLK_TCK"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: PROCESS_QUERY_MS,
      maxBuffer: GETCONF_OUTPUT_BYTES,
    });
    const value = Number(result.stdout?.trim());
    ticksPerSecond =
      !result.error && result.status === 0 && Number.isSafeInteger(value) && value > 0
        ? value
        : DEFAULT_CLOCK_TICKS;
  }
  return ticksPerSecond;
}

// A start time as processStart reports it, in epoch milliseconds, or null when
// it cannot be converted: Windows' UTC ticks; on Linux the clock ticks since
// boot plus the boot time (btime) in /proc/stat; elsewhere ps's lstart, a
// local time.
export function startTimeMs(start, platform = process.platform) {
  if (typeof start !== "string") return null;
  try {
    if (platform === PLATFORM.WIN32) {
      if (!/^\d{1,20}$/.test(start)) return null;
      return Number((BigInt(start) - EPOCH_TICKS) / TICKS_PER_MS);
    }
    if (platform === PLATFORM.LINUX) {
      const ticks = /^[0-9a-f-]+:(\d+)$/i.exec(start)?.[1];
      const boot = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1];
      if (!ticks || !boot) return null;
      return Number(boot) * SECOND_MS + Math.round((Number(ticks) * SECOND_MS) / clockTicks());
    }
    const lstart =
      /^[A-Z][a-z]{2} +([A-Z][a-z]{2}) +(\d{1,2}) +(\d{1,2}):(\d{2}):(\d{2}) +(\d{4})$/.exec(start);
    const month = MONTHS.indexOf(lstart?.[1]);
    if (month < 0) return null;
    const [day, hours, minutes, seconds, year] = lstart.slice(2).map(Number);
    const at = new Date(year, month, day, hours, minutes, seconds).getTime();
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

export function processOwner() {
  return { pid: process.pid, processStart: processStart(process.pid) };
}

export function ownerAlive(owner) {
  if (!alive(owner.pid)) return false;
  if (typeof owner.processStart !== "string") return true;
  const current = processStart(owner.pid);
  return current === null || current === owner.processStart;
}
export function workerStartedBy(record) {
  const value =
    record?.status === JOB_STATUS.RUNNING
      ? record.startedAt
      : record?.status === JOB_STATUS.QUEUED
        ? record.updatedAt
        : undefined;
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}

// The runner's own record of a job's worker, { jobId, pid, processStart }, kept
// in run.json as worker the first time the runner saw it alive; null for any
// other job.
export function workerIdentity(run, jobId = run?.jobId) {
  const worker = run?.worker;
  return jobId && worker?.jobId === jobId ? worker : null;
}

// Records the worker of the run's current job the first time the runner sees
// it alive (start: the opaque start time inspectWorker read), so a later check
// can tell that worker from another process that reuses its PID. Only a
// process the evidence shows to be the worker is recorded, never one whose
// identity is unknown.
export function noteWorker(run, pid, start, save) {
  if (!run.jobId || !Number.isSafeInteger(pid) || pid <= 0 || typeof start !== "string") return;
  if (workerIdentity(run)?.pid === pid) return;
  run.worker = { jobId: run.jobId, pid, processStart: start };
  save?.();
}

// Platforms whose start time of one process always reads the same: Windows'
// UTC ticks and Linux's boot ID with clock ticks. ps's lstart is a local time,
// which a time-zone or daylight-saving change rewrites.
const STABLE_START = new Set([PLATFORM.WIN32, PLATFORM.LINUX]);
const COMPARABLE_START = new Set([PLATFORM.WIN32, PLATFORM.DARWIN]);

// The OS queries inspectWorker makes, and the start-time reader a launch shares
// between its queries (openStartReader); tests pass their own.
export const PROCESS_PROBE = Object.freeze({
  start: processStart,
  commandLine: processCommandLine,
  reader: openStartReader,
});
function byRecords(pid, start, records) {
  if (!COMPARABLE_START.has(process.platform)) return null;
  const startedAt = startTimeMs(start);
  const bounds = records
    .filter((record) => record?.pid === pid)
    .map(workerStartedBy)
    .filter((at) => at !== null);
  // A start time in the future means a clock or a probe this check cannot trust.
  if (startedAt === null || !bounds.length || startedAt > Date.now() + START_SKEW_MS) return null;
  return startedAt > Math.max(...bounds) + START_SKEW_MS
    ? WORKER_STATE.REUSED
    : WORKER_STATE.WORKER;
}
export function inspectWorker(
  jobId,
  pid,
  records = [],
  identity = null,
  { probe = PROCESS_PROBE } = {},
) {
  if (!alive(pid)) return { state: WORKER_STATE.GONE, start: null };
  const known =
    identity?.jobId === jobId && identity.pid === pid && typeof identity.processStart === "string";
  let start = probe.start(pid);
  if (start === null && known && alive(pid))
    start = probe.start(pid, { timeoutMs: START_RETRY_MS });
  if (start === null)
    return { state: alive(pid) ? WORKER_STATE.UNKNOWN : WORKER_STATE.GONE, start: null };
  if (known && identity.processStart === start) return { state: WORKER_STATE.WORKER, start };
  if (known && STABLE_START.has(process.platform)) return { state: WORKER_STATE.REUSED, start };
  const dated = byRecords(pid, start, records);
  if (dated) return { state: dated, start };
  const line = validJobId(jobId) ? probe.commandLine(pid, start) : null;
  if (line !== null)
    return {
      state: new RegExp(workerCommandPattern(jobId)).test(line)
        ? WORKER_STATE.WORKER
        : WORKER_STATE.REUSED,
      start,
    };
  return { state: WORKER_STATE.UNKNOWN, start };
}

// Whether a job's worker is gone: its PID is dead, or provably reused.
export function workerGone(jobId, pid, records = [], identity = null) {
  return isGoneWorkerState(inspectWorker(jobId, pid, records, identity).state);
}
