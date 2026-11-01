// The quota surfaces: --limits (fresh, cached, --max-age, JSON), the state
// root's quota cache, doctor's codex-quota= and the footer's quota line.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { LAUNCH, fixture } from "./support/codex-fixture.mjs";
import { FOOTER, delivered } from "./support/capture.mjs";
import {
  limitsLine,
  quotaLine,
  creditsText,
  spanText,
  protocolUsage,
  limitField,
} from "../src/delivery/usage.mjs";
import { quotaRefusal } from "../src/codex/account.mjs";
import { parseArgs } from "../src/cli/options.mjs";

const launch = [...LAUNCH.slice(0, -2), "--wait-ms", "8000"];
const RESET = Math.floor(Date.UTC(2026, 10, 3, 12, 28, 30) / 1000);
const SHORT_RESET = Math.floor(Date.UTC(2026, 10, 1, 10, 0, 0) / 1000);
const snapshot = (usedPercent = 81) => ({
  limitId: "codex",
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent, windowDurationMins: 10080, resetsAt: RESET },
  secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: SHORT_RESET },
  credits: { hasCredits: true, unlimited: false, balance: "63694.7912" },
  individualLimit: null,
  spendControlReached: null,
  planType: "prolite",
  rateLimitReachedType: null,
});
const account = {
  rateLimits: snapshot(),
  ordinaryUsageAllowed: true,
  rateLimitResetCredits: { availableCount: 0, credits: null },
  rateLimitsByLimitId: {
    codex: snapshot(),
    other: { primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: null } },
  },
};
const PRIVATE = /account-id-must-not-print|must-not-print@example\.invalid/;
const methods = (f) => f.events().filter((e) => e.direction === "in" && e.method);
const cache = (f) => path.join(f.state, "quota.json");

test("--limits reads the quota on one probe app-server, prints one line and caches it without the account's identity", async (t) => {
  const f = fixture(t, account);
  const done = await f.invoke(["--limits"]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(
    done.stdout,
    /^codex-subagents-for-claude-code-limits: login=in plan=prolite limit=codex used=81% remaining=19% window=7d resets=2026-11-03T12:28Z resets-in=\S+ secondary=12%\/5h@2026-11-01T10:00Z credits=63694\.79 reset-credits=0 reached=- ordinary-usage=yes other-limits=other:30%\/7d source=fresh age=0s\n$/,
  );
  const launches = f.events().filter((e) => e.direction === "launch");
  assert.equal(launches.length, 1);
  for (const flag of ["plugins", "apps", "hooks", "notify=[]", 'otel.exporter="none"'])
    assert.ok(launches[0].args.includes(flag), flag);
  assert.equal(
    launches[0].args.some((arg) => arg.startsWith("mcp_servers.")),
    false,
  );
  assert.deepEqual(
    methods(f).map((e) => e.method),
    ["initialize", "initialized", "account/read", "account/rateLimits/read"],
  );
  const cached = JSON.parse(fs.readFileSync(cache(f), "utf8"));
  assert.equal(cached.source, "read");
  assert.equal(cached.primary.usedPercent, 81);
  assert.equal(cached.ordinaryUsageAllowed, true);
  assert.doesNotMatch(fs.readFileSync(cache(f), "utf8") + done.stdout + done.stderr, PRIVATE);

  const json = await f.invoke(["--limits", "--json"]);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.login, "in");
  assert.equal(parsed.source, "fresh");
  assert.equal(parsed.quota.planType, "prolite");
  assert.equal(parsed.quota.buckets[0].limitId, "other");
  assert.doesNotMatch(json.stdout, PRIVATE);
});

test("--limits answers logout without a quota read and caches only a logout marker", async (t) => {
  const f = fixture(t, { loggedOut: true });
  const done = await f.invoke(["--limits"]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /^codex-subagents-for-claude-code-limits: login=out plan=- .* used=- /);
  assert.equal(
    methods(f).some((e) => e.method === "account/rateLimits/read"),
    false,
  );
  const saved = JSON.parse(fs.readFileSync(cache(f), "utf8"));
  assert.equal(saved.login, "out");
  assert.equal(saved.primary, undefined);
});

