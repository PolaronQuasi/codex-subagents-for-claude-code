// The guards around the quota: the quota floor before turn/start, Codex's own
// failure names (codexErrorInfo) as runner codes, and the context window's fill.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { LAUNCH, fixture } from "./support/codex-fixture.mjs";
import { delivered } from "./support/capture.mjs";
import { mapCodexError, quotaRefusal } from "../src/codex/account.mjs";
import { parseTaskFile, applyDirectives } from "../src/cli/task-input.mjs";
import { parseArgs } from "../src/cli/options.mjs";
import { protocolUsage } from "../src/delivery/usage.mjs";

const launch = [...LAUNCH.slice(0, -2), "--wait-ms", "8000"];
const RESET = Math.floor(Date.UTC(2026, 10, 3, 12, 28, 30) / 1000);
const limits = (usedPercent, extra = {}) => ({
  limitId: "codex",
  primary: { usedPercent, windowDurationMins: 10080, resetsAt: RESET },
  secondary: null,
  credits: null,
  planType: "prolite",
  rateLimitReachedType: null,
  ...extra,
});
const sent = (f, method) => f.events().filter((e) => e.direction === "in" && e.method === method);
const order = (f) =>
  f
    .events()
    .filter((e) => e.direction === "in" && e.method)
    .map((e) => e.method);

test("a launch below its quota floor is refused before any thread, naming the reset", async (t) => {
  const f = fixture(t, { rateLimits: limits(95) });
  const done = await f.invoke([...launch, "--quota-floor", "10%"]);
  assert.equal(done.code, 2, done.stderr);
  const out = delivered(done.stdout);
  assert.equal(out.footer.status, "failed");
  assert.match(
    out.body,
    /^CODEX_QUOTA_LOW: 5% of the Codex quota remains, below the quota floor of 10%; it resets 2026-11-03T12:28Z \(in \S+\); the task was not sent to Codex\.\n$/,
  );
  assert.equal(sent(f, "thread/start").length, 0);
  assert.equal(sent(f, "turn/start").length, 0);
  assert.deepEqual(
    sent(f, "account/rateLimits/read").map((e) => e.params),
    [null],
  );
  const cached = JSON.parse(fs.readFileSync(path.join(f.state, "quota.json"), "utf8"));
  assert.equal(cached.source, "read");
  assert.equal(cached.primary.usedPercent, 95);
});

test("a floor the quota meets reads once before thread/start and runs; 0 sends no read", async (t) => {
  const f = fixture(t, { rateLimits: limits(50) });
  const done = await f.invoke([...launch, "--quota-floor", "10"]);
  assert.equal(done.code, 0, done.stderr);
  const methods = order(f);
  assert.ok(methods.indexOf("account/rateLimits/read") < methods.indexOf("thread/start"));
  assert.equal(sent(f, "account/rateLimits/read").length, 1);
  const off = fixture(t, { rateLimits: limits(99) });
  assert.equal((await off.invoke([...launch, "--quota-floor", "0"])).code, 0);
  assert.equal(sent(off, "account/rateLimits/read").length, 0);
});

test("the backend's ordinary-usage flag and a reached limit refuse; a null flag is unknown, not a denial", async (t) => {
  assert.match(
    quotaRefusal({ ordinaryUsageAllowed: false, rateLimits: limits(10) }, 5, RESET * 1000),
    /^CODEX_QUOTA_LOW: the backend does not allow ordinary usage on this account now; it resets 2026-11-03T12:28Z \(in 0s\); the task was not sent to Codex\.$/,
  );
  assert.match(
    quotaRefusal({ rateLimits: limits(10, { rateLimitReachedType: "rate_limit_reached" }) }, 5),
    /a Codex limit is reached \(rate_limit_reached\)/,
  );
  assert.equal(quotaRefusal({ ordinaryUsageAllowed: null, rateLimits: limits(10) }, 5), null);
  assert.equal(quotaRefusal({ rateLimits: { primary: null } }, 5), null, "no window, no proof");
  const secondary = {
    rateLimits: limits(10, {
      secondary: { usedPercent: 97, windowDurationMins: 300, resetsAt: RESET },
    }),
  };
  assert.match(quotaRefusal(secondary, 5), /3% of the Codex quota remains/, "the binding window");
  const f = fixture(t, { rateLimits: limits(20), ordinaryUsageAllowed: false });
  const done = await f.invoke([...launch, "--quota-floor", "1"]);
  assert.match(delivered(done.stdout).body, /^CODEX_QUOTA_LOW: the backend does not allow/);
  assert.equal(sent(f, "turn/start").length, 0);
});

test("the environment's default floor applies to a turn without its own, and an invalid one is refused", async (t) => {
  const f = fixture(t, { rateLimits: limits(85) });
  const env = { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_QUOTA_FLOOR: "20%" };
  const refused = await f.invoke([...launch, "--keep-prompt"], { env });
  assert.match(delivered(refused.stdout).body, /^CODEX_QUOTA_LOW: 15% of the Codex quota remains/);
  const own = await f.invoke([...launch, "--keep-prompt", "--quota-floor", "10"], { env });
  assert.equal(own.code, 0, own.stderr);
  const bad = await f.invoke(launch, {
    env: { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_QUOTA_FLOOR: "lots" },
  });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /CODEX_SUBAGENTS_FOR_CLAUDE_CODE_QUOTA_FLOOR needs a whole percent/);
});

