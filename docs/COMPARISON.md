# Comparing Codex subagents for Claude Code with OpenAI's plugin

Public source checked **2026-11-01**: [openai/codex-plugin-cc][official-readme], version
**1.0.6** in its [package metadata][official-package], at revision
[`db52e28f4d9ded852ab3942cea316258ae4ef346`][official-revision]. All GitHub source links below
are fixed to that revision, not a moving branch or a local installed plugin copy.

This page follows the runner's [manual](MANUAL.md) and
[CLI compatibility policy](COMPATIBILITY.md), including the distinction between the tested
CLI baseline and capability-based acceptance. The review inspected
documentation and source; it did not run a comparative model, performance or security benchmark.

Both projects delegate through a locally installed Codex app-server and use native Codex
authentication. This project is independent and is not endorsed by OpenAI or Anthropic.
OpenAI documents its runtime and configuration inheritance in [Codex integration][official-integration].

## Quick comparison

| What you need                                   | This runner                                                                      | OpenAI's plugin (1.0.6)                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A quick review or help with a stuck task        | Supported through task directives and named agents                               | Dedicated review and rescue slash commands                          |
| Several models working on one task              | Built-in batches with a concurrency limit                                        | Arrange separate jobs yourself                                      |
| Isolated branches and a path to merging changes | Managed worktrees, saved artifact records, verification and explicit integration | Arrange the Git workflow yourself                                   |
| Continue a conversation                         | Native Codex threads; steer, fork, compact or revert                             | Native Codex threads; transfer Claude conversation history to Codex |
| An automatic review when Claude stops           | No Claude lifecycle hook                                                         | Optional stop-review gate                                           |
| Setup                                           | Node 22+, Git and an existing logged-in Codex CLI                                | Node 18.18+; assisted CLI setup                                     |

Choose this runner for managing multiple tasks and their Git results. Choose OpenAI's plugin for
its focused review/rescue commands and Claude-history transfer. Both use Codex; this table makes no
claim of better answers, guaranteed caching, lower cost or stronger security. The detailed table
below links each distinction to its evidence.

## Workflow comparison

Choose this runner when explicit task directives, managed Git artifacts and bounded batches fit your
workflow. OpenAI's plugin offers a smaller set of review and rescue commands plus direct Claude-history
transfer. Neither choice establishes better model answers, lower cost or stronger security by itself.

