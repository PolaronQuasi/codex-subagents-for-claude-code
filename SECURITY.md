# Security and trust boundaries

This independent runner executes delegated tasks through a separately installed, logged-in Codex CLI.
The selected model receives the supplied task and can use the capabilities of that CLI and its configured integrations.
Node 22+, Git and a compatible Codex CLI are prerequisites. Tested with codex-cli 0.166.0;
other versions are admitted subject to the required capabilities and safety checks. Read-only is the default;
workspace writes require explicit authorization.

## Configuration, network and persistence

Codex inherits the user's CODEX_HOME and configuration, including MCP servers, apps, plugins, hooks and the notify program.
Those integrations can start processes, perform network requests and receive task data.
Inherited OTEL exporters may log user prompts and send them to configured collectors.
The runner does not copy credentials or create another login store. Native Codex authentication remains responsible for login/refresh.
Doctor calls account/read without a model request and never prints the account email; metadata probes can still initialize CLI integrations.

`mcp: off` disables plugins, apps and hooks, empties notify, disables every MCP server returned by the same CLI's
just-in-time `mcp list --json` with the same integration-disabling flags, and sets OTEL exporters to none. It retains native login.
A config edit between discovery and launch fails closed if a server name is no longer valid.
This directive does not turn off the network needed by Codex's model provider or create a separate login home.

Workspace-write jobs may add `trust_level = "trusted"` project entries to the user's Codex config.toml.
The CLI also persists its own threads and associated data. Plugin installations copy the runner's code into
read-only snapshots under the state root's `runtime/`, which the runner never deletes. Runner state keeps prompts, results, worktrees and job records;
durable result copies and invocation audits outlive run cleanup. Worktree branches remain after closing.

## Process ownership

One dedicated app-server belongs to one gated driver per turn. No shared Codex daemon is controlled.
Background tool processes can outlive `turn/completed` until the app-server exits; turn completion alone is not proof of quiescence.
The default warm window is zero. The runner waits for owned process exit before freeing writer exclusion.
Cancellation first sends turn/interrupt. Fallback stops use recorded creation identities, held handles on Windows and fresh
identity checks on POSIX. No process is stopped by bare PID. Unknown identity or surviving children retain state and locks.

Intentionally detached commands can escape ordinary descendant observation; their shutdown is not guaranteed.

Artifact verification is an explicit **trusted-local** execution profile, not an OS sandbox.
The caller supplies an executable and argv; no shell or dependency installation is added. Repository
code can access the account's files and network. Use it only for code you authorize locally.
Windows assigns the suspended command to a kill-on-close Job Object before executing it and waits
for all job members to stop. POSIX uses a held process-group leader, kills its group and checks for
survivors; deliberate session/group escape is outside this profile. Lost settlement evidence yields
an uncertain receipt. Attempts are never automatically repeated. Logs and recipes can contain
sensitive data and stay local; normal output includes metadata and receipt paths, without log previews or recipe argv/environment values.

Verification starts from the complete sealed commit checkout, with sparse checkout disabled. An in-memory
baseline records its actual checkout bytes, including Git's normal line-ending representation. Final inspection
compares those bytes, paths and file types directly, independently of the command's index and ignore flags.
Final mutations invalidate the result; temporary edits restored before inspection remain unobservable.
Settled snapshots are removed only after their directory and Git identities are confirmed; logs and receipts
remain. Uncertain processes or changed identities retain the snapshot for inspection.

Runner-owned Git operations disable repository hooks, executable fsmonitor and automatic signing, and use
the original object graph without replacement refs. Applicable external content filters are refused rather
than bypassed with different content semantics. Integration refuses to overwrite ignored target content.
These controls apply to the runner's Git commands; normal developer commit and push hooks still run.

## IPC and readable state

Local control uses a named pipe on Windows or a Unix socket, with mutual nonce/HMAC authentication and generation fencing.
Secrets never travel on the wire. An endpoint name or PID is not sufficient authority.
Windows named pipes use system-default ACLs, which can permit reads by Everyone and Anonymous and SMB
loopback access. Do not assume that the endpoint is private to the account or inaccessible over the network.

**Sandboxed Codex commands can read the runner's state root**, including every retained prompt, result and IPC secret file.
The secret's 0600 mode is not a Windows confidentiality guarantee. HMAC protects identity and generation, not secrecy from
the same user; a same-user process can read secrets and open control endpoints. State isolation is not isolation from model tools.
Optional local ACL hardening must be configured and tested by the operator; it is not promised by this release.

Prompts stay out of argv and invocation audit rows. Worker-death audit captures only terminal metadata and bounded event/log
tails with exact current/archived prompt and steer echoes redacted. Missing inputs or exhausted matching
budgets withhold text. Progress applies the same filtering before truncation; it excludes messages, tool
arguments and command output. Generated or paraphrased task details may still appear in summaries or paths.
Full run state and ordinary result files are sensitive task artifacts.

## Compatibility and reporting

The tested CLI baseline is informational, not a version allowlist. Desktop-private and sandbox-private binaries
are excluded. Kept runs remain bound to their identified executable and refuse an identity change; an
unresolvable launcher requires an explicit native executable path. Required RPC methods and safety settings
must still work. Accepting a version does not certify its behavior or available models.
Unsupported state formats are observational only except conservative forced quarantine of ended state.
No OpenAI extension source or generated schema is distributed here. LICENSE and NOTICE remain authoritative.
Report reproducible issues using [SUPPORT.md](SUPPORT.md), excluding credentials and unnecessary task contents.

For a vulnerability, use GitHub's **Report a vulnerability** action on this repository's
[Security page](https://github.com/PolaronQuasi/codex-subagents-for-claude-code/security) when private
vulnerability reporting is available. The maintainer must enable and verify that route before public
publication; this document does not enable it. If the action is unavailable, use an established private
channel to PolaronQuasi or ask for a private contact route without disclosing the vulnerability in an issue.

Windows verification accepts completion evidence only with a proof from its owned supervisor
and a clean supervisor exit. The one-attempt proof key is passed through a private pipe before
the command starts and is never stored in the recipe, environment or report. Invalid evidence
retains an uncertain receipt and its snapshot. This protects report provenance within the
trusted-local workflow; it does not turn verification into a sandbox against the same user.

The control connection pool evicts the oldest unauthenticated peer when full, preserving
already authenticated connections. Malformed login or signed replies fail with `IPC_AUTH_FAILED`.
This keeps a fixed set of idle connections from blocking cancellation or steering; it is not a
resource-isolation guarantee against a hostile program running as the same user.
