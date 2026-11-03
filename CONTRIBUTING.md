# Contributing to Codex subagents for Claude Code

The project's code, documentation, diagrams and templates are licensed under
[Apache-2.0](LICENSE). Unless you explicitly state otherwise, contributions intentionally
submitted for inclusion are provided under the same license. Submit only material you have the
right to contribute, and preserve applicable third-party license and attribution notices.

Work in a development copy, because a live installation can serve other Claude Code sessions. Use
the [isolated setup](docs/DEVELOPMENT.md#isolated-contributor-setup), then run `npm test`,
`npm run check`, `npm run format:check` and `git diff --check`. There are no package dependencies
to install; the two format scripts (`npm run format` rewrites the files) fetch the pinned Prettier
with `npx`, and CI runs the same `format:check`. The checks make no model calls; a live model test
is a separate, deliberate action using account capacity.

Keep a change focused and explain the problem, resulting behavior, verification and remaining
limitations. Add meaningful regression coverage for behavioral fixes. Documentation-only edits need
accurate commands, links and version references; do not add tests that merely mirror prose. When
editing forwarder or skill sources, deliberately refresh and review the rendering baseline as
described in [development](docs/DEVELOPMENT.md#agents-and-the-skill).

Current sources of truth:

| Topic                                   | Source                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Role names, model slugs and defaults    | `src/roles.mjs`                                                           |
| Formatting (Prettier version and width) | The `format` scripts in `package.json`, `.prettierrc.json`                |
| CLI surface and task syntax             | `src/cli/options.mjs`, `src/cli/task-input.mjs`, [manual](docs/MANUAL.md) |
| Upstream integration assumptions        | [CONTRACT.md](CONTRACT.md), `src/codex/`, `tools/codex.contract.mjs`      |
| Known limitations                       | [Security](SECURITY.md), [operations](docs/OPERATIONS.md)                 |
| GitHub repository maintenance           | [Setup and release checklist](docs/GITHUB-SETUP.md)                       |
| Public hosting and discoverability work | [Publishing guide](docs/PUBLISHING.md)                                    |

Use the repository's pull-request review workflow. Do not include local task results, rollout
files, audit logs, personal paths or credentials in a change. Version bumps, immutable release
installation, release manifests and tags follow the [release procedure](docs/DEVELOPMENT.md#releasing).