| Area                             | This runner                                                                                                                                                                                                                                                                                               | OpenAI plugin at the inspected revision                                                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delegation defaults              | [Read-only by default](../README.md#usage); writes need `write: yes` or `--write`. This makes the requested write policy explicit.                                                                                                                                                                        | The [rescue agent][official-rescue] normally adds `--write`, except for read-only, review, diagnosis or research requests. Its [direct task parser][official-task] defaults read-only.                                                               |
| Model and effort controls        | Named roles, literal model IDs, and [catalogue checks](MANUAL.md#output) when available; explicit `max` and `ultra` where supported. A model listing is not an entitlement check.                                                                                                                         | [Passes through concrete model IDs][official-selection] and otherwise uses Codex defaults. Its explicit effort parser accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; older example model names are not an allowlist.                   |
| Reviews                          | [Native targets](MANUAL.md#native-review) include uncommitted changes, base branch, commit and custom instructions. Custom instructions cannot combine with a structured target.                                                                                                                          | Native review plus [adversarial review][official-adversarial], which combines base selection with focus text. An optional [stop-review gate][official-gate] can block Claude's stop for further work; OpenAI warns about prolonged loops and usage.  |
| Continuation and handoff         | Kept native threads with [live steering](MANUAL.md#steering-a-running-turn), [forks](MANUAL.md#forking-retained-context), explicit compaction and history reverts. Tasks receive supplied context, not the surrounding Claude conversation automatically.                                                 | [Resumes native Codex threads][official-resume] too. [`/codex:transfer`][official-transfer] imports Claude history into a Codex thread for continuation in Codex.                                                                                    |
| Worktrees, batches and artifacts | [Managed worktrees and artifact receipts](MANUAL.md#artifact-workflows), [bounded multi-model batches](MANUAL.md#multi-model-batches), explicit finalization/integration and [separate verification](MANUAL.md#separate-artifact-verification). These add branch, receipt and cleanup concepts to manage. | The inspected [command dispatcher][official-commands] exposes no equivalent managed batch/artifact workflow. Users can still arrange worktrees and verification themselves; this is a command-surface distinction, not a limitation of Codex or Git. |
| Process lifecycle                | A dedicated driver/app-server per turn; no Claude Code lifecycle hooks. Invoked operations can stop owned processes. See [process ownership](../SECURITY.md#process-ownership).                                                                                                                           | [Lifecycle hooks][official-hooks] and a [reusable broker][official-broker] integrate with Claude sessions. This architecture is not evidence of a cache-hit or latency advantage.                                                                    |
| Setup and diagnostics            | Node 22+, Git and a logged-in CLI. **codex-cli 0.166.0 is the tested baseline**; other versions are accepted subject to required capabilities. [Doctor, quota inspection](MANUAL.md#list-inspection-doctor-and-sweeps), transcripts and diagnostic bundles expose more operational detail.                | Node 18.18+; [`/codex:setup`][official-setup] can offer CLI installation. [Status/result commands][official-jobs] and native Codex configuration provide a simpler entry workflow.                                                                   |

Neither project's read-only task policy implies no local persistence, no network access or no
integration side effects. For this runner, inherited integrations and readable state are documented
in [Security](../SECURITY.md). Artifact verification runs authorized local code; it is not an OS sandbox.

## Native threads and prompt caching

A native Codex thread stores conversation history. This runner's `--continue` starts a fresh driver
and app-server, then resumes the recorded thread ID. Starting a new process therefore does not mean
starting a new conversation. OpenAI's plugin also calls `thread/resume`; native session continuity
is shared functionality. See [running and continuing tasks](MANUAL.md#running-and-continuing-tasks),
the [public resume implementation][official-resume] and [Codex's app-server documentation][app-server-docs].

Provider prompt caching is separate: it reuses eligible matching prompt prefixes according to the
model and request settings. A stored thread or a long-lived process does not guarantee a cache hit;
restarting a process alone is not evidence that cache reuse was lost. Compaction can change the
reusable prefix even though the logical conversation continues. See [OpenAI's caching guide][cache-docs].

The runner's [`tokens=input/cached/output/reasoning` footer](MANUAL.md#output) reports native Codex
usage; `cached` comes from `cachedInputTokens`, not the size of saved conversation files. Missing
accounting remains unknown. These observations do not establish a billing discount, quota saving
or comparative cache-hit rate for a particular account/provider.

## Evidence limits and claims to avoid

- Native sessions, background work and model selection are shared capabilities, not exclusive advantages.
- This comparison contains no measured speed, cost, model-quality or security ranking. CLI acceptance
  does not establish compatibility with every operation, model or account.
- Missing wrapper commands do not mean the underlying Codex CLI lacks those capabilities. Conversely,
  a new CLI capability is not automatically exposed or verified by either wrapper.
- A Git receipt records provenance; it does not prove authorship or correctness. A verification command
  exiting zero does not prove that its tests are sufficient. Read the [verification limits](MANUAL.md#separate-artifact-verification).

For installation and the current repository address, start with the [README](../README.md).
Continue with [examples](EXAMPLES.md), [support](../SUPPORT.md), [diagrams](diagrams/README.md)
or the [GitHub publication checklist](GITHUB-SETUP.md). Access depends on repository visibility.

[official-readme]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/README.md
[official-package]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/package.json
[official-revision]: https://github.com/openai/codex-plugin-cc/commit/db52e28f4d9ded852ab3942cea316258ae4ef346
[official-integration]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/README.md#codex-integration
[official-rescue]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/agents/codex-rescue.md#L29-L38
[official-task]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/codex-companion.mjs#L762-L782
[official-selection]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/codex-companion.mjs#L103-L127
[official-adversarial]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/README.md#L101-L124
[official-gate]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/README.md#codexsetup
[official-resume]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/codex.mjs#L1095-L1141
[official-transfer]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/README.md#L165-L178
[official-commands]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/codex-companion.mjs#L1024-L1065
[official-hooks]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/hooks/hooks.json
[official-broker]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/plugins/codex/scripts/lib/broker-lifecycle.mjs#L113-L170
[official-setup]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/README.md#L16-L48
[official-jobs]: https://github.com/openai/codex-plugin-cc/blob/db52e28f4d9ded852ab3942cea316258ae4ef346/README.md#L180-L218
[app-server-docs]: https://learn.chatgpt.com/docs/app-server
[cache-docs]: https://developers.openai.com/api/docs/guides/prompt-caching
