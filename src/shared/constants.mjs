// The platforms whose rules differ, by process.platform's names: Windows'
// paths, shells, processes and file locking, Linux's /proc, macOS's clock.
export const PLATFORM = Object.freeze({
  WIN32: "win32",
  LINUX: "linux",
  DARWIN: "darwin",
});
export const IS_WINDOWS = process.platform === PLATFORM.WIN32;
export const IS_LINUX = process.platform === PLATFORM.LINUX;

// Units: a second, a minute, an hour and a day in milliseconds, and a day in
// minutes; .NET ticks (100 ns) from 0001-01-01 to 1970-01-01, UTC, and per
// millisecond, for Windows process start times; the clock ticks per second
// Linux has nearly everywhere, taken when getconf CLK_TCK cannot say.
export const SECOND_MS = 1000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_HOUR = 60;
export const EPOCH_TICKS = 621355968000000000n;
export const TICKS_PER_MS = 10000n;
export const DEFAULT_CLOCK_TICKS = 100;
// ECMAScript Date's largest representable epoch, in seconds.
export const MAX_DATE_SECONDS = 8_640_000_000_000;

export const DEFAULT_COMMAND_MS = 15_000;
// The foreground wait budget's default, and the longest one --wait-ms takes.
export const DEFAULT_WAIT_MS = 9 * 60 * 1000;
export const MAX_WAIT_MS = 86_400_000;
// The longest helper timeout --command-timeout-ms takes.
export const MAX_COMMAND_TIMEOUT_MS = 120_000;
// The largest caps --max-stdout-lines and --max-stdout-bytes take (0 is no cap).
export const MAX_STDOUT_LINES = 1_000_000;
export const MAX_STDOUT_BYTES = 1_000_000_000;

export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_FOOTER_BYTES = 1024 * 1024;
export const MAX_DURABLE_BYTES = MAX_OUTPUT_BYTES + MAX_FOOTER_BYTES + 1;

// Windows can deny an atomic replacement while another reader holds the target.
// Retry only that final rename, for at most 200 ms of synchronous waiting.
export const ATOMIC_RENAME_RETRIES = 20;
export const ATOMIC_RENAME_RETRY_MS = 10;

export const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
export const OUTPUT_SCHEMA_MAX_BYTES = 64 * 1024;
export const SERVICE_TIER = /^[a-z][a-z0-9_-]{0,63}$/;
export const DEFAULT_SERVICE_TIER = "default";
export const MODEL_MAX_TIERS = 16;
// Fail closed when exact prompt matching would exceed its memory/work budget.
export const PROMPT_REDACTION_MAX_FRAGMENTS = 512;
export const PROMPT_REDACTION_MAX_FRAGMENT_UNITS = 4 * 1024 * 1024;
export const PROMPT_REDACTION_MAX_SCAN_UNITS = 16 * 1024 * 1024;
export const PROMPT_REDACTION_MAX_HISTORY = 128;

export const RUN_KEY = /^[0-9a-f]{32}$/;
// rq:<request id> names the run that holds that request's claim.
export const REQUEST_HANDLE = /^rq:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
export const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export const GIT_REF = /^(?!-)[^\s\x00-\x1f\x7f]+$/;
// The form of request digest a run records, the whole SHA-256; a result
// file's name marks it as h3-. The prior format belongs to plugin-backed runs.
export const REQUEST_DIGEST_VERSION = 3;
export const REQUEST_DIGEST_PREVIOUS_VERSION = 2;
export const REQUEST_TEXT = Object.freeze({
  LEGACY_DIGEST: "was used by a run with an unsupported digest format",
  UNSUPPORTED_DIGEST: "was used by a runner with an unsupported request digest",
  REPLAY: "replay it with --run rq:",
});
// A semantic version's numeric parts, major, minor and patch: its pattern's
// groups 1 to 3 (compareVersions).
export const SEMVER_PARTS = 3;
// The oldest Node.js major version the runner runs on (package.json's engines),
// which --doctor checks.
export const MIN_NODE_MAJOR = 22;
// A task-file header name the runner guesses a directive for: one of at
// least GUESS_MIN_CHARS letters, one edit from a directive, or up to
// GUESS_LONG_EDITS from one of GUESS_LONG_CHARS letters or more.
export const GUESS_MIN_CHARS = 4;
export const GUESS_LONG_CHARS = 7;
export const GUESS_LONG_EDITS = 2;
export const JOB_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});
export const ACTIVE = new Set([JOB_STATUS.QUEUED, JOB_STATUS.RUNNING]);
export const TERMINAL = new Set([JOB_STATUS.COMPLETED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED]);
// The reasoning efforts a task may name, lowest first, each passed to Codex
// literally. ultra, above max, is an explicit choice only: no role defaults
// to it, and the pre-launch model check refuses it, as any effort, for a model
// whose model/list entry does not offer it.
export const EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export const validJobId = (value) => typeof value === "string" && JOB_ID.test(value);

// Value rules the command line and task-file directives share. Each caller
// keeps its own diagnostics, and its own path rule (the command line takes a
// relative path, a directive an absolute one).
export const validEffort = (value) => EFFORTS.has(value);
export const SUMMARY_MODES = new Set(["auto", "concise", "detailed", "none"]);
export const validSummary = (value) => SUMMARY_MODES.has(value);
export const validRequestId = (value) => typeof value === "string" && REQUEST_ID.test(value);
export const validGitRef = (value) => typeof value === "string" && GIT_REF.test(value);
// A run key, or rq:<request id> for the run that holds that request's claim.
export const validRunHandle = (value) =>
  typeof value === "string" && (RUN_KEY.test(value) || REQUEST_HANDLE.test(value));