test("--limits --cached starts nothing, and --max-age refreshes only an older cache", async (t) => {
  const f = fixture(t, account);
  const none = await f.invoke(["--limits", "--cached"]);
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stdout, /login=- .* source=none age=-\n$/);
  assert.equal(f.events().length, 0, "--cached starts no process");
  const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
  fs.writeFileSync(
    cache(f),
    JSON.stringify({ at: old, source: "turn", primary: { usedPercent: 50, windowMinutes: 300 } }),
  );
  const cached = await f.invoke(["--limits", "--cached"]);
  assert.match(cached.stdout, /used=50% remaining=50% window=5h .* source=cache age=2h0m\n$/);
  const young = await f.invoke(["--limits", "--max-age", "180"]);
  assert.match(young.stdout, /source=cache/);
  assert.equal(f.events().length, 0);
  const stale = await f.invoke(["--limits", "--max-age", "60"]);
  assert.match(stale.stdout, /used=81% .* source=fresh age=0s\n$/);
  assert.equal(JSON.parse(fs.readFileSync(cache(f), "utf8")).source, "read");
});

test("--limits options are its own and validated", () => {
  assert.equal(parseArgs(["--limits", "--max-age", "30"])["max-age"], 30);
  for (const [argv, message] of [
    [["--cached"], /--cached works with --limits only/],
    [["--max-age", "5"], /--max-age works with --limits only/],
    [["--limits", "--cached", "--max-age", "5"], /--cached or --max-age/],
    [["--limits", "--max-age", "-1"], /--max-age needs a nonempty value|--max-age must be/],
    [["--limits", "--max-age", "99999"], /--max-age must be an integer/],
    [["--limits", "--probe"], /--limits takes only/],
    [["--json"], /--json works with --inspect, --limits or --transcript only/],
  ])
    assert.throws(() => parseArgs(argv), message, argv.join(" "));
});

test("a delivered turn refreshes the cache and adds the quota line after the unchanged footer", async (t) => {
  const f = fixture(t, {
    rateLimits: { ...snapshot(40), secondary: null },
    touchedFiles: ["a.txt"],
  });
  const done = await f.invoke(launch);
  assert.equal(done.code, 0, done.stderr);
  const out = delivered(done.stdout);
  assert.equal(out.footer.limit, "40%/7d");
  assert.deepEqual(out.touched, ["a.txt"]);
  assert.equal(
    out.quota,
    "codex-subagents-for-claude-code-quota: used=40% remaining=60% resets=2026-11-03T12:28Z credits=63694.79 context=-",
  );
  const tail = done.stdout.slice(
    done.stdout.lastIndexOf("codex-subagents-for-claude-code: status="),
  );
  assert.match(tail, FOOTER);
  assert.match(
    tail,
    /\ncodex-subagents-for-claude-code-touched: a\.txt\ncodex-subagents-for-claude-code-quota: /,
  );
  assert.equal(fs.readFileSync(out.footer.file, "utf8"), done.stdout);
  const cached = JSON.parse(fs.readFileSync(cache(f), "utf8"));
  assert.equal(cached.source, "turn");
  assert.equal(cached.primary.usedPercent, 40);
  const replay = await f.invoke(["--attach", out.footer.job, "--run", out.footer.run]);
  assert.equal(replay.code, 0, replay.stderr);
  assert.match(replay.stdout, /^codex-subagents-for-claude-code-replay: /);
  assert.equal(delivered(replay.stdout).quota, out.quota);
});

