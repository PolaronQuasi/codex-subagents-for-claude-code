// Cross-feature regressions for run lifecycle and protocol boundaries.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, LAUNCH } from "./support/codex-fixture.mjs";
import { delivered } from "./support/capture.mjs";
import { CodexSession } from "../src/codex/session.mjs";
import { writeQuotaCache } from "../src/state/quota-cache.mjs";
import { protocolUsage, quotaLine, utcMinute } from "../src/delivery/usage.mjs";

const launch = [...LAUNCH.slice(0, -2), "--wait-ms", "10000"];
const snapshot = (used = 20) => ({
  primary: { usedPercent: used, windowDurationMins: 300, resetsAt: null },
});

test("quota updates preserve absent fields but clear explicit nulls", () => {
  const session = new CodexSession({});
  session.noteRateLimits(
    { ...snapshot(90), planType: "pro", rateLimitReachedType: "rate_limit_reached" },
    "turn",
  );
  session.noteRateLimits(
    { primary: null, secondary: snapshot().primary, rateLimitReachedType: null },
    "turn",
  );
  assert.equal(session.rateLimits.primary, null);
  assert.equal(session.rateLimits.rateLimitReachedType, null);
  assert.equal(session.rateLimits.planType, "pro");
  assert.match(quotaLine(protocolUsage(null, session.rateLimits)), /used=20% remaining=80%/);
});

test("a status-only quota denial replaces an older allowed cache", async (t) => {
  const f = fixture(t, { rateLimits: snapshot(), ordinaryUsageAllowed: true });
  assert.equal((await f.invoke(["--limits"])).code, 0);
  f.configure({
    rateLimits: {
      primary: null,
      secondary: null,
      credits: null,
      rateLimitReachedType: "rate_limit_reached",
    },
    ordinaryUsageAllowed: false,
  });
  assert.equal((await f.invoke(["--limits"])).code, 0);
  const cached = await f.invoke(["--limits", "--cached"]);
  assert.equal(cached.code, 0, cached.stderr);
  assert.match(cached.stdout, /used=- remaining=-/);
  assert.match(cached.stdout, /reached=rate_limit_reached ordinary-usage=no/);
  assert.match(cached.stdout, /login=-/);
});

test("fresh logout invalidates quota under the cache guard; read-only doctor does not", async (t) => {
  for (const command of [["--limits"], ["--doctor"]]) {
    const f = fixture(t, { rateLimits: snapshot(), ordinaryUsageAllowed: true });
    await f.invoke(["--limits"]);
    const file = path.join(f.state, "quota.json");
    const old = fs.readFileSync(file, "utf8");
    f.configure({ loggedOut: true });
    await f.invoke(["--doctor", "--read-only"]);
    assert.equal(fs.readFileSync(file, "utf8"), old);
    await f.invoke(command);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.login, "out");
    assert.equal(
      writeQuotaCache(f.state, { ...JSON.parse(old), at: "2000-01-01T00:00:00Z" }),
      false,
    );
    const cached = await f.invoke(["--limits", "--cached"]);
    assert.match(cached.stdout, /login=out .*used=- remaining=-/);
  }
});

test("invalid cache buckets are unknown without starting Codex", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.state, "quota.json"),
    JSON.stringify({ at: new Date().toISOString(), source: "read", buckets: {} }),
  );
  const result = await f.invoke(["--limits", "--cached"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /source=none/);
  assert.equal(f.events().length, 0);
});

test("invalid reset timestamps cannot prevent completed output; unlimited credits survive", async (t) => {
  const f = fixture(t, {
    rateLimits: {
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1e18 },
      credits: { unlimited: true, hasCredits: true, balance: null },
    },
  });
  const result = await f.invoke(launch);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.results().length, 1);
  assert.match(delivered(result.stdout).quota, /resets=- credits=unlimited/);
  for (const value of [1e18, Infinity, NaN, -1, null]) assert.equal(utcMinute(value), "-");
  assert.match(quotaLine(protocolUsage(null, { credits: { hasCredits: false } })), /credits=0/);
  assert.match(quotaLine({ credits: "12.345" }), /credits=12.34/);
});

test("failed partial answers retain the named error in both delivery copies", async (t) => {
  const f = fixture(t, {
    status: "failed",
    phase: null,
    result: "Partial answer\n",
    failure: "context exceeded",
    failureInfo: "contextWindowExceeded",
  });
  const result = await f.invoke(launch);
  assert.equal(result.code, 2, result.stderr);
  const body = delivered(result.stdout).body;
  assert.match(body, /Partial answer/);
  assert.match(body, /CODEX_CONTEXT_FULL/);
  assert.match(
    fs.readFileSync(path.join(f.resultsDir, f.results()[0]), "utf8"),
    /CODEX_CONTEXT_FULL/,
  );
});

test("a pre-dispatch continuation rollback preserves its previous quota policy", async (t) => {
  const f = fixture(t, { rateLimits: snapshot() });
  assert.equal(
    (await f.invoke([...launch, "--keep-state", "--keep-prompt", "--quota-floor", "10"])).code,
    0,
  );
  const key = f.runs()[0],
    before = f.metadata(key);
  f.configure({ version: "0.999.0" });
  const failed = await f.invoke([
    "--continue",
    key,
    "--prompt-file",
    "prompt.md",
    "--keep-prompt",
    "--quota-floor",
    "0",
  ]);
  assert.equal(failed.code, 1);
  assert.equal(f.metadata(key).jobId, before.jobId);
  assert.equal(f.metadata(key).quotaFloor, 10);
  const boundary = f.events().length;
  f.configure({ version: "0.166.0", rateLimits: snapshot(99), ordinaryUsageAllowed: false });
  const next = await f.invoke([
    "--continue",
    key,
    "--prompt-file",
    "prompt.md",
    "--wait-ms",
    "10000",
  ]);
  assert.equal(next.code, 2, next.stderr);
  const calls = f
    .events()
    .slice(boundary)
    .filter((event) => event.direction === "in");
  assert.equal(calls.filter((event) => event.method === "account/rateLimits/read").length, 1);
  assert.equal(calls.filter((event) => event.method === "turn/start").length, 0);
});

test("the first terminal notification freezes answer, turn identity and accounting items", () => {
  const session = new CodexSession({});
  session.threadId = "thread";
  session.turnId = "turn";
  const item = (id, text) => ({ id, type: "agentMessage", phase: "final_answer", text });
  session.notification("turn/completed", {
    threadId: "thread",
    turn: { id: "turn", status: "completed", items: [item("trusted", "TRUSTED_FINAL")] },
  });
  session.notification("item/completed", {
    threadId: "thread",
    turnId: "turn",
    item: item("late", "LATE_FINAL"),
  });
  session.notification("turn/started", { threadId: "thread", turn: { id: "unexpected" } });
  session.notification("turn/completed", {
    threadId: "thread",
    turn: { id: "turn", status: "failed", items: [] },
  });
  const result = session.result(session.terminal);
  assert.equal(result.text, "TRUSTED_FINAL");
  assert.equal(result.status, "completed");
  assert.equal(result.turnId, "turn");
});
