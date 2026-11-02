import { ERRNO, SIGNALS } from "../shared/errors.mjs";
import {
  IS_LINUX,
  PROCESS_TABLE_MAX,
  PROCESS_GROUP_QUERY_MS,
  VERIFY_IDENTITY_ATTEMPTS,
  VERIFY_IDENTITY_PAUSE_MS,
  VERIFY_WINDOWS_STARTUP_MS,
  VERIFY_START_PHASE,
  VERIFY_METADATA_BYTES,
  VERIFY_STOP_MS,
  VERIFY_POLL_MS,
  VERIFY_DRAIN_MS,
  VERIFY_LOG_BYTES,
  VERIFY_STATUS,
  VERIFY_IPC,
} from "../shared/constants.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { IS_WINDOWS } from "../shared/constants.mjs";
import { atomicWrite, digest, readLimited } from "../shared/io.mjs";
import { POWERSHELL, processStart, leadsProcessGroup } from "../shared/process-identity.mjs";
import { WINDOWS_JOB_SCRIPT } from "./windows-job.mjs";

// Diagnostic only: never use a phase file as execution or settlement evidence.
function supervisorPhase(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
      const phase = readLimited(file, VERIFY_METADATA_BYTES).toString("utf8").trim();
      if (Object.values(VERIFY_START_PHASE).includes(phase)) return phase;
    }
  } catch {
    /* A missing, replaced or malformed diagnostic cannot change the outcome. */
  }
  return VERIFY_START_PHASE.UNAVAILABLE;
}

function groupRemains(pid) {
  try {
    if (IS_LINUX) {
      const deadline = Date.now() + PROCESS_GROUP_QUERY_MS;
      let count = 0;
      for (const name of fs.readdirSync("/proc")) {
        if (Date.now() > deadline || ++count > PROCESS_TABLE_MAX) return true;
        if (!/^\d+$/.test(name)) continue;
        let text;
        try {
          text = fs.readFileSync("/proc/" + name + "/stat", "utf8");
        } catch (error) {
          if (error.code === ERRNO.ENOENT) continue;
          return true;
        }
        const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) === pid && fields[0] !== "Z") return true;
      }
      return false;
    }
    const result = spawnSync("ps", ["-axo", "pgid=,state="], {
      encoding: "utf8",
      timeout: PROCESS_GROUP_QUERY_MS,
      maxBuffer: VERIFY_LOG_BYTES,
    });
    if (result.error || result.status !== 0) return true;
    return result.stdout.split("\n").some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && !state.startsWith("Z");
    });
  } catch {
    return true;
  }
}