// A directive's yes or no.
export const isYesNo = (value) => value === "yes" || value === "no";

// What holds a job worker's PID now, as inspectWorker (process-identity.mjs)
// answers.
export const WORKER_STATE = Object.freeze({
  // The PID is dead.
  GONE: "gone",
  // The PID is alive but provably another process.
  REUSED: "reused",
  // The evidence says the PID is the worker.
  WORKER: "worker",
  // Nothing says either way.
  UNKNOWN: "unknown",
});

// A worker that has ended: its PID is dead, or now another process's.
export const isGoneWorkerState = (state) =>
  state === WORKER_STATE.GONE || state === WORKER_STATE.REUSED;

// How an identity-bound stop of a process tree ended (process-stop.mjs):
// gone, the root was dead before anything was done; reused, another process
// holds its PID now; unknown, its identity could not be read, so nothing was
// done; stopped, it was identified, then ended; alive, it was identified but
// still runs after the stop.
export const STOP_OUTCOME = Object.freeze({
  GONE: "gone",
  REUSED: "reused",
  UNKNOWN: "unknown",
  STOPPED: "stopped",
  ALIVE: "alive",
});

// The generic process-stop seam can report a failed graceful interrupt.
export const INTERRUPT_OUTCOME = Object.freeze({ FAILED: "failed" });

// The settlement helper's one-word answers (settle-dead-job.mjs).

// What a command tells an in-process collector at its end (io.onOutcome): it
// delivered a result, or it delivered nothing, because it failed or because
// its job, or another waiter or launcher of it, is still running.
export const OUTCOME = Object.freeze({
  DELIVERED: "delivered",
  FAILED: "failed",
  STILL_RUNNING: "still-running",
});

// What a search for the job of a lost launch found (findLostJob).
export const LOST_JOB = Object.freeze({
  FOUND: "found",
  NONE: "none",
  AMBIGUOUS: "ambiguous",
});

// What identifying a run's lost job did, for the caller to act on: recorded
// the job as the turn's, or rolled a continued turn that never started back.
export const RUN_JOB = Object.freeze({
  RECORDED: "recorded",
  ROLLED_BACK: "rolled-back",
});

// Cross-function phase results. These wire words are kept stable; they are
// distinct from job statuses and from the collector's OUTCOME vocabulary.
export const RUN_LOCK_OUTCOME = Object.freeze({ LOCKED: "locked", HELD: "held" });
export const LAUNCH_OUTCOME = Object.freeze({
  PREPARED: "prepared",
  ATTACH: "attach",
  REPLAY: "replay",
  WAITING: "waiting",
});
export const RUN_PHASE = Object.freeze({
  DONE: "done",
  VANISHED: "vanished",
  OPENED: "opened",
  OBTAIN: "obtain",
  RESULT: "result",
});
export const JOB_ACTIVITY = Object.freeze({ UNKNOWN: "unknown", UNDELIVERED: "undelivered" });
export const RETRY_REASON = Object.freeze({ WORKER_DIED: "worker-died" });
// Width of the workspace identity used in writer-lock filenames.
export const WORKSPACE_KEY_HEX_CHARS = 16;
// Diagnostic command labels keep the subcommand and its first non-flag word.
export const GIT_LABEL_WORDS = 2;

// The transitions an audit row records (audit.mjs).
export const AUDIT_TRANSITION = Object.freeze({
  LAUNCH: "launch",
  CONTINUE: "continue",
  ATTACH: "attach",
  RETRY: "retry",
  CANCEL: "cancel",
  DELIVER: "deliver",
  SLEEP: "sleep",
  CLOSE: "close",
  SWEEP: "sweep",
  ERROR: "error",
});

