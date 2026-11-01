// The pre-launch model check: model/list (cached per CLI build and day)
// refuses a model or an effort it proves unsupported, notes a retirement,
// and doctor reports each role against it, never as proof of access.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { LAUNCH, fixture } from "./support/codex-fixture.mjs";
import { delivered } from "./support/capture.mjs";
import { catalogModel, modelRefusal, listModels } from "../src/codex/models.mjs";
import { MODEL_LIST_MAX_PAGES, MAX_CATALOG_MODELS } from "../src/shared/constants.mjs";
import { ROLES } from "../src/roles.mjs";
import { CodexSession } from "../src/codex/session.mjs";
import { writeModelCache, readModelCache } from "../src/state/model-cache.mjs";

const launch = [...LAUNCH.slice(0, -2), "--wait-ms", "8000"];
const RETIRES = Math.floor(Date.UTC(2026, 11, 1) / 1000);
const model = (id, efforts, extra = {}) => ({
  id,
  model: id,
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: id,
  description: "",
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
    reasoningEffort,
    description: "",
  })),
  defaultReasoningEffort: efforts[0] ?? "medium",
  inputModalities: [],
  supportsPersonality: false,
  multiAgentVersion: null,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  availableAccessPrograms: null,
  isDefault: false,
  ...extra,
});
const ALL = ["low", "medium", "high", "xhigh", "max"];
const sent = (f, method) => f.events().filter((e) => e.direction === "in" && e.method === method);

test("an incomplete catalogue never refuses an unseen model or poisons the cache", async (t) => {
  for (const [count, pageSize] of [
    [MODEL_LIST_MAX_PAGES, 1],
    [MAX_CATALOG_MODELS, MAX_CATALOG_MODELS + 1],
  ]) {
    const f = fixture(t, {
      models: [
        ...Array.from({ length: count }, (_, i) => model(`other-${i}`, ALL)),
        model("gpt-6.1-sol", ALL),
      ],
      modelPageSize: pageSize,
    });
    const done = await f.invoke(launch);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(sent(f, "turn/start").length, 1);
    assert.equal(fs.existsSync(path.join(f.state, "models.json")), false);
  }
});

test("a complete catalogue at the size limit remains usable; malformed lists prove nothing", async () => {
  const data = Array.from({ length: MAX_CATALOG_MODELS }, (_, i) => model(`m-${i}`, ALL));
  assert.equal(
    (await listModels({ request: async () => ({ data, nextCursor: null }) })).length,
    MAX_CATALOG_MODELS,
  );
  for (const answer of [{}, { data: [null] }, { data, nextCursor: "more" }])
    await assert.rejects(listModels({ request: async () => answer }), /catalogue is incomplete/);
});

test("malformed or repeated model cursors never prepare a catalogue or prove a refusal", async () => {
  for (const nextCursor of [17, false, {}, [], "", "repeat"]) {
    const session = new CodexSession({ model: "wanted", effort: "xhigh" });
    let calls = 0;
    session.request = async () => {
      calls++;
      return { data: [model("other", ALL)], nextCursor };
    };
    await session.checkModel();
    assert.equal(session.modelCatalog, undefined);
    assert.equal(calls, nextCursor === "repeat" ? 2 : 1);
  }
});

test("an unlisted model is refused before any thread, saying the list cannot prove access", async (t) => {
  const f = fixture(t, {
    models: [model("other-model", ALL), model("hidden-one", ALL, { hidden: true })],
  });
  const done = await f.invoke(launch);
  assert.equal(done.code, 2, done.stderr);
  assert.match(
    delivered(done.stdout).body,
    /^CODEX_MODEL_UNLISTED: model gpt-6\.1-sol is not in this Codex CLI's model list \(codex-cli 0\.166\.0\); listed: other-model\. The list is the CLI's catalogue: it proves a typo, an effort mismatch or a retirement, never account access; the task was not sent to Codex\.\n$/,
  );
  assert.equal(sent(f, "thread/start").length, 0);
  assert.equal(sent(f, "turn/start").length, 0);
  assert.deepEqual(sent(f, "model/list")[0].params, { cursor: null, includeHidden: true });
});

