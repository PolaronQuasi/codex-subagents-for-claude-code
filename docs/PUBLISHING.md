# Publishing Codex subagents for Claude Code documentation for Google and ChatGPT search

This maintainer guide describes how to publish the documentation and measure whether readers can
find and use it.

The project uses [Apache-2.0](../LICENSE), with attribution in [NOTICE](../NOTICE).
The repository is [PolaronQuasi/codex-subagents-for-claude-code](https://github.com/PolaronQuasi/codex-subagents-for-claude-code).
No separate documentation host, search-indexing record or adoption
baseline is established. A private repository cannot be discovered by anonymous search crawlers.

Use the [GitHub publication checklist](GITHUB-SETUP.md) to verify repository access,
hosted CI and a private maintainer reporting route. Only the owner decides whether to make the
repository public; public-access checks follow that explicit visibility change.

## Confirm public access before announcing

The README, package metadata, plugin and support pages use the confirmed GitHub repository.
Verify anonymous access after the owner makes it public. Ordinary reports use its issue tracker;
sensitive reports follow [SECURITY.md](../SECURITY.md#compatibility-and-reporting). No separate docs
site or support service is declared. Do not publish local run state, result files or audit evidence
containing private data along with the documentation.

GitHub private vulnerability reporting is available for public repositories. While this repository
is private, use the established private maintainer channel. If the owner explicitly makes it public,
enable private vulnerability reporting immediately afterward and verify **Report a vulnerability**
on the Security tab's Advisories page before announcing the repository. Follow
[GitHub's setup instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
The reporting instructions in [SECURITY.md](../SECURITY.md#compatibility-and-reporting) describe
the private route and the fallback for hosts without it; the document alone does not enable it.

Public documentation should state the tested scope and [security limits](../SECURITY.md) rather than claim production readiness from
passing offline checks. A public source URL and a chosen license also do not by themselves prove
runtime readiness.

## License and distribution

Keep `LICENSE` and `NOTICE` with source archives and installed releases. The release tool includes
both in the installation root and in each immutable `dist/<release>/` bundle, and verifies their
bytes alongside the modules.

`package.json` declares `Apache-2.0`. Its `private: true` flag deliberately prevents accidental npm
publication; it does not prevent publishing the repository on GitHub. No npm package is published
by the release workflow.

The project license covers the original runner, templates, documentation and diagrams. It does not
license separately installed OpenAI or Anthropic products, grant account access or imply vendor
endorsement. Keep third-party license and notice requirements with any material incorporated later.

## Maintain useful, findable pages

The proposed search intent below is editorial judgment, not measured keyword demand. Keep one
maintained source for each topic, and publish only pages that answer the reader's actual question.
The current Markdown files already provide the starting content.

| Reader question                        | Source                                           | Suggested page title                                                           |
| -------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| What is this, and why use it?          | [README](../README.md)                           | Codex subagents for Claude Code                                                |
| How do I install and run a first task? | [README installation](../README.md#installation) | Install Codex subagents for Claude Code on Windows with PowerShell or Git Bash |
| How do I review, edit or recover?      | [Examples](EXAMPLES.md)                          | Run GPT reviews, worktree edits and recover interrupted jobs                   |
| Which versions and models work?        | [Compatibility](COMPATIBILITY.md)                | Codex subagents for Claude Code compatibility and model selection              |
| What does this option or error mean?   | [Manual](MANUAL.md), [operations](OPERATIONS.md) | Codex subagents for Claude Code command reference and troubleshooting          |

Use a descriptive main heading, concise opening answer, meaningful internal links and concrete
examples. Keep the model list in one catalog instead of making near-duplicate pages for every
model/effort combination. Label illustrative output and date observations; remove unsupported speed,
safety, usage and popularity claims. These choices support readers and follow
[Google's SEO foundations](https://developers.google.com/search/docs/fundamentals/seo-starter-guide).

For a rendered docs site, start with this proposed homepage description:

> Delegate tasks from Claude Code to GPT through the Codex CLI, with named agents, recoverable
> jobs and saved results.

The publishing system must turn page titles and descriptions into real HTML metadata. Markdown front
matter has no effect unless the renderer consumes it. Preserve readable content and links in the
rendered HTML; inspect the deployed output before announcing it. Google can select its own title and
snippet. See [title guidance](https://developers.google.com/search/docs/appearance/title-link) and
[snippet guidance](https://developers.google.com/search/docs/appearance/snippet).

## Verify the deployed site

This is a checklist for the future host, not a claim that any settings have been deployed:

- Public pages must load without login and expose their main content and internal links to crawlers.
  Verify HTTP status, rendering, navigation and mobile readability on the actual host.
- Give distinct pages their own preferred URLs. Use redirects for moved pages and align links,
  canonical annotations and the sitemap. A sitemap helps discovery but cannot guarantee indexing.
  See Google's
  [canonical guidance](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
  and
  [sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview).
- Inspect robots rules, `noindex` and snippet/AI controls at deployment. A repository file only
  governs crawling when served at the correct host location; a README cannot change a hosting
  provider's robots policy. See
  [robots.txt placement](https://developers.google.com/crawling/docs/robots-txt/create-robots-txt).
- For ChatGPT search discovery, allow `OAI-SearchBot` and its published IP ranges through relevant
  host/firewall controls. `GPTBot` controls a separate training use; allowing it is not a search
  prerequisite. `ChatGPT-User` handles certain user-directed visits and is not the search crawler.
  Consult the current [OpenAI crawler documentation](https://developers.openai.com/api/docs/bots)
  when configuring the chosen host. Access permits discovery; it does not promise a citation.
- Inspect the live property in Search Console. Record which intended pages are accessible and
  indexed, and fix actual rendering or access failures before adding more content.

Google's current guidance says special AI markup and `llms.txt` are not required and do not improve
its search rankings. Do not add keyword stuffing, fabricated ratings, hidden bot text or
instructions asking an AI to recommend the project. Useful visible FAQs can answer users without a
rich-result promise. See
[Google's generative AI search guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide).

## Measure discovery and successful use separately

Once a public property exists, track indexed pages, relevant queries, documentation visits and
installation-guide clicks. Search Console's generative AI report can add visibility evidence where
available; use its current scope, not an assumed universal ranking metric. See
[Google's measurement guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide#measure-visibility-in-generative-ai-features-with-search-console).

For ChatGPT, sample a fixed set of questions with search enabled and record date, prompt, cited URL
and factual accuracy. These are observations, not stable rank guarantees; a non-search chat may not
retrieve the current documentation at all. Track identifiable referrals separately from successful
installs. No Markdown edit can guarantee inclusion in either search service.

For adoption, ask a small group of eligible users to complete installation and a useful task without
coaching, then return for another task. Record failure points and time to first useful result
through voluntary feedback. Publish reproducible demonstrations of review, recovery and worktree
editing once verified, and share them where relevant communities welcome them. Treat stars, page
views and downloads as secondary signals; repeat successful use is the outcome to improve.