export const PROCESS_QUERY_MS = 3000;
// The second, longer try at the start time of a worker the runner recorded,
// when the first query gave nothing (a busy host).
export const START_RETRY_MS = 10_000;
// How long reading a process's command line may take (WMI on Windows).
export const COMMAND_LINE_QUERY_MS = 10_000;
// ps's arguments, before the PID, for one process's whole command line on
// macOS and the other BSDs. Their ps cuts the line to 79 columns when no stdio
// is a terminal, as under spawnSync, unless -w is given twice: a cut driver
// line loses `driver.mjs run --job-id <id>` and reads as another process.
export const PS_COMMAND_LINE = Object.freeze(["-ww", "-o", "command=", "-p"]);
// An identity-bound stop: how long identifying the tree may take, how long
// the stopped processes get to exit, the grace before SIGTERM becomes SIGKILL
// on Linux and macOS, and how often an exit is checked there.
export const STOP_PREPARE_MS = 30_000;
export const STOP_EXIT_MS = 10_000;
export const STOP_GRACE_MS = 3000;
export const STOP_POLL_MS = 50;
// How many times a Windows stop looks for descendants the processes it
// stopped had started meanwhile, stopping each new one, before it gives up.
export const STOP_ROUNDS = 8;
// How long a Windows stop may go without a word once told to proceed: one
// round of stops and of looking for descendants, or the wait for the stopped
// processes to exit. It reports each, so the stop as a whole may take longer.
export const STOP_PROGRESS_MS = STOP_PREPARE_MS + STOP_EXIT_MS;
// The progress words a Windows stop takes at most: one after each round and
// one before the wait for the exits. A word beyond them counts as no answer.
export const STOP_PROGRESS_WORDS = STOP_ROUNDS + 1;
// The longest a stop takes: identifying the tree, then each progress word and
// the answer within STOP_PROGRESS_MS (7 min 10 s on Windows; a Linux or macOS
// stop takes well under a minute). A turn interrupt before the kill adds its
// own time.
export const STOP_TOTAL_MS = STOP_PREPARE_MS + (STOP_PROGRESS_WORDS + 1) * STOP_PROGRESS_MS;
export const ORPHANED_LOCK_MS = 30_000;
export const LAUNCH_SETTLE_MS = 120_000;
// The longest a Codex version probe may take.
export const VERSION_PROBE_MS = 5000;
// Removing a run's folder: Windows can hold a handle in it for a moment.
export const RUN_FOLDER_REMOVAL = Object.freeze({ maxRetries: 3, retryDelay: 100 });
// Removing a lock or guard folder: a reader's open handle on its owner file
// can delay the removal by a few milliseconds on Windows.
export const LOCK_FOLDER_REMOVAL = Object.freeze({ maxRetries: 10, retryDelay: 10 });
// What a small probe (a version, a process start time, a git toplevel) may print.
export const PROBE_OUTPUT_BYTES = 65536;
// What getconf CLK_TCK may print.
export const GETCONF_OUTPUT_BYTES = 1024;
export const INSPECT_RECORD_BYTES = 1024 * 1024;
// The largest audit file --inspect reads for its rows.
export const MAX_AUDIT_BYTES = 1024 * 1024;
// How much of a dead job's log the audit folder keeps.
export const MAX_KEPT_LOG_BYTES = 256 * 1024;
export const MAX_TOUCHED_LINES = 50;
export const MAX_PROGRESS_CHARS = 200;
// What one git command may print (a diff, a status of a large tree).
export const GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
// Bound both filesystem enumeration and the path inventory in run.json.
export const CHANGE_MAX_ENTRIES = 10_000;
export const CHANGE_MAX_PATH_BYTES = 512 * 1024;
export const CHANGE_SOURCE = Object.freeze({ GIT: "git", SCRATCH: "scratch" });
export const REVIEW_TARGET = Object.freeze({
  UNCOMMITTED: "uncommittedChanges",
  BASE: "baseBranch",
  COMMIT: "commit",
  CUSTOM: "custom",
});
export const PATCH_STATUS = Object.freeze({
  COMPLETE: "complete",
  TRUNCATED: "truncated",
  EMPTY: "empty",
  OFF: "off",
  UNAVAILABLE: "unavailable",
  NOT_RECORDED: "not-recorded",
});
// How much of a failed command's output an error message quotes.
export const DETAIL_CHARS = 1200;
// How much of the stop helper's stderr a failed stop reports.
export const STOP_STDERR_CHARS = 2000;
// How much of a failure reason a one-line answer or warning quotes (a failed
// turn interrupt, a swept run's error).
export const EXCERPT_CHARS = 300;
// The longest value a turn's recorded metadata keeps (a thread ID, a path).
export const METADATA_CHARS = 512;

// How long one git command may take.
export const GIT_MS = 120_000;
// A linked worktree's .git file, which points git at the worktree's record in
// its repository; and Windows' MAX_PATH in UTF-16 code units, its terminating
// NUL included: git for Windows without core.longpaths can neither open nor
// remove a path that long.
export const GIT_LINK = ".git";
export const WINDOWS_MAX_PATH_CHARS = 260;
// The doctor's git --version probe takes at most this long, or the command
// timeout when that is shorter.
export const GIT_PROBE_MS = 10_000;
// After a command is killed, how long its pipes may stay open (a descendant
// can hold them) before they are closed on it.
export const PIPE_RELEASE_MS = 1000;
export const LAG_CONFIRMATIONS = 2;
export const LAG_RECHECK_MS = 1000;
// A request claim without a live owner record for this long is stale.
export const STALE_CLAIM_MS = 60_000;
// A busy publication guard is tried this many times, this far apart.
export const GUARD_RETRIES = 20;
export const GUARD_RETRY_MS = 100;
// A run lock that keeps changing hands this long fails the waiter; a busy
// one is tried again this far apart.
export const LOCK_TAKEOVER_MS = 10_000;
export const LOCK_RETRY_MS = 100;
// A waiter on a run lock another process holds looks again at most this far
// apart.
export const HELD_LOCK_POLL_MS = 1000;
// A launch waiting for another launch's claim of the same request looks again
// this far apart.
export const CLAIM_RETRY_MS = 250;
// How much later than a record that shows a worker running its process's start
// time may still lie: clock granularity (whole seconds in /proc/stat and ps)
// and skew between the clocks behind the two.
export const START_SKEW_MS = 5000;

