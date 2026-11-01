import assert from "node:assert/strict";
import test from "node:test";
import { publishDraft } from "../../tools/publish-gitea.mjs";
import { distributionFixture } from "../support/distribution-fixture.mjs";

function forge(bundle) {
  const state = {
    release: null,
    assets: [],
    uploads: 0,
    calls: [],
    corrupt: false,
    foreign: false,
    invalidUuid: false,
    failUpload: 0,
    commit: bundle.manifest.commit,
  };
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  state.fetch = async (url, options) => {
    assert.equal(url.origin, "http://gitea:3000");
    assert.equal(
      options.headers.Authorization,
      url.pathname.startsWith("/attachments/") ? "token read-only-secret" : "token test-secret",
    );
    assert.equal(options.redirect, "error");
    state.calls.push([options.method, url.pathname]);
    const route = url.pathname.replace("/api/v1/repos/example/codex-subagents-for-claude-code", "");
    if (route === `/tags/${bundle.manifest.tag}`) return json({ commit: { sha: state.commit } });
    if (route === `/releases/tags/${bundle.manifest.tag}`)
      return json(state.release, state.release ? 200 : 404);
    if (route === "/releases" && options.method === "POST") {
      state.release = {
        ...JSON.parse(options.body),
        id: 42,
        html_url: "http://localhost:3000/example/codex-subagents-for-claude-code/releases",
      };
      return json(state.release, 201);
    }
    if (route === "/releases/42") {
      if (options.method === "PATCH") Object.assign(state.release, JSON.parse(options.body));
      return json(state.release);
    }
    if (route === "/releases/42/assets") {
      if (options.method === "GET") return json(state.assets.map(({ bytes, ...asset }) => asset));
      const attempt = ++state.uploads;
      if (attempt === state.failUpload) return json({}, 503);
      const bytes = Buffer.from(await options.body.get("attachment").arrayBuffer());
      const asset = {
        name: url.searchParams.get("name"),
        size: bytes.length,
        bytes,
        uuid: state.invalidUuid
          ? "../outside"
          : `00000000-0000-4000-8000-${attempt.toString(16).padStart(12, "0")}`,
        browser_download_url: `${state.foreign ? "https://outside.invalid" : "http://localhost:3000"}/example/codex-subagents-for-claude-code/releases/download/${bundle.manifest.tag}/${url.searchParams.get("name")}`,
      };
      state.assets.push(asset);
      const { bytes: _, ...metadata } = asset;
      return json(metadata, 201);
    }
    if (url.pathname.startsWith("/attachments/")) {
      const asset = state.assets.find((item) => `/attachments/${item.uuid}` === url.pathname);
      return new Response(state.corrupt ? Buffer.from("corrupt") : asset.bytes);
    }
    throw new Error(`unexpected request ${options.method} ${url}`);
  };
  return state;
}

test("Gitea publication verifies every download, resumes drafts and rejects unsafe changes", async (t) => {
  const { bundle } = distributionFixture(t);
  const run = (state) =>
    publishDraft({
      directory: bundle.directory,
      server: "http://gitea:3000",
      repository: "example/codex-subagents-for-claude-code",
      token: "test-secret",
      assetToken: "read-only-secret",
      fetchImpl: state.fetch,
      write() {},
    });
  const state = forge(bundle);
  state.failUpload = 3;
  await assert.rejects(run(state), /HTTP 503/);
  assert.equal(state.release.draft, true);
  assert.equal(state.release.target_commitish, bundle.manifest.commit);
  assert.equal(state.assets.length, 2);
  await run(state);
  assert.equal(state.assets.length, 5);
  assert.match(state.release.body, /All five release assets/);
  const uploads = state.uploads;
  await run(state);
  assert.equal(state.uploads, uploads);
  state.assets.push({ name: "unexpected.txt" });
  await assert.rejects(run(state), /unexpected remote asset/);
  state.assets.pop();
  state.release.draft = false;
  await assert.rejects(run(state), /already published/);
  state.release.draft = true;
  state.release.body = "A manual draft";
  await assert.rejects(run(state), /not owned/);
  state.commit = "0".repeat(40);
  await assert.rejects(run(state), /remote tag/);

  const corrupt = forge(bundle);
  corrupt.corrupt = true;
  await assert.rejects(run(corrupt), /checksum mismatch/);
  assert.equal(corrupt.uploads, 1);
  const foreign = forge(bundle);
  foreign.foreign = true;
  await run(foreign);
  assert.equal(foreign.uploads, 5); // The advertised foreign URL was never requested.
  const invalid = forge(bundle);
  invalid.invalidUuid = true;
  await assert.rejects(run(invalid), /invalid remote attachment UUID/);
  assert.equal(invalid.uploads, 1);
});
