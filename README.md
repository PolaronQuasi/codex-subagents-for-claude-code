# Codex subagents for Claude Code

Independent project; not affiliated with or endorsed by OpenAI or Anthropic.
Source: [PolaronQuasi/codex-subagents-for-claude-code](https://github.com/PolaronQuasi/codex-subagents-for-claude-code).
See the [GitHub publication checklist](docs/GITHUB-SETUP.md) for repository setup and release verification.

Delegate self-contained tasks from Claude Code to GPT models through the installed Codex CLI.
`run-codex-task.mjs` (runner 1.0.0) starts our own driver and a dedicated Codex app-server for each turn.
The driver saves the answer and exits. Kept conversations resume the same persisted native Codex thread
in a fresh process for the next turn. [Session persistence and prompt caching](docs/COMPARISON.md#native-threads-and-prompt-caching)
are separate: neither a retained thread nor a running process guarantees cache reuse.
Jobs start read-only; edits require an explicit `write: yes` or `--write`.

Native reviews support uncommitted changes, a base branch, a commit or custom instructions.
Kept runs support bounded transcripts, model/effort/summary changes on continuation, and live steering.
They also support forks, explicit compaction and conversation reverts. Structured output saves a JSON
sidecar, and optional service tiers apply to one turn. Verbose doctor and local diagnostic bundles
help investigate failures. Faster tiers may use more quota; compaction makes an extra model call.
Worktree results count committed changes including shell writes; missing diffs explain their limits.
Bounded stdin input and multi-model batches reduce task-file handling. Durable Git receipts support
explicit finalization, fast-forward integration and recoverable branch retirement. Separate local
verification checks an exact sealed commit with bounded logs and execution time; it never resumes
the model or repairs code automatically. See [artifact workflows](docs/MANUAL.md#artifact-workflows).
Owned Codex threads are named and reversibly archived on cleanup. See the [manual](docs/MANUAL.md).

## Choosing a workflow

This runner provides explicit task directives, managed worktrees, durable artifact receipts and bounded
multi-model batches. OpenAI's Codex plugin offers review and rescue slash commands, Claude-session
transfer and an optional stop-review gate. Start with the [quick comparison table](docs/COMPARISON.md#quick-comparison).
The [detailed comparison](docs/COMPARISON.md#workflow-comparison) links to the
inspected public source and explains shared features, advantages and tradeoffs without performance guarantees.

Start with the [examples](docs/EXAMPLES.md), [architecture and lifecycle diagrams](docs/diagrams/README.md)
or [support guide](SUPPORT.md).

## Requirements

- Node.js 22 or later, installed by the user. Claude Code's installers do not provide Node for this runner.
- Git (the release checks use 2.39 or later). Windows forwarders also need Git for Windows / Git Bash and PowerShell.
- A separately installed Codex CLI, logged in with `codex login`. **codex-cli 0.166.0 is the tested baseline.**
  Other versions are accepted subject to the app-server capabilities required by the chosen operation;
  acceptance alone does not establish compatibility. See [Compatibility](docs/COMPATIBILITY.md) and
  [CLI setup and selection](docs/OPERATIONS.md).
- Claude Code for the named forwarders and skill. Direct terminal use needs only the runner's prerequisites.
- Account access to the exact requested model and effort. The runner never substitutes either.

The CLI uses its own authentication and `CODEX_HOME`. No second credential store is created.
Claude Code and Codex usage count against the respective account limits. See [Compatibility](docs/COMPATIBILITY.md).

## Installation

To use the tested CLI baseline, follow your CLI distribution's instructions. For the npm distribution:

```sh
npm install -g @openai/codex@0.166.0
codex --version
codex login
```

Then install the Claude Code side in one of two ways.

### 1. As a Claude Code plugin

```sh
claude plugin marketplace add https://github.com/PolaronQuasi/codex-subagents-for-claude-code.git
claude plugin install codex-subagents@codex-subagents-for-claude-code
```

Inside a session, use `/plugin marketplace add` with the same clone URL, then
`/plugin install codex-subagents@codex-subagents-for-claude-code`.
Restart Claude Code or run `/reload-plugins`. Plugin agents are namespaced, so ask for
`codex-subagents:gpt-6-1-sol` (the role names are unchanged); the skill is
`codex-subagents:codex-subagents-for-claude-code`. Each forwarder first runs
`node "${CLAUDE_PLUGIN_ROOT}/run-codex-task.mjs" --prepare <role>`. It makes sure this release's **runtime
snapshot** exists, an immutable copy of the runner under the state root's `runtime/<version>-<digest>/`, and the turn
runs from there: a plugin update replaces Claude Code's cache folder, never the files under a running job. Snapshots
of older releases stay until removed by hand. Updates reach users when the plugin's version changes.
Use either the plugin or a checkout install: with both, Claude Code lists every agent twice.
Follow [switching or uninstalling](#switching-or-uninstalling) to remove the old definitions while keeping your results.

The plugin adds three slash commands that only run the runner and make no Codex model call:
`/codex-subagents:codex-limits` (`--limits`, the remaining quota on one line),
`/codex-subagents:codex-list` (`--list --mine`, this session's runs) and
`/codex-subagents:codex-doctor` (`--doctor --read-only`). Use the full namespaced names;
Claude Code [namespaces plugin components](https://code.claude.com/docs/en/plugins/manifest-reference#name).
Each pre-approves only its own command, and Claude relays the output.
The plugin registers no Claude Code lifecycle hooks. Invoked runner operations can interrupt or stop
owned processes, including during turn cleanup; see [process ownership](SECURITY.md#process-ownership).
This does not disable inherited Codex integrations.

The marketplace installs the generated `plugin/` runtime payload, excluding tests, CI and release tools
from Claude's plugin cache. The marketplace's Git clone still contains the full repository.
Doctor inspects the selected plugin's bundled definitions and reports their namespace and availability;
it cannot prove that Claude has enabled or loaded them.

### 2. From a checkout

Clone this repository into a stable directory, then preview and install the definitions:

```sh
git clone https://github.com/PolaronQuasi/codex-subagents-for-claude-code.git
cd codex-subagents-for-claude-code
node install.mjs --check
node install.mjs
node install.mjs --check
node run-codex-task.mjs --doctor --read-only
```

On a first install, `--check` reports missing definitions. Review and back up custom same-named files before installing:
the installer replaces them. Definitions go under `~/.claude/agents` and `~/.claude/skills` unless overridden.
Restart Claude Code after installation. For managed releases selected by `dist/current`, see
[Development](docs/DEVELOPMENT.md). Doctor checks the CLI version, app-server availability and login through
`account/read`; it does not send a model task or prove model access. Normal doctor also probes storage writability.
`node run-codex-task.mjs --limits` prints the remaining Codex quota on one line without a model call (`--cached` starts nothing).

### Switching or uninstalling

From the checkout that installed your definitions, preview their removal, then uninstall:

```sh
node install.mjs --uninstall --check
node install.mjs --uninstall
```

The preview exits 1 while definitions remain or a conflict needs attention. Uninstall removes only
unchanged definitions with matching ownership receipts from that checkout. It preserves edited or unproven files and reports them;
it never removes shared agent/skill directories, the checkout, results, retained runs or branches.
Use the same directory overrides as installation. See [removal details](SUPPORT.md#update-or-remove-an-installation).

To switch to the plugin, uninstall the checkout definitions, then follow the plugin installation above.
To switch to a checkout, first uninstall the plugin from the scope where you installed it:

```sh
claude plugin uninstall codex-subagents@codex-subagents-for-claude-code --scope user --keep-data
```

Then install the checkout definitions and restart Claude Code or run `/reload-plugins`.
Use `--scope project` or `--scope local` when appropriate. Runner data and immutable runtime snapshots
live outside the plugin cache and remain available after plugin removal.

## Usage

Ask Claude to use a named agent and provide everything Codex needs. Codex does not receive the conversation.
For direct delegation, one message can Write the task to a new file and call Bash with
`run_in_background: true`:

```sh
node "<runner path>" --role gpt-6-1-sol --task-file "<task file>" --quiet --wait --relay --max-stdout-bytes 6000
```

Example task file:

```text
effort: high
keep: yes
mcp: off

Review the supplied patch for correctness. Explain each finding with a file and line.
```

Use `write: yes` for edits and `worktree: yes` to isolate them on a new Git branch.
`cwd: none` creates an empty scratch workspace. `request-id: ID` deduplicates retries of the same task.
`mcp: off` disables configured MCP servers, apps, plugins, hooks, notify and OTEL exporters for that turn;
the default inherits the user's Codex configuration. It retains the native login.

## Roles

| Role            | Exact model     | Default effort |
| --------------- | --------------- | -------------- |
| `gpt-6-1-sol`   | `gpt-6.1-sol`   | `xhigh`        |
| `gpt-6-1-terra` | `gpt-6.1-terra` | `xhigh`        |
| `gpt-6-astra`   | `gpt-6-astra`   | `xhigh`        |
| `gpt-6-sol`     | `gpt-6-sol`     | `xhigh`        |
| `gpt-6-luna`    | `gpt-6-luna`    | `xhigh`        |
| `gpt-5-6-sol`   | `gpt-5.6-sol`   | `xhigh`        |
| `gpt-5-6-terra` | `gpt-5.6-terra` | `xhigh`        |
| `gpt-5-6-luna`  | `gpt-5.6-luna`  | `xhigh`        |

Effort is passed literally: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
`ultra`, above `max`, is only ever an explicit choice. The catalogue check can refuse an unsupported
effort with `CODEX_EFFORT_UNSUPPORTED`. The 2026-10-31 catalogue observed with codex-cli 0.166.0 did not
offer `ultra` for the two luna models, or `none` and `minimal` for the listed models. Catalogue entries
and supported efforts can change; a listing does not prove account access. See the [manual](docs/MANUAL.md#output).
Use `low` for simple lookups or mechanical edits. Catalogue refusals happen after the runner job
starts, before any Codex thread or turn request. They leave a failed job to collect and a durable
failure result on collection; collect detached failures with `--run KEY --wait` or `--collect-finished`.

## Recovery and retention

Keep the run key and exact durable result path from the footer.
`--run KEY` attaches; `--continue KEY --prompt-file FILE` adds a turn; `--cancel KEY` interrupts;
`--close KEY` removes retained state. A wait ending with exit 3 leaves the task running.
Never relaunch an uncertain submission: attach or inspect its existing run.

Exit codes remain 0 for completion, 1 for a runner error, 2 for a failed/cancelled result, and 3 for still running.
`--relay` returns 0 for any delivered result. The footer retains `tokens=` and `limit=`, with `-` for missing usage.
Results are saved under `~/.claude/codex-subagents-for-claude-code-data/results`.
Nothing is moved or deleted automatically.
Doctor prints the selected `results=` path and `results-source=`; an explicit
`CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR` takes precedence. The results folder is user data,
not evidence of an installed checkout;
run state is under `~/.claude/codex-subagents-for-claude-code-state`.

Invalid run records are retained for inspection and cannot start or continue work.
`--close KEY --force` can quarantine ended state after process checks. Locks and claims remain respected.

## Configuration and trust

The runner selects an explicit `CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH`, an optional
`CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_DIR`, or the first eligible executable on PATH.
It excludes WindowsApps, the desktop app's private `%LOCALAPPDATA%/OpenAI/Codex/bin/*` copies and
`~/.codex/.sandbox-bin`. It records the found path, real path, version and build, and refuses a changed kept build.
Version 0.166.0 is the tested baseline, not an exclusive version requirement. Other versions still need
the required app-server capabilities and model support. Start a new run to evaluate a changed CLI build;
see [Compatibility](docs/COMPATIBILITY.md).

Inherited configuration includes MCP servers, hooks, the notify program and OTEL exporters. Exporters may log prompts.
Write jobs may add trusted-project entries to Codex's `config.toml`.
Background commands can outlive `turn/completed` until the dedicated app-server exits.
Sandboxed commands can read the runner's state root, including prompts, results and IPC secret files.
HMAC authenticates driver identity and generation; it is not a confidentiality boundary against the same user.
See [Security](SECURITY.md) for the pipe ACL facts and network/persistence boundaries.

## Reference and development

[Manual](docs/MANUAL.md) · [Operations](docs/OPERATIONS.md) · [Protocol contract](CONTRACT.md) ·
[Compatibility](docs/COMPATIBILITY.md) · [Comparison](docs/COMPARISON.md) · [Examples](docs/EXAMPLES.md) ·
[Support](SUPPORT.md) · [Diagrams](docs/diagrams/README.md) ·
[Release pipeline](docs/RELEASING.md)

No npm runtime dependencies. Ordinary tests use an independently written fake Codex and make no real model calls.
`npm run contract` checks the installed CLI schema in scratch and runs the fake driver contract.
Generated schema is never committed. This project's code, docs and templates are [Apache-2.0](LICENSE);
see [NOTICE](NOTICE). Codex and Claude Code have their own licenses and account terms.