export const RPC = Object.freeze({
  INITIALIZE: "initialize",
  INITIALIZED: "initialized",
  THREAD_START: "thread/start",
  THREAD_RESUME: "thread/resume",
  THREAD_NAME_SET: "thread/name/set",
  THREAD_ARCHIVE: "thread/archive",
  THREAD_LIST: "thread/list",
  THREAD_READ: "thread/read",
  THREAD_TURNS_LIST: "thread/turns/list",
  THREAD_ITEMS_LIST: "thread/items/list",
  THREAD_UNSUBSCRIBE: "thread/unsubscribe",
  TURN_START: "turn/start",
  REVIEW_START: "review/start",
  TURN_INTERRUPT: "turn/interrupt",
  TURN_STEER: "turn/steer",
  ACCOUNT_READ: "account/read",
  MCP_STATUS_LIST: "mcpServerStatus/list",
  HOOKS_LIST: "hooks/list",
  CONFIG_READ: "config/read",
  CONFIG_REQUIREMENTS_READ: "configRequirements/read",
  RATE_LIMITS_READ: "account/rateLimits/read",
  MODEL_LIST: "model/list",
  FEEDBACK_SAVE: "feedback/save",
  THREAD_COMPACT: "thread/compact/start",
  THREAD_REVERT: "thread/revert",
  THREAD_FORK: "thread/fork",
  WINDOWS_SANDBOX_READINESS: "windowsSandbox/readiness",
});
export const NOTIFICATION = Object.freeze({
  THREAD_STARTED: "thread/started",
  THREAD_STATUS_CHANGED: "thread/status/changed",
  THREAD_COMPACTED: "thread/compacted",
  TURN_STARTED: "turn/started",
  TURN_COMPLETED: "turn/completed",
  PLAN_UPDATED: "turn/plan/updated",
  DIFF_UPDATED: "turn/diff/updated",
  ITEM_STARTED: "item/started",
  ITEM_COMPLETED: "item/completed",
  AGENT_MESSAGE_DELTA: "item/agentMessage/delta",
  TOKEN_USAGE_UPDATED: "thread/tokenUsage/updated",
  RATE_LIMITS_UPDATED: "account/rateLimits/updated",
  MODEL_REROUTED: "model/rerouted",
  MODEL_SAFETY_BUFFERING: "model/safetyBuffering/updated",
  GUARDIAN_WARNING: "guardianWarning",
  STRICT_REVIEW_REQUIRED: "autoApprovalReview/strictReviewRequired",
  ERROR: "error",
});
export const SERVER_REQUEST = Object.freeze({
  COMMAND_APPROVAL: "item/commandExecution/requestApproval",
  FILE_APPROVAL: "item/fileChange/requestApproval",
  PERMISSIONS_APPROVAL: "item/permissions/requestApproval",
  USER_INPUT: "item/tool/requestUserInput",
  TOOL_CALL: "item/tool/call",
  MCP_ELICITATION: "mcpServer/elicitation/request",
  AUTH_REFRESH: "account/chatgptAuthTokens/refresh",
  ATTESTATION: "attestation/generate",
  APPLY_PATCH_APPROVAL: "applyPatchApproval",
  EXEC_COMMAND_APPROVAL: "execCommandApproval",
});
export const POLICY_DECISION = Object.freeze({ DECLINE: "decline", TURN: "turn" });
export const POLICY_EFFECT = Object.freeze({
  CONTINUE: "continue",
  INTERRUPT: "interrupt",
  FAIL: "fail",
});
export const POLICY_TEXT = Object.freeze({
  NON_INTERACTIVE: "Non-interactive approval is unavailable.",
  NO_TOOLS: "Client-provided tools are unavailable.",
  AUTH_REQUIRED: "External authentication refresh is unavailable; run codex login.",
  ATTESTATION_UNSUPPORTED: "Attestation is disabled for this client.",
  UNKNOWN_METHOD: "Unsupported server request; check Codex CLI compatibility.",
});
export const CODEX_ITEM = Object.freeze({
  COMMAND: "commandExecution",
  SEARCH: "webSearch",
  REASONING: "reasoning",
  MCP: "mcpToolCall",
  AGENT_MESSAGE: "agentMessage",
  FILE_CHANGE: "fileChange",
  REVIEW_ENTERED: "enteredReviewMode",
  REVIEW_EXITED: "exitedReviewMode",
  INPUT_TEXT: "inputText",
});
export const CODEX_PHASE = Object.freeze({ FINAL_ANSWER: "final_answer" });
export const TURN_STATUS = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  INTERRUPTED: "interrupted",
  IN_PROGRESS: "inProgress",
});
export const DRIVER_IPC = Object.freeze({
  HELLO: "hello",
  STATUS: "status",
  INTERRUPT: "interrupt",
  SHUTDOWN: "shutdown",
  STEER: "steer",
});
export const DRIVER_PHASE = Object.freeze({
  GATED: "gated",
  STARTING: "starting",
  DISPATCHING: "dispatching",
  RUNNING: "running",
  TERMINAL: "terminal",
});
export const DRIVER_PROTOCOL_VERSION = 1;
export const RUN_RECORD_VERSION = 2;
export const JOB_RECORD_VERSION = 1;
export const DRIVER_GATE_MS = 15_000;
export const DRIVER_GATE_GO = "GO\n";
export const DRIVER_PROBE_MS = 1000;
export const DRIVER_REPLY_MS = 5000;
export const DRIVER_EXIT_MS = 15_000;
export const DRIVER_POLL_MS = 250;
export const APP_SERVER_START_MS = 15_000;
export const APP_SERVER_REQUEST_MS = 30_000;
export const APP_SERVER_INTERRUPT_MS = 30_000;
export const APP_SERVER_EXIT_MS = 10_000;
export const APP_SERVER_PROBE_MS = 5000;
// The driver awaits the interrupt RPC response, then a terminal notification.
// Its caller must outlast both complete app-server windows.
export const DRIVER_INTERRUPT_MS = 2 * APP_SERVER_INTERRUPT_MS + DRIVER_REPLY_MS;
export const WARM_IDLE_MS = 0;
export const RPC_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const RPC_TURN_ENVELOPE_BYTES = 4096;
export const RPC_MAX_PENDING = 128;
export const RPC_MAX_SERVER_REQUESTS = 32;
export const RPC_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
export const RPC_EVENT = Object.freeze({ NOTIFICATION: "notification", CLOSE: "close" });
export const JOB_MAX_RECORD_BYTES = 1024 * 1024;
export const JOB_ATOMIC_RENAME_RETRIES = 100;
export const JOB_PUBLICATION_SUFFIX = ".publish";
export const JOB_MAX_EVENTS_BYTES = 1024 * 1024;
export const JOB_MAX_LOG_BYTES = 256 * 1024;
export const JOB_ID_BYTES = 16;
export const JOB_READ_POLICY = Object.freeze({
  BEST_EFFORT: "best-effort",
  STRICT: "strict",
  OBSERVED: "observed",
});
export const JOB_FILES = Object.freeze({
  PROGRESS: "progress.jsonl",
  DIFF: "diff.patch",
  DIRECTORY: "jobs",
  DRIVER: "driver.json",
  EVENTS: "events.jsonl",
  FINAL: "final.txt",
  TURN: "turn.json",
  LOG: "driver.log",
});
// Both fields describe the certification baseline. Neither field is an
// admission boundary: maxTested names the tested CLI baseline.
export const CODEX_VERSION_RANGE = Object.freeze({ min: "0.166.0", maxTested: "0.166.0" });
export const CODEX_ENV = Object.freeze({
  PATH: "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH",
  DIRECTORY: "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_DIR",
  ALLOW: "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_ALLOW_CODEX",
});
export const CODEX_OVERRIDE_REMEDY = "correct or unset this override";
export const CODEX_COMMAND = Object.freeze({
  APP_SERVER: "app-server",
  LISTEN: "--listen",
  STDIO: "stdio://",
  CONFIG: "-c",
  VERSION: "--version",
  HELP: "--help",
  MCP: "mcp",
  LIST: "list",
  JSON: "--json",
  DISABLE: "--disable",
  GENERATE_SCHEMA: "generate-json-schema",
  OUT: "--out",
});

