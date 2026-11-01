# Publishing a GitHub release

The GitHub pipelines are in `.github/workflows/`. The rest of the project stays in its normal
folders. See
[GitHub's workflow syntax documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#about-yaml-syntax-for-workflows).

| Workflow                                            | Trigger                                     | What it does                                                                                                      |
| --------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml` — **Source checks**      | Push to `main`, pull request, or manual run | Checks formatting, source and tests on Node 22/24 across Ubuntu, Windows and macOS                                |
| `.github/workflows/release.yml` — **Draft release** | Push a `vMAJOR.MINOR.PATCH` tag             | Validates the exact tag and commit, tests, builds and smoke-installs both archives, then creates a verified draft |

These jobs use GitHub-hosted runners and run only on GitHub.com. CI has read-only repository
permissions. Only the release job has `contents: write`. The publisher explicitly receives
`GITHUB_TOKEN`; checkout also uses the job token, with credential persistence disabled.
No personal token, Docker runner or Gitea secret is required.

The destination is [PolaronQuasi/codex-subagents-for-claude-code](https://github.com/PolaronQuasi/codex-subagents-for-claude-code).
Follow the [publication checklist](GITHUB-SETUP.md) to verify CODEOWNERS, branch/tag protection,
Actions access and private vulnerability reporting. The repository is initially private; check
Actions billing and permissions before running hosted jobs. Local tests do not establish a successful GitHub-hosted run.

## Prepare and publish

1. Work in a development checkout of the GitHub repository, with that repository as `origin`.
   Update `src/version.mjs`, `package.json`, `.claude-plugin/plugin.json`, the README's
   `(runner X.Y.Z)` phrase together.
2. Format the sources with `npm run format`, then run `npm run format:check` and `npm run ci`.
   The format scripts fetch pinned Prettier with `npx`; CI renders disposable definitions before
   checking and testing. Commit and push `main`, then wait for all six **Source checks** jobs
   to pass. Use the [isolated contributor setup](DEVELOPMENT.md#isolated-contributor-setup)
   for commit and push hooks; never skip the hooks.
3. Prepare the manifest commit through the
   [local release procedure](DEVELOPMENT.md#activating-a-local-release), and push it to `main`
   with normal hooks. The version tag belongs on that manifest commit:
   `node tools/release.mjs tag` refuses any other commit. Fetch `origin`, confirm that the
   manifest commit is on `origin/main`, and check out that commit. From the clean tracked
   checkout, run `node tools/release.mjs tag`, then push only that version tag:

   ```bash
   git push origin vMAJOR.MINOR.PATCH
   ```

4. Wait for **Draft release** to succeed. In **Releases**, review the draft's tag, exact commit,
   notes and five verified assets. Click **Publish release** when ready. The workflow never
   publishes the draft automatically.

The pipeline rejects malformed tags, mismatched versions or commits, commits outside
`origin/main`, a dirty tracked checkout and any existing release for that tag. Do not move a
released tag or replace published downloads. Source fixes get a new version.

The release tool runs Git without inherited `GIT_*` overrides, except the variables that choose
Git configuration files. The tagger comes from the checkout's configured `user.name` and
`user.email`. See [development](DEVELOPMENT.md#activating-a-local-release) for installation
and tag identity checks. Hosted publication does not activate another local installation.

## Interrupted runs

The GitHub publisher refuses every existing release, including a matching draft. It does not
resume uploads, delete drafts or overwrite assets. Inspect an interrupted attempt before using
GitHub's rerun controls. If an incomplete unpublished draft should be discarded, a maintainer
must deliberately remove it before rerunning the unchanged tag. Source or publisher fixes
require a new version and tag.

The workflow checks and packages the exact tagged tree, including that tag's publisher.
It does not substitute tools from a newer branch. Keep the draft unpublished until the complete
workflow has succeeded.

## What readers download

| Asset                                            | Contents                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `codex-subagents-for-claude-code-VERSION.zip`    | Installable sources, templates, documentation, diagrams, tooling, LICENSE and NOTICE |
| `codex-subagents-for-claude-code-VERSION.tar.gz` | The same files for tar-based environments                                            |
| `release-manifest.json`                          | Exact commit, archive hashes and every included file's size and SHA-256              |
| `SHA256SUMS`                                     | SHA-256 checksums for both archives, the manifest and release notes                  |
| `RELEASE-NOTES.md`                               | Generated version summary, exact commit and installation prerequisites               |

Each archive contains one `codex-subagents-for-claude-code-VERSION/` directory. Archives exclude
Git metadata, forge workflow directories, task results, installed `dist/` state, credentials
and machine-specific `releases/` manifests. GitHub also supplies automatic source archives;
the five named assets above are the outputs verified by this pipeline.

`tools/publish-github.mjs` verifies the tag on GitHub and compares the complete uploaded asset
inventory, sizes and GitHub-reported SHA-256 digests with local bytes. This is digest
verification, not a download round trip or a cryptographic publisher signature. Details and
API references are in the [GitHub setup guide](GITHUB-SETUP.md#draft-publication).

The archive smoke test extracts both packages and installs definitions and a managed release
into temporary folders. It makes no model calls and does not certify a live Claude Code/Codex
integration. See [compatibility](COMPATIBILITY.md) for that separate evidence.

## Local packaging

From a clean checkout at the intended tag, with `origin/main` fetched:

```bash
node tools/distribution.mjs build vMAJOR.MINOR.PATCH release-artifacts
node tools/distribution.mjs smoke release-artifacts
```

The output directory must be empty. The tools need Node 22+, Git and tar; Linux also needs
unzip, and Windows uses PowerShell's .NET ZIP reader. These commands do not publish anything.

For a repository hosted on Gitea, use the separate
[Gitea hosting and release guide](GITEA.md). Its Docker runner, credentials and draft-resume
behavior are specific to Gitea and are not prerequisites for GitHub.