export async function executeVerification(recipe, { directory, cwd, signal, checkpoint }) {
  const started = performance.now(),
    report = path.join(directory, "process-report.json");
  const cancel = path.join(directory, "cancel"),
    ready = path.join(directory, "ready.json"),
    go = path.join(directory, "go");
  const phase = path.join(directory, "supervisor-phase.txt");
  const logs = {
    stdout: { bytes: 0, parts: [], stored: 0 },
    stderr: { bytes: 0, parts: [], stored: 0 },
  };
  const saveLogs = () =>
    Object.fromEntries(
      Object.entries(logs).map(([name, log]) => {
        const bytes = Buffer.concat(log.parts),
          file = path.join(directory, name + ".log");
        atomicWrite(file, bytes);
        return [
          name,
          {
            file,
            bytes: log.bytes,
            storedBytes: bytes.length,
            truncated: log.bytes > bytes.length,
            sha256: digest(bytes),
          },
        ];
      }),
    );
  if (signal?.aborted)
    return {
      state: VERIFY_STATUS.CANCELLED,
      code: null,
      settled: true,
      durationMs: performance.now() - started,
      logs: saveLogs(),
    };
  // The completion key is sent through our pipe and consumed before the recipe
  // starts. It never appears in argv, environment, recipe or a state file.
  const completionKey = IS_WINDOWS ? crypto.randomBytes(32) : null;
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|COMSPEC|TEMP|TMP|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(key),
    ),
  );
  const env = { ...environment };
  const recipeKeys = new Set();
  for (const [key, value] of Object.entries(recipe.env)) {
    const canonical = IS_WINDOWS ? key.toUpperCase() : key;
    if (recipeKeys.has(canonical)) throw new Error("conflicting verification environment names");
    recipeKeys.add(canonical);
    if (IS_WINDOWS)
      for (const inherited of Object.keys(env))
        if (inherited.toUpperCase() === canonical) delete env[inherited];
    env[key] = value;
  }
  let child,
    exited = false,
    supervisorCode = null,
    supervisorSignal = null,
    closed = false,
    spawnError,
    terminal,
    termination,
    cancellationError;
  if (IS_WINDOWS) {
    const script = path.join(directory, "supervisor.ps1"),
      input = path.join(directory, "command.json");
    atomicWrite(script, WINDOWS_JOB_SCRIPT);
    atomicWrite(input, JSON.stringify({ ...recipe, cwd }));
    child = spawn(
      POWERSHELL,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Recipe",
        input,
        "-Cancel",
        cancel,
        "-Report",
        report,
        "-Ready",
        ready,
        "-Go",
        go,
        "-Phase",
        phase,
      ],
      { cwd: directory, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
  } else {
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./posix-worker.mjs", import.meta.url))],
      {
        cwd: directory,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child.on("message", (message) => {
      if ([VERIFY_IPC.EXIT, VERIFY_IPC.ERROR].includes(message?.kind)) terminal = message;
    });
  }
  child.once("error", (error) => {
    spawnError = error;
    exited = true;
  });
  child.once("exit", (code, signalName) => {
    exited = true;
    supervisorCode = code;
    supervisorSignal = signalName;
  });
  child.once("close", () => {
    closed = true;
  });
  if (IS_WINDOWS) {
    child.stdin.on("error", (error) => {
      spawnError = error;
    });
    child.stdin.end(completionKey.toString("base64") + "\n");
  }
  for (const name of ["stdout", "stderr"])
    child[name].on("data", (chunk) => {
      const log = logs[name];
      log.bytes += chunk.length;
      const left = recipe.maxLogBytes - log.stored;
      if (left > 0) {
        const part = chunk.subarray(0, left);
        log.parts.push(part);
        log.stored += part.length;
      }
    });
  const requestCancel = () => {
    termination = VERIFY_STATUS.CANCELLED;
    try {
      atomicWrite(cancel, "cancel");
    } catch (error) {
      // Abort listeners must not throw outside the executor's settlement path.
      cancellationError = error;
    }
  };
  signal?.addEventListener("abort", requestCancel, { once: true });
  let identity;
  try {
    for (let tries = 0; tries < VERIFY_IDENTITY_ATTEMPTS && !exited; tries++) {
      identity = processStart(child.pid);
      if (identity) break;
      await delay(VERIFY_IDENTITY_PAUSE_MS);
    }
    if (!identity || exited)
      throw spawnError ?? new Error("verification supervisor identity unavailable");
    checkpoint({
      supervisor: { pid: child.pid, processStart: identity },
      phase: VERIFY_STATUS.DISPATCHING,
    });
    if (signal?.aborted) requestCancel();
    if (!IS_WINDOWS) {
      if (leadsProcessGroup(child.pid) !== true)
        throw new Error("verification supervisor has no owned process group");
      if (!termination) child.send({ kind: VERIFY_IPC.START, ...recipe, cwd, env });
    }
    let authorized = false;
    const startupDeadline = performance.now() + VERIFY_WINDOWS_STARTUP_MS;
    let executionStart = IS_WINDOWS ? null : performance.now();
    for (;;) {
      if (cancellationError) throw cancellationError;
      // Check before accepting readiness: a delayed poll must never authorize
      // a command after the supervisor's startup allowance has expired.
      if (executionStart === null && performance.now() > startupDeadline)
        throw new Error("verification dispatch timed out");
      if (IS_WINDOWS && !authorized && fs.existsSync(ready)) {
        const owned = JSON.parse(readLimited(ready, VERIFY_METADATA_BYTES).toString("utf8"));
        if (
          !Number.isSafeInteger(owned.pid) ||
          owned.pid <= 0 ||
          typeof owned.processStart !== "string"
        )
          throw new Error("invalid command identity");
        checkpoint({ command: owned, phase: VERIFY_STATUS.RUNNING });
        if (!termination) {
          atomicWrite(go, "start");
          authorized = true;
          executionStart = performance.now();
        }
      }
      if (IS_WINDOWS && exited && closed) {
        if (supervisorCode !== 0 || supervisorSignal !== null)
          throw new Error("verification supervisor ended abnormally; settlement is unproven");
        if (!fs.existsSync(report))
          throw new Error("verification supervisor ended without settlement evidence");
        const reportStat = fs.lstatSync(report);
        if (!reportStat.isFile() || reportStat.isSymbolicLink() || reportStat.nlink !== 1)
          throw new Error("verification supervisor report is not a regular owned file");
        const envelope = JSON.parse(readLimited(report, VERIFY_METADATA_BYTES).toString("utf8"));
        if (
          !envelope ||
          typeof envelope.payload !== "string" ||
          !/^[a-f0-9]{64}$/.test(envelope.proof ?? "") ||
          Object.keys(envelope).some((key) => !["payload", "proof"].includes(key))
        )
          throw new Error("verification supervisor completion proof is missing");
        const expected = crypto
          .createHmac("sha256", completionKey)
          .update(envelope.payload)
          .digest();
        if (!crypto.timingSafeEqual(expected, Buffer.from(envelope.proof, "hex")))
          throw new Error("verification supervisor completion proof is invalid");
        const result = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
        if (
          !result ||
          result.settled !== true ||
          ![VERIFY_STATUS.EXITED, VERIFY_STATUS.TIMEOUT, VERIFY_STATUS.CANCELLED].includes(
            result.state,
          ) ||
          !Number.isSafeInteger(result.code) ||
          result.code < 0 ||
          result.code > 0xffffffff ||
          !Number.isFinite(result.durationMs) ||
          result.durationMs < 0 ||
          Object.keys(result).some(
            (key) => !["state", "code", "durationMs", "settled"].includes(key),
          )
        )
          throw new Error("verification supervisor report is invalid");
        if (termination && result.settled) result.state = termination;
        return { ...result, logs: saveLogs(), durationMs: performance.now() - started };
      }
      // A terminal message can arrive during the last poll after the deadline.
      // Check the inclusive deadline before accepting POSIX success, preserving
      // an already requested cancellation.
      if (
        executionStart !== null &&
        performance.now() - executionStart >= recipe.timeoutMs &&
        !termination
      ) {
        termination = VERIFY_STATUS.TIMEOUT;
        atomicWrite(cancel, VERIFY_STATUS.TIMEOUT);
      }
      if (!IS_WINDOWS && (terminal || termination)) break;
      if (exited && !IS_WINDOWS)
        throw new Error("verification supervisor exited before settlement");
      if (
        termination &&
        executionStart !== null &&
        performance.now() - executionStart > recipe.timeoutMs + VERIFY_STOP_MS
      )
        throw new Error("verification process stop timed out");
      await delay(VERIFY_POLL_MS);
    }
    // The held group leader is still ours. SIGKILL reaches ordinary descendants,
    // including those whose immediate parent exited. Intentional setsid escape
    // is outside the trusted-local profile, which is not a sandbox.
    if (processStart(child.pid) !== identity || leadsProcessGroup(child.pid) !== true)
      throw new Error("verification group identity changed");
    process.kill(-child.pid, SIGNALS.SIGKILL);
    const deadline = performance.now() + VERIFY_DRAIN_MS;
    while ((!closed || groupRemains(child.pid)) && performance.now() < deadline)
      await delay(VERIFY_POLL_MS);
    if (!closed || groupRemains(child.pid))
      throw new Error("verification process group did not stop");
    return {
      state:
        termination ??
        (terminal.kind === VERIFY_IPC.ERROR ? VERIFY_STATUS.ERROR : VERIFY_STATUS.EXITED),
      code: terminal?.code ?? null,
      settled: true,
      durationMs: performance.now() - started,
      logs: saveLogs(),
    };
  } catch (error) {
    // Windows kill-on-close tears down its job even if the supervisor fails.
    // A lost report still means uncertain, never a successful verification.
    if (!exited) {
      if (
        !IS_WINDOWS &&
        identity &&
        processStart(child.pid) === identity &&
        leadsProcessGroup(child.pid) === true
      )
        process.kill(-child.pid, SIGNALS.SIGKILL);
      else if (IS_WINDOWS || (identity && processStart(child.pid) === identity))
        child.kill(SIGNALS.SIGKILL);
    }
    // Release the owned POSIX worker before waiting for it to drain. This
    // needs no PID identity: its disconnect handler stops its own group.
    if (!IS_WINDOWS && child.connected) child.disconnect();
    const stopDeadline = performance.now() + VERIFY_DRAIN_MS;
    while (!closed && performance.now() < stopDeadline) await delay(VERIFY_POLL_MS);
    return {
      state: VERIFY_STATUS.UNCERTAIN,
      settled: false,
      error: IS_WINDOWS
        ? `${error.message} (supervisor phase: ${supervisorPhase(phase)})`
        : error.message,
      durationMs: performance.now() - started,
      logs: saveLogs(),
    };
  } finally {
    signal?.removeEventListener("abort", requestCancel);
    // Releasing our IPC channel is safe even when PID identity could not be
    // established. The owned POSIX worker handles disconnect itself.
    if (!IS_WINDOWS && child.connected) child.disconnect();
    child.stdin?.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
}
