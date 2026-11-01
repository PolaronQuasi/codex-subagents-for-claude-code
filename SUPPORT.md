# Getting help with Codex subagents for Claude Code

Start with the [installation guide](README.md#installation), [examples](docs/EXAMPLES.md) and
[troubleshooting guide](docs/OPERATIONS.md#troubleshooting).

The repository is [PolaronQuasi/codex-subagents-for-claude-code](https://github.com/PolaronQuasi/codex-subagents-for-claude-code),
maintained by [PolaronQuasi](https://github.com/PolaronQuasi). While the repository is private,
its source and issue tracker require access granted by the owner.

For account access or a model rejected outside this wrapper, use the Codex account or CLI support
channel. For problems with the runner's lifecycle or documentation, contact this repository's
maintainer.

Use the [GitHub issue tracker](https://github.com/PolaronQuasi/codex-subagents-for-claude-code/issues)
for ordinary bugs, or an established private maintainer channel.
No separate support site, service-level
agreement or response-time commitment is declared. Report sensitive issues using
[security reporting](SECURITY.md#compatibility-and-reporting).

## Useful bug reports

Include the following, after reviewing the output for private paths and task content:

1. Runner version/tag, OS/shell, Node, Git, actual Codex CLI version/path and installation method
   (plugin or checkout). Codex 0.166.0 is the tested reference; a different version alone is not a refusal.
2. The exact command and a minimal task file using a disposable repository.
3. Expected behavior, observed behavior, exit code and the final result footer when one exists.
4. Whether this was a launch, attach, continuation, cancellation, close or sweep.
5. Relevant diagnostics from `--doctor --read-only`, or `/codex-subagents:codex-doctor` for a plugin
   install. For a checkout install, also run `node install.mjs --check` from that checkout; the
   plugin payload does not include the installer. For a retained run, include `--inspect RUN_KEY --json`.
   Inspection accepts the printed hexadecimal key, not `rq:`.

Do not publish a whole result directory, Codex rollout or raw run record without reviewing it; those
can include prompts, source and private metadata. `--inspect` itself does not change state. A
missing or broken durable result should be recovered before closing the run.

For a batch, include the manifest's child status and process/ownership evidence after redaction;
never relaunch an uncertain child to produce a report. For verification, include the receipt's
outcome, cleanup state/reason and bounded log details. Settled verification snapshots are removed
when identity checks permit cleanup, so their absence is expected. Logs and receipts remain;
uncertain process or snapshot identity retains the checkout. Do not rerun an attempt with a new ID
without first resolving any possible live execution.

For apparent stale limits or model information, report the cache source/age and whether the observation
was live or cached. Cached quota cannot establish current login, and the model catalogue is not
account entitlement. See [cache behavior](docs/MANUAL.md#caches-and-retained-state).

## Update or remove an installation

Use the [release workflow](docs/DEVELOPMENT.md#releasing) for a live checkout with `dist/current`;
pulling source alone does not activate new immutable modules. Back up customized definitions before
running the installer. Re-run `node install.mjs --check` after an update and restart Claude Code.

For a checkout install, run these commands from the checkout that created the definitions, with
the same agent/skill directory overrides:

```sh
node install.mjs --uninstall --check
node install.mjs --uninstall
```

The preview writes nothing and reports `would-remove`, `preserved` or `missing` for each target.
Exit 1 means owned files remain or a preserved conflict needs review. The actual uninstall reports
`removed`, `preserved` or `missing`; it exits 1 for preserved conflicts. Repeating it is safe.
Ownership receipts and matching content identify files from this checkout. Definitions without a
matching receipt entry are preserved even when their content matches the current rendering.
Edited files, another checkout's files and unproven files remain; review them or
restore your backups. Linked paths are refused. There is no `--force` option.
Receipts are local ownership records, not authenticated proof against another process running as
your user. Keep the definitions and their receipts unchanged while uninstall runs; pathname checks
cannot make concurrent directory replacement safe.

Uninstall removes definitions, not the checkout itself or shared `~/.claude/agents` and
`~/.claude/skills` directories. It leaves result files, audits, state, runtime snapshots, Codex history
and worktree branches untouched. Before separately removing a checkout or runtime snapshot, collect
or deliberately cancel your own active runs and close retained runs that depend on it, including
idle conversations. Preserve wanted results and branches. See
[storage and diagnostics](docs/OPERATIONS.md#storage-and-diagnostics).

For a plugin install, use Claude Code's plugin manager:

```sh
claude plugin uninstall codex-subagents@codex-subagents-for-claude-code --scope user --keep-data
```

Select the original installation scope (`user`, `project` or `local`). `--keep-data` preserves any
Claude-managed plugin data; runner results and snapshots are already outside the plugin cache.
Do not delete another plugin's cache or marketplace. Follow [switching or uninstalling](README.md#switching-or-uninstalling)
to change installation type, then restart Claude Code or run `/reload-plugins`.
