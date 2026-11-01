import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { publishDraft } from "../../tools/publish-github.mjs";
import { digest } from "../../tools/distribution.mjs";
import { distributionFixture } from "../support/distribution-fixture.mjs";

function github(bundle) {
  const state = {
    release: null,
    assets: [],
    calls: [],
    commit: bundle.manifest.commit,
    annotated: true,
  };
  const tagObject = "a".repeat(40);
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  state.fetch = async (url, options) => {
    assert.ok(["https://api.github.com", "https://uploads.github.com"].includes(url.origin));
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(
      !["PATCH", "DELETE", "PUT"].includes(options.method),
      "no overwrite or publication operation",
    );
    state.calls.push([options.method, url.href]);
    const route = url.pathname.replace("/repos/example/codex-subagents-for-claude-code", "");
    if (route === `/git/ref/tags/${bundle.manifest.tag}`)
      return json({
        ref: `refs/tags/${bundle.manifest.tag}`,
        object: state.annotated
          ? { type: "tag", sha: tagObject }
          : { type: "commit", sha: state.commit },
      });
    if (route === `/git/tags/${tagObject}`)
      return json({
        sha: tagObject,
        object: state.cycle
          ? { type: "tag", sha: tagObject }
          : { type: "commit", sha: state.commit },
      });
    if (route.startsWith("/releases/tags/"))
      return json(state.release, state.release && !state.draftHidden ? 200 : 404);
    if (route === "/releases") {
      if (options.method === "GET") {
        if (state.paginate && url.searchParams.get("page") === "1")
          return json(Array.from({ length: 100 }, () => ({ tag_name: "v0.0.0" })));
        return json(state.release ? [state.release] : []);
      }
      state.release = {
        ...JSON.parse(options.body),
        id: 42,
        upload_url: "https://outside.invalid/steal",
      };
      if (state.badCreation) state.release.draft = false;
      assert.equal(state.release.target_commitish, bundle.manifest.commit);
      return json(state.release, 201);
    }
    if (route === "/releases/42") {
      if (state.changeDraft && state.assets.length) state.release.draft = false;
      return json(state.release);
    }
    if (route === "/releases/42/assets") {
      if (options.method === "GET") {
        const assets = state.assets.map((asset) => ({ ...asset }));
        if (state.extraAsset) assets.push({ name: "foreign.txt" });
        if (state.finalCorrupt) assets[0].digest = "sha256:" + "0".repeat(64);
        return json(assets);
      }
      assert.equal(url.origin, "https://uploads.github.com");
      if (state.failUpload === state.assets.length + 1) return json({}, 503);
      const name = url.searchParams.get("name");
      assert.deepEqual(options.body, fs.readFileSync(path.join(bundle.directory, name)));
      const asset = {
        id: state.assets.length + 1,
        name,
        state: "uploaded",
        size: options.body.length,
        digest: `sha256:${digest(options.body)}`,
      };
      state.assets.push(asset);
      if (state.moveTag) state.commit = "b".repeat(40);
      if (state.corrupt) asset.digest = "sha256:" + "0".repeat(64);
      return json(asset, 201);
    }
    throw new Error(`unexpected request ${options.method} ${url}`);
  };
  return state;
}

test("GitHub publication binds annotated and lightweight tags, verifies all asset digests and leaves a draft", async (t) => {
  const { bundle } = distributionFixture(t);
  for (const annotated of [true, false]) {
    const state = github(bundle);
    state.annotated = annotated;
    const result = await publishDraft({
      directory: bundle.directory,
      repository: "example/codex-subagents-for-claude-code",
      token: "fixture-token",
      fetchImpl: state.fetch,
      write() {},
    });
    assert.equal(result.draft, true);
    assert.equal(result.name, `codex-subagents-for-claude-code ${bundle.manifest.tag}`);
    assert.deepEqual(state.assets.map((asset) => asset.name).sort(), [...bundle.assets].sort());
    assert.ok(state.calls.every(([, url]) => !url.includes("outside.invalid")));
  }
});

test("GitHub retries refuse matching drafts including paginated drafts absent from the published-tag endpoint", async (t) => {
  const { bundle } = distributionFixture(t);
  const state = github(bundle);
  const run = () =>
    publishDraft({
      directory: bundle.directory,
      repository: "example/codex-subagents-for-claude-code",
      token: "fixture-token",
      fetchImpl: state.fetch,
      write() {},
    });
  state.failUpload = 3;
  await assert.rejects(run(), /HTTP 503/);
  assert.equal(state.release.draft, true);
  assert.equal(state.assets.length, 2);
  for (const hidden of [false, true]) {
    state.draftHidden = hidden;
    state.paginate = hidden;
    state.calls = [];
    await assert.rejects(run(), /already exists/);
    assert.ok(state.calls.every(([method]) => method === "GET"));
    assert.equal(state.assets.length, 2);
  }
});

test("GitHub publisher refuses wrong identity, tag changes, corrupt assets and changed publication state", async (t) => {
  const { bundle } = distributionFixture(t);
  const run = (state, extra = {}) =>
    publishDraft({
      directory: bundle.directory,
      repository: "example/codex-subagents-for-claude-code",
      token: "fixture-token",
      fetchImpl: state.fetch,
      write() {},
      ...extra,
    });
  for (const repository of [
    "example/unrelated-project",
    "OWNER/codex-subagents-for-claude-code",
    "example/../outside",
  ]) {
    const state = github(bundle);
    await assert.rejects(run(state, { repository }), /repository must/);
    assert.equal(state.calls.length, 0);
  }
  for (const [setting, expected] of [
    [{ commit: "0".repeat(40) }, /remote tag/],
    [{ cycle: true }, /annotated tag chain/],
    [{ badCreation: true }, /draft identity/],
    [{ corrupt: true }, /SHA-256 mismatch/],
    [{ finalCorrupt: true }, /SHA-256 mismatch/],
    [{ extraAsset: true }, /asset inventory/],
    [{ moveTag: true }, /remote tag/],
    [{ changeDraft: true }, /draft identity/],
  ]) {
    const state = Object.assign(github(bundle), setting);
    await assert.rejects(run(state), expected);
    if (setting.commit || setting.cycle)
      assert.ok(state.calls.every(([method]) => method === "GET"));
    if (setting.corrupt || setting.changeDraft) assert.equal(state.assets.length, 1);
  }
});
