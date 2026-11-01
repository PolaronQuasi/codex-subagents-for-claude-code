// Processes and I/O: bounded child processes, bounded stream writes, bounded
// reads, atomic file replacement and directory checks.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  DEFAULT_COMMAND_MS,
  MAX_OUTPUT_BYTES,
  IS_WINDOWS,
  DETAIL_CHARS,
  PIPE_RELEASE_MS,
  PLATFORM,
  ATOMIC_RENAME_RETRIES,
  ATOMIC_RENAME_RETRY_MS,
  PROCESS_QUERY_MS,
  PROBE_OUTPUT_BYTES,
} from "./constants.mjs";
import { CODES, ERRNO, SIGNALS, isMissing } from "./errors.mjs";

export function requireDirectory(dir) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    throw pathError(error, dir, "directory");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`expected a real directory, not a link: ${dir}`);
}

export function pathError(error, target, label = "path") {
  const reason =
    {
      [ERRNO.ENOENT]: "does not exist",
      [ERRNO.ENOTDIR]: "has a parent that is not a directory",
      [ERRNO.EEXIST]: "is occupied by a file or another incompatible entry",
      [ERRNO.EACCES]: "is not accessible; check permissions",
      [ERRNO.EPERM]: "is not accessible; check permissions or open handles",
      [ERRNO.EISDIR]: "is a directory; expected a file",
      [ERRNO.ENOSPC]: "cannot be written; the disk is full",
      [ERRNO.EROFS]: "is on a read-only filesystem",
    }[error.code] ?? error.message;
  return Object.assign(new Error(`${label} ${target}: ${reason}`, { cause: error }), {
    code: error.code,
  });
}
export function runProcess(
  command,
  args,
  {
    timeoutMs = DEFAULT_COMMAND_MS,
    maxBuffer = MAX_OUTPUT_BYTES,
    signal,
    input,
    onSpawn,
    ...options
  } = {},
) {
  return new Promise((resolve) => {
    let child,
      timer,
      forceTimer,
      failure,
      done = false,
      bytes = 0;
    const stdout = [],
      stderr = [];
    function finish(status = null, exitSignal = null) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
      resolve({
        status,
        signal: exitSignal,
        error: failure,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    }
    function stop(error) {
      if (done || failure) return;
      failure = error;
      child?.kill(SIGNALS.SIGKILL);
      // A misbehaving descendant can retain a pipe after the helper exits.
      forceTimer = setTimeout(() => {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.stdin?.destroy();
        child?.unref();
        finish();
      }, PIPE_RELEASE_MS);
    }
    function abort() {
      stop(signal.reason ?? new Error("interrupted"));
    }
    if (signal?.aborted) {
      failure = signal.reason ?? new Error("interrupted");
      finish();
      return;
    }
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        ...options,
      });
    } catch (error) {
      failure = error;
      finish();
      return;
    }
    // onSpawn(pid) runs once the helper exists, before it can do anything the
    // caller must be able to trace back to it; its failure is the caller's.
    if (onSpawn && child.pid) {
      try {
        onSpawn(child.pid);
      } catch {
        /* The helper runs on; the caller recorded nothing. */
      }
    }
    child.once("error", (error) => {
      failure ??= error;
      finish();
    });
    child.once("close", finish);
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ]) {
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBuffer) stop(new Error(`helper output exceeded ${maxBuffer} bytes`));
        else chunks.push(chunk);
      });
      stream.on("error", stop);
    }
    child.stdin.on("error", (error) => {
      if (error.code !== ERRNO.EPIPE) stop(error);
    });
    timer = setTimeout(() => stop(new Error(`helper timed out after ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end(input);
  });
}

// Git's repository-local variables, as `git rev-parse --local-env-vars` lists
// them in any supported git (GIT_INTERNAL_SUPER_PREFIX only in older ones,
// such as Debian bookworm's 2.39), and the GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n>
// pairs GIT_CONFIG_COUNT counts. A git hook, `git bisect run` or another git
// process exports them; inherited, they point every git command at that
// repository, whatever its -C or working directory.
const LOCAL_GIT_VARIABLES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);

// Windows matches environment names without regard to case.
export function localGitVariable(name, platform = process.platform) {
  const key = platform === PLATFORM.WIN32 ? name.toUpperCase() : name;
  return LOCAL_GIT_VARIABLES.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_/.test(key);
}

// The environment for a git command the runner starts, and the base of the
// Codex job's: env without git's repository-local variables. Every other
// variable stays, GIT_SSH_COMMAND and GIT_AUTHOR_* among them, since a job may
// need them.
export function withoutLocalGit(env = process.env, platform = process.platform) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !localGitVariable(name, platform)),
  );
}

// Windows paths with a drive (X:\… or X:/…) or UNC paths (\\server\share…).
// Node also calls a rooted path such as /w/builds/x absolute there, which Git
// Bash leaves unconverted in custom variables, and resolves it against the
// current drive.
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

export const isAbsolutePath = (value, platform = process.platform) =>
  typeof value === "string" &&
  (platform === PLATFORM.WIN32 ? WINDOWS_ABSOLUTE.test(value) : path.posix.isAbsolute(value));

// An absolute-path override from env, resolved, or null when unset. On
// Windows only a drive or UNC path is accepted.
export function absoluteOverride(env, name, platform = process.platform) {
  const value = env[name];
  if (value === undefined) return null;
  if (platform === PLATFORM.WIN32) {
    if (!isAbsolutePath(value, platform)) {
      const gitBash = /^\/([A-Za-z])(?:\/(.*))?$/.exec(value);
      const hint = gitBash
        ? `; use ${JSON.stringify(`${gitBash[1].toUpperCase()}:/${gitBash[2] ?? ""}`)} instead of the Git Bash spelling`
        : "";
      throw new Error(
        `${name} must be an absolute path: on Windows a drive or UNC path, such as D:\\codex-subagents-for-claude-code\\state or \\\\server\\share\\folder, not ${JSON.stringify(value)}${hint}`,
      );
    }
    return path.win32.resolve(value);
  }
  if (!isAbsolutePath(value, platform)) throw new Error(`${name} must be an absolute path`);
  return path.posix.resolve(value);
}

export function readLimited(file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    throw pathError(error, file, "file");
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit)
      throw new Error(`expected a regular file of at most ${limit} bytes: ${file}`);
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0,
      count;
    while (
      length < buffer.length &&
      (count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0
    )
      length += count;
    if (length !== stat.size) throw new Error(`file changed while reading: ${file}`);
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}

// The last bytes of a file, up to limit; null when it cannot be read. A short
// read is read on until the tail is whole or the file ends. The kept job log
// (audit.mjs) and the usage reader (usage.mjs) both read tails with it.
export function readTail(file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, limit));
    let length = 0,
      count;
    while (
      length < buffer.length &&
      (count = fs.readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        size - buffer.length + length,
      ))
    )
      length += count;
    return buffer.subarray(0, length);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readJson(file) {
  const text = readLimited(file, MAX_OUTPUT_BYTES).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw Object.assign(
      new Error(`invalid JSON in ${file}; restore or inspect this file`, { cause: error }),
      { code: CODES.INVALID_JSON },
    );
  }
}
export function digest(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function atomicWrite(file, data, { renameRetries = ATOMIC_RENAME_RETRIES } = {}) {
  if (!Number.isSafeInteger(renameRetries) || renameRetries < 0)
    throw new Error("invalid atomic rename retry bound");
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    let firstDenial;
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporary, file);
        break;
      } catch (error) {
        if (!IS_WINDOWS || ![ERRNO.EPERM, ERRNO.EACCES, ERRNO.EBUSY].includes(error.code))
          throw error;
        firstDenial ??= error;
        if (attempt >= renameRetries) throw firstDenial;
        // The same exclusive stage is already complete, fsynced and closed.
        // Never unlink or rewrite the target to work around a sharing denial.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ATOMIC_RENAME_RETRY_MS);
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Whether two paths name one folder: equal once resolved (without case on
// Windows), or with equal real paths, as when a temporary folder was named
// through a short name or a link.
export function sameFolder(a, b) {
  const key = (value) => (IS_WINDOWS ? value.toLowerCase() : value);
  if (key(path.resolve(a)) === key(path.resolve(b))) return true;
  try {
    return key(fs.realpathSync.native(a)) === key(fs.realpathSync.native(b));
  } catch {
    return false;
  }
}

// Whether signal 0 reaches pid: it goes through, or is refused (EPERM) because
// another user's process holds the PID.
function signalled(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === ERRNO.ESRCH) return false;
    if (error.code === ERRNO.EPERM) return true;
    throw error;
  }
}

// The state letter of a Linux process, the field after its name in
// /proc/<pid>/stat.
function procState(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
}

// Whether pid, which signals reach, is a Linux zombie: a process that has
// exited and waits only for its parent to reap it (state Z, or X while it is
// torn down). It runs nothing, and its PID stays its own until it is reaped. A
// container whose first process reaps nothing keeps such PIDs. readState
// reads the state letter (procState). A missing stat file means the process
// ended since it was signalled, or a host without procfs: a second signal
// tells which. Any other read failure (EACCES) leaves the process running.
export function zombie(pid, readState = procState) {
  try {
    return /^[ZX]$/.test(readState(pid));
  } catch (error) {
    return isMissing(error) && !signalled(pid);
  }
}

// A macOS zombie also answers kill(pid, 0) until its parent reaps it. Read
// only the bounded state field; a failed query is not evidence of an exit.
function psState(pid, query) {
  const result = query("ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
    windowsHide: true,
    timeout: PROCESS_QUERY_MS,
    maxBuffer: PROBE_OUTPUT_BYTES,
  });
  const state = !result.error && result.status === 0 ? result.stdout.trim() : "";
  return /^Z[A-Za-z+<>=-]*$/.test(state) ? "Z" : null;
}

// Whether a process holds pid and still runs: a zombie executes no work.
export function alive(pid, { platform = process.platform, query = spawnSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid lock owner PID");
  if (!signalled(pid)) return false;
  if (platform === PLATFORM.LINUX) return !zombie(pid);
  if (platform === PLATFORM.DARWIN) return !zombie(pid, (id) => psState(id, query));
  return true;
}

export function writeOutput(stream, text, { signal, timeoutMs = DEFAULT_COMMAND_MS } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else {
        stream.removeListener("error", onError);
        resolve();
      }
    };
    const stop = (error) => {
      finish(error);
      // Release pending pipe writes as well as the promise, so Node can exit.
      stream.destroy(error);
    };
    const abort = () => stop(signal.reason ?? new Error("interrupted during output"));
    const onError = (error) => finish(error);
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    stream.once("error", onError);
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => stop(new Error(`output write timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    // On a failed callback keep the listener for the subsequent error event.
    stream.write(text, finish);
  });
}

export function detail(result) {
  return (
    result.error?.message ||
    result.stderr.trim() ||
    result.stdout.trim() ||
    (result.signal ? `signal ${result.signal}` : `exit ${result.status}`)
  ).slice(0, DETAIL_CHARS);
}