test("quota-floor is a directive for launches and follow-ups, and --quota-floor is not for task files", () => {
  const parsed = parseTaskFile(Buffer.from("quota-floor: 10%\nwrite: no\n\nTask\n"));
  assert.equal(applyDirectives({}, parsed.directives)["quota-floor"], 10);
  const follow = parseTaskFile(
    Buffer.from(`continue: ${"a".repeat(32)}\nquota-floor: 5\n\nMore\n`),
  );
  assert.equal(applyDirectives({}, follow.directives)["quota-floor"], 5);
  assert.throws(
    () => applyDirectives({}, parseTaskFile(Buffer.from("quota-floor: 101%\n\nT\n")).directives),
    /whole percent from 0 to 100/,
  );
  assert.throws(
    () => parseTaskFile(Buffer.from("quota-flor: 10%\n\nT\n")),
    /did you mean quota-floor/,
  );
  assert.throws(() => parseTaskFile(Buffer.from("Quota-floor: 10%\n\nT\n")), /lowercase/);
  assert.equal(parseArgs([...launch, "--quota-floor", "7%"])["quota-floor"], 7);
  assert.throws(() => parseArgs([...launch, "--quota-floor", "x"]), /--quota-floor needs/);
  assert.throws(
    () => parseArgs(["--role", "gpt-6-1-sol", "--task-file", "t.md", "--quota-floor", "5"]),
    /--quota-floor cannot be used with --task-file/,
  );
  assert.throws(
    () => parseArgs(["--run", "a".repeat(32), "--quota-floor", "5"]),
    /--quota-floor cannot be used with --run/,
  );
});

test("Codex's failure names become runner codes with clear messages; other names stay CODEX_RPC_ERROR", () => {
  const now = RESET * 1000 - 3_600_000;
  const usage = mapCodexError(
    { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" },
    limits(100),
    now,
  );
  assert.deepEqual(usage, {
    code: "CODEX_USAGE_LIMIT",
    message:
      "CODEX_USAGE_LIMIT: the Codex usage limit of this account is reached; it resets 2026-11-03T12:28Z (in 1h0m). Codex said: You've hit your usage limit.",
  });
  for (const [info, code] of [
    ["rateLimitExceeded", "CODEX_USAGE_LIMIT"],
    ["contextWindowExceeded", "CODEX_CONTEXT_FULL"],
    ["sessionBudgetExceeded", "CODEX_CONTEXT_FULL"],
    ["modelNotFound", "CODEX_MODEL_UNAVAILABLE"],
    ["unauthorized", "CODEX_AUTH_REQUIRED"],
  ])
    assert.equal(mapCodexError({ message: "m", codexErrorInfo: info }).code, code, info);
  assert.match(
    mapCodexError({ message: "m", codexErrorInfo: "modelNotFound" }).message,
    /does not prove access/,
  );
  for (const info of [
    null,
    "serverOverloaded",
    { responseStreamDisconnected: { httpStatusCode: 502 } },
    "toString",
  ])
    assert.equal(mapCodexError({ message: "m", codexErrorInfo: info }), null);
});

test("a failed turn and a final error notification carry the named code to the result", async (t) => {
  const f = fixture(t, {
    status: "failed",
    failure: "This model's context window is exceeded.",
    failureInfo: "contextWindowExceeded",
    phase: "commentary",
  });
  const done = await f.invoke([...launch, "--keep-state"]);
  assert.equal(done.code, 2, done.stderr);
  assert.match(
    delivered(done.stdout).body,
    /^CODEX_CONTEXT_FULL: the thread's context window is full; start a new run instead of continuing this one\. Codex said: This model's context window is exceeded\.\n$/,
  );
  assert.equal(f.metadata().result.error.code, "CODEX_CONTEXT_FULL");
  const g = fixture(t, {
    rateLimits: limits(100),
    errors: [{ message: "Usage limit.", codexErrorInfo: "usageLimitExceeded", willRetry: false }],
    phase: "commentary",
  });
  const limited = await g.invoke(launch);
  assert.equal(limited.code, 2);
  assert.match(
    delivered(limited.stdout).body,
    /^CODEX_USAGE_LIMIT: the Codex usage limit of this account is reached; it resets 2026-11-03T12:28Z \(in \S+\)\. Codex said: Usage limit\.\n$/,
  );
});

test("the context window's fill reaches the quota line and --list, and a kept run near it is warned", async (t) => {
  const usage = (inContext) => ({
    last: { totalTokens: inContext },
    total: { inputTokens: 900_000, totalTokens: 950_000 },
    modelContextWindow: 200_000,
  });
  assert.deepEqual(protocolUsage(usage(84_000), null).context, {
    usedTokens: 84_000,
    windowTokens: 200_000,
    percent: 42,
  });
  assert.equal(protocolUsage({ last: { totalTokens: 5 } }, null).context, null);
  const f = fixture(t, { tokenUsage: usage(180_000) });
  const full = await f.invoke([...launch, "--keep-state", "--quiet"]);
  assert.equal(full.code, 0, full.stderr);
  assert.match(delivered(full.stdout).quota, / context=90%$/);
  assert.match(full.stderr, /thread is 90% of its context window; a follow-up may compact or fail/);
  assert.match((await f.invoke(["--list"])).stdout, / driver=\S+ context=90% session=/);
  const g = fixture(t, { tokenUsage: usage(150_000) });
  const note = await g.invoke([...launch, "--keep-state", "--keep-prompt"]);
  assert.match(note.stderr, /thread is 75% of its context window/);
  const quiet = await g.invoke([...launch, "--keep-state", "--quiet"]);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /context window/);
});
