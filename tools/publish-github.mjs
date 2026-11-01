#!/usr/bin/env node
// GitHub.com adapter. A failed attempt leaves its draft for manual inspection;
// reruns refuse existing releases, and no operation replaces assets or publishes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digest, loadBundle, PROJECT } from "./distribution.mjs";
import { EXIT } from "../src/shared/errors.mjs";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const API_VERSION = "2026-03-10";
const REQUEST_MS = 60_000;
const HTTP_NOT_FOUND = 404;
const TAG_DEPTH = 8;
const ASSET_PAGE_SIZE = 100;
const RELEASE_PAGES = 100;
const ASSET_STATE = "uploaded";
const SHA = /^[0-9a-f]{40}$/;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;

export async function publishDraft({
  directory,
  repository,
  token,
  fetchImpl = fetch,
  write = console.log,
}) {
  const bundle = loadBundle(directory);
  const { manifest } = bundle;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
    repository.split("/")[1] !== PROJECT ||
    repository.split("/")[0] === "OWNER"
  )
    throw new Error("repository must be a real OWNER with the public project name");
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const repoPath = `/repos/${repository}`;
  const marker = `<!-- codex-subagents-for-claude-code-release ${manifest.tag} ${manifest.commit} -->`;
  async function request(
    route,
    { method = "GET", json, bytes, upload = false, missing = false } = {},
  ) {
    // Construct both origins locally; ignore all server-supplied URLs and redirects.
    const response = await fetchImpl(new URL(`${upload ? UPLOADS : API}${repoPath}${route}`), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "Content-Type": bytes ? "application/octet-stream" : "application/json",
      },
      body: json ? JSON.stringify(json) : bytes,
    });
    if (missing && response.status === HTTP_NOT_FOUND) return null;
    if (!response.ok)
      throw new Error(`GitHub ${method} ${route} failed with HTTP ${response.status}`);
    return response.json();
  }
  async function verifyTag() {
    const ref = await request(`/git/ref/tags/${manifest.tag}`);
    if (ref.ref !== `refs/tags/${manifest.tag}`) throw new Error("unexpected remote tag ref");
    let object = ref.object;
    const seen = new Set();
    for (let depth = 0; object?.type === "tag" && depth < TAG_DEPTH; depth++) {
      if (!SHA.test(object.sha) || seen.has(object.sha))
        throw new Error("invalid annotated tag chain");
      seen.add(object.sha);
      const tag = await request(`/git/tags/${object.sha}`);
      if (tag.sha !== object.sha) throw new Error("annotated tag identity mismatch");
      object = tag.object;
    }
    if (object?.type !== "commit" || object.sha !== manifest.commit)
      throw new Error("remote tag does not match the packaged commit");
  }
  function verifyDraft(release, id) {
    if (
      !positiveId(release?.id) ||
      (id !== undefined && release.id !== id) ||
      release.tag_name !== manifest.tag ||
      release.target_commitish !== manifest.commit ||
      release.draft !== true ||
      !release.body?.includes(marker)
    )
      throw new Error("draft identity or publication state changed; refusing further writes");
  }
  function verifyAsset(asset, name) {
    const bytes = fs.readFileSync(path.join(bundle.directory, name));
    if (
      !positiveId(asset?.id) ||
      asset.name !== name ||
      asset.state !== ASSET_STATE ||
      asset.size !== bytes.length ||
      asset.digest !== `sha256:${digest(bytes)}`
    )
      throw new Error(`remote asset identity or SHA-256 mismatch: ${name}`);
  }
  await verifyTag();
  if (await request(`/releases/tags/${manifest.tag}`, { missing: true }))
    throw new Error("release already exists; inspect it manually, nothing will be overwritten");
  // The tag endpoint describes published releases. Enumerate drafts visible to
  // the write token too, so an interrupted attempt cannot create another draft.
  for (let page = 1; page <= RELEASE_PAGES; page++) {
    const releases = await request(`/releases?per_page=${ASSET_PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(releases)) throw new Error("invalid release listing");
    if (releases.some((item) => item.tag_name === manifest.tag))
      throw new Error("release already exists; inspect it manually, nothing will be overwritten");
    if (releases.length < ASSET_PAGE_SIZE) break;
    if (page === RELEASE_PAGES)
      throw new Error("release listing limit reached; refusing to create a draft");
  }
  const notes = fs.readFileSync(path.join(bundle.directory, "RELEASE-NOTES.md"), "utf8");
  const release = await request("/releases", {
    method: "POST",
    json: {
      tag_name: manifest.tag,
      target_commitish: manifest.commit,
      name: `${PROJECT} ${manifest.tag}`,
      draft: true,
      prerelease: false,
      body: `${marker}\n\nWait for the release workflow to succeed before manually publishing this draft.\n\n${notes}`,
    },
  });
  verifyDraft(release);
  const releasePath = `/releases/${release.id}`;
  for (const name of bundle.assets) {
    verifyDraft(await request(releasePath), release.id);
    const asset = await request(`${releasePath}/assets?name=${encodeURIComponent(name)}`, {
      method: "POST",
      upload: true,
      bytes: fs.readFileSync(path.join(bundle.directory, name)),
    });
    verifyAsset(asset, name);
  }
  const assets = await request(`${releasePath}/assets?per_page=${ASSET_PAGE_SIZE}`);
  if (
    !Array.isArray(assets) ||
    assets.length !== bundle.assets.length ||
    new Set(assets.map((asset) => asset.name)).size !== bundle.assets.length ||
    assets.some((asset) => !bundle.assets.includes(asset.name))
  )
    throw new Error("remote asset inventory differs from the bundle");
  for (const asset of assets) verifyAsset(asset, asset.name);
  await verifyTag();
  verifyDraft(await request(releasePath), release.id);
  write(`draft ready: https://github.com/${repository}/releases/tag/${manifest.tag}`);
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3)
      throw new Error("usage: node tools/publish-github.mjs ARTIFACT_DIRECTORY");
    await publishDraft({
      directory: process.argv[2],
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = EXIT.FAILURE;
  }
}
