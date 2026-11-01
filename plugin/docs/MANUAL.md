# Codex subagents for Claude Code: command and task-file reference

Start with [installation](https://github.com/PolaronQuasi/codex-subagents-for-claude-code/blob/main/README.md#installation) and a [worked example](EXAMPLES.md).
For setup failures, see [troubleshooting](OPERATIONS.md#troubleshooting); for version and platform
evidence, see [compatibility](COMPATIBILITY.md). This reference covers explicit task inputs and lifecycle operations.

## Ways in

Use named Claude forwarders, the installed skill, or `node run-codex-task.mjs` directly.
Node 22+, Git and a logged-in Codex CLI are required. Any Codex version may be selected;
0.166.0 is the tested reference, not a launch restriction. Executable safety, protocol checks and
retained executable identity still apply. Run `--help` for the complete option reference.

Two installations exist: the Claude Code plugin (`codex-subagents`, from this repository's marketplace) and a
checkout with `install.mjs`. The plugin's forwarders and skill name no machine path. They first run
`--prepare ROLE`, which makes sure the release's runtime snapshot exists under `<state>/runtime/<version>-<digest>/`
(the entry, every module and the legal files, read-only, made once and never overwritten) and prints
`runner: <path>` and `task-file: <path>`. The turn then runs from that runner, so its driver, its printed attach and
continue commands and its later turns never depend on Claude Code's replaceable plugin cache. Several releases'
snapshots coexist; the runner never deletes one. Remove an old snapshot by hand only after all runs
that reference it have been closed, including idle kept runs that could still continue.

The plugin's slash commands are skills only the user invokes, each one injected shell command that runs the runner
from the plugin folder and leaves nothing running: `/codex-subagents:codex-limits` (`--limits`),
`/codex-subagents:codex-list` (`--list --mine`) and `/codex-subagents:codex-doctor`
(`--doctor --read-only`). Each command's `allowed-tools` pre-approves exactly that command. A
nonzero exit appends one `echo` line instead of aborting the command, so the output is always shown. They send
nothing to a Codex model; Claude relays the output, which costs a short turn of Claude tokens.

Plugin forwarders use names such as `codex-subagents:gpt-6-1-sol`; checkout-installed forwarders use
`gpt-6-1-sol`. Runner `--role` values are always the unprefixed role names. For removing definitions
or changing installation type, see [switching or uninstalling](https://github.com/PolaronQuasi/codex-subagents-for-claude-code/blob/main/README.md#switching-or-uninstalling).

## Task files and directives

Start directives on line 1, one lowercase `name: value` per line. A blank line separates the verbatim task.
UTF-8 regular inputs are limited to 8 MiB. The runner rejects malformed or misplaced directives.

| Directive      | Meaning                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| effort         | none, minimal, low, medium, high, xhigh, max, ultra; default xhigh, never ultra                                              |
| model          | model ID or role name; overrides the role default and may change on continuation                                             |
| summary        | auto, concise, detailed or none; inherited on continuation when omitted                                                      |
| write          | yes/no; default read-only                                                                                                    |
| keep           | yes/no; retain conversation state                                                                                            |
| cwd            | absolute workspace, none for scratch, or worktree                                                                            |
| worktree       | yes/no; a new branch for writes, a detached snapshot for read-only                                                           |
| worktree-ref   | existing local branch, tag, commit or fetched remote ref; default HEAD                                                       |
| prompt-file    | absolute file to send instead of inline text; preserved                                                                      |
| request-id     | 1–64 safe identifier characters; deduplicate the same task                                                                   |
| mcp            | inherit (default) or off; per-turn config isolation described below                                                          |
| quota-floor    | whole percent such as 10%; refuse before `turn/start` when less quota remains                                                |
| progress       | on/off; default on, inherited on continuation; controls progress and diff files                                              |
| continue       | next turn of the named run; may accompany model, effort, summary, write, prompt-file, request-id, mcp, quota-floor, progress |
| cancel / close | lifecycle action by run key; no other directives                                                                             |

On Windows, absolute paths in `cwd:`, `prompt-file:`, `output-schema:` and
`commit-trailers:` require a drive (`C:/work/repo`) or UNC path (`\\server\share\repo`).
Git Bash `/c/...`, single-rooted `/tmp` or `\tmp`, and drive-relative `C:tmp` are refused.
`--cwd` also requires a native absolute path on Windows. The same check applies to rooted CLI
file paths; CLI file options that already
accept ordinary relative paths continue to resolve them against the caller's directory.

The caller's task file is consumed only after launch if it is unchanged; `--keep-prompt` preserves it.

`quota-floor:` (or `--quota-floor N` on a launch or `--continue`; default
`CODEX_SUBAGENTS_FOR_CLAUDE_CODE_QUOTA_FLOOR`, else 0, off) reads `account/rateLimits/read` after the
app-server starts and before any thread is started or resumed, about 0.5–1 s per launch. It refuses with
`CODEX_QUOTA_LOW` and the reset time when the binding window (the more used of the two) has less than the floor
left, when a limit is reached (`rateLimitReachedType`), or when the backend says `ordinaryUsageAllowed: false`;
a null flag or a failed read is unknown and the launch goes on. The task is never sent. A follow-up keeps its
run's floor unless it names its own. The percentages are whole numbers and lag the backend.
The private prompt snapshot remains in run state. Codex receives no surrounding Claude conversation.

## Modes

### Native review

Use `review: uncommitted`, `review: base:main`, or `review: commit:<7–40 hex characters>` in a
task header with no task body. Direct CLI equivalents accept `--review` with the same values,
without a prompt file. These call Codex's native `review/start` in the chosen workspace, always
read-only with approvals refused. `uncommitted` includes staged, unstaged and untracked files;
`base:` compares the current branch with the named base; `commit:` reviews that commit's changes.
A fresh read-only worktree is a clean snapshot, so use the original checkout to review its uncommitted changes.

`review: custom` sends the task body as custom review instructions (`--review custom --prompt-file FILE`
on the CLI). The API cannot combine custom instructions with a structured target: such combinations
are refused. Custom mode may differ from the tuned prompt used for structured reviews.
The selected model, effort and optional summary are applied through per-thread configuration;
the returned model, effort, sandbox and approval policy are checked before dispatch.

Review is per-turn. `continue:` may start a review on the retained thread; a later continuation
without `review:` starts an ordinary task. Request IDs distinguish targets. The normal output,
progress, cancellation and delivery rules apply. A lost review submission without a proven turn ID
is `SUBMISSION_UNCERTAIN`; it is never resent or guessed from the newest history entry.

### Transcripts

`--transcript KEY [--turn N] [--json]` reads a delivered, sleeping run's persisted Codex history
without a model turn. It briefly resumes the thread with a read-only sandbox, approvals refused,
and all MCP servers, plugins, apps, hooks, notify and OTEL disabled for that probe. A run lock prevents
concurrent close/continue. Active or uncertain drivers are refused; collect with `--run` and, if needed,
stop lingering processes with `--sleep` first.

Turns are numbered in Codex's persisted chronological order. Native review's internal turns may appear,
so these transcript numbers can differ from the runner footer's turn number. `--turn N` selects one
of those history entries. Commands include exit code, duration and bounded output; other items show
file paths, searches, tool names, final messages and reasoning summaries. User messages, raw reasoning,
MCP arguments/results and unknown payloads are omitted. Known prompt/steer echoes are redacted.
This explicit output can still contain sensitive task data; it is written only to stdout.

The reader caps history at 100 pages / 16 MiB and 30 seconds after resume, fields at 8 KiB, and output
at 1 MiB. `truncated=true` in JSON (or `truncated=yes` in text) means history or fields were omitted.
Unreadable saved inputs withhold text rather than exposing prompt echoes. A malformed or cyclic page
fails without printing a partial transcript. History may be less complete than live events; the runner
does not reconstruct missing commands or outputs. The turn's progress setting does not erase Codex history.

### Running and continuing tasks

`--role ROLE --task-file FILE` uses directives. `--model MODEL --effort EFFORT --prompt-file FILE` is direct launch.
`--keep-state` enables future turns; forwarders pass `--default-keep` so `keep: no` can opt out.
`--wait` removes the wait budget; `--wait-ms N` sets it. `--detach` returns a launch receipt immediately.
Exit 3 preserves the driver and prints an attach command. SIGINT/SIGTERM end only the waiter (130/143).

`--run KEY` or `--attach JOB --run KEY` obtains or replays the result.
`--continue KEY --prompt-file FILE` starts a fresh driver and resumes the same thread.
Use `--model MODEL`, `--effort EFFORT` and `--summary auto|concise|detailed|none` to change the next turn.
Task files accept `model:` (also a role name), `effort:` and `summary:`. Omitted values inherit the run.
`--task-file FILE` (or `--task-file -`) needs no `--role` when the header starts with `continue: KEY`.
An explicitly supplied `--role` selects that role's model for the continuation; it does not reset the
stored effort. An explicit `model:` or `--model` takes precedence over the role. Forwarders omit the
role on follow-ups so a prior model override is retained. An unknown continuation names its key and
suggests `--list --mine`; a new launch still needs a role or both model and effort.
An initial omitted summary leaves Codex's default unchanged. The summary level controls Codex reasoning
summaries, not the length of the final answer. It is recorded per turn and participates in request-ID
matching; a continuation that never starts restores the previous settings.
`--cancel KEY` persists intent and interrupts even while a waiter owns the run lock.
`--sleep KEY` retries shutdown of a lingering driver and retains state. Normally the runner confirms
owned processes and descendants have stopped before committing/capturing the workspace. If shutdown
cannot be confirmed because the descendant tree was not captured, `--run KEY` still delivers the saved
answer with `keep=yes` and a `codex-subagents-for-claude-code-shutdown: confirmed=no` line. It retains
state and writer/request claims, defers workspace finalization, and names `--close KEY --force` as
the explicit recovery command. A new continuation requires collection to finish finalizing a stopped turn.
`--close KEY` refuses active, uncertain and undelivered work. `--close KEY --force` first attempts an
identity-bound stop. For an unknown descendant tree only, it can then accept unconfirmed shutdown:
it never signals an unidentified/reused PID, and a known surviving process still blocks cleanup.
It prints a warning naming unconfirmed PIDs, saves a timestamped `results/audit/KEY/forced-close.json`
receipt, marks retained result footers and artifact/thread receipts, and removes run state/releases
claims. Evidence-write failures retain state. Repeating the forced close is harmless with the same
state/results roots. The marker records accepted uncertainty, never proof of shutdown. An unfinalized
worktree can be committed on explicit close to preserve its branch, but is not published as a sealed
artifact under the earlier answer. Existing finalized worktrees retain their snapshot checks.

## Live progress

While a turn runs, `--run KEY --wait-ms 0` shows its latest plan and up to five completed
commands, file changes, searches, MCP tool names or reasoning summaries, even when another waiter
owns the delivery lock. `--run KEY --diff` prints the latest patch immediately (exit 3 while active,
0 after a recorded terminal result); it neither delivers the result nor starts a model call.

The driver stores a rolling `jobs/J/progress.jsonl` of at most 64 KiB and replaces `jobs/J/diff.patch`
with at most 256 KiB. Rotation retains the latest plan while dropping older completed items.
Text fields are limited to 384 UTF-8 bytes, plans and item lists to 32 entries.
Truncation may leave a patch unsuitable for applying; this is a progress preview. User and agent
messages, command output, tool arguments and reasoning content are excluded. Exact prompt/steer echoes,
their JSON-escaped forms and complete nonempty input lines are redacted before truncation, including
earlier turns whose progress was off. Missing archived input withholds text. Matching has fixed memory
and work budgets; large inputs can therefore produce `[prompt withheld]` instead of a preview. Generated summaries and commands
can still contain sensitive task details. Add `progress: off` to a task header to disable both files
for that turn. Follow-ups inherit the choice and may override it. This does not remove earlier turns'
progress. Like the existing prompt files, these private state files may be readable by sandboxed
commands; progress is an observation aid, not an audit or transcript.

## Steering a running turn

Use `node run-codex-task.mjs --steer KEY --prompt-file FILE` to correct a running turn, including
one whose waiter still holds its delivery lock. The UTF-8 file is kept at its original path.
The command authenticates to that job's driver, writes `jobs/J/steer-N.txt` and identity metadata
in `steer-N.json`, then sends authenticated IPC `steer {n}`. The driver uses `turn/steer` with
`expectedTurnId` and `clientUserMessageId=J/steer-N`. No prompt text or secret crosses IPC.

Only an active matching turn accepts a steer. An ended, cancelled or changed turn refuses it;
Codex may also report it is not steerable, in which case interrupt and continue explicitly.
Each job accepts at most 32 reservations, each with at most 64 KiB of text. Unsent reservations
left by a caller crash are not dispatched automatically. An acknowledgement timeout means
**do not resend**: inspect the job's `driver.json` or collect with `--run KEY` to reconcile a
dead driver's history by client ID. A matching observed user message can settle acceptance even if
the RPC acknowledgement was lost; unresolved dispatches stay uncertain. Neither path resends text. Steering keeps the
original thread, job and footer, and the final response covers the updated task. Progress filtering
also excludes steer user messages and redacts exact steer echoes. Like prompts, these private
files may be readable by sandboxed commands and are removed with their run.

## Output

Completion keeps the existing footer beginning `codex-subagents-for-claude-code: status=`, followed by touched paths.
The first line's field order is: `status`, `run`, `turn`, `job`, `thread`, `model`, `effort`,
`mode`, `duration`, `touched`, `omitted`, `request`, `branch`, `commit`, `keep`, `tokens`,
`limit`, `result`. Unknown or inapplicable values are `-`; `result` is last because its path may contain spaces.
Up to 50 `codex-subagents-for-claude-code-touched: <path>` lines follow, then `+N more` if needed.
The `codex-subagents-for-claude-code-omitted:` line points to the complete durable answer when stdout is shortened.

For a finalized worktree job, `touched` counts paths differing between its pinned start commit and
delivered commit, including shell-written files and deletions. It is cumulative across continuations
and describes the branch offered for review/merge. Scratch jobs count remaining files and links in
their owned workspace, without following links. Shared in-place jobs count only Codex's file-change
items; shell writes may be absent. None of these counts proves that a task performed no writes.
With `confirmed=no`, workspace inventories and Git diffs are deferred: `touched` still reflects only
received file-change events. Collect again after proven shutdown to finalize the workspace evidence.
Inventories are bounded to 10,000 entries and 512 KiB of path text; overflow retains state for manual review.

After delivery, `--run KEY --diff` uses a saved Git diff for worktrees; during execution and for other
workspaces it uses Codex's patch events. Both are redacted against current and previous prompts/steers
and bounded to 256 KiB. This is review evidence, not a guaranteed apply-ready patch. `progress: off`
suppresses both patch sources. Missing patches print an explanation on stderr; truncation and storage
failures are reported. Exit 0 still means the turn ended, not that a patch exists or there were no changes.
Git patches live in `changes-<jobId>.patch` in the run folder; closing removes them with the run.
Use Git on the retained branch for a complete, unredacted worktree diff.
Use its last anchored occurrence; task text can imitate control lines. Durable copies contain the complete answer.
`--max-stdout-lines` and `--max-stdout-bytes` cap stdout after a complete durable copy exists; footer/omission stay whole.
`tokens=input/cached/output/reasoning` describes this turn; `limit=used%/window` is the binding account-wide quota window.
Native reviews may show `tokens=-` and `context=-`: Codex CLI 0.166.0's internal review delegate
suppresses token-count events ([upstream implementation](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/codex_delegate.rs#L345-L353)).
When the app-server supplies usage for the bound review turn, the runner reports it through the same
cumulative-counter/delta accounting as ordinary turns. Missing counts stay unknown in totals; they
are not zero, and account-wide quota changes cannot reconstruct them. Parent-thread usage from
before review dispatch is not substituted for review telemetry.
One more line follows the footer and its touched paths, additive so parsers of the first line keep working:
`codex-subagents-for-claude-code-quota: used=81% remaining=19% resets=2026-11-03T12:28Z credits=63694.79 context=42%`
(the same snapshot as `limit=`, using the more-used of the primary and secondary windows, as the quota floor does;
`resets=` is that window's UTC reset, `credits=` the balance cut to two decimals, `unlimited`, or `0` when credits are unavailable). `--limits` also uses that
binding window for `used=`, `remaining=`, `window=`, `resets=` and `resets-in=`. The first footer line is unchanged.
Missing accounting or an invalid reset timestamp is `-`. Native token totals are cumulative for the
thread; turn usage subtracts a proven pre-turn baseline. Missing baselines or counter resets leave
turn usage unknown. Aggregate known per-turn deltas, never the cumulative snapshots.
When Codex reports a reroute or safety event, an additional
`codex-subagents-for-claude-code-model:` line shows `rerouted=`, `reason=`, `buffered=`, current
`buffering=`, warning codes and whether earlier reroutes were truncated. The first footer's `model=`
remains the requested model. The run keeps up to 16 reroutes (model IDs up to 128 characters), the
latest buffering state and whether buffering was ever observed, and the `guardian-warning` /
`strict-review-required` codes. Free-text warning messages, buffering reasons and use cases are excluded.
These facts survive durable replay and driver recovery when checkpointed; missing observations are unknown.
They grant no permission, and each continuation starts with fresh observations.
Model and effort pre-checks use the [model catalogue cache](#caches-and-retained-state).
A listed model can still be unavailable to the account; use [compatibility](COMPATIBILITY.md#model-and-effort-selection)
to distinguish catalogue observations from access.
`context=` is the context window's fill after the turn: the last response's total tokens (its input holds the
thread) over the model's window, from `thread/tokenUsage/updated`. A kept run at 70% gets a note on stderr, at
85% a warning that `--quiet` does not hide: a follow-up may compact or fail. `--list` shows it as `context=`.
Codex's own failure names (`codexErrorInfo`) become codes with a clear message and Codex's text:
`usageLimitExceeded` and `rateLimitExceeded` are `CODEX_USAGE_LIMIT` (with the reset time),
`contextWindowExceeded` and `sessionBudgetExceeded` `CODEX_CONTEXT_FULL`, `modelNotFound`
`CODEX_MODEL_UNAVAILABLE`, `unauthorized` `CODEX_AUTH_REQUIRED`; other names stay `CODEX_RPC_ERROR`.
A partial answer from a failed turn is delivered together with that named error, in stdout and the durable copy.
Exit codes: 0 completed, 1 runner error, 2 failed/cancelled, 3 still running. `--relay` maps delivered results to 0.
An interactive delivery may still print after a durable-copy failure, retaining its cached state; collection requires the copy.

## Request IDs

Launch IDs cover the complete prompt digest, model, effort, write policy, workspace/ref, MCP policy
and effective progress policy. A retry cannot change progress from on to off or vice versa.
Repeating the same ID joins or replays existing work; changing its task is refused. Follow-up IDs deduplicate that turn.
An initial request can later attach to the run's current turn, so retain exact historical result paths too.
`rq:ID` names the retained run holding that claim, or replays its durable copy after cleanup.
A launch refuses a claim with an unsupported digest. A saved copy with an unsupported digest cannot
be replayed by request ID. Inspect the saved claim and result files before retrying; do not change
the request ID just to bypass the refusal, since that would create new work.

## Workspaces and locks

Writers in a normal checkout coordinate by repository identity in the configured state root.
Worktree jobs use their own branch/snapshot; scratch jobs use an empty folder under state.
Delivery snapshots worktree changes and closes remove the checkout, retaining write branches.
A checkout whose `.git` link is gone (an earlier removal that failed part-way, or a job that
deleted it) cannot be committed: `--close KEY` refuses it and `--close KEY --force` removes it.
Keep the state root outside any Git repository for scratch jobs. Unknown ownership/status keeps exclusion in place.

## List, inspection, doctor and sweeps

`--list [--mine] [--active]` shows retained state, delivery, lock and `driver=` fields without launching processes.
`--inspect KEY [--json]` observes metadata, driver/job evidence, locks and audit paths. `--probe` explicitly adds liveness and authenticated IPC checks.
`--doctor [--read-only]` reports `codex=`, `codex-path=`, `codex-app-server=`, `codex-supported=`
and `codex-login=`. `codex-tested-version=` names the tested reference; `codex-version-tested=`
compares the selected version with it. That comparison is informational: `codex-version-tested=no`
alone is not a launch refusal. Diagnose protocol, executable or login failures separately.
Login uses `account/read`, with no model call; doctor cannot prove model access.
`installation-mode=`, `agent-namespace=`, `agents-dir=`, `agents-evidence=`,
`agents-available=` and `agents-required=` explain the forwarder checks. Plugin installs use their
bundled namespaced agents; immutable snapshots report the inventory captured at preparation, rather
than claiming to inspect current plugin files. A source tree usable as either a checkout or plugin
is reported as ambiguous unless the selected plugin root identifies it; checkout forwarders and
bundled definitions are reported separately. `claude-agents-loaded=unverified` always distinguishes
file discovery from Claude registration. Missing forwarders are optional for direct terminal use
when none are installed (`agents-required=no`); a partial installation or missing required plugin
definition is a problem. `results-source=override|data-default` explains the effective
results directory; existing results are never moved automatically.
`codex-models=` counts `model/list` (hidden models included), and one `model-<role>=` row per role says
`listed=`, `hidden=`, `efforts=`, `default=`, the role's `effort=` (`(unsupported)` when not offered), `upgrade=`
and `retires=`. An unlisted role model or an unsupported effort is a problem. The list is the CLI's catalogue,
not the account's entitlement: it succeeds logged out, and a backend has refused models it listed.
`codex-quota=81%/7d resets=…` follows the login (one `account/rateLimits/read`, about a second more);
it also refreshes the quota cache, except with `--read-only`.

`--limits [--json] [--cached | --max-age MIN]` prints the Codex quota on one line, with no thread and no model call:

```text
codex-subagents-for-claude-code-limits: login=in plan=prolite limit=codex used=81% remaining=19% window=7d resets=2026-11-03T12:28Z resets-in=2d11h secondary=- credits=63694.79 reset-credits=0 reached=- ordinary-usage=yes other-limits=- source=fresh age=0s
```

A fresh answer (the default) starts one probe app-server, with plugins, apps, hooks, notify and OTEL exporters off
and no MCP discovery, and asks `account/read` and `account/rateLimits/read`: about 1–2 s and one backend call.
Both windows print when the plan has two (`secondary=used%/window@reset`), and other buckets as `other-limits=`.
`ordinary-usage=` is the backend's own permission flag; `-` means it did not say. `--json` prints one object
(`login`, `source`, `ageSeconds`, `quota`). The account's email and ID are never printed or cached.
Fresh reads and delivered turns attempt to update the guarded state root cache `quota.json`; `--cached` prints it with its
`age=` and starts nothing (`source=none` when there is none), and `--max-age MIN` uses it when younger than MIN
minutes. A cached quota does not prove current login (`login=-`, JSON `login:null`). A fresh observed
logout writes only a timestamped invalidation marker (`login=out`, no quota), preventing an older
delivery from restoring that snapshot. Read-only doctor never changes the cache. Sparse quota updates
preserve absent fields and clear explicit nulls; status-only denials replace stale allowed status.
Malformed cache shapes read as unknown. Exit 0, also for a logout; exit 1 when the CLI is missing or the read fails.

`--collect-finished` durably delivers ended jobs without printing their result text.
`--close-idle` closes delivered runs; `--sleep-idle` stops delivered lingering drivers that authenticate.
All take `--older-than AGE`, `--dry-run` and `--all-sessions` (which requires an age).
CLAUDE_CODE_SESSION_ID is shared with the main thread's subagents, so session sweeps include all of them.
A subagent should close its own runs by key, `--close KEY`.

## Codex thread history

Each new turn names its thread `csfcc <run key> <role>` (the model ID when no role matches).
A kept run stays unarchived. Actual cleanup, including automatic cleanup after delivery and explicit
close, attempts reversible `thread/archive` after owned processes have stopped. It never deletes
Codex history. Naming or archive errors warn without resending work; a failed archive does not block
local cleanup. Failure to stop a probe safely still retains state.

`--list --codex` lists named, unarchived app-server threads whose run is absent from this state root
and its quarantine. It starts a short probe, makes no model call, and prints IDs and ownership only.
It cannot combine `--mine` or `--active`. Pagination is bounded to 100 pages, 16 MiB and 30 seconds;
an incomplete listing refuses all archive attempts.

`--archive-orphans --dry-run` previews the same candidates. `--archive-orphans` rechecks each thread's
identity and idle status under a run lock, then archives only candidates with a valid ownership receipt
for this state root. Receipts live in `<results>/thread-owners`, survive run cleanup, contain no prompt
or workspace path, and are at most 8 KiB each. Retained or quarantined runs, locks, active/unknown
threads, and candidates without matching receipts are skipped. Archives are reversible in Codex;
this command never uses `thread/delete`. A name alone is not authority to archive another root's work.
Keep the results directory with its receipts when removing old run state. Missing receipts or failed
thread naming require explicit archival through Codex history. This command covers all proven orphans
in the configured state root, not just the current Claude session; inspect the dry run first.

## Caches and retained state

These stores serve different purposes. Local metadata reuse and provider-reported cached input tokens
do not establish lower cost, lower latency, a cache-hit rate or an advantage over another integration.

| Store                                          | Contents and reuse                                                                                                                                                    | Limits                                                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model catalogue, `<state>/models.json`         | A complete `model/list` observation for the selected CLI build and UTC day.                                                                                           | The key does not include account identity; a catalogue is not account entitlement. A missing, malformed, stale or different-build entry is a cache miss. |
| Quota, `<state>/quota.json`                    | The latest accepted observation from a fresh read, doctor or delivered turn. `--limits --cached` starts nothing; `--max-age MIN` permits a sufficiently recent entry. | A cached quota does not prove current login or reserve capacity. Inspect its age and source; unknown values remain unknown.                              |
| Run result and durable answer                  | The complete answer is retained before delivery. Attach can collect or replay the existing result.                                                                    | This is recovery/replay of that job, not a cache that answers a different prompt. Request IDs have their own [retention limits](#request-ids).           |
| Runtime, `<state>/runtime/<version>-<digest>/` | An immutable runner snapshot used across turns, outside Claude Code's replaceable plugin cache.                                                                       | Referenced snapshots must remain available for active and retained runs. No automatic expiry or removal is supplied.                                     |
| Native Codex thread                            | A kept conversation can resume on a fresh driver and app-server.                                                                                                      | Continuation submits a new turn. It does not guarantee provider prompt-cache reuse.                                                                      |

Before starting or resuming a thread, model/effort checks use the matching catalogue or a live list.
A cached refusal triggers a fresh lookup before refusing. A failed, malformed or incomplete live list
proves nothing, is not cached, and does not by itself block ordinary model/effort dispatch. An explicit
non-default service tier still requires fresh verification; failure to verify it prevents dispatch.
A valid list can refuse an unknown model with `CODEX_MODEL_UNLISTED` or an unoffered effort with
`CODEX_EFFORT_UNSUPPORTED`. Hidden entries are not refused by this pre-check.

This check runs inside an already-started runner job, not before job creation. The driver and
Codex app-server can start, but a catalogue refusal sends no thread or turn request and consumes
no model-inference quota. It leaves run state and failure output; collection writes the durable
result file even though the task was not sent. A `--detach` job remains listed until collected
with `--run KEY --wait` or `--collect-finished`. A kept run remains after collection until `--close KEY`.

Doctor publishes catalogues only while logged in and outside `--read-only`; delivery also attempts
publication. Model and quota writers serialize the observation-age check and atomic publication.
An older accepted observation cannot replace a newer one; contention may skip an update.
Read-only doctor performs live observations without updating these caches.

The 2026-10-31 catalogue observed with codex-cli 0.166.0 offered `ultra` for gpt-6.1-sol,
gpt-6.1-terra, gpt-6-astra, gpt-6-sol, gpt-5.6-sol and gpt-5.6-terra, but not the luna models.
It did not offer `none` or `minimal`. These are dated observations, not a fixed model-access list;
check `--doctor --read-only` for the current catalogue. `ultra` is always an explicit choice.
Use `low` for simple lookups and one-line mechanical edits; do not select `none` or `minimal`
unless the current catalogue explicitly offers it for that model. Accepted effort syntax is
not a guarantee that the selected model supports it.

The footer's `tokens=<input>/<cached>/<output>/<reasoning>` uses Codex-reported accounting.
The cached value describes input tokens reported as cached by the provider, not hits in the local
model, quota or result stores. Missing telemetry is `-`. Do not derive a dollar cost or compare
integration efficiency from that field alone.

## Configuration overrides

Absolute overrides: `CODEX_SUBAGENTS_FOR_CLAUDE_CODE_STATE_DIR`, `..._RESULTS_DIR`, `..._AGENTS_DIR`,
`..._CODEX_PATH` and `..._CODEX_DIR`. `CODEX_HOME` continues to select native Codex configuration/login.
Windows paths need a drive or UNC path; Git Bash /c/... forms are refused in overrides.
Any Codex version may be selected; 0.166.0 is the tested reference, not a version gate. No
`CODEX_SUBAGENTS_FOR_CLAUDE_CODE_ALLOW_CODEX` override is needed to select another version. Selection
still requires an identifiable eligible native executable and the required app-server protocol.
Desktop-private and sandbox-private executables remain excluded. Kept runs retain the selected
paths, reported version/build and native payload fingerprint; a changed executable refuses the next turn.
Accepting a version does not certify every feature, account, provider or operating system.

Default MCP policy inherits the user's configuration. `mcp: off` disables plugins, apps, hooks, notify, discovered MCP names and OTEL exporters while keeping login.
Inherited notify and hooks can run programs; OTEL exporters may log prompts. Write jobs can persist trust entries in Codex config.
Background commands can remain active after turn completion until the app-server exits. Sandboxed commands can read the state root.
See [Security](../SECURITY.md) and the [protocol contract](../CONTRACT.md).

## Structured output

Set `output-schema: /absolute/schema.json` in the task header, or pass
`--output-schema /absolute/schema.json` on a direct launch or continuation. The
UTF-8 file must contain a JSON object and be at most 64 KiB. The runner snapshots
it before launch and never consumes the schema file. Omitted follow-ups use plain
output; native review cannot combine this option.

Codex receives the schema as its output constraint. If the final answer parses as
JSON, delivery writes `<answer-file>.result.json` beside the durable Markdown
answer. `codex-subagents-for-claude-code-schema: schema=valid|invalid json=PATH|-`
is an additional footer line. Valid means JSON parsing succeeded, not that the
runner implemented a JSON Schema validator. Provider schema support varies; an
invalid JSON answer keeps the original turn status. Sidecar storage failure retains
the run for delivery recovery.

## Service tiers

Use `tier: default` (or `--tier default`) for standard speed. An explicit offered
tier such as `priority` or `ultrafast` applies to that turn only; omitted turns
retain Codex's configured default. Faster tiers may consume more quota. No exact
price multiplier is assumed. The runner checks a fresh model catalogue before a
non-default selection and refuses an unavailable or unverifiable tier before
dispatch. The additional `codex-subagents-for-claude-code-tier: requested=...`
line records the request, not a guarantee of latency or billing. Native review
does not accept this option.

## Detailed doctor

`--doctor --verbose` adds `codex-mcp=`, `codex-hooks=`, `codex-defaults=` and
`codex-requirements=`. It reads configuration through the stable API, without
starting a thread or making a model call. It prints bounded names, states and
counts; credentials, hook commands, config layers and instructions are omitted.
MCP status discovery can initialize configured servers to obtain their tools.
The measured local discovery took 3.2 seconds; no additional direct child remained
after the call, which does not rule out transient processes or network traffic.
`--read-only` suppresses runner cache/directory writes; it does not prevent Codex
from reading its native configuration or contacting configured integrations.

## Forking retained context

`--fork KEY [--at N] [--request-id ID]` creates a new kept run and Codex thread
without making a model call. The source must be delivered and sleeping. N is the
inclusive persisted turn number shown by `--transcript`, defaulting to the latest.
Use a request ID when retrying: an uncertain fork is retained and never resent.
Run `--continue NEW_KEY --prompt-file FILE` for the fork's first model turn; its
local footer starts at turn 1. `--run` prints the fork receipt before that turn.

Worktree forks always get a fresh worktree and, for writers, a new branch from the
recorded delivered commit. Every explicitly selected write-worktree history point (including the current last context turn after revert) requires a matching
delivered commit. An omitted `--at` uses the current delivered filesystem snapshot. Uncommitted changes are not copied. Scratch forks get a new empty
folder. Shared-checkout writer forks are refused, and shared-checkout reader forks
remain read-only. No writer lock or worker is inherited. Prompts needed for redaction
are kept privately in bounded fork metadata, so closing the parent cannot expose
old prompts in the child's progress or transcript. A ready fork can be inspected,
transcribed or closed without sending a task. Failed forks retain their state for
inspection; after a lost reply the native thread may need manual identification.

## Compaction and history repair

On a continuation, set `compact: yes` or pass `--compact`. Codex summarizes the
existing thread before receiving the follow-up prompt. This is an extra model
call, so it is never automatic or inherited. A request ID makes repeating the
same continuation replay its existing result. The driver records compaction
intent before dispatch; an uncertain summary never triggers another summary or
sends the pending prompt. An additive compaction line reports its outcome.

`--revert KEY --before-turn N` removes that persisted Codex turn and all later
ones. Use `--transcript KEY` to find N; native review and compaction can add turns
that differ from the runner footer's turn count. The run must be delivered and
sleeping, with no active Codex thread. This changes conversation history only:
files, commits, durable answers, local turn records and request-ID claims remain.
Local result records mark when their context was removed. A disconnected revert
blocks continuations; repeat the exact revert command to reconcile by reading the
expected prefix. The runner never resends an uncertain revert. A prefix that
cannot be proven stays blocked for inspection. Keep subsequent work consistent
with the filesystem, which may still contain changes from removed turns.

## Diagnostic bundles

`--bundle KEY` saves a local Codex diagnostic ZIP for a delivered, sleeping run.
It makes no model call and uploads nothing. The ZIP can contain prompts, logs and
credentials; inspect it before sharing. Each explicit request gets a fresh private
folder under the results directory with a request receipt and `diagnostics.zip`.
The runner accepts only a regular single-link file at that exact path, at most
64 MiB. This is a post-write acceptance bound; Codex can write a larger file, which
is retained for inspection. Disconnected or mismatched replies never trigger a
retry or overwrite an earlier bundle. Native Codex log creation is not disabled.

## State formats and recovery

Invalid records appear as `damaged-metadata` in an unfiltered list; inspection shows their raw data
and validation error. Active operations refuse them. `--close KEY --force` can quarantine
ended state after checking that no recorded process remains alive. Sweeps skip invalid records.
Claims and locks remain respected. Damaged or live ownership refuses quarantine.
An uncertain dispatch is never resent automatically. Worker-death audit preserves turn evidence and bounded event/log tails with prompts omitted.

A finalized worktree is immutable for cleanup purposes: if its HEAD or tracked/untracked files change after finalization, close (including force) refuses and preserves them. Close never makes a new commit under an already published artifact. An answer collected with `confirmed=no` has no finalized workspace; its explicit-close exception is described above. Preserve or resolve changes to a finalized worktree before retrying.

Native usage totals are cumulative for the Codex thread. The turn fields subtract an observed pre-turn baseline; a missing baseline or a reset makes turn usage unknown. A fork never charges its inherited context as newly consumed usage. Quota percentages are snapshots and are not additive.

## Artifact workflows

`--task-file -` reads the task header and body from stdin; `--prompt-file -` reads a raw prompt
(including for continuation or steering). Input must be strict UTF-8 and at most 8 MiB. EOF must
arrive within `--command-timeout-ms` before any launch or detachment. Use one input source only;
stdin is never interpreted as a file to delete. `--steer` uses its standard command timeout.

Write worktrees use `csfcc/<20 hex characters>`; the full 32-character run key is the
identity in state and receipts. Branch creation is exclusive;
a collision is refused, never adopted. On Windows the runner enables long paths for its own Git
commands. `--doctor` reports effective author and committer identities, placeholder warnings and
external-Git long-path limitations. It does not edit Git configuration or pack refs.
Runner-managed Git commands disable hooks and fsmonitor per process and refuse external filters.
These controls do not change repository/user settings or developer commit/push hooks. Explicit
verification commands and commands issued inside a model task have their own caller-authorized scope.

For a write worktree turn, `commit-subject:` (or `--commit-subject`) selects the runner-created
commit subject. `commit-trailers:` names an absolute JSON file of up to 16 single-line key/value
pairs; the direct flag also accepts a relative file path. Subjects are at most 200 characters,
trailer values at most 512. `Co-authored-by` requires an explicit name and email. `Codex-*` keys are
reserved for the full run key, selected model and request ID. These are provenance labels, not
proof of authorship or authority. Both settings apply to one turn and are included in its request
digest. The runner does not amend model-created commits, infer a subject from task text, or invent
co-authors. Existing effective Git identity and the documented fallback still govern author/committer.

`--artifact KEY` prints the durable JSON receipt in `results/artifacts/KEY.json`, containing repository
identity, start/final commits, tree, branch, full run/job identity and answer digest. It survives
normal close. `--finalize KEY` seals a delivered sleeping worktree and prevents further continuation;
normal cleanup also seals its artifact before removing the checkout. Finalization refuses edits made
after delivery. Start a fresh run or fork context for further work. Artifact commands require full
run keys, because request-ID claims may already have been removed.

`--integrate KEY --target CHECKOUT` fast-forwards a clean target branch in the same repository to a
completed sealed artifact's exact commit. Dirty targets, divergent history, in-progress Git operations,
changed repository identity or moved source branches are refused. The source branch stays. Integration
intent is recorded before Git runs; a repeat only confirms the exact recorded target/commit, and never
retries an ambiguous merge. Cooperating runner operations serialize on a repository guard; external
Git users must not change the target checkout concurrently. No squash, cherry-pick or destructive reset
is performed.

`--discard KEY` requires a sealed branch with no registered checkout (close its run first). It creates
`refs/csfcc/retired/KEY` at the recorded commit before compare-and-deleting the source branch. Repeats
reconcile that recovery ref; a moved branch is preserved. Recover with an explicit ordinary Git branch
creation from that ref. There is no permanent purge command or automatic cleanup hook.

## Multi-model batches

`--batch RECIPE.json [--wait-ms N]` starts independent jobs, each with its own worktree and native
conversation, from one resolved commit. The bounded JSON recipe is:

```json
{
  "version": 1,
  "requestId": "parser-review",
  "cwd": "D:/project",
  "ref": "HEAD",
  "promptFile": "D:/tasks/review.txt",
  "write": false,
  "concurrency": 2,
  "models": [
    { "model": "gpt-6.1-sol", "effort": "max" },
    { "model": "gpt-6-astra", "effort": "max" }
  ]
}
```

`promptFile` is raw prompt text, with no task-header grammar. Paths must be absolute; model and effort
are explicit. Limit: 16 children, concurrency 1-4 (default 2). The coordinator persists the prompt and
child request IDs before dispatch, then consumes the unchanged input once. Its durable manifest lives
in `results/batches/ID/manifest.json`; prompt bytes remain in private state. The recipe is retained.
Repeating an ID with changed recipe or prompt is refused. Use `--batch-run ID [--wait-ms N]` to collect
and launch remaining planned children after the wait budget ends. Exit 3 means incomplete, 2 means
finished with failed/cancelled children, and 0 means every child completed. Results and child runs stay
available individually. A coordinator interrupted during launch recovers known child identities;
missing or ambiguous launch evidence is never resubmitted. Partial success is preserved.
Collection and cancellation require the recorded child identity and exact request digest/version;
matching a request ID, branch or model name alone does not establish ownership.

An uncertain child remains uncertain and is never relaunched. If evidence proves it has no live
process, its slot can be released so unaffected, still-planned children can progress. A child that
may still be live retains its concurrency slot. Missing identity alone does not free a slot;
contradictory ownership retains possible-live status. This permits independent progress without
resending a possibly dispatched prompt.
An answer collected with unconfirmed shutdown is saved in the child manifest, but the child stays
uncertain and keeps its slot. Collection after proven shutdown can finalize it and free that slot;
forced close alone accepts uncertainty and is not evidence that another child can safely start.

`--batch-cancel ID` cancels only identity-checked children recorded in that manifest and skips planned
ones. It never sweeps sessions or closes results. Usage reports a sum of known per-turn totals and a
count of unknown children; quota snapshots are not added. Concurrency is a process-count bound, not a
spending cap. Every selected model makes a separately chargeable/accounted turn.

## Separate artifact verification

`--verify-artifact KEY --recipe FILE --attempt ID --execution-profile trusted-local` executes a caller
supplied command against a fresh snapshot of an exact sealed artifact. It makes no model call and does
not continue, repair or rewrite the original result. The explicit profile authorizes local execution;
it is not an OS sandbox. A minimal recipe is:

```json
{
  "version": 1,
  "executable": "D:/tools/node.exe",
  "args": ["--test", "test/parser.test.mjs"],
  "timeoutMs": 60000,
  "maxLogBytes": 1048576
}
```

The executable must be absolute. Optional `env` contains explicit environment overrides (at most 32);
the base environment keeps path, OS, home, locale and temporary-directory variables only. No shell,
package installation or automatic dependency preparation is added. Timeout is 1-300000 ms (default
60000); each stdout/stderr log retains at most 1-4194304 bytes (default 1 MiB), while excess is drained
and counted. Snapshot setup rejects submodules, symlinks, LFS/checkout filters and repository-local
attribute overrides. It disables sparse checkout, checkout hooks, fsmonitor and global attributes,
and checks that the fresh checkout contains the complete sealed commit tree before execution.
The runner captures file bytes as SHA-256 digests and relevant file/checkout identity in memory
before starting the command. Command behavior remains caller-controlled. Shared checkouts and
scratch-only results are outside this feature.

Each filesystem comparison is bounded to 2 GiB of file bytes, 100,000 entries (including directories)
and 60 seconds; the saved tree itself is limited to 50,000 entries. Exceeding a comparison bound
cannot produce a successful verification. On Windows, environment names are case-insensitive;
recipe overrides take precedence and conflicting case variants are refused.

Receipts under `results/verifications/KEY/ID.json` bind commit/tree, answer and recipe digests,
executable hash, platform, process identities, UTC timestamps, elapsed execution time, exit code,
log hashes/bounds and observed final mutations. Read one with `--verification KEY --attempt ID`.
The private receipt also retains the exact command and environment overrides; treat it as sensitive.
CLI output omits those recipe values and gives the receipt path. After process settlement and
checkout-identity checks, the temporary snapshot is removed; bounded logs and the receipt remain.
A snapshot is retained when process settlement or checkout identity is uncertain, or cleanup fails;
inspect the receipt's cleanup state and reason. A repeated attempt replays its receipt; changed
input is refused. Incomplete attempts are uncertain and are never re-executed. Another execution
requires an explicit new attempt ID; it must not bypass a still-live or uncertain earlier process.

Outcomes are `exit-0`, `failed`, `error`, `cancelled`, `uncertain`, `invalidated` or `skipped`.
`exit-0` means only the named command exited zero and the observed snapshot remained unchanged.
After owned processes settle, actual filesystem bytes and relevant file identity are compared
against the in-memory pre-command baseline. Changes to checkout/HEAD identity or to tracked,
untracked or ignored files invalidate the result. The comparison does not trust a post-command
Git index, status output, ignore rules or assume-unchanged/skip-worktree flags. It cannot prove
that temporary edits were never made or that a test is correct. Model status
and verification status remain separate. Windows uses a Job Object for descendants; POSIX drains its
owned process group. Intentional process-group escape is outside the trusted-local profile. No automatic
repair loop, destructive rollback, hard cost cap or close-time execution hook is supplied.