// The sole execution backend, also recorded in request identity.
export const BACKEND = Object.freeze({ DRIVER: "driver" });
export const MCP_MODE = Object.freeze({ INHERIT: "inherit", OFF: "off" });
export const MCP_DIRECTIVE = "mcp";
export const PROGRESS_DIRECTIVE = "progress";
export const PROGRESS_MODE = Object.freeze({ ON: "on", OFF: "off" });
export const PROGRESS_KIND = Object.freeze({ PLAN: "plan", ITEM: "item" });
export const PLAN_STATUS = Object.freeze({
  PENDING: "pending",
  ACTIVE: "inProgress",
  DONE: "completed",
});
export const PROGRESS_MAX_BYTES = 64 * 1024;
export const DIFF_MAX_BYTES = 256 * 1024;
export const PROGRESS_TEXT_BYTES = 384;
export const PROGRESS_MAX_PARTS = 32;
export const PROGRESS_TAIL_LINES = 5;
export const PROGRESS_REDACTED = "[prompt withheld]";
export const STEER_MAX_BYTES = 64 * 1024;
export const STEER_MAX_COUNT = 32;
export const STEER_REQUEST_MS = 10_000;
export const STEER_REPLY_MS = STEER_REQUEST_MS + DRIVER_REPLY_MS;
export const STEER_FILES = Object.freeze({ PREFIX: "steer-", TEXT: ".txt", RECORD: ".json" });
export const STEER_STATUS = Object.freeze({
  DISPATCHING: "dispatching",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  UNCERTAIN: "uncertain",
});
export const STEER_TEXT = Object.freeze({
  INACTIVE: "No steerable turn is running; interrupt and continue instead if needed.",
  CHANGED: "The active turn changed; the steer was refused.",
  INVALID: "Invalid steer file or identity; nothing was sent.",
  LIMIT: "Steer count or text byte limit exceeded.",
  UNCERTAIN:
    "Steer acknowledgement is uncertain; do not resend. Inspect the job's driver.json or collect the run to reconcile history.",
  REJECTED: "Codex refused the steer; interrupt and continue instead.",
});
export const DRIVER_FILES = Object.freeze({
  SECRET: "ipc.key",
  GATE: "gate.json",
  SOCKET: "driver.sock",
  CANCEL: "cancel.json",
});
export const DRIVER_ENTRY = "driver.mjs";
export const DRIVER_ARG = Object.freeze({ RUN: "run", JOB: "--job-id", STATE: "--state-dir" });
export const IPC_AUTH = Object.freeze({
  CHALLENGE: "challenge",
  PROVE: "prove",
  SERVER: "server",
  CLIENT: "client",
  ACK: "ack",
  REQUEST: "request",
  RESPONSE: "response",
});
export const IPC_SECRET_BYTES = 32;
export const IPC_NONCE_BYTES = 32;
export const IPC_MAX_CONNECTIONS = 16;
export const IPC_MAX_FRAME_BYTES = 64 * 1024;
export const IPC_AUTH_MS = 2000;
export const IPC_PIPE_PREFIX = "\\\\.\\pipe\\csfcc-";
export const IPC_SOCKET_PREFIX = "csfcc-";
export const IPC_SOCKET_SUFFIX = ".sock";
// The longest socket path sockaddr_un holds with its terminating NUL: sun_path
// is 108 bytes on Linux and 104 on macOS and the BSDs, the bound kept for any
// other POSIX system.
export const IPC_LINUX_PATH_BYTES = 107;
export const IPC_UNIX_PATH_BYTES = 103;
export const IPC_POSIX_TMP = "/tmp";
export const DRIVER_HASH = "sha256";
export const DRIVER_ENCODING = "hex";
export const DRIVER_TEXT = Object.freeze({
  AUTH: "Driver IPC authentication failed; state retained.",
  PROTOCOL: "Driver protocol mismatch; use the runner release that started this job.",
  GATE: "Driver start gate expired before its identity was recorded.",
  NOT_STARTED: "Driver did not start.",
  PUBLICATION_BUSY: "Another job publisher is still writing; state retained.",
  PROMPT_FRAME: "Prompt exceeds the Codex RPC byte limit after JSON encoding; shorten the prompt.",
  HISTORY_FAILURE: "History lookup failed:",
  HISTORY_REDACTED:
    "Diagnostic text withheld because the saved prompt could not be read for redaction.",
  CLI_CHANGED: "Codex executable changed since this run began; state retained",
  DIED: "Driver ended without recording a terminal result.",
  CHILD_DIED: "Codex app-server ended before the turn completed.",
  UNCERTAIN: "Submission could not be reconciled; the turn will never be resent.",
  STOP: "Process exit could not be confirmed; state retained.",
  STOP_PID: "Unconfirmed process PID",
  RECOVER: "Recover with:",
  SHUTDOWN: "Driver shutdown was requested.",
  CANCELLED: "The turn was cancelled.",
  NO_FINAL: "Codex completed without a final agent message.",
  SANDBOX: "Windows sandbox is not ready for a write job.",
});
export const CLIENT_NAME = "codex-subagents-for-claude-code";
export const OPT_OUT_NOTIFICATIONS = Object.freeze([
  NOTIFICATION.AGENT_MESSAGE_DELTA,
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/mcpToolCall/progress",
  "item/commandExecution/terminalInteraction",
]);
export const MCP_OFF_FEATURES = Object.freeze(["plugins", "apps", "hooks"]);
export const MCP_OFF_CONFIG = Object.freeze([
  "notify=[]",
  'otel.exporter="none"',
  'otel.metrics_exporter="none"',
  'otel.trace_exporter="none"',
]);
export const CODEX_READY = "ready";
export const RECOVERY_PAGE_SIZE = 100;
export const RECOVERY_MAX_PAGES = 100;
export const RECOVERY_SORT = "desc";
export const HISTORY_SORT = "asc";
export const HISTORY_READ_MS = 30_000;
export const HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export const TRANSCRIPT_MAX_BYTES = 1024 * 1024;
export const TRANSCRIPT_FIELD_BYTES = 8192;
export const TRANSCRIPT_META_BYTES = 2048;
export const TRANSCRIPT_MAX_TURNS = RECOVERY_PAGE_SIZE * RECOVERY_MAX_PAGES;
export const THREAD_OWNER_DIRECTORY = "thread-owners";
export const THREAD_OWNER_BYTES = 8192;
export const DOCTOR_MAX_ROWS = 100;
export const DOCTOR_WORD_CHARS = 128;
export const DOCTOR_DETAIL = "toolsAndAuthOnly";
export const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
export const BUNDLE_CLASSIFICATION = "bug";
export const COMPACTION_ITEM = "contextCompaction";
export const COMPACTION_UNCERTAIN = "uncertain";
export const COMPACTION_TIMEOUT_MS = 120_000;
export const HISTORY_EDIT_MAX = 100;
export const HISTORY_ITEMS_OMITTED = "notLoaded";
export const FORK_STATE = Object.freeze({
  PREPARED: "prepared",
  DISPATCHING: "dispatching",
  READY: "ready",
});
export const FORK_REDACTION_FILE = "fork-redaction.json";
export const FORK_SETTINGS = Object.freeze([
  "commitSubject",
  "commitTrailers",
  "model",
  "effort",
  "write",
  "mcp",
  "progress",
  "quotaFloor",
  "summary",
  "review",
  "outputSchema",
  "tier",
  "compact",
]);
export const THREAD_OWNER_VERSION = 1;
export const TRANSCRIPT_TURN_OPTION = "turn";
export const THREAD_ARCHIVE_FAILED = "failed";
export const THREAD_NAME_PREFIX = "csfcc ";
export const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const ARCHIVABLE_THREAD_STATES = new Set(["notLoaded", "idle"]);
export const CODEX_EXECUTABLES = Object.freeze({
  WINDOWS: Object.freeze(["codex.exe", "codex.cmd", "codex"]),
  POSIX: Object.freeze(["codex"]),
});
export const CODEX_VALUE = Object.freeze({
  NEVER: "never",
  USER: "user",
  READ_ONLY: "read-only",
  WORKSPACE_WRITE: "workspace-write",
  READ_ONLY_POLICY: "readOnly",
  WORKSPACE_WRITE_POLICY: "workspaceWrite",
  IDLE: "idle",
  FULL: "full",
  PAGINATED: "paginated",
  OPENAI: "openai",
  APP_SERVER: "appServer",
  COMMAND: "command",
  FORM: "form",
  OBJECT: "object",
  AUTH_UNAUTHORIZED: "unauthorized",
  USER_MESSAGE: "userMessage",
  TEXT: "text",
  UPDATE: "update",
});

