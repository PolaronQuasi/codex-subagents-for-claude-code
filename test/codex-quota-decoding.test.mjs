import assert from "node:assert/strict";
import test from "node:test";
import { CodexSession } from "../src/codex/session.mjs";
import { quotaEntry } from "../src/codex/account.mjs";

test("status-only quota denial replaces an earlier allowance and survives delivery projection", () => {
  const session = new CodexSession({});
  session.noteRateLimits({ primary: { usedPercent: 10 } }, "read", { ordinaryUsageAllowed: true });
  session.noteRateLimits(null, "read", { ordinaryUsageAllowed: false });
  assert.equal(session.ordinaryUsageAllowed, false);
  const entry = quotaEntry(session.rateLimits, {
    at: session.rateLimitsAt,
    source: session.rateLimitsSource,
    ordinaryUsageAllowed: session.ordinaryUsageAllowed,
  });
  assert.equal(entry.ordinaryUsageAllowed, false);
  assert.equal(entry.primary.usedPercent, 10);
  const fresh = new CodexSession({});
  fresh.noteRateLimits(undefined, "read", { ordinaryUsageAllowed: false });
  assert.equal(
    quotaEntry(fresh.rateLimits, {
      at: fresh.rateLimitsAt,
      source: fresh.rateLimitsSource,
      ordinaryUsageAllowed: fresh.ordinaryUsageAllowed,
    }).ordinaryUsageAllowed,
    false,
  );
});

test("sparse quota reads preserve absent fields while explicit null clears them", () => {
  const session = new CodexSession({});
  session.noteRateLimits({}, "read", {
    ordinaryUsageAllowed: false,
    rateLimitResetCredits: { availableCount: 3 },
  });
  session.noteRateLimits({}, "read", {});
  session.noteRateLimits(null, "read", { rateLimitResetCredits: {} });
  assert.equal(session.ordinaryUsageAllowed, false);
  assert.equal(session.resetCredits, 3);
  session.noteRateLimits(null, "read", { ordinaryUsageAllowed: null, rateLimitResetCredits: null });
  assert.equal(session.ordinaryUsageAllowed, null);
  assert.equal(session.resetCredits, null);
});
