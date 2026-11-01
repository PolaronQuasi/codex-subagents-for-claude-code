// Runner-owned control flow uses codes; messages remain the human contract.
//
// Every code a RunnerError (or another runner error) carries, by name. The
// values are the strings audit rows and --inspect show, so a value never
// changes; a new code is added here, never written inline.
export const CODES = Object.freeze({
  // Publication guards of writer locks and request claims.
  GUARD_BUSY: "GUARD_BUSY",
  GUARD_OWNERSHIP_CHANGED: "GUARD_OWNERSHIP_CHANGED",
  // Run locks.
  RUN_LOCK_BUSY: "RUN_LOCK_BUSY",
  RUN_LOCK_HELD: "RUN_LOCK_HELD",
  RUN_LOCK_INCOMPLETE: "RUN_LOCK_INCOMPLETE",
  RUN_LOCK_OWNERSHIP_CHANGED: "RUN_LOCK_OWNERSHIP_CHANGED",
  RUN_LOCK_RECOVERY_STALE: "RUN_LOCK_RECOVERY_STALE",
  RUN_LOCK_STUCK: "RUN_LOCK_STUCK",
  // Run records.
  RUN_GONE: "RUN_GONE",
  RUN_METADATA_INVALID: "RUN_METADATA_INVALID",
  // Jobs and turns.
  JOB_UNIDENTIFIED: "JOB_UNIDENTIFIED",
  TURN_NOT_STARTED: "TURN_NOT_STARTED",
  // A launch whose helper may still be creating the job.
  LAUNCH_SETTLING: "LAUNCH_SETTLING",
  // Processes: a live PID that cannot be confirmed as the job's worker, a
  // driver or app-server still running after the runner tried to stop it.
  WORKER_UNCONFIRMED: "WORKER_UNCONFIRMED",
  WORKER_STILL_RUNNING: "WORKER_STILL_RUNNING",
  DRIVER_STILL_RUNNING: "DRIVER_STILL_RUNNING",
  DRIVER_PROTOCOL_MISMATCH: "DRIVER_PROTOCOL_MISMATCH",
  CODEX_UNSUPPORTED: "CODEX_UNSUPPORTED",
  CODEX_RPC_ERROR: "CODEX_RPC_ERROR",
  CODEX_AUTH_REQUIRED: "CODEX_AUTH_REQUIRED",
  // Quota and Codex's own named failures (codexErrorInfo): a launch refused
  // below its quota floor, a usage or rate limit hit, a full context window
  // or spent thread budget, a model the backend refused.
  CODEX_QUOTA_LOW: "CODEX_QUOTA_LOW",
  CODEX_USAGE_LIMIT: "CODEX_USAGE_LIMIT",
  CODEX_CONTEXT_FULL: "CODEX_CONTEXT_FULL",
  CODEX_MODEL_UNAVAILABLE: "CODEX_MODEL_UNAVAILABLE",
  // A model or an effort the CLI's model list proves unsupported.
  CODEX_MODEL_UNLISTED: "CODEX_MODEL_UNLISTED",
  CODEX_EFFORT_UNSUPPORTED: "CODEX_EFFORT_UNSUPPORTED",
  IPC_AUTH_FAILED: "IPC_AUTH_FAILED",
  SUBMISSION_UNCERTAIN: "SUBMISSION_UNCERTAIN",
  STEER_NOT_RUNNING: "STEER_NOT_RUNNING",
  STEER_TURN_CHANGED: "STEER_TURN_CHANGED",
  STEER_INVALID: "STEER_INVALID",
  STEER_LIMIT: "STEER_LIMIT",
  STEER_REJECTED: "STEER_REJECTED",
  INTERACTION_REQUIRED: "INTERACTION_REQUIRED",
  STOP_INCOMPLETE: "STOP_INCOMPLETE",
  LEGACY_RUN_UNSUPPORTED: "LEGACY_RUN_UNSUPPORTED",
  // Results and files; a runtime snapshot with other bytes than its release.
  UNSAFE_RESULT_DESTINATION: "UNSAFE_RESULT_DESTINATION",
  RUNTIME_CONFLICT: "RUNTIME_CONFLICT",
  INVALID_JSON: "INVALID_JSON",
});

// JSON-RPC wire errors, kept distinct from the runner's diagnostic codes.
export const RPC_ERROR = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  AUTH_REQUIRED: -32000,
  UNSUPPORTED: -32001,
});

// The codes of a run lock that another process holds, makes, takes over or
// left half made.
export const RUN_LOCK_CODES = new Set([
  CODES.RUN_LOCK_BUSY,
  CODES.RUN_LOCK_HELD,
  CODES.RUN_LOCK_INCOMPLETE,
  CODES.RUN_LOCK_OWNERSHIP_CHANGED,
  CODES.RUN_LOCK_RECOVERY_STALE,
  CODES.RUN_LOCK_STUCK,
]);

// The errno codes the code compares, by name: the values Node.js reports.
// ENOBUFS is a child's output over its maxBuffer, which the release tool
// tells apart from a git that cannot start.
export const ERRNO = Object.freeze({
  ENOENT: "ENOENT",
  ENOTDIR: "ENOTDIR",
  EISDIR: "EISDIR",
  EEXIST: "EEXIST",
  EPERM: "EPERM",
  EACCES: "EACCES",
  ESRCH: "ESRCH",
  EPIPE: "EPIPE",
  EBUSY: "EBUSY",
  ENOTEMPTY: "ENOTEMPTY",
  EXDEV: "EXDEV",
  ELOOP: "ELOOP",
  EINVAL: "EINVAL",
  ENOSPC: "ENOSPC",
  EROFS: "EROFS",
  ENOBUFS: "ENOBUFS",
  ETIMEDOUT: "ETIMEDOUT",
});

// What an errno code tells a caller: nothing is at the path (ENOENT), or one
// of its parents is not a directory (ENOTDIR), so there is nothing to read.
export const isMissing = (error) => error?.code === ERRNO.ENOENT || error?.code === ERRNO.ENOTDIR;

// The signals the runner sends or handles, by name.
export const SIGNALS = Object.freeze({
  SIGKILL: "SIGKILL",
  SIGTERM: "SIGTERM",
  SIGINT: "SIGINT",
});

// The runner's exit codes, as the manual's "Exit codes" section documents
// them: completed (and every other success), failure, a delivered job that
// failed or was cancelled, a job still running, and a waiter stopped by
// SIGINT or SIGTERM.
export const EXIT = Object.freeze({
  COMPLETED: 0,
  FAILURE: 1,
  NOT_COMPLETED: 2,
  STILL_RUNNING: 3,
  SIGINT: 130,
  SIGTERM: 143,
});

// Exit statuses internal to the identity-bound Windows command-line probe.
// These are not runner exits: a failed probe yields no command-line evidence.
export const COMMAND_PROBE_EXIT = Object.freeze({
  IDENTITY_CHANGED: 3,
  NO_COMMAND_LINE: 4,
});

export class RunnerError extends Error {
  constructor(code, message, fields = {}) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    Object.assign(this, fields);
  }
}