// Run records and executable pins are independent of the job and IPC versions.
export const LEGACY_RUN_VERSION = 1;
export const CODEX_IDENTITY_FIELDS = Object.freeze(["path", "realPath", "version", "build"]);
export const LEGACY_RUN_TEXT =
  "LEGACY_RUN_UNSUPPORTED: this record format does not support active operations. List, inspect and durable replay remain available; --close KEY --force can quarantine ended state. Use the creating runner for active work.";
export const CODEX_LOGIN = Object.freeze({
  IN: "logged-in",
  OUT: "logged-out",
  UNKNOWN: "unknown",
});

// A session app-server, or a probe one: no thread, plugins, apps, hooks,
// notify or OTEL exporters, and no MCP discovery (--limits).
export const APP_SERVER_MODE = Object.freeze({ SESSION: "session", PROBE: "probe" });
// The state root's quota cache: the last snapshot a read or a delivered turn
// saw, which --limits --cached and a status line read without starting Codex.
export const QUOTA_FILE = "quota.json";
export const QUOTA_FILE_BYTES = 64 * 1024;
// Where a cached snapshot came from: a delivered turn's pushed update, or an
// explicit account/rateLimits/read.
export const QUOTA_SOURCE = Object.freeze({ TURN: "turn", READ: "read" });
// What --limits answers from: a fresh read, the cache, or neither; and its
// login field.
export const LIMITS_SOURCE = Object.freeze({ FRESH: "fresh", CACHE: "cache", NONE: "none" });
export const LIMITS_LOGIN = Object.freeze({ IN: "in", OUT: "out" });
export const LIMITS_LINE = "codex-subagents-for-claude-code-limits:";
export const QUOTA_LINE = "codex-subagents-for-claude-code-quota:";
export const MODEL_EVENT_LINE = "codex-subagents-for-claude-code-model:";
export const MODEL_EVENT_MAX_REROUTES = 16;
export const MODEL_EVENT_ID_CHARS = 128;
export const MODEL_REROUTE_REASON = "highRiskCyberActivity";
export const MODEL_WARNING = Object.freeze({
  GUARDIAN: "guardian-warning",
  STRICT_REVIEW: "strict-review-required",
});
// A whole in percent, the decimals a credit balance shows, the oldest cache
// --max-age takes (minutes), and the most other buckets one line names.
export const PERCENT = 100;
export const CREDIT_DECIMALS = 2;
export const MAX_CACHE_AGE_MINUTES = 7 * MINUTES_PER_DAY;
export const MAX_LIMIT_BUCKETS = 8;

