# Developing Codex subagents for Claude Code

Use this guide to find the source files, change agents and the skill, run checks, and release or
roll back a version.

For installation and use, start with the [README](../README.md), [manual](MANUAL.md) and
[operations guide](OPERATIONS.md). Read [contributing](../CONTRIBUTING.md) for contribution scope and
review expectations.

For a visual introduction, read the [architecture and lifecycle diagrams](diagrams/README.md).
Their editable Mermaid sources and SVG exports live together in `docs/diagrams/`.
The release tool copies this folder with the documentation and includes `LICENSE` and `NOTICE`
both at the installation root and inside each immutable release. Their hashes participate in
release identity and verification, so legal-file changes require a new release just as code changes do.

## Repository layout

| Path                                                | Responsibility                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `run-codex-task.mjs`                                | Entry shim: loads the immutable release selected by `dist/current`, or source in a fresh checkout.      |
| `src/cli/`                                          | Options, task headers and command dispatch.                                                             |
| `src/run/`                                          | Launch, attach, continuation, cancellation, history recovery and delivery coordination.                 |
| `src/codex/`                                        | CLI identity, dedicated app-server RPC, authenticated driver IPC, progress and steering.                |
| `src/state/`                                        | Run/job records, immutable terminal output, locks, turn transitions, request claims and guarded caches. |
| `src/delivery/`                                     | Durable results, stdout limits, accounting and footer formatting.                                       |
| `src/maintenance/`                                  | List, inspect, doctor, limits and explicit sweeps.                                                      |
| `src/shared/`                                       | Filesystem, process identity, audit, bounded prompt redaction and shared constants.                     |
| `src/roles.mjs`, `src/version.mjs`, `src/index.mjs` | Model catalogue, runner version and public exports.                                                     |
| `claude/`, `install.mjs`                            | Forwarder and skill templates, plus the installer.                                                      |
| `.claude-plugin/`, `agents/`, `skills/`             | This repository's Claude Code plugin manifests and generated definitions.                               |
| `plugin/`                                           | Generated installable payload selected by the marketplace; rebuilt from maintained root sources.        |
| `assets/`                                           | Source assets, including the plugin icon copied into the payload.                                       |
| `test/`, `test/fixtures/codex/`                     | Hermetic tests and our fake Codex CLI/app-server. No model calls.                                       |
| `tools/`, `.githooks/`                              | Checks, formatting, contract certification, packaging and managed releases.                             |
| `.github/`, `ci/gitea/`                             | GitHub workflows and optional self-hosted Gitea runner tooling; local environment files stay ignored.   |
| `docs/`, `docs/diagrams/`                           | Usage/development guides, editable Mermaid diagrams and generated SVGs.                                 |
| `releases/`                                         | Managed-installation receipts created during local releases.                                            |
| `dist/`                                             | Untracked immutable release folders and the active `current` pointer.                                   |

Not versioned: `dist/`, `results/` (durable result copies), `node_modules/`, a staged `*.next.mjs`
and the probe log.

The tooling lives in its own repository on purpose: sessions use it whatever branch a project
checkout is on, and a project's branch switches, automatic commits or documentation checks must not
change it under them.

## Portable archive contents

