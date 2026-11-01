# Codex subagents for Claude Code: requirements and tested compatibility

For setup, see [installation](https://github.com/PolaronQuasi/codex-subagents-for-claude-code/blob/main/README.md#installation), [CLI selection](OPERATIONS.md#installing-and-selecting-codex-cli)
and the [worked examples](EXAMPLES.md). For failures, start with [troubleshooting](OPERATIONS.md#troubleshooting).

## Runtime prerequisites

Node.js 22+, Git (release checks use 2.39+) and a logged-in Codex CLI are required.
**codex-cli 0.166.0 is the tested reference. Any Codex version may be selected**; this is not a
promise that every version supports the required protocol or every runner feature.
Windows forwarders use Git Bash and process identity helpers use PowerShell. Claude Code installers do not supply Node.
The runner has no npm runtime dependencies. Windows comes first; Linux and macOS use the same stdio protocol and Unix sockets.

## CLI selection

Select `CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH` first, then an explicit `..._CODEX_DIR`, otherwise PATH order.
Resolve links and record found path, real path, version and build. Never search the current directory implicitly.
Exclude WindowsApps, `%LOCALAPPDATA%/OpenAI/Codex/bin/*` and `~/.codex/.sandbox-bin`, including links to those copies.
Version differences alone are accepted; no `CODEX_SUBAGENTS_FOR_CLAUDE_CODE_ALLOW_CODEX` override is
required. Executable safety checks, native payload identification and required app-server protocol
checks still apply. Kept runs refuse changed paths, builds, versions or native payload fingerprints
before starting another turn. Start a new run after deliberately selecting a changed executable.

## Model and effort selection

Roles select model slugs with xhigh defaults. Explicit model and effort values pass literally,
including max and the explicitly selected ultra. See the [role catalogue](https://github.com/PolaronQuasi/codex-subagents-for-claude-code/blob/main/README.md#roles).
An account/provider can reject a model or effort; the runner never silently downgrades or substitutes one.
Doctor uses `account/read` for login. `model/list` can succeed while logged out and cannot establish
real model access. A model catalogue may be reused for the same CLI build and UTC day; it is not
keyed by account entitlement. Cached refusals are refreshed before rejection. See
[caches and retained state](MANUAL.md#caches-and-retained-state) for refresh and failure behavior.

## Certification

Treat the tested CLI reference and the observations below separately from runtime admission.
Accepting a version number is not certification. Record the actual CLI, OS, account/provider,
requested model and effort when reporting a result; fake tests do not establish live model access.

The ordinary suite uses an independent fake Codex and makes no real model calls.
The contract lane regenerates schema in scratch and checks the exact protocol surface before running the fake driver.
Generated schema is never committed. See [CONTRACT.md](../CONTRACT.md) for the method and policy contract.
Live model access, platform integrations and commands that deliberately detach require separate validation.

## State and disclosures

Run records use schema version 2 and include CLI identity and driverProtocol. The schema version is independent
of the runner's release version. Records that fail validation are retained for inspection;
active operations refuse them, while forced close can quarantine ended state after process checks.
Locks and claims remain respected. No migration or interpretation of other record formats is provided.

Configuration is inherited by default, including notify, hooks and OTEL exporters (which may log prompts).
Write jobs may persist trusted-project entries. Background processes can outlive terminal notifications until app-server exit.
Sandboxed commands can read the state root. `mcp: off` disables inherited integrations and telemetry exporters for a turn,
while preserving native login. Runner-managed Git operations separately disable hooks/fsmonitor
and refuse external filters; developer Git hooks and user settings remain unchanged. Read
[SECURITY.md](../SECURITY.md) before delegating sensitive data.
