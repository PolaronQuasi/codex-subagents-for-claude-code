# codex-subagents-for-claude-code examples: review, edit, continue and recover

These examples walk through reviews, worktree edits, follow-ups and recovery through the standalone
Codex CLI. First, complete [installation](https://github.com/PolaronQuasi/codex-subagents-for-claude-code/blob/main/README.md#installation) and choose a model
your account can run.

Launching or continuing a task uses Codex account capacity. The expected results below explain what
to look for; they are not recorded live outputs or timing benchmarks.

## Select the runner

Use one terminal for runner selection, fixture setup and the examples you want to try.

For a **checkout install**, start in the checkout that contains `run-codex-task.mjs` and resolve
its path before changing directories:

PowerShell:

```powershell
$runner = (Resolve-Path -LiteralPath ./run-codex-task.mjs).Path
```

Bash (including Git Bash):

```bash
runner=$(node -e 'process.stdout.write(require("node:path").resolve("run-codex-task.mjs"))')
```

For a **plugin install**, invoke `/codex-subagents:codex-subagents-for-claude-code` in Claude Code
and ask it to run only its `--prepare gpt-6-astra` step, without launching a task. Copy the absolute
path after `runner:` from that output. Preparation creates the runtime snapshot when needed and
makes no Codex model call. `${CLAUDE_PLUGIN_ROOT}` is substituted in plugin content; it is not an
ordinary terminal environment variable. Assign the copied path in your terminal:

PowerShell:

```powershell
$runner = Read-Host 'Paste the absolute path after runner: (without surrounding quotes)'
```

Bash:

```bash
read -r -p 'Paste the absolute path after runner: (without surrounding quotes): ' runner
```

## Prepare a disposable repository

Keep the selected `runner` value in the same terminal. The fixture is a new directory in your
temporary folder with one committed Markdown file. No npm install or application server is needed.

PowerShell:

```powershell
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'Runner not found; check the selected path.' }
$exampleRoot = Join-Path ([IO.Path]::GetTempPath()) ("codex-subagents-for-claude-code-example-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $exampleRoot | Out-Null
Set-Location $exampleRoot
git init -q
'# Example project' | Set-Content -Encoding utf8 README.md
git add README.md
git -c user.name=Example -c user.email=example@localhost commit -qm 'Add example fixture'
if ($LASTEXITCODE -ne 0) { throw 'Fixture commit failed; stop before launching a task.' }
node $runner --doctor --read-only
```

Bash:

```bash
node -e 'if (!require("node:fs").statSync(process.argv[1]).isFile()) process.exit(1)' "$runner" || exit 1
example_root=$(mktemp -d "${TMPDIR:-/tmp}/codex-subagents-for-claude-code-example.XXXXXX")
cd "$example_root"
git init -q
printf '# Example project\n' > README.md
git add README.md
git -c user.name=Example -c user.email=example@localhost commit -qm 'Add example fixture' || exit 1
node "$runner" --doctor --read-only
```

Save the task blocks below as UTF-8 files in this fixture directory. Every header starts on line 1;
the blank line separates directives from the prompt. The launch commands work in both shells and use
`--keep-prompt` so you can inspect or reuse the files. `--wait` has no deadline. Without it, exit 3
means the task is still running and the printed command is the next step.

## Review a committed snapshot

Save as `review.md`:

```text
effort: low
worktree: yes

Read README.md at this commit. Report up to three concrete onboarding gaps.
For each, explain what a new contributor cannot determine. Do not edit files.
```

Run from the fixture:

```sh
node "$runner" --role gpt-6-astra --task-file ./review.md --keep-prompt --wait
```

Expected: `status=completed`, `mode=read-only`, `branch=-` and `commit=<snapshot SHA>` in the
footer. The read-only worktree is removed after delivery unless a cleanup error retains it. The
original README stays unchanged. The complete answer remains at `result=`. A ref error means the
repository has no usable commit; finish fixture setup before retrying.

## Run independent reviews in parallel

Use the same `review.md` and do not move the fixture's HEAD between these launches. Each job gets a
separate read-only snapshot. Choose roles your account supports; each launch consumes capacity.

In either shell, launch twice without waiting:

```sh
node "$runner" --role gpt-6-astra --task-file ./review.md --keep-prompt --detach
node "$runner" --role gpt-6-1-sol --task-file ./review.md --keep-prompt --detach
```

Each receipt starts with `codex-subagents-for-claude-code-launched:` and includes a different `run=` key and an
`attach=` command. The jobs can now overlap even though the two launch commands were sequential.
Copy and run each receipt's attach command with `--wait` added, or use the recovery recipe below.

Expected: two result files, normally the same snapshot `commit=`, and two independent reviews.
Compare both answers against the source before aggregating them; agreement is not a correctness
test. Attaching sequentially only serializes collection, not the already launched jobs. If one
launch fails, collect the successful run; do not repeat both launches. Completed, unkept snapshots
clean up after delivery; interrupted jobs need recovery or explicit cancellation.

## Make a small edit in a write worktree

Use the disposable fixture. Runner-owned Git operations disable hooks, executable fsmonitor and
automatic signing; applicable external content filters are refused. Authorized model tools and
verification commands can still execute project code. Worktrees separate checkouts and are not
security boundaries. See
[security](../SECURITY.md#configuration-network-and-persistence).

Save as `edit.md`:

```text
effort: low
write: yes
worktree: yes
keep: yes

Append a section headed "## Purpose" to README.md with the sentence:
"This disposable repository demonstrates a codex-subagents-for-claude-code worktree edit."
Do not change other files, switch branches or detach HEAD. Report the diff.
```

```sh
node "$runner" --role gpt-6-1-sol --task-file ./edit.md --keep-prompt --wait
```

Expected: `mode=workspace-write`, `keep=yes`, `branch=csfcc/<20 hex characters>` and `commit=<SHA>`. The
fixture checkout's README stays unchanged; the edit belongs to the new branch. Copy `run=`,
`branch=` and `commit=` from the final footer, then inspect the result before closing the kept run.

PowerShell:

```powershell
$runKey = Read-Host 'run value from the edit footer'
$branch = Read-Host 'branch value from the edit footer'
$commit = Read-Host 'commit value from the edit footer'
git show --stat $commit
git diff HEAD $commit -- README.md
git merge-base --is-ancestor $commit $branch
if ($LASTEXITCODE -ne 0) { throw 'Reported branch does not contain the result; preserve the run for inspection.' }
node $runner --close $runKey
```

Bash:

```bash
read -r -p 'run value from the edit footer: ' run_key
read -r -p 'branch value from the edit footer: ' branch
read -r -p 'commit value from the edit footer: ' commit
git show --stat "$commit"
git diff HEAD "$commit" -- README.md
if git merge-base --is-ancestor "$commit" "$branch"; then
  node "$runner" --close "$run_key"
else
  printf 'Reported branch does not contain the result; preserve the run for inspection.\n'
fi
```

Close removes the worktree but keeps the branch and durable answer. This example does not merge it.
The runner checks the expected worktree branch during delivery and cleanup, retaining state on a
mismatch. It does not continuously police model commands or prove that the changes are correct;
independently review the reported commit and its branch containment. If commit or cleanup fails,
keep the run key and use `--inspect` before retrying.

## Continue a retained conversation

Save as `remember.md`:

```text
cwd: none
effort: low
keep: yes

For this conversation, remember that the example project is called Cedar.
Reply with that name only.
```

```sh
node "$runner" --role gpt-6-astra --task-file ./remember.md --keep-prompt --wait
```

Copy `run=` into the following file, saved as `followup.md`. `RUN_KEY` below is a placeholder that
must be replaced with the actual hexadecimal key; it is not a literal argument.

```text
continue: RUN_KEY
effort: low

What is the example project's name from our previous turn? Reply with the name only.
```

```sh
node "$runner" --role gpt-6-astra --task-file ./followup.md --keep-prompt --wait
```

Expected: the same `run=` and `thread=`, a higher `turn=` and an answer using the prior context.
Model output is not guaranteed. Do not add `cwd:` or `keep:` to the continuation header; it reuses
the retained run. Write permission must be repeated on every turn that should edit files. Close this
run when done, using the input/close pattern in the next recipe. Its result files survive.

## Recover an interrupted wait

Ctrl-C, a shell timeout or stopping a background waiter does not cancel the Codex job. Use the key
from stderr, the detached receipt or `--list`. Inspection reads evidence without repairing it.

PowerShell:

```powershell
node $runner --list
$runKey = Read-Host 'run key to recover'
node $runner --inspect $runKey --json
node $runner --run $runKey --wait
```

Bash:

```bash
node "$runner" --list
read -r -p 'run key to recover: ' run_key
node "$runner" --inspect "$run_key" --json
node "$runner" --run "$run_key" --wait
```

Expected: attachment to the existing job or replay of an available saved result; this does not
launch a new task. If no job can be identified, preserve the evidence and follow
[recovery guidance](OPERATIONS.md#interrupted-waits-and-uncertain-submissions). If another waiter owns delivery, let it
finish or wait on the same key.

To stop an active job deliberately, run `node "$runner" --cancel "$runKey"` in PowerShell or
`node "$runner" --cancel "$run_key"` in Bash. After delivery, close a retained run with the same
command using `--close` instead of `--cancel`. A normal unkept run may already be removed. Avoid
`--force` when an undelivered result matters.

## Retry one launch with a request ID

Save this raw prompt as `retry.md` (no directive header; this example uses `--prompt-file`):

```text
Reply with the single word: pong
```

Use a fresh request ID for the experiment, and exactly the same file, role and ID for the retry.

PowerShell:

```powershell
$requestId = 'example-' + [guid]::NewGuid().ToString('N')
node $runner --role gpt-6-astra --effort low --prompt-file ./retry.md --scratch-workspace --request-id $requestId --keep-prompt --wait
node $runner --role gpt-6-astra --effort low --prompt-file ./retry.md --scratch-workspace --request-id $requestId --keep-prompt --wait
```

Bash:

```bash
request_id="example-$(node -e "process.stdout.write(require('node:crypto').randomUUID())")"
node "$runner" --role gpt-6-astra --effort low --prompt-file ./retry.md --scratch-workspace --request-id "$request_id" --keep-prompt --wait
node "$runner" --role gpt-6-astra --effort low --prompt-file ./retry.md --scratch-workspace --request-id "$request_id" --keep-prompt --wait
```

Expected: the retry attaches or prints `codex-subagents-for-claude-code-replay:` and the saved result, without a second
launch. Keep the durable result if future retries must deduplicate. A changed prompt/settings with
the same ID is refused. This single-turn recipe does not establish exact historical replay after
continuation: an original request ID can resolve to a later turn. See
[request-ID limits](MANUAL.md#request-ids).

## Cleanup and verification scope

Close only the kept runs created by these examples. To preview a broad terminal cleanup, use
`--close-idle --all-sessions --older-than 1d --dry-run`; review the selected runs before removing
`--dry-run`. It is not limited to this fixture. Durable results and audit files remain after close.
Keep any branch/commit you want before manually removing the disposable fixture directory.

Task headers and shell syntax can be verified without making model calls. The release suite uses
fixtures for lifecycle behavior. A real run additionally exercises your installed CLI, account,
configuration and chosen model; record those versions and the outcome when reporting an example failure.