Portable archives include these root files: `LICENSE`, `NOTICE`, `README.md`,
`CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, `CONTRACT.md`,
`package.json`, `run-codex-task.mjs`, `install.mjs`, `.editorconfig`,
`.gitattributes`, `.gitignore`, `.prettierrc.json` and `.prettierignore`; and these folders:
`.githooks/`, `.claude-plugin/`, `plugin/`, `assets/`, `agents/`, `skills/`, `src/`, `test/`, `tools/`,
`claude/`, `docs/` and `ci/`.
They exclude all of `docs/local/`, the GitHub workflows and templates (`.github/`), installation
receipts (`releases/`), machine state (`dist/`, `results/`) and any path component
named `.runner`, `.env` or beginning with `.env.`. The archive manifest lists each
included file and its hash. Compare that inventory with this list when changing the layout.

## Agents and the skill

Claude Code reads agents from `~/.claude/agents/` and skills from `~/.claude/skills/`, so those are
installed copies; edit the sources here and run `node install.mjs`. It renders one forwarder per
role in the `ROLES` table of the runner the entry loads (the release `dist/current` names, or `src/`
without one), and the skill, filling these placeholders:

| Placeholder                          | Becomes                                                                                                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{role}}`, `{{model}}`, `{{alias}}` | The role, and its display name and aliases from that release's catalogue (`src/roles.mjs`); the selected release must export matching role and display tables. Explicit rendering inputs with missing display entries get derived names and a warning (agents only). |
| `{{runner}}`                         | This folder's `run-codex-task.mjs`, as an absolute path with forward slashes.                                                                                                                                                                                        |
| `{{manual}}`                         | This folder's `docs/MANUAL.md`, likewise.                                                                                                                                                                                                                            |
| `{{tmp}}`                            | The system temporary folder, likewise.                                                                                                                                                                                                                               |
| `{{taskfile}}`, `{{prepare}}`        | The task file a forwarder writes (`{{tmp}}/codex-subagents-for-claude-code/<role>-<8 random lowercase hex characters>.md`; the skill's example names `<role>-<8 hex>.md`), and nothing.                                                                              |

Plugin definitions are rendered from the same templates by `node install.mjs --plugin` into
`agents/<role>.md` and `skills/codex-subagents-for-claude-code/SKILL.md` at the repository root.
`npm run build-plugin` runs that rendering and then packages the installable `plugin/` tree.
The definitions contain no machine path: `{{runner}}` is
`<runner path>`, `{{manual}}` `${CLAUDE_PLUGIN_ROOT}/docs/MANUAL.md` (Claude Code substitutes the variable in
agent and skill text, not in the Bash environment), `{{taskfile}}` `<task path>`, and `{{prepare}}` the step
that runs `node "${CLAUDE_PLUGIN_ROOT}/run-codex-task.mjs" --prepare <role>` first. `--prepare` makes sure
the runtime snapshot (`src/shared/runtime-release.mjs`) of the release it runs exists and prints its
`runner:` and an unused `task-file:` in the temporary folder (Claude Code protects `~/.claude`, so a
forwarder cannot write task files under the state root). The plugin's roles are those of `src/roles.mjs`.
`node install.mjs --plugin --check` writes nothing and exits 1 on drift; `check` runs it when
`.claude-plugin/` exists, holds `plugin.json`'s `version` to `RUNNER_VERSION`, and requires
`marketplace.json` to list the plugin once, from `"./plugin"`, without a version of its own.
`npm run check-plugin` checks both root renderings and the packaged payload without writing them.
`claude plugin validate --strict .` validates the marketplace and the plugin.

The plugin registers no hook, monitor or MCP server, and `test/plugin.test.mjs` keeps it so. The runtime
snapshot is the only thing a hook could have prepared, and `--prepare` makes it on demand before every launch,
whichever session or plugin version asks. A SessionStart hook would add a Node start-up to every session, also
those that never delegate, and would not run where the user's policy turns hooks off. A quota refresh at session
start would be a network call. Invoked runner operations stop owned processes during cancellation,
turn cleanup and recovery. Stops require recorded process identity; see [process ownership](../SECURITY.md#process-ownership).

A placeholder left unfilled stops the install. The sources therefore hold no machine paths, and
`npm run check` refuses a tracked source that contains a user-profile path (`C:\Users\<name>\…`,
`/home/<name>/…`, `/Users/<name>/…`); write `~`, `$HOME` or a placeholder instead.

`node install.mjs --check` writes nothing and exits 1 when an installed copy differs or is missing;
`npm run check` runs it against the selected install folders in every checkout. Use the scratch
overrides in [isolated contributor setup](#isolated-contributor-setup) for manual checks. Commit and
push hooks render disposable definitions automatically. Restart Claude Code after updating installed definitions.

To add a model: add one entry to the catalogue in `src/roles.mjs` (model, default effort, display
name and aliases). It derives both `ROLES` and the installer's `DISPLAY` table. Defaults remain `xhigh`; selectable `max` uses the owned app-server submission path and
requires support from the selected model. Add the model to the README's Roles table and its role to the skill's
sentence "There is one role per model: …" (`npm run check` reports a role missing from that list,
or listed there but absent from `ROLES`), update the intentional render baseline, run the tests,
release, and run `node install.mjs`. Until that release is active, the installer renders the active
release's roles only. Use the CLI model picker to confirm account access.
`codex debug models`, when available in the installed CLI, provides catalog details; it is a debug
interface, not a stable prerequisite.

`test/fixtures/role-rendering.json` intentionally pins rendered agent and skill bytes. When changing
those Markdown sources, generate `plannedFiles({ paths: baseline.paths })` from `install.mjs` and
replace the baseline's `sha256` map with SHA-256 hashes keyed by each target basename. Preserve the
fixed paths and role/display tables unless those actually changed. Review both the source diff and
the hashes; do not remove the equality test to accommodate drift. All entries describe the current
rendering. Uninstall ownership comes from installation receipts, not this test fixture.

The fake-Codex suite uses native test launchers so production executable checks stay enabled.
Windows builds the small checked-in C# fixture with the existing .NET Framework compiler; Linux
x64 uses a fixed static fixture with checked-in C source, rebuild command and SHA-256. Other
POSIX hosts need an existing `cc` compiler. No runtime dependency or compiler installation is
performed by the suite. Tests continue to use the isolated fake backend for model turns.

## Isolated contributor setup

Commit and push hooks render and validate definitions in temporary folders automatically, then
remove those folders. They do not read or rewrite your live Claude agents or skill, and need no
installation overrides. The push hook also runs the test suite.

For manual installer work and `npm run check`, use a dedicated terminal with these overrides to
keep writes and installed-copy comparisons out of the real Claude profile. Alternatively,
`npm run ci` renders temporary definitions and runs source checks and tests automatically.

PowerShell:

```powershell
$checkRoot = Join-Path ([IO.Path]::GetTempPath()) ("codex-subagents-for-claude-code-check-" + [guid]::NewGuid().ToString('N'))
$env:CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR = Join-Path $checkRoot 'agents'
$env:CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR = Join-Path $checkRoot 'skill'
node install.mjs
node install.mjs --check
npm run check
npm test
```

Bash:

```bash
check_root=$(mktemp -d "${TMPDIR:-/tmp}/codex-subagents-for-claude-code-check.XXXXXX")
export CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR="$check_root/agents"
export CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR="$check_root/skill"
node install.mjs
node install.mjs --check
npm run check
npm test
```

Use `npm run setup` once per clone to enable the repository hooks. Close the dedicated terminal afterward, or
restore any prior override values before working on a live installation. The scratch definitions do
not need to be loaded into Claude Code to run the tests.

The source suite uses temporary agent definitions and our fake Codex CLI. Its filesystem guard rejects reads
of installed plugin trees and profile configuration before reaching the filesystem, but not of the
checkout's own tree, so the suite also runs in a clone inside `~/.claude`.

## Tests

`npm run contract` regenerates JSON schema from the selected standalone Codex CLI into scratch,
checks the shapes used by this implementation, and runs our fake Codex regressions. It reads no
OpenAI Claude Code extension source, starts no real app-server and makes no model calls. Select the
binary with `CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH`. The tested version is recorded in
`CODEX_VERSION_RANGE`; it does not restrict admission to that version. No allow override is needed
to evaluate another CLI. Review [CONTRACT.md](../CONTRACT.md) when updating the tested baseline.

```bash
npm test              # node tools/test-files.mjs run: every *.test.mjs under test/
npm test -- --test-name-pattern=paths   # options for node --test, before the files
npm test -- test/paths.test.mjs         # the files named, instead of the discovery
npm run ci            # render scratch definitions, check source, then run the suite
npm run check         # syntax, versions, machine paths, skill role list, installed agents and skill
npm run format:check  # the pinned Prettier, width from .prettierrc.json, as CI runs it
git diff --check      # whitespace errors in the working diff
```

One discovery, `tools/test-files.mjs`, finds the suite: every `*.test.mjs` under `test/`, at any depth, with fixture folders left out. `npm test` and the `pre-push` hook run it
(`node tools/test-files.mjs run`), `tools/ci.mjs` runs what it finds, and `check` syntax-checks every
module under `test/` and `tools/` at any depth, fixtures included; a test with a planted nested file
keeps all four on it. `run` passes the arguments after it to `node --test`: the
options go before the files, and test files named (relative to the repository, where npm runs the
script) replace the discovery. Every argument that does not start with `-` must name an existing
file, so give an option's value after `=`: any other argument is refused with the usage line, so
`node --test` never falls back to its own discovery, which would run the fixtures too.

CI selects Node's TAP reporter so assertion errors, stack traces and expected/actual values
remain visible in the job log. Locally, select it with `npm test -- --test-reporter=tap`.
The CI step repeats recorded failures and their assertion details at the end. A second incremental
TAP log lets it summarize earlier failures even if a later test reaches the subprocess deadline;
an incomplete report is labelled as such. Large diagnostics are bounded and refer back to the live log.
The complete Windows suite has a 60-minute subprocess deadline inside a 90-minute hosted job,
including setup and protocol checks. Other platforms retain the 20-minute suite deadline and
30-minute job limit. Packaging commands keep their separate 20-minute bound.

The marketplace installs the generated `plugin/` payload. Edit the maintained root sources,
format them, then run `npm run build-plugin` to render the forwarders and rebuild the payload.
`npm run check-plugin` verifies both renderings and every payload byte, including its inventory.
The ordinary source check, commit hook and CI also reject missing, stale or unexpected payload files.
Generated files are excluded from a second Prettier pass; never edit them directly.
These package checks and the fake-backend tests do not certify live Claude Code registration or
Codex model access; validate that integration separately when deliberately requested.

The payload includes the runtime, forwarders, skills, user documentation, icon and legal files.
Development tests, CI definitions, hooks and release tooling stay in the marketplace/source clone;
Claude Code's separate plugin cache receives only the payload. This reduces the plugin cache, not
the marketplace's Git clone. Source archives include the generator and payload so offline checks work.

Platform-specific tests skip where their OS facilities are absent, including Windows process
handles and PowerShell, Linux/macOS zombies, and privileged file symlinks. Retain the test command and
its pass, fail and skip counts with the verification evidence. See
[compatibility](COMPATIBILITY.md#certification) for the platforms.

`check` scans what a release copies: in a checkout its tracked files under the entry and every
copied top-level entry, `.github/` and `ci/` included, and in a copy without git the files
its `.gitignore` files do not exclude. Every text file there is held to the user-profile path rule
above and rejected for trailing spaces/tabs and missing final newlines (LF and CRLF are both
accepted). Two exceptions are explicit in `tools/release.mjs`: the diagrams' SVG exports, which the
Mermaid CLI writes as one line, skip the whitespace rules, and under `ci/gitea/` the node
user's home in `/home`, a container path of the runner image, is no machine path. `check` does not
scan durable results or parse JavaScript style. Hooks check both staged and unstaged diffs for
whitespace errors; no linter or development
dependency is installed. Formatting is the separate `npm run format:check` (`npm run format`
rewrites): it fetches the pinned Prettier with `npx`, so the offline hooks and `npm run ci` do not
run it, and both workflows do.

Codes, errno codes, signals and exit values are named once in `src/shared/errors.mjs`, a module without
imports; platform names, job statuses, the helpers' vocabularies and the timing, retry and size
policies in `src/shared/constants.mjs`. `test/error-codes.test.mjs` fails on a code, errno code, signal,
exit value, platform name or job status written inline in `src/`, `tools/` or `install.mjs`, on a
vocabulary word written inline in `src/`, on a registry key that does not exist, on an exit
status returned as a number, and on a timing, retry or size number written inline in `src/`,
`tools/` or `install.mjs`: a timer, a sleep, a deadline (in any case), a retry, round, probe or
count limit, a loop bound, a comparison with a limit or with a number of two digits or more, a
slice, a default parameter or an option key named for a time, a size or a count (`…Ms`,
`…Bytes`, `…Retries`, `…Attempts`, `…Rounds`, `…Lines`, `…Chars`, in camelCase or
SCREAMING_CASE or as the word alone) or for a limit (`limit`, `count`, `attempts`, `…Limit`,
`…Count`), arithmetic (`%` too) with a number of three digits or more, a call or an array given
one, a decimal number given as a value (a branch of a condition, a default after `??` or `||`,
an object's value of three digits or more), and the options and calls that take one (tests set
their own waits). Any other number set on its own, but 0, 1 and -1, fails too (a `for` loop's
initialiser is no setting; its bound is): in `src/` it belongs in `src/shared/constants.mjs`, a unit such
as a second, a minute or a day in milliseconds included; `src/shared/errors.mjs` names the exit codes.
Arithmetic, calls, arrays, values and two-digit comparisons are read in a line's code alone, its
comments and the insides of its strings, templates and regular expressions blanked over the whole
file (`test/support/code-text.mjs`, which the imports test uses too), but a template's `${…}` kept as
code; arithmetic is an operator with a space on each side, as Prettier writes it, so a date, a
slash in prose or a file mode (`0o644`) is none. The errno codes and signals it knows are
POSIX's and the host's, so it reads the same on Windows, which lacks some, and a settlement reply
that is an everyday word (`"ready"`, `"changed"`, `"live"`) fails where it is compared, returned, switched on,
printed, written, resolved or given as a value. Each of its detectors must catch a planted line and
leave a planted look-alike alone, such as `"NODE_OPTIONS"`, `"ESM"`, `"SIGNATURE"`, a log line
saying `"ready to go"`, or an arrow comparator inside `main()`. Tools share error definitions and
protocol, CLI and installation-path helpers with `src/`. Each tool that tells platforms apart defines `IS_WINDOWS` or `IS_LINUX` once at
its top level, and each names its own policies in top-level SCREAMING_CASE definitions, whole
statements however Prettier wraps them; the entry shim, which loads no module before it picks a
release, names its literals in definitions the test enumerates. The tools' tests
(`test/tools/`) and the release tests' fixture are read with `tools/`, as when they lived there,
by every rule but the returns and the policies, which tests set themselves, and the distribution
tests' fixture (`test/support/distribution-fixture.mjs`), once a module of `tools/`, by every rule.

`check` reads the working tree, so the hooks first make sure it is what git records
(`node tools/release.mjs pre-commit` and `pre-push`, which the hooks run):

- `pre-commit` refuses while a file `check` reads has unstaged changes or is untracked; stage it,
  stash it or move it out. It reads the index git hands the hook, so `git commit -a` and a commit
  of named paths are judged by what they commit.
- `pre-push` refuses unless every pushed commit is HEAD, or one the remote already has (as the last
  fetch saw it), and the files `check` reads equal HEAD's. Then `check` and the suite run on what is
  pushed. To push another commit, check it out first.

Both gates render fresh agent/skill definitions in owned temporary folders before calling `check`,
and clean them up on success or failure. Existing installed definitions and installation-folder
overrides do not affect the hook. `npm run check` and `node install.mjs --check` still compare the
explicitly selected installation, so they remain useful for checking a managed live release.

Behaviour tests import `src/index.mjs` directly, passing the stable entry path explicitly. A
sentinel-release regression checks that `dist/current` cannot redirect source imports. Separate
entry tests cover release selection, fallback, CLI invocation, and pointer changes.

Policy tests pass `io.timing = { now, sleep }` to source `main()`. This controls the foreground wait
budget, lock retries, lag confirmations and driver recovery polling. Stored dates, child-process timeouts, socket probes and stdout deadlines use real time.
Real integration tests of those boundaries remain in the suite; there is no timing environment
override.

They pass `io.processes = { probe: { start, commandLine }, stop }` (default `PROCESSES` in
`src/shared/process-stop.mjs`) to replace the OS queries that identify a worker and the identity-bound
stop, so a test can make an identity unconfirmable or a stop fail without a real process. A probe
may also give a launch's start-time `reader` (the default's is one PowerShell per launch on
Windows). Its first answer has a ten-second startup budget; later answers retain the three-second
query budget. A timeout abandons the reader and never accepts a late answer. A probe without a
reader has its `start` asked for each query. Inspection of a still-live driver or app-server
with a saved birth identity retries an unavailable read once with a ten-second budget;
another unavailable read remains unknown and cannot authorize a signal. A probe may also name the
`platform` whose rules its answers follow (`process.platform` by default), so a test on any host
can answer as macOS does, where a changed start time is confirmed only by a command line that is
not ours (`changedStartState` in `src/shared/process-identity.mjs`). Tests that
kill a real process kill only the disposable driver and fake app-server children registered by the fixture, after checking their
start time.

In-process collectors receive `io.onOutcome({ kind: "delivered", status, keep, resultFile })` only
after stdout accepts a delivery, and a command that delivers nothing gives
`io.onOutcome({ kind: "failed", reason })`, the message its error line shows, or
`io.onOutcome({ kind: "still-running", reason })`, the first line of its STILL RUNNING notice.
`main()` still returns the same integer code. Sweeps take their lines from those outcomes alone and
keep nothing the commands print. Durable-copy replay derives its outcome from the stored footer,
requiring the current complete footer; collectors never parse printed text to determine success
or the reason of a failure.

The runner's tests use our fake Codex executable, bounded child processes, private state roots and
throwaway Git repositories. They cover:

- launch, attach, continue, cancel, close and sweeps, including unknown identities and interrupted waits;
- CLI build pinning, MCP policy, sparse quota updates, model pagination and concurrent cache publishers;
- authenticated IPC, generation/turn fencing, lost steer acknowledgements and recovery without resending;
- bounded progress/diffs and redaction of current and archived prompts and steering input;
- immutable terminal answers, durable delivery, partial failure diagnostics and stdout limits;
- request-ID policy, writer locks, continuation rollback, worktrees and scratch workspaces;
- installers, runtime snapshots, releases and the consistency of generated agent/skill definitions.

The throwaway repositories never see the developer's git configuration. Every git a test starts runs
without inherited `GIT_*` variables, with `GIT_CONFIG_NOSYSTEM=1` and with `GIT_CONFIG_GLOBAL`
naming a private, empty file (`test/support/git-environment.mjs`). Each fixture repository is made with
`git init` and `git symbolic-ref` and gets a local identity, commit and tag signing off, and no
`core.hooksPath`. Global hooks, signing helpers and `init.defaultBranch` therefore never reach a
fixture; a git older than 2.32 ignores `GIT_CONFIG_GLOBAL` and still applies the global
configuration. The release tools strip every other `GIT_*` variable by design (see
[Publishing a release](RELEASING.md)) but keep `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and
`GIT_CONFIG_NOSYSTEM`, which only choose the configuration files git reads, so a release function a
test calls in-process reads the private global file too. Fixtures also point `CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR` and `CODEX_SUBAGENTS_FOR_CLAUDE_CODE_SKILL_DIR` at
private folders, so doctor never reads the developer's agents.

Ordinary tests use only disposable fixtures. The test launcher preloads `test/support/hermetic.mjs`,
which rejects filesystem access to `~/.claude` and `~/.codex` (the live agents, skills, settings,
plugins, installation and state root, and Codex's configuration) and to an OpenAI plugin tree under
any folder. Inside those folders it still allows the repository's own tree, found from the guard's
own path (as loaded and as resolved on disk, case-insensitively on Windows and macOS), and the
temporary folder. So the live installation, a clone in `~/.claude`, runs its own suite, while the
folders above and beside it, such as the state root, stay refused. An allowed folder never opens a
guarded folder it contains, nor a plugin tree; `test/hermetic.test.mjs` runs a clone planted in a
temporary profile. The tests never call a model; a live contract check is a separate, deliberate
command. `npm test` works without reading or changing live agents, skills or plugin code.

## Updating the tested Codex CLI baseline

The runner records its tested CLI baseline in `CODEX_VERSION_RANGE` in `src/shared/constants.mjs`.
Other versions are admitted subject to capabilities and safety checks. Update the certification record
with `tools/repin-codex.mjs`, in a development copy, never the live folder:

```bash
node tools/repin-codex.mjs 0.170.0 --codex-path /absolute/path/to/codex   # prints the smoke call
node tools/repin-codex.mjs 0.170.0 --codex-path /absolute/path/to/codex --smoke
```

Version, protocol, executable-identity and missing-anchor checks finish before any source write.
Later writes, generation and optional smoke execution are not a transaction: a failure can leave
edits, and no automatic rollback runs. Inspect the development-copy diff before retrying.

1. The selected executable must identify itself as the requested version. The runner resolves a
   recognized npm launcher to its actual native Codex payload; an unresolved launcher needs an explicit native path.
2. The contract lane (`tools/codex.contract.mjs`, `npm run contract`) must pass against it, run with
   `CODEX_SUBAGENTS_FOR_CLAUDE_CODE_CODEX_PATH` naming that executable. The lane makes no model call.
3. Only then does it rewrite the tested baseline where it is written by hand: the registry, the `--help` text,
   README, SECURITY, CONTRACT, the skill, the compatibility, manual and operations guides, the CI
   workflows' install step, the release notes of `tools/distribution.mjs` and the tests that quote
   the version. Each place is a fixed anchor in the tool's `PINS` table, and every one must still
   be found, or nothing is written: update the table when that wording changes. The tool lists
   any remaining mentions of the replaced baseline for review.
4. It regenerates the root plugin agent and skill definitions with their generated-file inventory,
   then `test/fixtures/role-rendering.json` by the procedure above, since the skill names the tested
   version. It does not rebuild the `plugin/` payload or restore an exclusive runtime version gate.
5. It prints the one real smoke call: a read-only launch of this copy's entry with the role
   catalogue's first model at effort `low`, in a scratch workspace, with a scratch state root and
   results folder under the temporary folder and the explicit executable. It runs that call only
   with `--smoke`, which makes one real model call. Remove the printed scratch folder afterwards.

Then run `npm run format`, `npm run build-plugin` and `npm run check-plugin`, followed by
`npm run format:check` and `npm run ci`. Review and stage the maintained and generated changes
before committing. The updater's tests (`test/tools/repin-codex.test.mjs`) use the fake CLI on a
disposable copy and never smoke.

## Releasing

For GitHub CI, downloadable packages and draft publication, see [Publishing a release](RELEASING.md).
[Gitea hosting and releases](GITEA.md) describes optional self-hosted tooling.
Hosted publication does not activate the live installation.

## Activating a local release

The live installation is this repository's checkout. Its entry `run-codex-task.mjs` reads the
one-line pointer `dist/current` once per invocation and loads the release it names, an immutable,
read-only copy of `src/` under `dist/<version>-<commit>/`; without a pointer (a fresh clone) it runs
`src/` itself. Other sessions run it while you work, so develop in a copy and let the release tool
move the result in:

1. Make a copy: a git worktree (`git worktree add <copy> -b <branch>`) or
   `git archive HEAD | tar -x -C <copy>`. Edit there and run `npm test` there. The pre-commit hook
   checks the copy using its own temporary agent/skill definitions.
2. Bump the version in four places together: `RUNNER_VERSION` in `src/version.mjs`, `version` in
   `package.json` and in `.claude-plugin/plugin.json` (the plugin's users update only when it changes),
   and the `(runner X.Y.Z)` phrase in the README. Run `npm run format`, `npm run build-plugin`
   and `npm run check-plugin`, then `npm run format:check` and `npm run ci`. Review and stage
   the maintained and generated changes. `node tools/release.mjs check` reports version or payload
   disagreement. Commit: the release is named after the
   commit, and a copy with uncommitted changes or an unreadable Git status is refused, as is one
   with untracked files no `.gitignore` excludes, since the release would miss a module not yet
   added (install names them: commit, ignore or remove them first). Source
   symlinks, junctions and other nonregular entries are rejected before installation, so external
   target bytes cannot be published under that commit's identity. A copy that is not itself a git checkout,
   such as one made with `git archive`, is named after a digest of its modules, `LICENSE` and
   `NOTICE` instead, even when it lies inside another repository.
3. Fetch and check for concurrent upstream changes. With the live tracked checkout clean,
   fast-forward `main` to the checked source branch while preserving unrelated local files. Do this
   before the install: the install rewrites tracked files in the live folder, and git would then
   refuse the fast-forward over them. Resolve
   divergence in the development copy rather than resetting shared `main` history. Installed
   immutable modules keep serving the previous version until step 4 flips the pointer. A source-only
   installation has no such pointer protection; stop its callers before updating it.
4. In the live folder, `node tools/release.mjs install --from-dir <copy>`. It copies the copy's
   release files (below) to `dist/<version>-<commit>/`, syntax-checks every module and makes it
   read-only (a folder of that name with the same content is reused, and made read-only again; one
   with other content is never overwritten), copies the other sources, replaces the entry in one
   rename when it changed, flips `dist/current` to the release in one rename, runs `install.mjs`,
   and writes `releases/v<version>.json`. A new invocation loads the release the pointer named when
   it started, never a mix; one already running keeps the folder it loaded.
   - The sources it copies are the copy's tracked files (`git ls-files`) under every tracked
     top-level entry but the entry, `.github/` and `src/` among them (`src/` for a clone without a
     pointer; a test keeps that list complete). Ignored and untracked files stay in the copy. A
     copy that is no git checkout gives the files its `.gitignore` files do not exclude.
   - A path that either side's `.gitignore` excludes is never written, even when the copy tracks
     it, so the live folder's machine-local `ci/gitea/.env` stays as it is; install names
     such a file.
   - Install copies the current source tree without pruning unrelated target files or directories.
     Both source and target ignore decisions are captured before copying any file, so replacing
     a root or nested `.gitignore` cannot erase a target's existing protections during that install.
   - Before writing, install validates every planned target path and every existing ancestor,
     including ancestors above the target root. The standard root-owned `/var`, `/tmp` and `/etc`
     aliases to `/private/var`, `/private/tmp` and `/private/etc` are accepted only with those exact
     destinations; their physical ancestors are checked too. Other symlinks, junctions, hard-linked
     leaves and nonregular destinations are refused. Paths are checked again before each source copy.
   - On POSIX the executable bits follow the ones git records, for unchanged files too; the entry is
     read-only and executable.
   - A release's files are every `*.mjs` under `src/`, at any depth (`src/process/stop.mjs` as well
     as `src/version.mjs`), and `LICENSE` and `NOTICE`, named by `/`-separated paths. One rule,
     `isReleaseFile` in `tools/release.mjs`, says so for every inventory: a folder (the copy, a
     release under `dist/`, a staging folder) and a git tree (a tag, HEAD), so install, the
     manifest's `files`, the reuse of a folder under `dist/`, `verify`, `rollback` and `check` agree
     on them. Only regular files count: a link, a junction or a submodule where a release file can
     be is refused, never followed. The rule tells case, as git and Linux do, so `check` names a
     file under `src/` that ends in `.mjs` in another case (`.MJS`, `.Mjs`): Windows and macOS
     would load it, but no release would hold it. Every inventory is in code-unit order, never a
     locale's, so the content digest that names a release from a copy without git is the same on
     every machine.
5. In the live folder, use its normal install destinations (not the scratch overrides), run
   `node install.mjs --check`, `npm run check` and `npm test`. Commit only the new
   `releases/v<version>.json` manifest after inspecting the diff, and tag that manifest commit right
   away with `node tools/release.mjs tag`. It refuses unless HEAD is the commit that recorded
   `releases/v<version>.json`, and while a tracked file has uncommitted changes (untracked files do
   not count). Until the tag exists, `check` warns that the newest manifest has no tag, and
   `npm run verify` reports it as `untagged=<version>` with a problem, so run `npm run verify` after
   tagging. Then push `main` and that exact `v<version>` tag. The pre-push hook runs the checks and
   suite; do not bypass it or push unrelated tags.

`verify` is for an installed release. A fresh clone without `dist/current` runs source normally but
fails that integrity check until a managed release is installed. The release manifest records hashes
and environment; it is not itself proof that live model or cross-platform tests passed.

Other commands:

Before a release is published or reused, a bounded child Node process imports its `src/index.mjs`
and checks all required exports and `RUNNER_VERSION`. A bad import, missing export or wrong version
leaves the pointer untouched and removes the staging folder. This is separate from each module's
`node --check`.

Activation is not a transaction across files. `install` runs five steps, in order: preflight
(everything it reads and asks git, the copy's entry included, before its first write), stage (the
release folder, then the other sources), activate (the entry, then the pointer), agents and
manifest; its comment in `tools/release.mjs` says what a failure in each leaves. A failure before
the stage changes nothing, so a copy without its entry is refused with the target as it was.
After the pointer flips, an agent installation or manifest failure leaves the new release
active. Inspect `dist/current` and `verify`, fix the failed post-activation step or explicitly roll
back with `node tools/release.mjs rollback VERSION`; no automatic rollback runs underneath sessions
that may already have loaded the new release.

Agents and skills are staged beside their targets and renamed one file at a time; a failed stage or
rename removes that temporary file. Earlier files from the same installer invocation may already
have been updated. Manifests likewise use a unique sibling temporary file and one rename, with
cleanup on failure, so readers see either the previous complete JSON or the new complete JSON. These
policies do not make the whole release transactional. Immutable module staging is discarded before
activation on failure; pointer retries preserve the prior pointer if replacement fails. A manifest
failure happens after activation.

- `node tools/release.mjs verify` reports whether the entry and the release `dist/current` names are
  the committed ones (byte for byte against HEAD) and read-only, and names what differs or is
  missing. It also lists every `releases/v*.json` without its tag (`untagged=`), each as a problem
  too: a release that was installed but never tagged.
- `node tools/release.mjs rollback VERSION` flips `dist/current` to the release of tag `vVERSION`,
  materialized from the tag when it is not under `dist/` yet, and replaces the entry when that tag's
  differs; the other files stay at HEAD until the fix is released. Both releases use the current
  modular inventory, including nested module paths. The tag must contain `tools/check-stage.mjs`;
  its own checker must pass before activation. Verify reports a mismatch while a deliberately
  different release is selected under the current HEAD; restoring the aligned release passes.
- `npm run setup` once per clone points git at `.githooks/`. On POSIX it also makes the hooks
  executable when they are not (git skips such a hook without a word), and says so.

The release tool asks git in three ways, and none reads a failure as an answer. A required command
(a listing, a blob, a tag) that fails stops the command with git's own reason. A committed file
counts as missing only when git's listing has no such path (or no such ref), never because reading
it failed. A current modular tag must contain `src/version.mjs`. A yes-or-no
question, such as whether a tag exists, is git's exit status 0 or 1, and any other status is a
failure. A git that ran and was cut off, its output over the tool's limit or the process killed, is
such a failure too; only a git that could not start (not found, or not allowed to run) is reported
as one that cannot run. So an object git cannot read, or a git that cannot run, stops `verify`,
`rollback`, `tag` and `install` before they change anything (an install's git questions all come
before its first write), and `check`, which only warns about tags, warns that it could not ask.

Releases are tagged `v<version>`.

Code, tests and documentation describe current behavior and data without a release chronology.
Describe a record, claim, copy or footer by the fields it has or lacks. Packaging generates a
release summary with the version, exact commit and installation prerequisites.

The runtime module map above describes the owned implementation. Protocol certification lives in
`tools/codex.contract.mjs`; `test/fixtures/codex/codex.mjs` supplies the fake executable. Every model
turn and steer in the ordinary suite goes to that fake, including literal `max` effort and resume.
