# Our Codex protocol contract

This is the independently implemented contract between this runner and Codex CLI, tested with **0.166.0**.
It is based on the CLI's generated schema, help output and the documented protocol, with our own wording and code.
No implementation or private source from OpenAI's Claude Code extension is part of this integration.

## Executable and transport

Resolve an explicit path or PATH executable, excluding desktop-private and sandbox-private copies.
Identify it with `--version`, resolve links, and pin its path/version/build in run record version 2.
Accept other version labels without an allow override, subject to capability and protocol checks.
Fingerprint the executable payload actually launched; refuse an unresolved wrapper and a changed kept build before dispatch.
One detached driver owns one dedicated `codex app-server --listen stdio://` per turn; never a shared daemon.
Prompts travel through a private file and stdin, never argv. JSONL frames, queues, logs and request waits are bounded.

## Session

Send `initialize` with client name/version, `experimentalApi:false`, `requestAttestation:false` and delta opt-outs;
then notify `initialized`. Authentication remains the CLI's native login.
Doctor reads `account/read` without creating a thread; a null account means logged out. Do not print the account email.
`model/list` cannot prove model access. Doctor and each turn's pre-launch check read it with `includeHidden:true`,
every page (`nextCursor`), and refuse only what a complete catalogue proves: an unlisted model id or an effort missing from a
non-empty `supportedReasoningEfforts` on a visible entry. Malformed, truncated or over-budget catalogues
prove nothing and are not cached. A cached refusal gets a fresh lookup; a failed refresh permits dispatch.
`upgradeInfo.retirementAt` is warned. A hidden model is noted and never refused by this check.

Start a persistent thread with `thread/start`, exact model/cwd, approval policy `never` and explicit
`read-only` or `workspace-write` sandbox. Follow-ups use `thread/resume` by ID and `excludeTurns:true`.
On Windows, writes require `windowsSandbox/readiness` to be `ready`.
Persist dispatch intent before `turn/start`, including `clientUserMessageId` equal to the local job ID.
The text input, exact effort and model are preserved. `max` is a literal effort string.
Optional `summary` is one of `auto`, `concise`, `detailed`, `none`; omission preserves the initial
default or inherits the previous turn. Model, effort, summary and review policy participate in request matching.

Native review uses `review/start` with inline delivery, a structured target or custom instructions,
and per-thread review model/effort/summary configuration. It is always read-only and per-turn.
Bind only the outer turn ID returned by `review/start`: nested review notifications cannot change it.
Early notifications are byte-bounded until that reply arrives. Review has no client message ID;
possibly sent review requests are never repeated, and recovery requires an already proven outer turn ID.

## Evidence and accounting

Structured output snapshots a JSON Schema object (64 KiB maximum) before a request
claim and includes it in the request digest. `turn/start.outputSchema` is per-turn.
JSON parsing alone determines the additive `-schema:` line; provider schema support
is separate. A parseable answer is saved beside the durable Markdown copy as
`.result.json`. The first footer line is unchanged. Service-tier selection uses
`serviceTierForTurn`, never the sticky `serviceTier`, with a fresh offered-tier
check for explicit non-default values. The additive `-tier:` line names the requested
tier, without claiming latency or cost.

