// The command line: roles, option definitions, parseArgs, parseDuration, the
// --help text, and the folders an invocation takes from its environment.
// Default folder selection performs no filesystem access.

import os from "node:os";
import path from "node:path";
import { RUNNER_VERSION } from "../version.mjs";
import {
  DEFAULT_COMMAND_MS,
  MODEL,
  SERVICE_TIER,
  RUN_KEY,
  validEffort,
  validSummary,
  validGitRef,
  validJobId,
  validRequestId,
  validRunHandle,
  IS_WINDOWS,
  DEFAULT_WAIT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_STDOUT_BYTES,
  MAX_STDOUT_LINES,
  MAX_WAIT_MS,
  SECOND_MS,
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
  MAX_CACHE_AGE_MINUTES,
  TRANSCRIPT_MAX_TURNS,
  TRANSCRIPT_TURN_OPTION,
  QUOTA_FLOOR_ENV,
  QUOTA_FLOOR_OFF,
  parseQuotaFloor,
} from "../shared/constants.mjs";
import { absoluteOverride, isAbsolutePath } from "../shared/io.mjs";
import { validReview, structuredReview } from "../shared/review.mjs";
import { validCommitSubject } from "../shared/commit-message.mjs";

import { ROLES } from "../roles.mjs";
export { ROLES };

export const DEFAULT_AGENTS_DIR = path.join(os.homedir(), ".claude", "agents");

const DURATION = /^(\d{1,9})(s|m|h|d)?$/;

const SELECTORS = ["run", "continue", "cancel", "close", "sleep"];

const VALUE_OPTIONS = [
  "verify-artifact",
  "verification",
  "recipe",
  "attempt",
  "execution-profile",
  "batch",
  "batch-run",
  "batch-cancel",
  "artifact",
  "finalize",
  "integrate",
  "discard",
  "target",
  "commit-subject",
  "commit-trailers",
  "fork",
  "at",
  "revert",
  "before-turn",
  "bundle",
  "tier",
  "output-schema",
  "transcript",
  TRANSCRIPT_TURN_OPTION,
  "review",
  "model",
  "effort",
  "summary",
  "prompt-file",
  "task-file",
  "role",
  "request-id",
  "attach",
  ...SELECTORS,
  "cwd",
  "worktree-ref",
  "wait-ms",
  "command-timeout-ms",
  "max-stdout-lines",
  "max-stdout-bytes",
  "older-than",
  "inspect",
  "max-age",
  "quota-floor",
  "prepare",
  "steer",
];
const FLAG_OPTIONS = [
  "compact",
  "verbose",
  "codex",
  "archive-orphans",
  "write",
  "keep-prompt",
  "keep-state",
  "default-keep",
  "scratch-workspace",
  "worktree",
  "quiet",
  "wait",
  "detach",
  "relay",
  "force",
  "list",
  "mine",
  "active",
  "close-idle",
  "collect-finished",
  "sleep-idle",
  "all-sessions",
  "dry-run",
  "doctor",
  "help",
  "json",
  "probe",
  "read-only",
  "limits",
  "cached",
  "diff",
];
// Modes that stand alone, with the only options each accepts.
// The manual sweeps over retained runs share their options.
export const SWEEPS = ["close-idle", "collect-finished", "sleep-idle"];
const STANDALONE = {
  "verify-artifact": ["recipe", "attempt", "execution-profile"],
  verification: ["attempt"],
  batch: ["wait-ms"],
  "batch-run": ["wait-ms"],
  "batch-cancel": [],
  artifact: [],
  finalize: [],
  integrate: ["target"],
  discard: [],
  fork: ["at", "request-id"],
  revert: ["before-turn"],
  bundle: [],
  help: [],
  doctor: ["read-only", "verbose"],
  list: ["mine", "active", "codex"],
  "archive-orphans": ["dry-run"],
  inspect: ["json", "probe"],
  limits: ["json", "cached", "max-age"],
  prepare: [],
  steer: ["prompt-file"],
  transcript: [TRANSCRIPT_TURN_OPTION, "json"],
  ...Object.fromEntries(
    SWEEPS.map((sweep) => [sweep, ["older-than", "all-sessions", "dry-run", "quiet"]]),
  ),
};
export const KNOWN_OPTIONS = Object.freeze([...VALUE_OPTIONS, ...FLAG_OPTIONS]);
const LAUNCH_OPTIONS = [
  "commit-subject",
  "commit-trailers",
  "compact",
  "tier",
  "output-schema",
  "review",
  "model",
  "effort",
  "summary",
  "prompt-file",
  "task-file",
  "role",
  "request-id",
  "write",
  "keep-prompt",
  "keep-state",
  "cwd",
  "scratch-workspace",
  "worktree",
  "worktree-ref",
  "quota-floor",
];