test("ultra reaches turn/start literally where model/list offers it, and is refused before any thread where it does not, as for the luna models", async (t) => {
  // codex-cli 0.166.0's catalogue: ultra above max for the sol, terra and astra models, not for luna.
  const ultra = launch.map((arg) => (arg === "xhigh" ? "ultra" : arg));
  const f = fixture(t, { models: [model("gpt-6.1-sol", [...ALL, "ultra"])] });
  const ran = await f.invoke(ultra);
  assert.equal(ran.code, 0, ran.stderr);
  assert.match(ran.stdout, / effort=ultra /);
  assert.equal(sent(f, "turn/start")[0].params.effort, "ultra");
  const luna = ultra.map((arg) => (arg === "gpt-6.1-sol" ? "gpt-6-luna" : arg));
  const g = fixture(t, { models: [model("gpt-6-luna", ALL)] });
  const refused = await g.invoke(luna);
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(
    delivered(refused.stdout).body,
    /^CODEX_EFFORT_UNSUPPORTED: effort ultra is not an effort model\/list offers for gpt-6-luna; offered: low, medium, high, xhigh, max; the task was not sent to Codex\.\n$/,
  );
  assert.equal(sent(g, "thread/start").length, 0);
  assert.equal(sent(g, "turn/start").length, 0);
});

test("an effort the model does not offer is refused with the offered ones; a hidden listed model runs", async (t) => {
  const f = fixture(t, { models: [model("gpt-6.1-sol", ["low", "medium", "high", "xhigh"])] });
  const done = await f.invoke(launch.map((arg) => (arg === "xhigh" ? "max" : arg)));
  assert.equal(done.code, 2, done.stderr);
  assert.match(
    delivered(done.stdout).body,
    /^CODEX_EFFORT_UNSUPPORTED: effort max is not an effort model\/list offers for gpt-6\.1-sol; offered: low, medium, high, xhigh; the task was not sent to Codex\.\n$/,
  );
  assert.equal(sent(f, "turn/start").length, 0);
  const g = fixture(t, {
    models: [model("first", ALL), model("gpt-6.1-sol", ["low"], { hidden: true })],
    modelPageSize: 1,
  });
  const ran = await g.invoke(launch);
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(
    sent(g, "model/list").map((e) => e.params.cursor),
    [null, "1"],
    "every page is read",
  );
});

test("the catalogue is cached per CLI build and day, so the next launch sends no model/list", async (t) => {
  const f = fixture(t, { models: [model("gpt-6.1-sol", ALL)] });
  assert.equal((await f.invoke([...launch, "--keep-prompt"])).code, 0);
  const file = path.join(f.state, "models.json");
  const cache = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(cache.day, new Date().toISOString().slice(0, 10));
  assert.match(cache.build, /^[0-9a-f]{64}$/);
  assert.deepEqual(cache.models[0].efforts, ALL);
  assert.equal((await f.invoke([...launch, "--keep-prompt"])).code, 0);
  assert.equal(sent(f, "model/list").length, 1, "the cached catalogue answered");
  fs.writeFileSync(file, JSON.stringify({ ...cache, day: "2000-01-01" }));
  assert.equal((await f.invoke([...launch, "--keep-prompt"])).code, 0);
  assert.equal(sent(f, "model/list").length, 2, "yesterday's catalogue is listed again");
});

test("a failed model/list proves nothing and the launch goes on; a retirement is warned", async (t) => {
  const f = fixture(t);
  const done = await f.invoke(launch);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(sent(f, "model/list").length, 1);
  const g = fixture(t, {
    models: [
      model("gpt-6.1-sol", ALL, {
        upgradeInfo: {
          model: "gpt-7-sol",
          upgradeCopy: null,
          modelLink: null,
          migrationMarkdown: null,
          retirementAt: RETIRES,
        },
      }),
    ],
  });
  const warned = await g.invoke(launch);
  assert.equal(warned.code, 0, warned.stderr);
  assert.match(warned.stderr, /model gpt-6\.1-sol retires 2026-12-01T00:00Z; upgrade: gpt-7-sol\./);
});

test("cached model and effort refusals refresh, allowing catalogue additions during the day", async (t) => {
  for (const stale of [model("other", ALL), model("gpt-6.1-sol", ["low"])]) {
    const f = fixture(t, { models: [model("gpt-6.1-sol", ALL)] });
    assert.equal((await f.invoke([...launch, "--keep-prompt"])).code, 0);
    const file = path.join(f.state, "models.json");
    const cache = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...cache, models: [catalogModel(stale)] }));
    const done = await f.invoke(launch);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(sent(f, "model/list").length, 2);
    assert.equal(sent(f, "turn/start").length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).models[0].efforts, ALL);
  }
});

test("a cached refusal blocks only when its fresh list confirms it; a failed refresh permits launch", async (t) => {
  for (const fresh of [null, [model("other", ALL)]]) {
    const f = fixture(t, { models: [model("other", ALL)] });
    assert.equal((await f.invoke([...launch, "--keep-prompt"])).code, 2);
    assert.ok(fs.existsSync(path.join(f.state, "models.json")));
    f.configure({ models: fresh });
    const done = await f.invoke(launch);
    assert.equal(done.code, fresh ? 2 : 0, done.stderr);
    assert.equal(sent(f, "model/list").length, 2);
    assert.equal(sent(f, "thread/start").length, fresh ? 0 : 1);
    assert.equal(sent(f, "turn/start").length, fresh ? 0 : 1);
  }
});