// The quota floor: the least remaining percent a launch or follow-up needs
// before turn/start (a directive, --quota-floor, or this variable's default;
// 0, the default, sends no read). Values are whole percents, "10" or "10%".
export const QUOTA_FLOOR_DIRECTIVE = "quota-floor";
export const QUOTA_FLOOR_ENV = "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_QUOTA_FLOOR";
export const QUOTA_FLOOR_OFF = 0;
export const parseQuotaFloor = (value) => {
  const match = /^(\d{1,3})%?$/.exec(String(value ?? ""));
  return match && Number(match[1]) <= PERCENT ? Number(match[1]) : null;
};
// A kept thread this full gets a note after its result, and this full a
// warning: a follow-up on it may compact or fail.
export const CONTEXT_NOTE_PERCENT = 70;
export const CONTEXT_WARN_PERCENT = 85;
// The codexErrorInfo values the runner names (the CodexErrorInfo enum), and
// what each tells the caller.
export const CODEX_ERROR_INFO = Object.freeze({
  USAGE_LIMIT: "usageLimitExceeded",
  RATE_LIMIT: "rateLimitExceeded",
  CONTEXT_WINDOW: "contextWindowExceeded",
  SESSION_BUDGET: "sessionBudgetExceeded",
  MODEL_NOT_FOUND: "modelNotFound",
  UNAUTHORIZED: "unauthorized",
});
export const CODEX_ERROR_TEXT = Object.freeze({
  [CODEX_ERROR_INFO.USAGE_LIMIT]: "the Codex usage limit of this account is reached",
  [CODEX_ERROR_INFO.RATE_LIMIT]: "Codex rate-limited this account",
  [CODEX_ERROR_INFO.CONTEXT_WINDOW]:
    "the thread's context window is full; start a new run instead of continuing this one",
  [CODEX_ERROR_INFO.SESSION_BUDGET]:
    "the thread's token budget is spent; start a new run instead of continuing this one",
  [CODEX_ERROR_INFO.MODEL_NOT_FOUND]:
    "the backend refused this model for this account (being listed by model/list does not prove access); choose another model",
  [CODEX_ERROR_INFO.UNAUTHORIZED]: "Codex is not authorized; run codex login",
});
// The state root's model catalogue cache: model/list's answer for one CLI
// build and UTC day. model/list is read in pages, bounded in pages and
// models; a refusal names a few of the visible ones.
export const MODELS_FILE = "models.json";
// The runtime snapshots (shared/runtime-release.mjs): <state>/runtime/<id>/,
// each the entry, the modules under src/ and the legal files of one release,
// named <version>-<RUNTIME_DIGEST_CHARS hex digits of their digest>; a
// snapshot being written is a sibling folder whose name starts with
// RUNTIME_STAGING.
export const RUNTIME_DIR = "runtime";
export const RUNTIME_ENTRY = "run-codex-task.mjs";
export const RUNTIME_MODULES = "src";
export const RUNTIME_LEGAL_FILES = Object.freeze(["LICENSE", "NOTICE"]);
export const RUNTIME_DIGEST_CHARS = 12;
export const RUNTIME_STAGING = ".staging-";
// --prepare's task files: <temporary folder>/<TASK_FOLDER>/<role>-<hex>.md,
// with TASK_NAME_BYTES random bytes in hex, never an existing file's name.
export const TASK_FOLDER = "codex-subagents-for-claude-code";
export const TASK_NAME_BYTES = 4;
export const TASK_NAME_ATTEMPTS = 8;
export const MODEL_LIST_MAX_PAGES = 10;
export const MAX_CATALOG_MODELS = 200;
export const MAX_LISTED_MODELS = 12;
export const MODEL_TEXT = Object.freeze({
  UNLISTED: "is not in this Codex CLI's model list",
  LISTED: "listed:",
  CATALOGUE:
    "The list is the CLI's catalogue: it proves a typo, an effort mismatch or a retirement, never account access",
  EFFORT: "is not an effort model/list offers for",
  OFFERED: "offered:",
  RETIRES: "retires",
  UPGRADE: "upgrade:",
  NOT_SENT: "the task was not sent to Codex",
  ACCESS: "catalogue only: a listed model can still be refused for this account",
});
export const QUOTA_TEXT = Object.freeze({
  NOT_ALLOWED: "the backend does not allow ordinary usage on this account now",
  REACHED: "a Codex limit is reached",
  BELOW: "remains, below the quota floor of",
  NOT_SENT: "the task was not sent to Codex",
  RESETS: "it resets",
  SAID: "Codex said:",
});

