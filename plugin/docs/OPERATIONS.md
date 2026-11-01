# Codex subagents for Claude Code: installation and troubleshooting

Start with [installation](https://github.com/PolaronQuasi/codex-subagents-for-claude-code/blob/main/README.md#installation) and the [worked examples](EXAMPLES.md).
See the [manual](MANUAL.md) for task syntax and [support](../SUPPORT.md) for reporting a problem.

## Installing and selecting Codex CLI

Install Codex CLI separately and authenticate with `codex login`. Any Codex version may be
selected; **0.166.0 is the tested reference**, not a minimum or an exclusive supported version.
Executable safety, app-server protocol checks and retained executable identity still apply.
The following npm examples select that tested version explicitly; choose another version deliberately
when needed and check its actual behavior. A global installation example is:

```sh
npm install --global @openai/codex@0.166.0
```

Or give it its own folder:

```sh
npm install --prefix <folder> @openai/codex@0.166.0
```

Set `CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH` to the native executable inside that folder's
platform package. On Windows x64, its relative path is
`node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`.
For example, use a folder under your user profile:

```powershell
npm install --prefix "$env:USERPROFILE\codex-cli" @openai/codex@0.166.0
```

To apply the path to every Claude Code session, merge an `env` entry into your user settings at
`~/.claude/settings.json`, replacing `<you>` with your profile folder name:

```json
{
  "env": {
    "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH": "C:\\Users\\<you>\\codex-cli\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe"
  }
}
```

Check the effective path in each already-open session with `--doctor --read-only`; restart a session if it still uses the old environment.
A version outside the tested reference does not by itself prevent launch. Missing protocol features,
unsafe or unidentifiable executables, changed retained executable identity and backend model/effort
rejections still can.

On Windows, processes inside an MSIX-packaged app, including the Claude desktop app, have writes under
`%LOCALAPPDATA%` redirected into the package's private `LocalCache`. A CLI installed under AppData from
inside such an app can therefore be invisible to other programs; `--doctor` shows a
`...\Packages\<app>\LocalCache\...` path. Install outside AppData, such as the user-profile folder above.

## Troubleshooting

Start with `node run-codex-task.mjs --doctor --read-only`. It identifies the selected CLI, probes
app-server availability and initializes a dedicated session to call `account/read`. It sends no model
task and prints no account email. `codex-tested-version=` is the reference and
`codex-version-tested=no` is advisory. Diagnose the actual executable, protocol, login or model
error instead of treating a different version as unsupported.
`codex-login=logged-out` means run `codex login` with the same environment/CODEX_HOME.
Model discovery does not establish model access; preserve the requested model and effort when diagnosing failures.
Do not use an allow-version override to bypass executable or retained-state checks. After deliberately
changing the CLI binary, start a new run rather than altering a retained run's identity metadata.
For cache age, reuse and refresh rules, see [caches and retained state](MANUAL.md#caches-and-retained-state).

Windows paths passed from Git Bash must use `C:/...` or a UNC share when absolute.
The runner refuses `/c/...` and drive-relative `C:...` spellings before reading task files or
choosing a workspace; it does not translate Git Bash mount names.

## Interrupted waits and uncertain submissions

Exit 3 and interrupted waiters leave detached work alive. Use the printed `--attach JOB --run KEY` or `--run KEY`.
Use `--inspect KEY --json` to examine state without changing it; `--probe` explicitly adds process and IPC observations.
Never relaunch a possibly dispatched turn. Recovery searches persisted Codex history using the job's client ID.
Native reviews have no client message ID: recovery requires the proven outer review turn ID and never
guesses from nested review turns or history position.
If it cannot prove one result, `SUBMISSION_UNCERTAIN` retains evidence. A crashed interrupted turn is reported failed.
For batches, a child requires exact request-digest ownership before collection or cancellation.
An uncertain child is never resent. Its slot can be freed only after no-live-process evidence;
otherwise the possible-live slot remains occupied. Unaffected planned children may use proven free
capacity. A saved answer does not free an unconfirmed child's slot; accepting uncertainty with forced
close is not proof that its descendants stopped. See [batch recovery](MANUAL.md#multi-model-batches).

## Keeping and closing runs

Each driver exits after its turn and app-server shutdown. A kept run retains thread/results and has no idle process by default.
`--continue KEY --prompt-file FILE` resumes that thread in a new driver. Finish with `--close KEY`.
`--cancel KEY` interrupts, observes terminal evidence and escalates only with an identity proof.
`--sleep KEY` retries a lingering driver's shutdown without removing state. Unknown identity or surviving children preserve locks.
`--close KEY --force` can drop undelivered output and stop active work; inspect first when the outcome is uncertain.
Shutdown records each captured process identity before permitting signals. If a stop reply is lost,
retry collection, `--sleep` or close: recorded targets that are now gone clear the incomplete flag.
An identity timeout before capture can be retried while the same root still exists. Unknown identities
or an uncaptured descendant set keep state and locks during ordinary operations.
Records missing their descendant list cannot be automatically repaired from a dead root PID
alone. Collect an already-saved answer with `--run KEY`; it retains the uncertainty and defers workspace
finalization. Investigate the recorded owned processes. To explicitly accept an unknown tree, use
`--close KEY --force`. It makes a fresh identity-bound stop attempt, refuses known survivors, never
signals unconfirmed/reused PIDs, and warns which PIDs remain unconfirmed (uncaptured descendants may
also exist). Before cleanup it must save `results/audit/KEY/forced-close.json`, including
`shutdownUnconfirmedAcceptedAt`, reason and observed process identities. Durable result footers and
artifact/thread receipts retain the warning. If evidence cannot be written, cleanup refuses. Once
accepted, ordinary teardown releases claims and keeps results; repeat with the same state/results
roots safely. No model turn is submitted. Do not erase driver flags by hand or mistake the receipt
for confirmation that every process stopped.

Kept threads remain unarchived; cleanup attempts reversible archival after owned processes stop.
`--transcript KEY [--turn N] [--json]` reads bounded persisted history of a delivered sleeping run.
`--list --codex` lists named orphan candidates. Inspect `--archive-orphans --dry-run` before explicit
archival; only receipts bound to this state root authorize it. Preserve `<results>/thread-owners`
when deleting old state. Missing receipts or failed naming require manual archival in Codex history.

`--collect-finished`, `--close-idle` and `--sleep-idle` support `--dry-run`, `--older-than AGE` and `--all-sessions`.
CLAUDE_CODE_SESSION_ID is shared by the main thread and its subagents. A subagent should close its own runs by key;
session-wide sweeps can include someone else's active delegation.

## Storage and diagnostics

The default state root is `~/.claude/codex-subagents-for-claude-code-state`.
Results and metadata-only invocation audits are saved under
`~/.claude/codex-subagents-for-claude-code-data/results`, separate from installed code.
`--doctor --read-only` prints `results=` and `results-source=data-default` or `override`.
Other directories are not auto-discovered. Neither installation method nor uninstall moves or deletes results.
Use absolute `..._STATE_DIR` and `..._RESULTS_DIR` overrides for another local filesystem.
The state root needs working atomic rename/locking and must be outside a repository for scratch workspaces.
Plugin installations keep read-only runtime snapshots in its `runtime/` folder, one per release digest,
made by `--prepare`. Nothing removes them automatically. After an upgrade, remove an older one only when
no active or retained run still references it, including kept runs awaiting continuation.
Use `--list` and `--inspect KEY --json` to review retained runs before removal; active-only listing is insufficient.
A snapshot whose files changed is refused with `RUNTIME_CONFLICT`, never repaired.
If a durable copy fails, ordinary delivery may print and retains its cache; collection fails and keeps the run.
Fix storage and attach again. Result hashes detect mismatched bytes; local hashes do not create a
confidentiality or trust boundary against the same user. The [cache reference](MANUAL.md#caches-and-retained-state)
distinguishes runtime snapshots, result replay, model catalogues, quota and provider token accounting.

Artifact verification creates a separate complete checkout of the sealed commit, captures an in-memory
baseline before execution, and compares actual file bytes after the owned process settles. It does
not trust the command's resulting Git index or ignore flags. A settled snapshot with confirmed
checkout identity is removed; receipts and bounded logs remain. Uncertain process/checkout identity
or a cleanup failure retains the snapshot. Read the receipt's cleanup reason before taking action;
repeating an attempt reads its receipt and never executes it again. See
[artifact verification](MANUAL.md#separate-artifact-verification).

Windows verification errors include the last observed supervisor phase, such as `compiling` or
`waiting-authorization`. This bounded diagnostic in `supervisor-phase.txt` helps locate startup
failures; it is not proof that a command ran or that its processes stopped. An uncertain receipt
still retains the snapshot for recovery.

Worktree `touched=` and delivered `--diff` use pinned start-to-delivery commits, including shell writes.
Scratch `touched=` inventories remaining files; shared checkout counts still depend on Codex file-change
events. Patch previews are redacted and bounded, so use Git on the retained branch for complete review.
An empty `--diff` explains absent evidence on stderr; exit0 means terminal, not unchanged. Windows Git
worktree operations enable long paths per process without changing global or repository settings.
Very deep physical repository paths can still exceed Git's own `.git/worktrees/...` lookup limits,
even with long paths enabled. If Git reports that administrative path as "not a git repository",
move the checkout closer to the drive root. This boundary was reproduced with Git for Windows 2.51.0.

After driver death, the audit keeps `turn.json` and bounded tails of `events.jsonl` and `driver.log`,
scrubbing exact current/archived prompt and steer echoes. Missing inputs or exhausted matching budgets
withhold diagnostic text. Generated or paraphrased task details can still be sensitive.
The launch plan and final answer are not audit inputs. Share minimal diagnostics; run state and normal results contain task data.
`--close KEY --force` quarantines damaged records only when recorded processes are ended; no hooks are invoked.

## Invalid state

Invalid records appear as `damaged-metadata` in an unfiltered list and can be inspected as raw data.
Active operations refuse them rather than attempting to interpret another format.
Forced close can quarantine ended state and then release its claims. Live or unknown identities retain state.
Writer locks and request claims are never treated as free merely because the record is invalid.
The tested reference is 0.166.0, but version selection is unrestricted by that reference.

## Configuration side effects

Inherited config includes MCP, hooks, notify and OTEL exporters; exporters may include prompt logging.
`mcp: off` disables those integrations for the turn while keeping native login.
Write jobs may add trusted-project config entries. Background commands may outlive turn completion until the app-server exits.
Runner-managed Git disables hooks and fsmonitor per process and refuses external filters. This
neither disables developer hooks nor changes Git settings; an explicit trusted-local verification
command or a model-issued shell command is not covered merely because it invokes Git.
Sandboxed commands can read prompts, results and secret files in the state root. Review [Security](../SECURITY.md).