export const HELP = `run-codex-task ${RUNNER_VERSION}

Usage:
  node run-codex-task.mjs --role ROLE --task-file FILE                (what the agents run)
  node run-codex-task.mjs --model MODEL --effort EFFORT --prompt-file FILE [--write] [--keep-state] [--scratch-workspace|--worktree] [--request-id ID]
  node run-codex-task.mjs --continue RUN_KEY --prompt-file FILE [--model MODEL] [--effort EFFORT] [--write]
  node run-codex-task.mjs --attach JOB_ID --run RUN_KEY
  node run-codex-task.mjs --run RUN_KEY
  node run-codex-task.mjs --run RUN_KEY --diff                       (latest bounded patch; no wait)
  node run-codex-task.mjs --role ROLE --review uncommitted|base:REF|commit:HEX
  node run-codex-task.mjs --role ROLE --review custom --prompt-file FILE
  Launches, --continue and --run also take --wait (no wait budget, for
  background calls), --detach (launches and --continue: print a receipt and
  return at once) and --relay (exit 0 for every delivered result).
  node run-codex-task.mjs --cancel RUN_KEY
  node run-codex-task.mjs --steer RUN_KEY --prompt-file FILE          (running turn only)
  node run-codex-task.mjs --close RUN_KEY
  node run-codex-task.mjs --sleep RUN_KEY
  node run-codex-task.mjs --list [--mine] [--active]
  node run-codex-task.mjs --list --codex                            (named orphan threads; no model call)
  node run-codex-task.mjs --archive-orphans [--dry-run]              (confirmed ownership only)
  node run-codex-task.mjs --close-idle [--older-than AGE] [--all-sessions] [--dry-run]
  node run-codex-task.mjs --collect-finished [--older-than AGE] [--all-sessions] [--dry-run]
  node run-codex-task.mjs --sleep-idle [--older-than AGE] [--all-sessions] [--dry-run]
  node run-codex-task.mjs --inspect RUN_KEY [--json] [--probe]
  node run-codex-task.mjs --transcript RUN_KEY [--turn N] [--json]   (bounded persisted history; no model call)
  node run-codex-task.mjs --bundle RUN_KEY                        (local ZIP; contains sensitive logs/prompts)
  node run-codex-task.mjs --revert RUN_KEY --before-turn N         (persisted history only; files unchanged)
  node run-codex-task.mjs --fork RUN_KEY [--at N] [--request-id ID] (new kept context; no model turn)
  node run-codex-task.mjs --doctor [--read-only] [--verbose]
  node run-codex-task.mjs --limits [--json] [--cached | --max-age MIN]
  node run-codex-task.mjs --prepare ROLE                              (what the plugin's agents run first)
  node run-codex-task.mjs --role ROLE --task-file -                  (bounded UTF-8 stdin)
  node run-codex-task.mjs --artifact RUN_KEY                         (durable Git receipt, JSON)
  node run-codex-task.mjs --finalize RUN_KEY                         (seal a delivered worktree)
  node run-codex-task.mjs --integrate RUN_KEY --target CHECKOUT      (clean fast-forward only)
  node run-codex-task.mjs --discard RUN_KEY                          (retire branch to a recovery ref)
  node run-codex-task.mjs --batch RECIPE.json [--wait-ms N]           (bounded independent model jobs)
  node run-codex-task.mjs --batch-run ID [--wait-ms N]                (collect/resume coordinator)
  node run-codex-task.mjs --batch-cancel ID                          (owned children only)
  node run-codex-task.mjs --verify-artifact RUN_KEY --recipe FILE --attempt ID --execution-profile trusted-local
  node run-codex-task.mjs --verification RUN_KEY --attempt ID        (read verification receipt)
  RUN_KEY may also be rq:<request id>, the run holding that request's claim.
  Artifact and verification commands require a full run key. --prompt-file -
  also reads stdin. Input is fully read before dispatch; the command timeout
  bounds waiting for EOF. Batch and verification recipes are documented in MANUAL.md.

Task files start with optional directive lines ("name: value", the name in
lowercase, one per line, from the first line on); the first other line starts
the task text, which is sent verbatim. Refused rather than sent as text: a
directive line after a blank line; a directive name in another case with a
value it accepts ("Effort: low"; "Write: a parser for X" stays text); and a
lowercase header name that is a known misspelling (kept:) or one edit off a directive,
two off one of seven letters or more (writ:, wortre:, prompt_file:). Names
under four letters are not guessed. Task and prompt files must be UTF-8 regular
files of at most 8 MiB (8,388,608 bytes). Directives:
  commit-subject explicit single-line subject (1-200 characters) for a write
                worktree's runner-created commit. Per-turn; no history rewriting.
  commit-trailers absolute JSON object file of validated trailer key/value pairs.
                Per-turn; no invented co-author identity. Codex-* keys reserved.
  effort        none, minimal, low, medium, high, xhigh, max, ultra (default: the
                role's, never ultra)
  model         model ID or role name; may change on continue
  summary       auto, concise, detailed or none; --summary also works on direct
                launches and continuations. Omitted continues inherit it.
  output-schema absolute path to a JSON Schema object (max 64 KiB). Per-turn;
                constrains turn/start output and saves parseable JSON beside
                the durable answer. Not supported with native review.
  tier          default or a tier offered by model/list (such as priority).
                Per-turn only; faster tiers may consume more quota. Native
                review cannot combine this option. --tier also works directly.
  compact       yes/no, continue only: explicitly summarize the thread before
                sending the follow-up prompt. This makes an extra model call.
                --compact works on direct continuations.
  review        uncommitted, base:<ref>, commit:<hex>, or custom. Read-only;
                structured targets need an empty task body, custom needs text.
                Per-turn: an omitted review on continue resumes ordinary tasks.
  mcp           inherit (default) or off: disable configured integrations, notify
                and OTEL exporters for this turn, while keeping native login.
  keep          yes/no: keep the run after its result for --continue
  progress      on (default) or off: record bounded plan/item summaries and diff;
                off creates neither progress.jsonl nor diff.patch for this turn.
  write         yes/no: allow workspace writes (default no)
  cwd           absolute workspace path, "none" for an empty scratch folder,
                or "worktree" for a fresh git worktree of the current workspace
  worktree      yes/no: run in a fresh git worktree of the workspace named by
                cwd (or the current one); with write: yes on a new branch,
                without it read-only in a detached snapshot
  worktree-ref  branch, remote-tracking ref, tag or commit to start from
                (default HEAD); needs worktree: yes or cwd: worktree
  prompt-file   absolute path sent as the prompt instead of the text; kept
  request-id    1-64 [A-Za-z0-9._-], the first a letter or digit: a repeat of
                the same task (same prompt, model, effort, write mode and
                workspace) attaches to or replays the run; the same ID with a
                different task is refused. With continue it makes that turn
                retry-safe.
  quota-floor   whole percent, such as 10%: before turn/start, read the
                quota (account/rateLimits/read, about 0.5-1 s) and refuse with
                CODEX_QUOTA_LOW, naming the reset time, when less remains, a
                limit is reached or ordinary usage is not allowed. Default
                ${QUOTA_FLOOR_ENV} or 0 (off); a follow-up keeps its run's.
  continue      run key: next turn on that run's thread (with effort, write,
                model, summary, review, output-schema, tier, compact, prompt-file,
                request-id, mcp, quota-floor, progress, commit-subject, commit-trailers only)
  cancel/close  run key: lifecycle actions; other directives are not allowed
Roles: ${Object.keys(ROLES).join(", ")} (model + default effort);
--model and --effort may replace --role.
Task files with continue: RUN_KEY need no role: model/effort inherit the run.
An explicit --role on such a file selects its model, preserving stored effort;
an explicit model directive/option takes precedence over the role.

Options:
  --write                  Allow workspace writes (default: read-only).
  --keep-state             Keep the run after its result so --continue can add
                           turns to the same Codex thread; finish it with --close.
                           --continue implies this.
  --default-keep           With --task-file: keep a launched run unless the file
                           says "keep: no" (what the agents pass, so SendMessage
                           can continue the thread). Kept runs sleep between
                           turns: their Codex processes stop after each result.
  --keep-prompt            Keep the prompt or task file after a confirmed launch.
  --cwd DIR                Workspace for a new job (default: current directory).
                           On Windows use an absolute drive or UNC path.
  --scratch-workspace      Run a new job in an empty folder inside its run state
                           (removed with the run) instead of a workspace. The
                           state root must not lie inside a git repository.
  --worktree               Run a new job in a git worktree of the workspace from
                           --worktree-ref (default HEAD). With --write it works
                           on branch codex-subagents-for-claude-code/<run key> and its changes are
                           committed there when the result is delivered; the
                           branch stays. Without --write it reads a detached
                           snapshot of that commit. The folder is removed with
                           the run.
  --worktree-ref REF       Starting branch, remote-tracking ref, tag or commit
                           for --worktree. Must already resolve locally; no fetch.
                           Uncommitted changes are not copied.
  --quota-floor PERCENT    The quota-floor directive's check, for launches and
                           --continue. Refused with --task-file.
  --request-id ID          Dedupe key, claimed before the launch (see above).
                           Refused with --task-file; put request-id: in the file.
  --quiet                  Print no informational diagnostics on stderr, only
                           warnings and errors. Recorded in the run; attach,
                           continue and cancel inherit it unless given again.
  --relay                  Exit 0 for every delivered result, failed and
                           cancelled ones too; the footer's status= tells them
                           apart. Recorded in the run like --quiet.
  --max-stdout-lines N     Show at most N lines of the result on stdout
                           (0 = all, default; at most ${MAX_STDOUT_LINES}). The durable
                           copy stays complete and a "codex-subagents-for-claude-code-omitted:"
                           line names it. Recorded in the run like --quiet.
  --max-stdout-bytes N     Cap everything a delivered result prints on stdout,
                           omission line and footer included, at N bytes
                           (0 = all, default; at most ${MAX_STDOUT_BYTES}), cutting the
                           text at a line end where possible. The footer and
                           the omission line are never cut: when they alone
                           exceed N, no text is shown. Nothing is cut when the
                           durable copy could not be written (result=-).
  --wait-ms N              Foreground wait budget, 0..${MAX_WAIT_MS} (default: ${DEFAULT_WAIT_MS}).
                           0 checks once; it does not cancel the job.
  --wait                   No wait budget: wait until the job ends. For Bash
                           run_in_background calls, which have no time limit.
                           Not recorded; each waiter chooses its own budget.
  --detach                 Launch (or --continue) without waiting: print one
                           "codex-subagents-for-claude-code-launched:" receipt line and exit 0.
                           Collect the result later with --run RUN_KEY.
  --force                  With --close: close even when the job's activity is
                           unknown, its finished result was never delivered, or
                           the job still runs (its worker is then stopped first,
                           as the process the runner identified).
  --command-timeout-ms N   Helper timeout, 1..${MAX_COMMAND_TIMEOUT_MS} (default: ${DEFAULT_COMMAND_MS}).
  --help                   Show this help without requiring an installed CLI.

Modes:
  --inspect RUN_KEY [--json]  Shows retained metadata, milestones, locks, driver,
              worktree, recovery commands and audit files without changing them
              or spawning helpers. --probe adds PID and driver endpoint checks.
  --continue  Sends FILE as the next turn of the run's Codex thread (same model
              and effort unless overridden; read-only unless --write) and waits
              for it like a new job. The run must have a delivered result.
  --cancel    Interrupts the run's job even while another process waits on the
              run, then delivers its terminal record (or reports which waiter
              will).
  --close     Tears down a kept or retained run whose job is not active, and
              releases its workspace writer lock and request claim. It refuses
              when it cannot tell whether the job still runs, and when a
              finished job's result was never delivered (collect it with
              --run first); --force closes anyway and stops a running job identity-bound.
  --sleep     Stops a delivered run's lingering driver and app-server, retaining
              its thread. Unknown identity retains state and kills nothing.
  --list      Lists retained runs, newest first, without touching them; --mine
              only this Claude session's (CLAUDE_CODE_SESSION_ID), --active only
              those without a delivered result.
  --close-idle  Closes this session's delivered runs (kept or retained) that
              are not continuing and have no live waiter, delivered at least
              --older-than AGE ago (Ns, Nm, Nh or Nd; default 0). --all-sessions
              widens it to every session and then needs --older-than. --dry-run
              lists what it would close.
  --collect-finished  Delivers runs whose Codex job ended while nobody waited
              (exit 3, a --detach, a killed waiter), as --run would: writes the
              durable copy, then a kept run sleeps and any other run is removed.
              It prints one line per run, never the result text. A later
              --attach JOB --run KEY replays the copy. Same --older-than (time
              the job ended, or for a result fetched but never delivered the
              time it was cached), --all-sessions and --dry-run as --close-idle;
              a run whose job was never identified is skipped, not guessed at.
  --sleep-idle  Stops delivered lingering drivers that authenticate, as --sleep
              does. Same --older-than (time of delivery), --all-sessions and --dry-run.
              All three sweeps skip continuing runs and runs with a live waiter,
              print one line per run (closed/collected/slept, would-close/...,
              skipped with reason=, or failed with error=) and a count line such
              as "sleep-idle: slept=1 would-sleep=0 skipped=0 failed=0", and exit
              1 if any run failed.
              "This session" is CLAUDE_CODE_SESSION_ID, which a Claude Code
              session shares with all of its subagents: --mine and the three
              sweeps cover the main thread's and every subagent's runs. A
              subagent should close its own runs by key (--close RUN_KEY),
              not with a session-wide sweep.
  --doctor    Checks Node, Codex version, app-server, login, quota, the model list
              against each role (model, efforts, upgrade), git, the state and
              results folders and the agent definitions without submitting
              anything. A listed model can still be refused for the account.
              --read-only skips directory creation and write probes.
  --limits    Prints the Codex quota on one "codex-subagents-for-claude-code-limits:"
              line (--json: one JSON object), without a thread or a model
              call: one probe app-server answers account/read and
              account/rateLimits/read (about 1-2 s and one backend call), and
              the answer refreshes the cache <state>/quota.json, which every
              delivered turn also updates. --cached prints the cache and starts
              nothing; --max-age MIN uses a cache younger than MIN minutes
              (0..${MAX_CACHE_AGE_MINUTES}). A logout is login=out with exit 0.
  --prepare   Makes sure this release's runtime snapshot exists, an immutable
              copy of the entry, its modules and the legal files under
              <state>/runtime/<version>-<digest>/ (made once, never
              overwritten), and prints two lines: "runner: <path>", that copy's
              entry, and "task-file: <path>", an unused task file name for ROLE
              in the temporary folder. The plugin's forwarders and skill run
              every turn through that runner, so a plugin update never changes
              the files under a running job. Starts no process.

Stdout shapes, by exit code: a delivered result is the text, an optional
"codex-subagents-for-claude-code-omitted:" line, then one anchored footer line starting
"codex-subagents-for-claude-code: status=" (the LAST such line is the footer; the text may contain
anything) and "codex-subagents-for-claude-code-touched:" lines; exit 0 or 2. The footer's
tokens=<input>/<cached>/<output>/<reasoning> is Codex's own count for the turn
and limit=<used>%/<window> the plan's latest rate limit, both read from protocol events, "-" when unknown.
After them one "codex-subagents-for-claude-code-quota: used= remaining= resets= credits= context="
line gives the same snapshot's remaining percent, reset time (UTC) and credit balance.
A replay prefixes one
"codex-subagents-for-claude-code-replay:" line (exit 0 or 2). "STILL RUNNING: ..." plus one
"codex-subagents-for-claude-code-progress:" line is the WHOLE stdout with exit 3; a relay acts on it
only with exit 3. "CANCEL REQUESTED: ..." is the whole stdout with exit 0. With
--detach, one "codex-subagents-for-claude-code-launched: run=... attach=<command>" line is the whole
stdout with exit 0 (existing=yes when a repeated request ID names a retained run).
Write jobs hold a per-repository writer lock until their result is delivered or
the run is closed; a second write job on the same repository is refused.

Effort: none, minimal, low, medium, high, xhigh, max, ultra (passed literally; model
support is required). ultra, above max, is never a default.
Before any thread, a turn checks its model and effort against model/list (cached in
<state>/models.json per CLI build and day): CODEX_MODEL_UNLISTED or
CODEX_EFFORT_UNSUPPORTED refuse what the list proves unsupported, and a retirement
date is warned. The list cannot prove account access; a failed list refuses nothing.
Exit codes: 0 completed (with --relay: any delivered result; also a --detach
receipt); 1 runner error; 2 failed/cancelled; 3 still running.
SIGINT/SIGTERM stop the waiter with exit 130/143 and preserve the detached job.
--run alone recovers a launch whose job ID was not returned. Never relaunch an
uncertain task: use its run key. Attach uses the original workspace and pinned CLI build.

Environment overrides (absolute paths; on Windows, and for CODEX_HOME there, a
drive or UNC path such as D:\\codex-subagents-for-claude-code\\state, not a Git Bash /c/... path):
  CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR
    Private runs root (default: ~/.claude/codex-subagents-for-claude-code-state).
    One root is used per invocation.
  CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR
    Durable result copies (default: ~/.claude/codex-subagents-for-claude-code-data/results).
  CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR
    Explicit agent definitions checked by --doctor, ahead of plugin discovery.
    Otherwise checks a selected plugin or its snapshot inventory, then ~/.claude/agents.
    Dual-use sources report bundled plugin candidates separately from checkout forwarders.
    Empty non-plugin installations are optional for direct CLI use. Claude loading is unverified.
  CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_DIR
    Directory containing the explicitly selected CLI; otherwise PATH order.
  CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH
    Absolute executable path, ahead of directory/PATH discovery.
Tested with codex-cli 0.166.0. Other version labels are allowed; required
capabilities and protocol checks still apply. Retained runs keep the exact
native executable/build. Unresolved launchers require an explicit native path.
Runs record CLAUDE_CODE_SESSION_ID and CLAUDE_CODE_HOST_SESSION_ID when set.
`;

