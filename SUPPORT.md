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
5. Relevant diagnostics from `--doctor --read-only`, `node install.mjs --check` and, for a retained
   run, `--inspect RUN_KEY --json`. Inspection accepts the printed hexadecimal key, not `rq:`.

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

There is no uninstall command. First collect or deliberately cancel your own active runs, then close
retained runs using their keys. Preserve wanted result files and branches. Review the role
filenames in the [catalog](README.md#roles) and the installed
`~/.claude/skills/codex-subagents-for-claude-code/SKILL.md`; remove only definitions belonging to this installation, or
restore your backups. Do not delete the entire shared `~/.claude/agents` or `~/.claude/skills`
directory. Results, audits, Codex history and worktree branches have separate lifetimes, described
under [storage and diagnostics](docs/OPERATIONS.md#storage-and-diagnostics).
