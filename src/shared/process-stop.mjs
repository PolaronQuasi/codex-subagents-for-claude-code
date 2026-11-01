// Identity-bound termination. A process tree is stopped only while the process
// at its root is still the one the caller identified by its OS start time
// (processStart's format) and, where its command line can be read, while that
// line matches the caller's pattern. Nothing is killed by a bare PID:
// - Windows: one PowerShell process opens a handle on the root, checks its
//   start time and command line, then opens a handle on each descendant
//   (Win32_Process ParentProcessId, each started no earlier than its parent)
//   and stops every one through its process object. A held handle keeps
//   Windows from giving its PID to another process.
// - Linux and macOS: the start time is read again immediately before each
//   signal, and the signal goes to the process group when the root leads one;
//   SIGTERM first, SIGKILL after a grace period.
// interrupt, when given, runs once the tree is identified and before any
// kill; its answer comes back as interrupted. An aborted signal before the
// kill stops nothing.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { alive } from "./io.mjs";
import { ERRNO, EXIT, SIGNALS } from "./errors.mjs";
import {
  INTERRUPT_OUTCOME,
  STOP_EXIT_MS,
  STOP_GRACE_MS,
  STOP_OUTCOME,
  STOP_POLL_MS,
  STOP_PREPARE_MS,
  STOP_PROGRESS_MS,
  STOP_ROUNDS,
  IS_WINDOWS,
  STOP_STDERR_CHARS,
  EXCERPT_CHARS,
  STOP_PROGRESS_WORDS,
} from "./constants.mjs";
import {
  POWERSHELL,
  PROCESS_PROBE,
  leadsProcessGroup,
  processCommandLine,
  processStart,
  posixDescendants,
  posixProcessAlive,
} from "./process-identity.mjs";

// The lines between a Windows stop and its caller: the tree is identified and
// held, the caller's go-ahead to stop it, and progress during descendant
// discovery and before it waits for the exits.
export const IDENTIFIED = "identified";
export const PROCEED = "proceed";
export const PROGRESS = "progress";
// The detail of a stop the caller's abort signal ended before any kill.
export const STOP_INTERRUPTED = "interrupted";