test("logged-out doctor displays its catalogue without creating or replacing the logged-in cache", async (t) => {
  const f = fixture(t, { loggedOut: true, models: [model("other", ALL)] });
  const file = path.join(f.state, "models.json");
  assert.match((await f.invoke(["--doctor"])).stdout, /^codex-models=1 listed /m);
  assert.equal(fs.existsSync(file), false);
  f.configure({ loggedOut: false, models: [model("gpt-6.1-sol", ALL)] });
  await f.invoke(["--doctor"]);
  const before = fs.readFileSync(file, "utf8");
  f.configure({ loggedOut: true, models: [model("other", ALL)] });
  await f.invoke(["--doctor"]);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("an older driver catalogue cannot replace a newer doctor catalogue, including across build/day keys", (t) => {
  const f = fixture(t);
  assert.equal(
    readModelCache(f.state, undefined),
    null,
    "an absent cache is unknown even without a build",
  );
  const newer = {
    build: "new",
    day: "2026-11-01",
    at: "2026-11-01T00:01:00Z",
    models: [catalogModel(model("m", ALL))],
  };
  assert.equal(writeModelCache(f.state, newer), true);
  assert.equal(
    writeModelCache(f.state, { ...newer, at: "2026-11-01T00:00:00Z", models: [] }),
    false,
  );
  assert.equal(
    writeModelCache(f.state, {
      ...newer,
      build: "old",
      day: "2026-10-31",
      at: "2026-10-31T23:59:00Z",
    }),
    false,
  );
  assert.equal(writeModelCache(f.state, { ...newer, at: "invalid" }), false);
  assert.deepEqual(readModelCache(f.state, newer.build, newer.day), newer);
  const latest = { ...newer, at: "2026-11-01T00:02:00Z", models: [] };
  assert.equal(writeModelCache(f.state, latest), true);
  assert.deepEqual(readModelCache(f.state, newer.build, newer.day), latest);
});

test("doctor reports each role against the catalogue, flags unlisted models and unsupported efforts", async (t) => {
  const [first, second] = Object.entries(ROLES);
  const f = fixture(t, {
    models: [
      model(first[1].model, [first[1].effort, "max"], { defaultReasoningEffort: "medium" }),
      model(second[1].model, ["low"]),
    ],
  });
  const report = await f.invoke(["--doctor", "--read-only"]);
  assert.match(
    report.stdout,
    /^codex-models=2 listed \(catalogue only: a listed model can still be refused for this account\)$/m,
  );
  assert.match(
    report.stdout,
    new RegExp(
      `^model-${first[0]}=${first[1].model.replace(/\./g, "\\.")} listed=yes hidden=no efforts=${first[1].effort},max default=medium effort=${first[1].effort} upgrade=- retires=-$`,
      "m",
    ),
  );
  assert.match(
    report.stdout,
    new RegExp(`^model-${second[0]}=\\S+ listed=yes .*effort=\\S+\\(unsupported\\)`, "m"),
  );
  assert.match(
    report.stdout,
    new RegExp(`^problem=role ${second[0]}'s effort \\S+ is not offered`, "m"),
  );
  const third = Object.keys(ROLES)[2];
  assert.match(report.stdout, new RegExp(`^model-${third}=\\S+ listed=no$`, "m"));
  assert.match(
    report.stdout,
    new RegExp(`^problem=role ${third}'s model \\S+ is not in Codex's model list$`, "m"),
  );
  assert.equal(
    fs.existsSync(path.join(f.state, "models.json")),
    false,
    "--read-only writes no cache",
  );
  await f.invoke(["--doctor"]);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.state, "models.json"), "utf8")).models.length,
    2,
  );
  const g = fixture(t);
  assert.match((await g.invoke(["--doctor", "--read-only"])).stdout, /^codex-models=unavailable$/m);
});

test("the catalogue keeps only what the check needs and proves nothing about a model without efforts", () => {
  const kept = catalogModel(model("m", ["low"], { upgrade: "n", hidden: true }));
  assert.deepEqual(kept, {
    id: "m",
    model: "m",
    hidden: true,
    isDefault: false,
    defaultEffort: "low",
    efforts: ["low"],
    serviceTiers: [],
    upgrade: "n",
    retirementAt: null,
  });
  assert.equal(catalogModel({ model: "no id" }), null);
  assert.equal(modelRefusal([catalogModel(model("m", []))], "m", "max"), null);
});