test("doctor reports codex-quota= and writes the cache, except with --read-only", async (t) => {
  const f = fixture(t, account);
  const readOnly = await f.invoke(["--doctor", "--read-only"]);
  assert.match(
    readOnly.stdout,
    /^codex-quota=81%\/7d resets=2026-11-03T12:28Z secondary=12%\/5h@2026-11-01T10:00Z$/m,
  );
  assert.equal(fs.existsSync(cache(f)), false);
  await f.invoke(["--doctor"]);
  assert.equal(JSON.parse(fs.readFileSync(cache(f), "utf8")).primary.usedPercent, 81);
  assert.doesNotMatch(readOnly.stdout, PRIVATE);
});

test("a binding secondary window drives limits and the durable quota footer without changing the first footer", async (t) => {
  const rateLimits = {
    ...snapshot(40),
    secondary: { usedPercent: 97, windowDurationMins: 300, resetsAt: SHORT_RESET },
  };
  const f = fixture(t, { rateLimits });
  const limits = await f.invoke(["--limits"]);
  assert.equal(limits.code, 0, limits.stderr);
  assert.match(
    limits.stdout,
    /used=97% remaining=3% window=5h resets=2026-11-01T10:00Z resets-in=\S+/,
  );
  const cached = await f.invoke(["--limits", "--cached"]);
  assert.match(cached.stdout, /used=97% remaining=3% window=5h resets=2026-11-01T10:00Z/);
  const done = await f.invoke(launch);
  assert.equal(done.code, 0, done.stderr);
  const out = delivered(done.stdout);
  assert.equal(out.footer.limit, "40%/7d");
  assert.match(out.quota, /used=97% remaining=3% resets=2026-11-01T10:00Z/);
  assert.equal(fs.readFileSync(out.footer.file, "utf8"), done.stdout);
  assert.match(quotaRefusal({ rateLimits }, 10), /3%.*2026-11-01T10:00Z/);
});

test("quota summaries handle secondary-only, tied, unknown and older primary-only accounting", () => {
  const primary = { usedPercent: 97, windowDurationMins: 10080, resetsAt: RESET };
  const secondary = { usedPercent: 97, windowDurationMins: 300, resetsAt: SHORT_RESET };
  for (const [rateLimits, first, reset] of [
    [{ primary, secondary }, "97%/7d", "2026-11-03T12:28Z"],
    [{ primary: null, secondary }, "-", "2026-11-01T10:00Z"],
    [{ primary: { usedPercent: -1 }, secondary }, "-", "2026-11-01T10:00Z"],
  ]) {
    const usage = protocolUsage(null, rateLimits);
    assert.equal(limitField(usage), first);
    assert.ok(quotaLine(usage).includes(`used=97% remaining=3% resets=${reset}`));
    assert.ok(quotaRefusal({ rateLimits }, 10).includes(reset));
  }
  assert.match(
    quotaLine({ limit: { usedPercent: 40, resetsAt: RESET } }),
    /used=40% remaining=60% resets=2026-11-03T12:28Z/,
  );
  assert.equal(
    quotaRefusal({ rateLimits: { primary: { usedPercent: 99, resetsAt: -1 } } }, 10).includes(
      "1969",
    ),
    false,
  );
});

test("quota fields render - for unknowns, cut credits and name spans by their two largest units", () => {
  assert.equal(creditsText({ balance: "12.3456" }), "12.34");
  assert.equal(creditsText({ unlimited: true }), "unlimited");
  assert.equal(creditsText({ hasCredits: false, balance: null }), "0");
  assert.equal(creditsText(null), "-");
  assert.equal(spanText(2 * 86_400_000 + 11 * 3_600_000 + 5), "2d11h");
  assert.equal(spanText(-5), "0s");
  assert.equal(
    quotaLine(null),
    "codex-subagents-for-claude-code-quota: used=- remaining=- resets=- credits=- context=-",
  );
  assert.match(
    limitsLine({ source: "none" }),
    /^codex-subagents-for-claude-code-limits: (?:[a-z-]+=-\s)+source=none age=-\n$/,
  );
});