// Artifact coordination and trusted-local verification policies.
export const JSON_INDENT = 2;
export const BRANCH_SUFFIX_CHARS = 20;
export const ARTIFACT_BYTES = 65536;
export const BATCH_BYTES = 262144;
export const BATCH_CHILDREN_MAX = 16;
export const BATCH_CONCURRENCY_MAX = 4;
export const BATCH_REQUEST_HASH_CHARS = 24;
export const BATCH_ERROR_CHARS = 1024;
export const BATCH_POLL_MS = 250;
export const RECIPE_BYTES = 65536;
export const COMMIT_SUBJECT_CHARS = 200;
export const COMMIT_TRAILERS_MAX = 16;
export const COMMIT_TRAILER_CHARS = 512;
export const COMMIT_TRAILERS_BYTES = 16384;
export const PROCESS_TABLE_MAX = 16384;
export const PROCESS_GROUP_QUERY_MS = 1000;
export const VERIFY_RECEIPT_BYTES = 262144;
export const VERIFY_ARGS_MAX = 128;
export const VERIFY_VALUE_CHARS = 8192;
export const VERIFY_ENV_MAX = 32;
export const VERIFY_TIMEOUT_MS = 60000;
export const VERIFY_TIMEOUT_MAX_MS = 300000;
export const VERIFY_LOG_BYTES = 1048576;
export const VERIFY_LOG_MAX_BYTES = 4194304;
export const VERIFY_EXECUTABLE_BYTES = 536870912;
export const VERIFY_TREE_ENTRIES_MAX = 50000;
export const VERIFY_SCAN_BYTES_MAX = 2147483648;
export const VERIFY_SCAN_MS = 60000;
export const VERIFY_METADATA_BYTES = 4096;
export const VERIFY_MUTATIONS_MAX = 200;
export const VERIFY_ERROR_CHARS = 2048;
export const VERIFY_IDENTITY_ATTEMPTS = 50;
export const VERIFY_IDENTITY_PAUSE_MS = 20;
export const VERIFY_DISPATCH_MS = 15000;
export const VERIFY_DRAIN_MS = 5000;
export const VERIFY_STOP_MS = 10000;
export const VERIFY_POLL_MS = 25;
export const VERIFY_STATUS = Object.freeze({
  PREPARING: "preparing",
  RUNNING: JOB_STATUS.RUNNING,
  EXIT_ZERO: "exit-0",
  FAILED: JOB_STATUS.FAILED,
  CANCELLED: JOB_STATUS.CANCELLED,
  ERROR: "error",
  UNCERTAIN: "uncertain",
  INVALIDATED: "invalidated",
  SKIPPED: "skipped",
  EXITED: "exited",
  TIMEOUT: "timeout",
  DISPATCHING: "dispatching",
});
export const VERIFY_IPC = Object.freeze({ START: "start", EXIT: "exit", ERROR: "error" });
export const BATCH_STATUS = Object.freeze({
  PLANNED: "planned",
  LAUNCHING: "launching",
  RUNNING: JOB_STATUS.RUNNING,
  UNCERTAIN: "uncertain",
  SKIPPED: "skipped",
  COMPLETED: JOB_STATUS.COMPLETED,
  FAILED: JOB_STATUS.FAILED,
  CANCELLED: JOB_STATUS.CANCELLED,
});
export const GIT_OPERATION_MARKERS = Object.freeze([
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
]);
export const GIT_IDENT_VARS = Object.freeze({
  author: "GIT_AUTHOR_IDENT",
  committer: "GIT_COMMITTER_IDENT",
});
export const FOOTER_FIELDS = Object.freeze([
  "status",
  "run",
  "turn",
  "job",
  "thread",
  "model",
  "effort",
  "mode",
  "duration",
  "touched",
  "omitted",
  "request",
  "branch",
  "commit",
  "keep",
  "tokens",
  "limit",
]);

// Request claims distinguish persisted jobs from proven undispatched owners.
export const REQUEST_CLAIM_STATE = Object.freeze({
  UNDISPATCHED: "undispatched",
  POSSIBLE_LIVE: "possible-live",
  RECORDED: "recorded",
  CLOSED: "closed",
});
export const STATE_CLAIM_DIRECTORY = Object.freeze({ REQUESTS: "requests", WRITERS: "writers" });
export const CODEX_NATIVE_SIGNATURE_BYTES = 4;
export const GIT_SUBMODULE_DEPTH_MAX = 16;
