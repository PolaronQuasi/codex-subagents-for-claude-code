#!/usr/bin/env node
// Gitea adapter: consumes the portable bundle and only creates/resumes drafts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digest, loadBundle, PROJECT } from "./distribution.mjs";
import { EXIT } from "../src/shared/errors.mjs";

// How long one request to the Gitea API may take.
const REQUEST_MS = 60_000;
const HTTP_NOT_FOUND = 404;

export async function publishDraft({
  directory,
  server,
  repository,
  token,
  assetToken = token,
  fetchImpl = fetch,
  write = console.log,
}) {
  const bundle = loadBundle(directory);
  const { manifest } = bundle;
  const base = new URL(server);
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("Gitea server must be an HTTP(S) URL without credentials, query or fragment");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ""))
    throw new Error("repository must be OWNER/REPO");
  if (repository.split("/")[1] !== PROJECT)
    throw new Error("repository name must match the public project identity");
  if (!token) throw new Error("GITEA_TOKEN is required");
  const prefix = base.href.replace(/\/$/, "");
  const api = `${prefix}/api/v1/repos/${repository}`;
  const marker = `<!-- codex-subagents-for-claude-code-release ${manifest.tag} ${manifest.commit} -->`;
  async function request(
    url,
    { method = "GET", json, body, raw = false, missing = false, credential = token } = {},
  ) {
    const target = new URL(url);
    if (target.origin !== base.origin)
      throw new Error("refusing to send a release credential to another origin");
    const response = await fetchImpl(target, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_MS),
      headers: {
        Authorization: `token ${credential}`,
        ...(json ? { "Content-Type": "application/json" } : {}),
      },
      body: json ? JSON.stringify(json) : body,
    });
    if (missing && response.status === HTTP_NOT_FOUND) return null;
    if (!response.ok)
      throw new Error(`Gitea ${method} ${target.pathname} failed with HTTP ${response.status}`);
    return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  async function verifyTag() {
    const remote = await request(`${api}/tags/${manifest.tag}`);
    if (remote.commit?.sha !== manifest.commit)
      throw new Error("remote tag does not match the packaged commit");
  }
  const notes = fs.readFileSync(path.join(bundle.directory, "RELEASE-NOTES.md"), "utf8");
  await verifyTag();
  let release = await request(`${api}/releases/tags/${manifest.tag}`, { missing: true });
  if (release) {
    if (!release.draft)
      throw new Error("release is already published; publish changes as a new version");
    if (!release.body?.includes(marker))
      throw new Error("existing draft is not owned by this bundle; review it manually");
  } else {
    release = await request(`${api}/releases`, {
      method: "POST",
      json: {
        tag_name: manifest.tag,
        target_commitish: manifest.commit,
        name: `${PROJECT} ${manifest.tag}`,
        draft: true,
        prerelease: false,
        body: `${marker}\n\nUpload verification is in progress. Wait for the release workflow to succeed before publishing.\n\n${notes}`,
      },
    });
  }
  if (
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== manifest.tag ||
    !release.draft
  )
    throw new Error("Gitea did not return the expected draft release");
  const releaseApi = `${api}/releases/${release.id}`;
  const existing = await request(`${releaseApi}/assets`);
  const names = new Set();
  for (const asset of existing) {
    if (!bundle.assets.includes(asset.name))
      throw new Error(`unexpected remote asset: ${asset.name}`);
    if (names.has(asset.name)) throw new Error(`duplicate remote asset: ${asset.name}`);
    names.add(asset.name);
  }
  for (const name of bundle.assets) {
    const current = await request(releaseApi);
    if (!current.draft || !current.body?.includes(marker))
      throw new Error("draft changed during upload; refusing further writes");
    const bytes = fs.readFileSync(path.join(bundle.directory, name));
    let asset = existing.find((item) => item.name === name);
    if (!asset) {
      const form = new FormData();
      form.append("attachment", new Blob([bytes]), name);
      asset = await request(`${releaseApi}/assets?name=${encodeURIComponent(name)}`, {
        method: "POST",
        body: form,
      });
    }
    if (asset.name !== name || asset.size !== bytes.length)
      throw new Error(`remote asset metadata mismatch: ${name}`);
    // browser_download_url can redirect through a public hostname inaccessible from Docker.
    // Address the verified attachment UUID on the configured server; never follow that URL.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(asset.uuid ?? ""))
      throw new Error("invalid remote attachment UUID");
    const downloaded = await request(`${prefix}/attachments/${asset.uuid}`, {
      raw: true,
      credential: assetToken,
    });
    if (digest(downloaded) !== digest(bytes))
      throw new Error(`remote asset checksum mismatch: ${name}; nothing was overwritten`);
    write(`verified ${name}`);
  }
  await verifyTag();
  const current = await request(releaseApi);
  if (!current.draft || !current.body?.includes(marker))
    throw new Error("draft changed before final verification");
  release = await request(releaseApi, {
    method: "PATCH",
    json: {
      body: `${marker}\n\n${notes}\nAll five release assets were downloaded and verified against their local SHA-256 hashes.\n`,
      draft: true,
    },
  });
  write(`draft ready: ${release.html_url}`);
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3)
      throw new Error("usage: node tools/publish-gitea.mjs ARTIFACT_DIRECTORY");
    await publishDraft({
      directory: process.argv[2],
      server: process.env.GITEA_SERVER_URL,
      repository: process.env.GITEA_REPOSITORY,
      token: process.env.GITEA_TOKEN,
      assetToken: process.env.GITEA_ASSET_TOKEN || process.env.GITEA_TOKEN,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = EXIT.FAILURE;
  }
}