// Both command-line launches and task-file launches use this precedence.
export function applyRoleDefaults(options) {
  if (options.role) {
    options.model ??= ROLES[options.role].model;
    options.effort ??= ROLES[options.role].effort;
  }
  return options;
}

export function parseArgs(argv) {
  const options = {
    write: false,
    "keep-prompt": false,
    "keep-state": false,
    "scratch-workspace": false,
    worktree: false,
    list: false,
    doctor: false,
    help: false,
    "wait-ms": DEFAULT_WAIT_MS,
    "command-timeout-ms": DEFAULT_COMMAND_MS,
  };
  const values = new Set(VALUE_OPTIONS),
    flags = new Set(FLAG_OPTIONS);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].startsWith("--") ? argv[i].slice(2) : "";
    if (!values.has(key) && !flags.has(key))
      throw new Error(`unknown argument ${argv[i]} (runner ${RUNNER_VERSION}; see --help)`);
    if (seen.has(key)) throw new Error(`duplicate argument --${key}`);
    seen.add(key);
    if (flags.has(key)) options[key] = true;
    else {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith("--") || /[\x00-\x1f\x7f]/.test(value)) {
        throw new Error(`--${key} needs a nonempty value without control characters`);
      }
      options[key] = value;
    }
  }
  if (IS_WINDOWS && options.cwd !== undefined && !isAbsolutePath(options.cwd))
    absoluteOverride({ "--cwd": options.cwd }, "--cwd");
  // Native Windows paths must not resolve a Git Bash /c/... path against
  // whichever drive happened to launch Node. Ordinary relative file options
  // remain relative, but rooted and drive-relative spellings are refused.
  for (const key of [
    "cwd",
    "task-file",
    "prompt-file",
    "output-schema",
    "commit-trailers",
    "target",
    "recipe",
    "batch",
  ]) {
    const value = options[key];
    if (
      IS_WINDOWS &&
      typeof value === "string" &&
      /^[\\/]|^[A-Za-z]:/.test(value) &&
      !isAbsolutePath(value)
    )
      absoluteOverride({ [key]: value }, `${key}`);
  }
  for (const [alone, allowed] of Object.entries(STANDALONE)) {
    if (!options[alone]) continue;
    const extra = [...seen].filter((key) => key !== alone && !allowed.includes(key));
    if (extra.length) {
      if (alone === "doctor" && !options["read-only"]) throw new Error("use --doctor by itself");
      throw new Error(
        allowed.length
          ? `--${alone} takes only ${allowed.map((key) => `--${key}`).join(", ")}`
          : `use --${alone} by itself`,
      );
    }
    options.mode = alone;
    if (["verify-artifact", "verification"].includes(alone)) {
      if (!RUN_KEY.test(options[alone]) || !validRequestId(options.attempt))
        throw new Error("verification needs a full run key and --attempt ID");
      if (
        alone === "verify-artifact" &&
        (!options.recipe || options["execution-profile"] !== "trusted-local")
      )
        throw new Error(
          "verification executes caller-owned local code; supply --recipe FILE --execution-profile trusted-local",
        );
      options.key = options[alone];
    }
    if (["batch", "batch-run", "batch-cancel"].includes(alone)) {
      if (alone !== "batch" && !validRequestId(options[alone]))
        throw new Error("invalid batch identity");
      options.key = options[alone];
      if (!/^\d+$/.test(String(options["wait-ms"])) || Number(options["wait-ms"]) > MAX_WAIT_MS)
        throw new Error("batch wait-ms is outside the supported bound");
      options["wait-ms"] = Number(options["wait-ms"]);
    }
    if (["artifact", "finalize", "integrate", "discard"].includes(alone)) {
      if (!RUN_KEY.test(options[alone])) throw new Error("--" + alone + " needs a full run key");
      options.key = options[alone];
      if (alone === "integrate" && !options.target)
        throw new Error("--integrate needs --target CHECKOUT");
    }
    if (alone === "fork") {
      if (!validRunHandle(options.fork)) throw new Error("--fork needs a retained run key");
      options.key = options.fork;
      if (options.at !== undefined) {
        if (!/^[1-9]\d*$/.test(options.at) || Number(options.at) > TRANSCRIPT_MAX_TURNS)
          throw new Error("--at needs a positive persisted turn number");
        options.at = Number(options.at);
      }
      if (options["request-id"] !== undefined && !validRequestId(options["request-id"]))
        throw new Error("invalid fork request ID");
    }
    if (alone === "revert") {
      if (
        !validRunHandle(options.revert) ||
        !/^[1-9]\d*$/.test(options["before-turn"] ?? "") ||
        Number(options["before-turn"]) > TRANSCRIPT_MAX_TURNS
      )
        throw new Error("--revert needs a retained run key and --before-turn N");
      options.key = options.revert;
      options["before-turn"] = Number(options["before-turn"]);
    }
    if (alone === "bundle") {
      if (!validRunHandle(options.bundle)) throw new Error("--bundle needs a retained run key");
      options.key = options.bundle;
    }
    if (alone === "list" && options.codex && (options.mine || options.active))
      throw new Error("--list --codex cannot combine --mine or --active");
    if (alone === "transcript") {
      if (!validRunHandle(options.transcript))
        throw new Error("--transcript needs a retained run key");
      options.key = options.transcript;
      if (options.turn !== undefined) {
        if (!/^[1-9]\d*$/.test(options.turn) || Number(options.turn) > TRANSCRIPT_MAX_TURNS)
          throw new Error(`--turn must be an integer from 1 to ${TRANSCRIPT_MAX_TURNS}`);
        options.turn = Number(options.turn);
      }
    }
    if (alone === "steer") {
      if (!validRunHandle(options.steer) || !options["prompt-file"])
        throw new Error("--steer needs a run key and --prompt-file FILE");
      options.key = options.steer;
    }
    if (alone === "inspect" && !RUN_KEY.test(options.inspect))
      throw new Error("--inspect needs a 32-character hexadecimal run key");
    if (alone === "prepare" && !Object.hasOwn(ROLES, options.prepare))
      throw new Error(
        `unknown role ${options.prepare}; known roles: ${Object.keys(ROLES).join(", ")}`,
      );
    if (alone === "limits") {
      if (options.cached && options["max-age"] !== undefined)
        throw new Error("use --cached or --max-age, not both");
      if (
        options["max-age"] !== undefined &&
        (!/^\d+$/.test(options["max-age"]) || Number(options["max-age"]) > MAX_CACHE_AGE_MINUTES)
      )
        throw new Error(`--max-age must be an integer from 0 to ${MAX_CACHE_AGE_MINUTES}`);
      if (options["max-age"] !== undefined) options["max-age"] = Number(options["max-age"]);
    }
    if (SWEEPS.includes(alone)) {
      if (options["all-sessions"] && options["older-than"] === undefined)
        throw new Error(`--${alone} --all-sessions needs --older-than AGE`);
      options.olderThanMs = parseDuration(options["older-than"] ?? "0");
    }
    return options;
  }
  const strays = ["mine", "active", "older-than", "all-sessions", "dry-run"].filter((key) =>
    seen.has(key),
  );
  if (strays.length)
    throw new Error(
      `--${strays[0]} belongs to --list, --close-idle, --collect-finished or --sleep-idle`,
    );
  for (const key of ["cached", "max-age"])
    if (seen.has(key)) throw new Error(`--${key} works with --limits only`);
  if (seen.has("codex")) throw new Error("--codex works with --list only");
  if (seen.has("json"))
    throw new Error("--json works with --inspect, --limits or --transcript only");
  if (seen.has(TRANSCRIPT_TURN_OPTION)) throw new Error("--turn works with --transcript only");
  if (seen.has("probe")) throw new Error("--probe works with --inspect only");
  if (seen.has("target")) throw new Error("--target works with --integrate only");
  for (const key of ["recipe", "attempt", "execution-profile"])
    if (seen.has(key)) throw new Error("--" + key + " belongs to artifact verification");
  if (seen.has("verbose")) throw new Error("--verbose works with --doctor only");
  if (seen.has("at")) throw new Error("--at works with --fork only");
  if (seen.has("before-turn")) throw new Error("--before-turn works with --revert only");
  if (seen.has("read-only")) throw new Error("--read-only works with --doctor only");
  if (options["default-keep"] && options["task-file"] === undefined)
    throw new Error("--default-keep works with --task-file only");
  if (options.force && !seen.has("close")) throw new Error("--force works with --close only");
  for (const [key, min, max] of [
    ["wait-ms", 0, MAX_WAIT_MS],
    ["command-timeout-ms", 1, MAX_COMMAND_TIMEOUT_MS],
    ["max-stdout-lines", 0, MAX_STDOUT_LINES],
    ["max-stdout-bytes", 0, MAX_STDOUT_BYTES],
  ]) {
    if (options[key] === undefined) continue;
    if (
      !/^\d+$/.test(String(options[key])) ||
      Number(options[key]) < min ||
      Number(options[key]) > max
    ) {
      throw new Error(`--${key} must be an integer from ${min} to ${max}`);
    }
    options[key] = Number(options[key]);
  }
  // --wait is for callers without a time limit (a background Bash call): the
  // waiter returns only when the job ends, never with exit 3.
  if (options.wait) {
    if (seen.has("wait-ms")) throw new Error("use --wait or --wait-ms, not both");
    options["wait-ms"] = Infinity;
  }
  if (options.detach && (options.wait || seen.has("wait-ms")))
    throw new Error("--detach does not wait; drop --wait and --wait-ms");
  if (options.model !== undefined && !MODEL.test(options.model))
    throw new Error("invalid model identifier");
  if (options["commit-subject"] !== undefined && !validCommitSubject(options["commit-subject"]))
    throw new Error("--commit-subject needs a single-line subject of 1-200 characters");
  if (options.effort !== undefined && !validEffort(options.effort))
    throw new Error(`unsupported effort ${options.effort}; see --help`);
  if (options.summary !== undefined && !validSummary(options.summary))
    throw new Error(`unsupported summary ${options.summary}; use auto, concise, detailed or none`);
  if (options.tier !== undefined && !SERVICE_TIER.test(options.tier))
    throw new Error("tier needs a lowercase service tier ID or default");
  if (options.tier !== undefined && options.review)
    throw new Error("tier is not supported with native review");
  if (options.review !== undefined && !validReview(options.review))
    throw new Error("review needs uncommitted, base:<ref>, commit:<hex>, or custom");
  if (options.review && options.write) throw new Error("native review requires read-only mode");
  if (options["output-schema"] !== undefined && !isAbsolutePath(options["output-schema"]))
    throw new Error("output-schema needs an absolute path");
  if (options.role !== undefined && !ROLES[options.role])
    throw new Error(`unknown role ${options.role}; known roles: ${Object.keys(ROLES).join(", ")}`);
  if (options["request-id"] !== undefined && !validRequestId(options["request-id"])) {
    throw new Error("invalid request ID (1-64 letters, digits, dots, underscores or dashes)");
  }
  if (options["quota-floor"] !== undefined) {
    const floor = parseQuotaFloor(options["quota-floor"]);
    if (floor === null)
      throw new Error("--quota-floor needs a whole percent from 0 to 100, such as 10%");
    options["quota-floor"] = floor;
  }
  if (options["scratch-workspace"] && options.cwd)
    throw new Error("--scratch-workspace and --cwd are exclusive");
  if (options["scratch-workspace"] && options.worktree)
    throw new Error("--scratch-workspace and --worktree are exclusive");
  if (options["worktree-ref"] !== undefined) {
    if (!validGitRef(options["worktree-ref"]))
      throw new Error("--worktree-ref needs a ref without whitespace or a leading dash");
    if (!options.worktree) throw new Error("--worktree-ref needs --worktree");
  }
  const selected = SELECTORS.filter((key) => seen.has(key));
  if (selected.length > 1)
    throw new Error("use only one of --run, --continue, --cancel, --close and --sleep");
  if (options.attach && !options.run) throw new Error("--attach needs --run RUN_KEY");
  if (options.diff && (!options.run || options.attach || options.wait || seen.has("wait-ms")))
    throw new Error("--diff needs --run alone and does not wait");
  if (options["task-file"] !== undefined) {
    const clash = [
      "commit-subject",
      "commit-trailers",
      "compact",
      "tier",
      "output-schema",
      "review",
      "prompt-file",
      "attach",
      "write",
      "keep-state",
      "cwd",
      "scratch-workspace",
      "worktree",
      "worktree-ref",
      "request-id",
      "quota-floor",
      ...SELECTORS,
    ].filter((key) => seen.has(key));
    if (clash.length)
      throw new Error(
        `--${clash[0]} cannot be used with --task-file; use a directive line in the file`,
      );
    // The header decides whether this launches or continues an existing run.
    // A continuation may inherit its stored model and effort without defaults.
    options.mode = "task";
    return options;
  }
  if (selected.length === 0) {
    if (options.compact) throw new Error("--compact requires --continue");
    applyRoleDefaults(options);
    if (
      !options.model ||
      !options.effort ||
      (!options["prompt-file"] && !structuredReview(options.review))
    ) {
      throw new Error(
        "give --model, --effort and --prompt-file (or --role and --prompt-file), --task-file, or one of --run, --continue, --cancel, --close, --sleep, --list, --inspect, --doctor, --close-idle, --collect-finished, --sleep-idle (see --help)",
      );
    }
    options.mode = "launch";
    return options;
  }
  const [selector] = selected;
  options.key = options[selector];
  if (!validRunHandle(options.key)) {
    throw new Error("invalid run key (expected 32 lowercase hex characters, or rq:<request id>)");
  }
  if (options.attach && !validJobId(options.attach)) throw new Error("invalid job ID");
  options.mode = selector === "run" ? "attach" : selector;
  if (options.detach && options.mode !== "continue")
    throw new Error(
      `--detach cannot be used with --${selector}; it is for launches and --continue`,
    );
  const forbidden = (
    options.mode === "continue"
      ? ["cwd", "scratch-workspace", "worktree", "worktree-ref", "role", "task-file"]
      : LAUNCH_OPTIONS
  ).filter((key) => seen.has(key));
  if (forbidden.length) throw new Error(`--${forbidden[0]} cannot be used with --${selector}`);
  if (options.mode === "continue" && !options["prompt-file"] && !structuredReview(options.review))
    throw new Error("--continue needs --prompt-file FILE");
  return options;
}

