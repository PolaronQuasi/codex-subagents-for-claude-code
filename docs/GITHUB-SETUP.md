# GitHub repository maintenance

The public repository is
[PolaronQuasi/codex-subagents-for-claude-code](https://github.com/PolaronQuasi/codex-subagents-for-claude-code),
owned by **PolaronQuasi**, with clone URL
`https://github.com/PolaronQuasi/codex-subagents-for-claude-code.git`.
Use this checklist when maintaining repository settings, documentation or releases.
For the release commands, see [Publishing a release](RELEASING.md).

## Source and documentation

1. Check remote refs before pushing and preserve existing remote work. Submit changes through
   pull requests to `main`.
2. Keep `package.json` repository/homepage/bugs URLs, `.claude-plugin/plugin.json` repository/homepage,
   README install commands and hosting metadata consistent with the destination above.
3. Keep internal documentation links relative, including [examples](EXAMPLES.md),
   [support](../SUPPORT.md), [diagrams](diagrams/README.md) and the [comparison](COMPARISON.md).
   Check files, heading anchors and rendered navigation on the chosen host. Preserve the comparison's
   source revision and date until a new review is performed.
4. Keep credentials, runtime state and local configuration out of source and releases. Preserve
   executable modes on the commit and push hooks. Local checks do not establish live model compatibility.

## Repository settings

Verify these settings in GitHub when repository permissions or workflows change:

1. Keep `.github/CODEOWNERS` valid for `@PolaronQuasi` and restrict repository write access.
2. Keep private vulnerability reporting enabled and verify **Report a vulnerability** on the
   Security tab's Advisories page. Keep Dependabot alerts, secret-scanning alerts and push protection
   enabled. Reporting instructions are in [SECURITY.md](../SECURITY.md); see also GitHub's
   [private reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
3. Protect `main`: require pull requests, resolved review conversations, linear history and an
   up-to-date branch with all six CI checks passing. Keep zero mandatory approvals for the sole
   maintainer, block force pushes and deletion, allow squash merges only, and delete merged branches.
4. Restrict creation of `v*` tags to repository admins. Separately block updates and deletion of
   existing version tags, including by admins.
5. Keep Actions permissions read-only by default, allow only the external actions used by the
   workflows, require full commit-SHA pins, and require approval for outside contributors' fork
   workflows. Use ephemeral hosted runners; never give fork PR jobs privileged
   `pull_request_target` execution or a trusted persistent runner.
6. Run the committed Node 22/24 matrix on Ubuntu, Windows and macOS. If job names change, update
   the six required check names after verifying the replacement jobs. Local tests do not establish
   successful hosted CI.

## Installation and workflow identity

A managed local installation creates its own receipt, bound to its exact source and installation.
Keep local receipts and published tags immutable; never copy a receipt from another source identity
or installation.

The active workflows are in `.github/workflows/`.
Both workflows are restricted to GitHub.com, so a staging forge that also discovers that
directory cannot run them with its own token or runners. Releases use the job's automatic
`GITHUB_TOKEN`; no personal token or self-hosted runner is required.

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
