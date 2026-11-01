# Codex subagents for Claude Code

Version 1.0.0. Requires Node.js 22+, Git, Claude Code and a logged-in compatible Codex CLI.

Install from the repository marketplace in Claude Code:

```text
/plugin marketplace add https://github.com/PolaronQuasi/codex-subagents-for-claude-code.git
/plugin install codex-subagents@codex-subagents-for-claude-code
```

Use the named GPT forwarder agents or the direct-use skill to delegate tasks.
The user commands are:

- `/codex-subagents:codex-limits`
- `/codex-subagents:codex-list`
- `/codex-subagents:codex-doctor`

See the [manual](docs/MANUAL.md), [examples](docs/EXAMPLES.md),
[operations guide](docs/OPERATIONS.md), [compatibility](docs/COMPATIBILITY.md)
and [security notes](SECURITY.md). Full installation instructions live in the
[repository README](https://github.com/PolaronQuasi/codex-subagents-for-claude-code/blob/main/README.md#installation).

This directory is generated from the repository's maintained runtime, rendered
agents/skills, selected user docs, manifest and icon. Development files stay in
the repository. Change those sources, render with `node install.mjs --plugin`,
then run `node tools/plugin-package.mjs build`. CI checks the byte inventory with
`node tools/plugin-package.mjs check`; do not edit or format this copy independently.