// "90m", "24h", "2d", "30s" or plain seconds, as milliseconds.
export function parseDuration(value) {
  const match = DURATION.exec(String(value));
  if (!match)
    throw new Error(`invalid age ${value}; use a number with s, m, h or d, such as 90m or 24h`);
  return Number(match[1]) * { s: SECOND_MS, m: MINUTE_MS, h: HOUR_MS, d: DAY_MS }[match[2] ?? "s"];
}

// The quota floor a turn gets without one of its own: the environment's
// default, else 0 (off).
export function defaultQuotaFloor(env) {
  if (env[QUOTA_FLOOR_ENV] === undefined || env[QUOTA_FLOOR_ENV] === "") return QUOTA_FLOOR_OFF;
  const floor = parseQuotaFloor(env[QUOTA_FLOOR_ENV]);
  if (floor === null)
    throw new Error(`${QUOTA_FLOOR_ENV} needs a whole percent from 0 to 100, such as 10%`);
  return floor;
}

// The default private runs root lies outside the temporary workspace sandbox.
const defaultStateDir = () =>
  path.join(os.homedir(), ".claude", "codex-subagents-for-claude-code-state");

// One configured root per invocation; each override must be absolute.
export function environmentPaths(env, onError) {
  const override = (name, fallback) => {
    try {
      return absoluteOverride(env, name) || fallback;
    } catch (error) {
      if (!onError) throw error;
      onError(error);
      return null;
    }
  };
  const stateBase = override("CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR", defaultStateDir());
  let resultsSource = "override";
  let resultsDir = override("CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR", null);
  if (env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR === undefined) {
    resultsSource = "data-default";
    resultsDir = path.join(
      os.homedir(),
      ".claude",
      "codex-subagents-for-claude-code-data",
      "results",
    );
  }
  return {
    stateBase,
    resultsDir,
    resultsSource,
    // Codex's own variable: on Windows a drive or UNC path, as for the overrides.
    codexHome: !env.CODEX_HOME
      ? path.join(os.homedir(), ".codex")
      : IS_WINDOWS
        ? override("CODEX_HOME", null)
        : path.resolve(env.CODEX_HOME),
  };
}
