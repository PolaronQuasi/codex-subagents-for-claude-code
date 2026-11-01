// The account's quota, read without a thread or a model call, and the
// normalized snapshot the state root caches. Neither the account's email nor
// its ID is kept: account/read's email and the read's accountId are dropped
// here, before anything is printed, logged or cached.
import {
  RPC,
  QUOTA_SOURCE,
  CODEX_LOGIN,
  MAX_LIMIT_BUCKETS,
  PERCENT,
  SECOND_MS,
  CODEX_ERROR_INFO,
  CODEX_ERROR_TEXT,
  QUOTA_TEXT,
} from "../shared/constants.mjs";
import { CODES } from "../shared/errors.mjs";
import { spanText, utcMinute, timestampSeconds } from "../delivery/usage.mjs";
import { bindingWindow } from "../shared/quota-window.mjs";

const count = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const word = (value) => (typeof value === "string" && value ? value : null);
const flag = (value) => (typeof value === "boolean" ? value : null);

// A protocol window ({usedPercent, windowDurationMins, resetsAt}) as the
// runner keeps it ({usedPercent, windowMinutes, resetsAt}), or null.
export function quotaWindow(window) {
  const usedPercent = count(window?.usedPercent);
  if (usedPercent === null) return null;
  return {
    usedPercent,
    windowMinutes: count(window.windowDurationMins),
    resetsAt: timestampSeconds(window.resetsAt),
  };
}

function credits(value) {
  if (!value || typeof value !== "object") return null;
  return {
    hasCredits: flag(value.hasCredits),
    unlimited: flag(value.unlimited),
    balance: word(value.balance),
  };
}

// One snapshot (a RateLimitSnapshot) with when and how it was seen. A pushed
// update carries no ordinary-usage flag, reset credits or other buckets.
export function quotaEntry(
  snapshot,
  { at, source, ordinaryUsageAllowed = null, resetCredits = null, buckets = null, planType = null },
) {
  if (!Number.isFinite(Date.parse(at ?? ""))) return null;
  if (!snapshot || typeof snapshot !== "object") {
    if (typeof ordinaryUsageAllowed !== "boolean") return null;
    snapshot = {};
  }
  return {
    at,
    source,
    limitId: word(snapshot.limitId),
    planType: word(snapshot.planType) ?? word(planType),
    primary: quotaWindow(snapshot.primary),
    secondary: quotaWindow(snapshot.secondary),
    credits: credits(snapshot.credits),
    reachedType: word(snapshot.rateLimitReachedType),
    ordinaryUsageAllowed: flag(ordinaryUsageAllowed),
    resetCredits: count(resetCredits),
    buckets,
  };
}

// A GetAccountRateLimitsResponse as an entry: its single-bucket view, plus
// the other buckets of its multi-bucket view.
export function quotaFromRead(read, at, planType = null) {
  const main = read?.rateLimits;
  const buckets = Object.entries(read?.rateLimitsByLimitId ?? {})
    .filter(([id, snapshot]) => snapshot && id !== (main?.limitId ?? null))
    .slice(0, MAX_LIMIT_BUCKETS)
    .map(([id, snapshot]) => ({
      limitId: id,
      primary: quotaWindow(snapshot.primary),
      secondary: quotaWindow(snapshot.secondary),
    }));
  return quotaEntry(main, {
    at,
    source: QUOTA_SOURCE.READ,
    ordinaryUsageAllowed: read?.ordinaryUsageAllowed,
    resetCredits: read?.rateLimitResetCredits?.availableCount,
    buckets,
    planType,
  });
}

const resetSentence = (window, now) =>
  timestampSeconds(window?.resetsAt) !== null
    ? `; ${QUOTA_TEXT.RESETS} ${utcMinute(window.resetsAt)} (in ${spanText(window.resetsAt * SECOND_MS - now)})`
    : "";

// Why a launch below its quota floor is refused, from an
// account/rateLimits/read before turn/start, or null to let it go on. The
// backend's ordinaryUsageAllowed decides when it says false; null is unknown,
// never a denial. A reached limit refuses too, and otherwise the binding
// window's remaining percent is held to the floor.
export function quotaRefusal(read, floor, now = Date.now()) {
  const snapshot = read?.rateLimits;
  const window = bindingWindow(snapshot);
  const remaining = window ? Math.max(0, PERCENT - window.usedPercent) : null;
  const reason =
    read?.ordinaryUsageAllowed === false
      ? QUOTA_TEXT.NOT_ALLOWED
      : typeof snapshot?.rateLimitReachedType === "string" && snapshot.rateLimitReachedType
        ? `${QUOTA_TEXT.REACHED} (${snapshot.rateLimitReachedType})`
        : remaining !== null && remaining < floor
          ? `${remaining}% of the Codex quota ${QUOTA_TEXT.BELOW} ${floor}%`
          : null;
  return reason
    ? `${CODES.CODEX_QUOTA_LOW}: ${reason}${resetSentence(window, now)}; ${QUOTA_TEXT.NOT_SENT}.`
    : null;
}

// The runner codes for Codex's own failure names (TurnError.codexErrorInfo,
// a string or a one-key object). Names it does not list keep CODEX_RPC_ERROR.
const CODEX_ERROR_CODES = Object.freeze({
  [CODEX_ERROR_INFO.USAGE_LIMIT]: CODES.CODEX_USAGE_LIMIT,
  [CODEX_ERROR_INFO.RATE_LIMIT]: CODES.CODEX_USAGE_LIMIT,
  [CODEX_ERROR_INFO.CONTEXT_WINDOW]: CODES.CODEX_CONTEXT_FULL,
  [CODEX_ERROR_INFO.SESSION_BUDGET]: CODES.CODEX_CONTEXT_FULL,
  [CODEX_ERROR_INFO.MODEL_NOT_FOUND]: CODES.CODEX_MODEL_UNAVAILABLE,
  [CODEX_ERROR_INFO.UNAUTHORIZED]: CODES.CODEX_AUTH_REQUIRED,
});
export const codexErrorName = (info) =>
  typeof info === "string"
    ? info
    : info && typeof info === "object"
      ? (Object.keys(info)[0] ?? null)
      : null;

// A TurnError as { code, message }, or null when its name is not one the
// runner maps. A usage limit names the binding window's reset.
export function mapCodexError(turnError, rateLimits = null, now = Date.now()) {
  const name = codexErrorName(turnError?.codexErrorInfo);
  if (!name || !Object.hasOwn(CODEX_ERROR_CODES, name)) return null;
  const code = CODEX_ERROR_CODES[name];
  const reset =
    code === CODES.CODEX_USAGE_LIMIT ? resetSentence(bindingWindow(rateLimits), now) : "";
  const said =
    typeof turnError.message === "string" && turnError.message
      ? ` ${QUOTA_TEXT.SAID} ${turnError.message}`
      : "";
  return { code, message: `${code}: ${CODEX_ERROR_TEXT[name]}${reset}.${said}` };
}

// The login and, when logged in, the quota. Without a login the rate-limit
// read would fail, so it is not sent: a null account is the logged-out answer.
export async function readAccountQuota(session) {
  const account = await session.request(RPC.ACCOUNT_READ, {});
  if (!account?.account) return { login: CODEX_LOGIN.OUT, quota: null };
  const read = await session.request(RPC.RATE_LIMITS_READ, null);
  return {
    login: CODEX_LOGIN.IN,
    quota: quotaFromRead(read, new Date().toISOString(), account.account.planType),
  };
}
