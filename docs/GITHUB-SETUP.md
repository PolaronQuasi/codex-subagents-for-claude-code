# GitHub repository setup

The repository is
[PolaronQuasi/codex-subagents-for-claude-code](https://github.com/PolaronQuasi/codex-subagents-for-claude-code),
owned by **PolaronQuasi**, with clone URL
`https://github.com/PolaronQuasi/codex-subagents-for-claude-code.git`.
Repository metadata, CODEOWNERS, plugin ownership, installation commands and support links
use this destination. No separate documentation host is declared.

Private access requires GitHub authentication and repository permission. Anonymous HTTP404 does not
establish that a private repository is missing. Public discoverability starts only after the owner
makes it public and anonymous access is verified; editing metadata cannot grant public access.

## Before public publishing

1. Verify authenticated access to the repository and check its remote refs before pushing.
   Preserve existing remote work.
2. Keep `package.json` repository/homepage/bugs URLs, `.claude-plugin/plugin.json` repository/homepage,
   README install commands and hosting metadata consistent with the destination above.
3. Keep internal documentation links relative, including [examples](EXAMPLES.md),
   [support](../SUPPORT.md), [diagrams](diagrams/README.md) and the [comparison](COMPARISON.md).
   Check files, heading anchors and rendered navigation on the chosen host. Preserve the comparison's
   source revision and date until a new review is performed.
4. Verify anonymous access, HTTP success, indexable rendered content and crawler access. Check redirects,
   canonical URLs, robots rules and indexing directives on the deployed host. Access makes indexing
   possible, not guaranteed; see [Google's technical requirements](https://developers.google.com/search/docs/essentials/technical).
5. If ChatGPT search discovery is wanted, configure `OAI-SearchBot` access separately from training
   preferences for `GPTBot`. See [OpenAI's crawler documentation](https://developers.openai.com/api/docs/bots).
6. After publication, record the actual source revision, deployed URLs and observed indexing results.
   Do not claim that publication, search inclusion or live model compatibility follows from local checks.
   The [publishing plan](PUBLISHING.md) covers documentation and discovery checks in more detail.

## Repository settings

Before making the repository public, the maintainer should complete and verify these settings:

1. Confirm that `.github/CODEOWNERS` recognizes `@PolaronQuasi` with write access. The default
   ownership rule is already present; check GitHub for ownership errors after the source is pushed.
2. Enable **Settings → Security → Advanced Security → Private vulnerability reporting**.
   Confirm the Security tab offers **Report a vulnerability** before publication. Follow
   [SECURITY.md](../SECURITY.md) and GitHub's
   [private reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
3. Protect `main` and version tags, restrict write access, and review Actions access, token
   permissions and any private-repository billing before running hosted jobs. The workflows use ephemeral hosted runners. Never convert fork PR jobs
   to privileged pull_request_target execution or a trusted persistent runner.
4. Run the committed CI matrix on GitHub, including Windows and macOS. Local Linux execution
   does not establish hosted OS validation or live model compatibility.
5. Push only reviewed source and intended release tags. Keep credentials, runtime state and local
   configuration out of the repository. Preserve executable modes on the commit and push hooks.

## Installation and workflow identity

A managed local installation creates its own receipt, bound to that exact public release.
Keep published receipts and tags immutable; never copy a receipt from another source identity
or installation.

The package, archives, install and state folders, skill, branch prefix, output markers,
runner image and runner label use the `codex-subagents-for-claude-code` namespace.
Environment variables use `CODEX_SUBAGENTS_FOR_CLAUDE_CODE_`. Use the current names
when configuring an installation; no compatibility aliases or automatic migration are provided.

The active workflows are in `.github/workflows/`.
Both GitHub jobs are restricted to GitHub.com, so a staging forge that also discovers that
directory cannot run them with its own token or runners. CI covers Node 22/24 on Ubuntu,
Windows and macOS; releases use the job's automatic `GITHUB_TOKEN`. No Docker runner, Gitea
account or Gitea secret is needed on GitHub.

Optional self-hosted tooling is described in [Gitea hosting and releases](GITEA.md).

## Draft publication

The GitHub tag workflow validates the event tag, checked-out commit, package/runner/README versions
and ancestry on `origin/main`, then runs source checks, builds and smoke-installs ZIP and tar.gz.
Only its release job has `contents: write`. The publisher explicitly receives `GITHUB_TOKEN`;
checkout also uses the job token, with credential persistence disabled.

`tools/publish-github.mjs` supports GitHub.com and constructs the API/upload origins itself. It
verifies annotated or lightweight tags, creates a draft, and compares the uploaded sizes and
GitHub-reported SHA-256 digests with local bytes, including the complete asset inventory. See the
[GitHub release asset API](https://docs.github.com/en/rest/releases/assets).
It never follows credential-bearing redirects, uses an advertised upload URL, replaces assets or
publishes a draft. This is digest verification, not a download round trip or publisher signature.

An existing release, including a matching draft, stops a rerun. After an interrupted run, inspect
the draft manually. Prefer a new version for source changes. If discarding an incomplete unpublished
draft is appropriate, a maintainer must do that deliberately before rerunning the unchanged tag;
the publisher never deletes it. A completed draft remains unpublished until a maintainer reviews
the successful workflow and explicitly publishes it. See [Publishing a release](RELEASING.md)
for the full GitHub procedure.