Fold completed `agentMessage` items, preferring `phase:final_answer` and falling back to the last null-phase message.
Collect `fileChange.changes[].path`. Commentary and partial deltas are not final answers.
At delivery, isolated worktrees replace that file list with the cumulative Git diff from pinned start
to delivered commit, including shell writes. Scratch workspaces inventory remaining files without following
links. Shared checkouts retain protocol observations only. Bounded redacted Git patches are parent-owned
and checksummed; `--diff` explains missing/truncated evidence instead of implying no changes.
Windows Git calls use per-process `-c core.longpaths=true`, with inherited Git overrides stripped.
Runner Git disables hooks, executable fsmonitor and automatic signing, refuses applicable external content filters,
and uses original objects rather than replacement refs or grafts. These controls do not disable developer hooks.
Known terminal statuses are `completed`, `failed` and `interrupted`. Unknown statuses remain active/uncertain.
Observe pushed token usage and rate limits before completion; a turn uses `account/rateLimits/read` only as fallback.
`--limits` and doctor read `account/read` and `account/rateLimits/read` (null params) without a thread; `--limits`
runs a probe app-server (`mcp: off`'s switches, no MCP discovery). In a sparse snapshot, absent fields preserve
the previous observation and explicit nulls clear it. `ordinaryUsageAllowed` null is unknown.
Status-only denials are valid observations. Never print, log or cache `accountId` or the email.
A turn with a quota floor reads `account/rateLimits/read` before `thread/start` or `thread/resume` and is refused
(`CODEX_QUOTA_LOW`) without dispatch. `TurnError.codexErrorInfo` names (string or one-key object) map to runner
codes; the context fill is `tokenUsage.last.totalTokens / modelContextWindow`.
Totals reset per app-server process, so the runner sums its own archived-turn totals.
Interrupted or killed turns with no accounting report `tokens=-`. Invalid reset dates render as unknown;
credits preserve balance, availability and unlimited status. A failed turn retains its named error even with a partial answer.

Model and quota cache updates hold an identity-owned guard across the age check and atomic rename.
Contending updates may be skipped; an accepted older observation cannot overwrite a newer one.
An observed logout writes a timestamped quota invalidation marker unless doctor is read-only.
Cached quota never proves current login. Malformed cache shapes read as unknown.

Publish `final.txt` before the immutable atomic `turn.json`. Only the waiter writes `run.json` under the run lock.
Driver jobs live under `jobs/J`: `driver.json`, `events.jsonl`, `final.txt`, `turn.json`, `driver.log`.
Use Windows sharing retries for atomic writes. A terminal publication wins a racing cancel or settlement.
The first terminal notification freezes answer items and turn identity; late items cannot replace the final answer.
Bounded model reroute IDs, buffering flags and allowlisted warning codes survive recovery and appear on
an additive model footer line. Backend warning text is excluded; the first footer line is unchanged.

## Progress and steering

Progress accepts only matching active thread/turn notifications. Keep the latest plan and bounded completed-item
metadata in a 64 KiB JSONL file, and the latest diff in a separate 256 KiB file. Exclude messages, deltas,
tool arguments, command output and full reasoning. Scrub exact current and archived prompt/steer echoes before
truncation. Missing input or exhausted matching budgets withholds text. `progress: off` writes neither file;
the effective progress policy participates in request-ID matching and continuation rollback.

A steer reservation stores text and fenced metadata in private job files. IPC carries only `{n}`.
Before `turn/steer`, persist dispatch intent, the expected turn ID and a unique client user-message ID.
Never repeat a dispatched steer after timeout or recovery. A matching user-message observation or unique
history match can settle an uncertain acknowledgement; missing evidence stays uncertain. Recovery/audit
diagnostics use the same prompt and steer inputs for redaction, withholding text if those inputs are unavailable.

## Unattended requests

| Request                                         | Answer                                                    |
| ----------------------------------------------- | --------------------------------------------------------- |
| command/file approval                           | `{decision:"decline"}`                                    |
| permissions approval                            | `{permissions:{},scope:"turn"}`                           |
| legacy applyPatchApproval / execCommandApproval | denied, with a non-interactive reason                     |
| tool requestUserInput                           | empty answers, then interrupt with `INTERACTION_REQUIRED` |
| tool call                                       | failure; no client tools are executed                     |
| MCP elicitation                                 | decline, with null content and metadata                   |
| external authentication refresh                 | protocol error; fail and advise `codex login`             |
| attestation                                     | unsupported-operation error; opted out at initialize      |
| unknown request                                 | method-not-found and a compatibility diagnostic           |

## Control and recovery

The driver starts Codex only after its birth identity is recorded and the bounded gate opens.
Mutual nonce/HMAC authentication fences run, generation, protocol, PID and creation time.
Only hello, status, steer, interrupt and shutdown are exposed over the local pipe/socket; no arbitrary RPC forwarding.
Cancel persists intent, asks `turn/interrupt`, then observes terminal output and process exit.
Interrupt settlement and graceful exit each allow at least ten seconds for inherited hooks and telemetry flushing.
Escalation uses held handles or a fresh identity proof; an unknown identity retains state and kills nothing.

After a driver crash, wait for its recorded app-server to end. A definitely unsent turn may retry once.
A possibly sent turn is never resent: page `thread/turns/list` and `thread/items/list` by `userMessage.clientId`.
Adopt only one unambiguous result. Interrupted crash history is failure, never invented cancellation.
Missing evidence yields `SUBMISSION_UNCERTAIN`.

## Explicit history and cleanup

An unknown shutdown tree still blocks ordinary sleep/close and workspace finalization. Collection
may deliver a validated saved answer while retaining state and claims, with `keep=yes` and an additive
shutdown warning. Only explicit `--close KEY --force` can accept this uncertainty after fresh
identity-bound checks. Unconfirmed/reused PIDs are never signalled; known survivors still block.
Mandatory durable acceptance evidence and warning markers precede deletion. Repeated forced close
with that state-root-bound receipt is a no-op. This does not change model submission/retry rules.
Batch collection retains a possible-live slot for a delivered answer whose shutdown is unconfirmed.

`--transcript` locks a delivered sleeping run, verifies ended driver/app-server identity, resumes with
MCP and integrations disabled, and reads paginated persisted turns/items without submitting work.
Only selected bounded fields survive prompt/steer redaction; user text, raw reasoning and tool payloads
are omitted. Persisted history order may include review-internal turns. Limits apply across all pages
and items:100 pages,16 MiB,30 seconds; rendered output is at most1 MiB, with truncation disclosed.

`thread/name/set` labels owned threads with run key and role. Actual cleanup attempts `thread/archive`
after safe shutdown; kept runs remain available. Archive failures preserve ownership receipts beside
durable results and warn. `thread/list` uses explicit app-server filtering. Orphan archival requires a
valid receipt bound to state root/run/thread, absent retained/quarantined state and lock, and a fresh
idle identity check under a run lock. Never infer ownership from a name alone or use `thread/delete`.

## Configuration and certification

`--fork` requires an idle retained source under its lock, then publishes a separate
run record and lock before creating a native thread. It creates no synthetic model
turn. A ready seed starts local turn 1 on continuation; an unconfirmed seed cannot
dispatch. Every worktree fork uses a fresh worktree; shared-checkout write forks are
refused. Redaction fragments are copied privately within a byte bound and fail closed.

Explicit compaction checkpoints intent before its RPC, waits for confirmed terminal
compaction evidence, then dispatches the follow-up prompt once. An interrupted summary
does not permit startup retry. Revert records an expected history-prefix hash before
mutation; a lost response can only be reconciled by a read, never by repeating the RPC.
History edits do not change files or erase local delivery/request evidence. Maintenance
probes save their app-server birth identity under the run lock, so a successor refuses
to continue or clean up until the old process is confirmed ended.

Verbose doctor projects a bounded allowlist from MCP, hooks and config APIs, with no
raw config layers, credentials or commands. Explicit `feedback/save` writes only a
fresh caller-owned ZIP path, preserves uncertain outputs for inspection and uploads
nothing. A 64 MiB acceptance check is applied after the native writer returns.

Per-thread credit usage and token-budget enforcement are not claimed: the verified
usage route returned null, and a budget-limited goal did not cap its active turn.

The default inherits native Codex configuration. `mcp: off` disables plugins/apps/hooks, sets notify to an empty list,
queries `codex mcp list --json` with the same integration-disabling flags immediately before launch and disables each returned server by name,
and sets the three OTEL exporters to none. Empty-table MCP overrides are insufficient. Native login remains available.
Read [Security](SECURITY.md) for inherited notify, OTEL prompt logging, trust entries, background processes and state reads.

`npm run contract` regenerates JSON schema from the installed CLI into scratch, verifies the methods, inputs,
outputs, status values, items, usage and rate-limit shapes used here, then runs the driver against the fake Codex.
Nothing generated is committed and no real app-server or model turn is part of runtime certification.