// The PowerShell half of a Windows stop. Its parameters come through the
// environment (CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STOP_*), so nothing is quoted into the script. It
// prints one JSON line {state} when the root is gone, reused or cannot be
// read; otherwise {state: IDENTIFIED}, and once its stdin says PROCEED, the
// final {state, ended, tree, alive, failed}: ended, the root had already
// exited when the kill began; alive and failed, the PIDs still running and
// those whose stop failed. Any other line, or none, ends it with nothing
// killed. After each round of stops it looks for descendants started
// meanwhile, and stops those too, until a round finds none or
// CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STOP_ROUNDS rounds have run. Each later
// capture waits for another PROCEED so its identities are durable before any
// new signals. Progress words (STOP_PROGRESS_WORDS at most) bound each step.
const WINDOWS_STOP = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Say($value) { [Console]::Out.WriteLine((ConvertTo-Json $value -Compress)); [Console]::Out.Flush() }
function Hold([int]$id) {
  try { $p = [System.Diagnostics.Process]::GetProcessById($id); $null = $p.Handle; return $p } catch { return $null }
}
function Ticks($p) { try { return $p.StartTime.ToUniversalTime().Ticks } catch { return $null } }
function Parents {
  $map = @{}
  foreach ($row in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId)) {
    $map[[int]$row.ProcessId] = [int]$row.ParentProcessId
  }
  return $map
}
$rootId = [int]$env:CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STOP_PID
$pattern = [string]$env:CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STOP_PATTERN
$root = Hold $rootId
if ($null -eq $root -or $root.HasExited) { Say @{ state = '${STOP_OUTCOME.GONE}' }; exit ${EXIT.COMPLETED} }
$t = Ticks $root
if ($null -eq $t) { Say @{ state = '${STOP_OUTCOME.UNKNOWN}' }; exit ${EXIT.COMPLETED} }
if ([string]$t -ne $env:CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STOP_START) { Say @{ state = '${STOP_OUTCOME.REUSED}' }; exit ${EXIT.COMPLETED} }
if ($pattern) {
  $line = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $rootId" -Property CommandLine).CommandLine
  if ($null -ne $line -and $line -notmatch $pattern) { Say @{ state = '${STOP_OUTCOME.REUSED}' }; exit ${EXIT.COMPLETED} }
}
$held = @{}
$held[$rootId] = $root
$starts = @{}
$starts[$rootId] = $t
$order = New-Object System.Collections.Generic.List[int]
$order.Add($rootId)
# Adds the descendants of the held processes: a first snapshot names the
# candidates, a handle pins each one, and a second snapshot, which can then
# only describe those very processes, confirms each parent. A candidate counts
# when its parent is held and it started no earlier than that parent.
function Grow {
  $before = Parents
  $found = @{}
  $frontier = @($held.Keys)
  while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($id in @($before.Keys)) {
      if ($held.ContainsKey($id) -or $found.ContainsKey($id)) { continue }
      if ($frontier -notcontains $before[$id]) { continue }
      $p = Hold $id
      if ($null -ne $p) { $found[$id] = $p; $next += $id }
    }
    $frontier = $next
  }
  if ($found.Count -eq 0) { return 0 }
  $after = Parents
  $added = 0
  do {
    $more = $false
    foreach ($id in @($found.Keys)) {
      if (-not $after.ContainsKey($id)) { continue }
      $parent = $after[$id]
      if (-not $held.ContainsKey($parent)) { continue }
      $tt = Ticks $found[$id]
      if ($null -eq $tt -or $tt -lt $starts[$parent]) { continue }
      $held[$id] = $found[$id]; $starts[$id] = $tt; $order.Add($id)
      $found.Remove($id); $added++; $more = $true
    }
  } while ($more)
  foreach ($p in $found.Values) { $p.Dispose() }
  return $added
}
$null = Grow
$identities = @($order | ForEach-Object { @{ pid = $_; start = [string]$starts[$_] } })
Say @{ state = '${IDENTIFIED}'; tree = @($order); identities = $identities }
if ([Console]::In.ReadLine() -ne '${PROCEED}') { exit ${EXIT.COMPLETED} }
$ended = $root.HasExited
$failed = New-Object System.Collections.Generic.List[int]
$done = @{}
# Stops every held process not stopped yet.
function StopHeld {
  foreach ($id in @($order)) {
    if ($done.ContainsKey($id)) { continue }
    $done[$id] = $true
    try { if (-not $held[$id].HasExited) { Stop-Process -InputObject $held[$id] -Force -ErrorAction Stop } }
    catch { if (-not $held[$id].HasExited) { $failed.Add($id) } }
  }
}
StopHeld
Say @{ state = '${PROGRESS}'; round = 1 }
# Every process a round adds is stopped: the bound ends the search, never a
# round's stops.
for ($round = 1; $round -lt [int]$env:CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STOP_ROUNDS; $round++) {
  if ((Grow) -eq 0) { break }
  $identities = @($order | ForEach-Object { @{ pid = $_; start = [string]$starts[$_] } })
  Say @{ state = '${PROGRESS}'; round = $round + 1; capture = $true; identities = $identities }
  if ([Console]::In.ReadLine() -ne '${PROCEED}') { exit ${EXIT.COMPLETED} }
  StopHeld
}
Say @{ state = '${PROGRESS}'; waiting = $true }
$deadline = [DateTime]::UtcNow.AddMilliseconds([int]$env:CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STOP_WAIT_MS)
$alive = @()
foreach ($id in @($order)) {
  $left = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
  if (-not $held[$id].WaitForExit($left)) { $alive += $id }
}
$state = $(if ($alive -contains $rootId) { '${STOP_OUTCOME.ALIVE}' } else { '${STOP_OUTCOME.STOPPED}' })
$identities = @($order | ForEach-Object { @{ pid = $_; start = [string]$starts[$_] } })
Say @{ state = $state; ended = $ended; tree = @($order); identities = $identities; alive = @($alive); failed = @($failed) }
`;

const ENCODED_WINDOWS_STOP = Buffer.from(WINDOWS_STOP, "utf16le").toString("base64");

// Reads JSON lines from a child's stdout, one per call to next(); null once the
// stream ends.
function lineReader(stream) {
  let buffer = "";
  const lines = [];
  let ended = false;
  let wake = null;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (let at; (at = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(at + 1))
      if (buffer.slice(0, at).trim()) lines.push(buffer.slice(0, at).trim());
    wake?.();
  });
  stream.on("end", () => {
    ended = true;
    wake?.();
  });
  return async function next(deadline) {
    while (!lines.length && !ended) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      // A cleared timer: a pending one would keep this process alive after it is done.
      let timer;
      await new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, left);
      });
      clearTimeout(timer);
      wake = null;
    }
    if (!lines.length) return null;
    try {
      return JSON.parse(lines.shift());
    } catch {
      return null;
    }
  };
}

// interrupt's answer; a failure becomes an answer too, so the stop goes on.
async function interruptSafely(interrupt) {
  if (!interrupt) return null;
  try {
    return await interrupt();
  } catch (error) {
    return `${INTERRUPT_OUTCOME.FAILED} ${String(error?.message ?? error)
      .replace(/\s+/g, " ")
      .slice(0, EXCERPT_CHARS)}`;
  }
}

// The Windows stop as a child process: its first line answers whether pid,
// which started at start, is identified and held, and it stops the tree only
// once its stdin says PROCEED. The protocol tests drive it directly.
export function spawnWindowsStop({ pid, start, pattern = null }) {
  return spawn(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_WINDOWS_STOP],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STOP_PID: String(pid),
        CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STOP_START: start,
        CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STOP_PATTERN: pattern ?? "",
        CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STOP_WAIT_MS: String(STOP_EXIT_MS),
        CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STOP_ROUNDS: String(STOP_ROUNDS),
      },
    },
  );
}

// What a stop's answer says beyond its state: the processes whose stop failed,
// and those of the tree other than its root still running.
function survivors(answer, pid) {
  const others = (answer.alive ?? []).filter((id) => id !== pid);
  const parts = [
    answer.failed?.length ? `the stop of processes ${answer.failed.join(", ")} failed` : null,
    others.length ? `processes ${others.join(", ")} of its tree still run` : null,
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

// The answer for a stop the caller's abort signal ended before any kill.
const interruptedStop = (interrupted) => ({
  state: STOP_OUTCOME.UNKNOWN,
  interrupted,
  detail: STOP_INTERRUPTED,
});

async function stopWindowsTree({ pid, start, pattern, interrupt, signal, onIdentified }) {
  if (!/^\d{1,20}$/.test(start ?? "")) return { state: STOP_OUTCOME.UNKNOWN, interrupted: null };
  return driveStop(spawnWindowsStop({ pid, start, pattern }), {
    pid,
    start,
    interrupt,
    signal,
    onIdentified,
  });
}

// Speaks the stop protocol with a helper child (spawnWindowsStop, or a test's
// own): its first line within prepareMs, then, once told PROCEED, up to
// STOP_PROGRESS_WORDS progress words and its answer, each within progressMs
// of the last, so the stop ends within STOP_TOTAL_MS, plus the time the turn
// interrupt takes before PROCEED. pid is the root the helper stops; when the
// helper falls silent after it was told to proceed, or goes on past its last
// step, only an exit of pid observed then counts. The caller's signal is not
// consulted after PROCEED: a stop begun is finished. Returns what
// stopProcessTree does.
export async function driveStop(
  child,
  {
    pid,
    start,
    interrupt = null,
    onIdentified,
    signal = undefined,
    prepareMs = STOP_PREPARE_MS,
    progressMs = STOP_PROGRESS_MS,
  },
) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-STOP_STDERR_CHARS)));
  child.stdin.on("error", () => {});
  const failed = new Promise((resolve) => child.once("error", resolve));
  const next = lineReader(child.stdout);
  const finish = () => {
    child.stdin.end();
    // PowerShell is this process's own child; ChildProcess.kill uses its handle.
    if (child.exitCode === null) child.kill();
  };
  const first = await Promise.race([next(Date.now() + prepareMs), failed.then(() => null)]);
  if (first?.state !== IDENTIFIED) {
    finish();
    const state = Object.values(STOP_OUTCOME).includes(first?.state)
      ? first.state
      : STOP_OUTCOME.UNKNOWN;
    return { state, interrupted: null, detail: first ? null : stderr.trim() || "no answer" };
  }
  let captured = null;
  const capture = async (identities) => {
    if (
      !Array.isArray(identities) ||
      !identities.some(
        (target) => target?.pid === pid && (start === undefined || target.start === start),
      ) ||
      identities.some(
        (target) =>
          !Number.isSafeInteger(target?.pid) ||
          target.pid <= 0 ||
          typeof target.start !== "string" ||
          !target.start,
      )
    )
      return false;
    try {
      await onIdentified?.(identities);
      captured = identities;
      return true;
    } catch (error) {
      finish();
      throw error;
    }
  };
  if ((onIdentified || first.identities !== undefined) && !(await capture(first.identities))) {
    finish();
    return {
      state: STOP_OUTCOME.UNKNOWN,
      interrupted: null,
      detail: "stop helper supplied no complete identities",
    };
  }
  const interrupted = await interruptSafely(interrupt);
  if (signal?.aborted) {
    // No PROCEED: the helper reads the end of its stdin and kills nothing.
    finish();
    return interruptedStop(interrupted);
  }
  child.stdin.write(`${PROCEED}\n`);
  let last = await next(Date.now() + progressMs);
  for (let words = 1; last?.state === PROGRESS && words <= STOP_PROGRESS_WORDS; words++) {
    if (last.capture === true) {
      if (!(await capture(last.identities))) {
        finish();
        return {
          state: STOP_OUTCOME.UNKNOWN,
          interrupted,
          treeUnknown: true,
          identities: captured,
          detail: "stop helper supplied incomplete descendant identities",
        };
      }
      child.stdin.write(`${PROCEED}\n`);
    }
    last = await next(Date.now() + progressMs);
  }
  finish();
  if (last?.state === STOP_OUTCOME.STOPPED || last?.state === STOP_OUTCOME.ALIVE)
    return {
      state: last.state,
      interrupted,
      detail: survivors(last, pid),
      tree: last.tree ?? [],
      identities: last.identities ?? null,
    };
  // The stop helper vanished, fell silent or went on past its last step after
  // the root was identified: whatever it did, only an exit observed now counts.
  return {
    state: alive(pid) ? STOP_OUTCOME.ALIVE : STOP_OUTCOME.STOPPED,
    interrupted,
    identities: captured,
    detail:
      stderr.trim() ||
      (last?.state === PROGRESS
        ? `the stop helper gave no answer after ${STOP_PROGRESS_WORDS} progress words`
        : "the stop helper gave no answer"),
  };
}

// Whether pid still holds the process that started at start: same start time,
// and, with a pattern, a command line that matches when it can be read.
function stillIdentified(pid, start, pattern, probe) {
  if (!probe.alive(pid)) return STOP_OUTCOME.GONE;
  const now = probe.start(pid);
  if (now === null) return probe.alive(pid) ? STOP_OUTCOME.UNKNOWN : STOP_OUTCOME.GONE;
  if (now !== start) return STOP_OUTCOME.REUSED;
  if (pattern) {
    const line = probe.commandLine(pid, start);
    if (line !== null && !new RegExp(pattern).test(line)) return STOP_OUTCOME.REUSED;
  }
  return null;
}

// Signals pid's group (or pid) only while its start time is unchanged, read
// immediately before. An unreadable identity is distinct from a proven exit.
function signalIdentified(pid, start, signal, group, probe) {
  const state = stillIdentified(pid, start, null, probe);
  if (state) return state;
  try {
    probe.kill(group ? -pid : pid, signal);
  } catch (error) {
    if (error.code !== ERRNO.ESRCH) throw error;
  }
  return null;
}

// Injectable OS operations also let Windows exercise the POSIX safety rules.
export async function stopPosixTree(
  { pid, start, pattern, interrupt, signal, onIdentified },
  probe = {
    alive: posixProcessAlive,
    start: processStart,
    commandLine: processCommandLine,
    group: leadsProcessGroup,
    kill: process.kill,
    now: Date.now,
    sleep: delay,
    descendants: posixDescendants,
  },
) {
  const before = stillIdentified(pid, start, pattern, probe);
  if (before) return { state: before, interrupted: null };
  const descendants = probe.descendants ? probe.descendants(pid) : [];
  if (!Array.isArray(descendants))
    return {
      state: STOP_OUTCOME.UNKNOWN,
      interrupted: null,
      detail: "Cannot capture owned process descendants",
    };
  const changed = stillIdentified(pid, start, pattern, probe);
  if (changed) return { state: changed, interrupted: null };
  const targets = [{ pid, start }, ...descendants];
  await onIdentified?.(targets);
  if (signal?.aborted) return interruptedStop(null);
  const interrupted = await interruptSafely(interrupt);
  if (signal?.aborted) return interruptedStop(interrupted);
  const group = probe.group(pid) === true;
  let signalledAny = false;
  for (const [signal, waitMs] of [
    [SIGNALS.SIGTERM, STOP_GRACE_MS],
    [SIGNALS.SIGKILL, STOP_EXIT_MS],
  ]) {
    for (const target of targets) {
      const state = signalIdentified(
        target.pid,
        target.start,
        signal,
        target.pid === pid && group,
        probe,
      );
      if (state === STOP_OUTCOME.UNKNOWN)
        return {
          state,
          interrupted,
          tree: targets,
          detail: "Owned process identity became unreadable",
        };
      if (!state) signalledAny = true;
    }
    const deadline = probe.now() + waitMs;
    for (;;) {
      const states = targets.map((target) =>
        stillIdentified(target.pid, target.start, null, probe),
      );
      if (states.includes(STOP_OUTCOME.UNKNOWN))
        return {
          state: STOP_OUTCOME.UNKNOWN,
          interrupted,
          tree: targets,
          detail: "Owned process identity became unreadable",
        };
      if (states.every(Boolean))
        return {
          state: signalledAny ? STOP_OUTCOME.STOPPED : states[0],
          interrupted,
          tree: targets,
        };
      if (probe.now() >= deadline) break;
      await probe.sleep(STOP_POLL_MS);
    }
  }
  return {
    state: STOP_OUTCOME.ALIVE,
    interrupted,
    tree: targets,
    detail: "Owned process descendants outlived SIGKILL",
  };
}

// Stops the process tree rooted at pid while pid is still the process that
// started at start (and whose command line matches pattern, a regular
// expression source, when it can be read). Returns { state, interrupted,
// detail } with state a STOP_OUTCOME; interrupted is interrupt's answer, or
// null when it did not run; detail names the tree's processes left running.
// When signal (the caller's AbortSignal) is aborted before the kill, nothing is
// killed: UNKNOWN, with detail STOP_INTERRUPTED.
/** @param {{pid: number, start: string, pattern?: string|null, interrupt?: (() => Promise<string>)|null, signal?: AbortSignal, onIdentified?: ((targets: Array<{pid: number, start: string}>) => void|Promise<void>)}} target */
export async function stopProcessTree({
  pid,
  start,
  pattern = null,
  interrupt = null,
  signal = undefined,
  onIdentified,
}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof start !== "string")
    return { state: STOP_OUTCOME.UNKNOWN, interrupted: null };
  if (signal?.aborted) return interruptedStop(null);
  return IS_WINDOWS
    ? stopWindowsTree({ pid, start, pattern, interrupt, signal, onIdentified })
    : stopPosixTree({ pid, start, pattern, interrupt, signal, onIdentified });
}

// The OS queries and the stop the runner uses; tests pass their own.
export const PROCESSES = Object.freeze({ probe: PROCESS_PROBE, stop: stopProcessTree });

// Only for a ChildProcess the caller spawned and still holds. Windows' stop
// helper captures the identified tree before this held root handle is used;
// the helper then drains the captured descendants too. POSIX uses rechecks.
export function stopOwnedChild(
  child,
  start,
  { stop = stopProcessTree, signal, onIdentified } = {},
) {
  return stop({
    pid: child.pid,
    start,
    signal,
    onIdentified,
    interrupt: IS_WINDOWS
      ? async () => {
          signal?.throwIfAborted();
          child.kill(SIGNALS.SIGTERM);
          return null;
        }
      : null,
  });
}
