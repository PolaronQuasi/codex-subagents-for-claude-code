import {
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  SECOND_MS,
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
  PERCENT,
  CREDIT_DECIMALS,
  LIMITS_LINE,
  QUOTA_LINE,
  MAX_DATE_SECONDS,
} from "../shared/constants.mjs";
import { bindingWindow } from "../shared/quota-window.mjs";

// Date accepts only a finite epoch range. A malformed quota must never stop
// delivery of an otherwise complete answer.
export const timestampSeconds = (value) =>
  Number.isFinite(value) && value >= 0 && value <= MAX_DATE_SECONDS ? value : null;

// Native totals are cumulative across resume. A frozen pre-dispatch baseline
// gives the whole turn (including tool responses); last is just one response.
// Missing baselines and reset counters remain unknown, never invented usage.
export function protocolUsage(tokenUsage, rateLimits, baseline = undefined) {
  const count = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
  const total = tokenUsage?.total;
  const threadTotal = total
    ? {
        input: count(total.inputTokens),
        cached: count(total.cachedInputTokens),
        output: count(total.outputTokens),
        reasoning: count(total.reasoningOutputTokens),
        total: count(total.totalTokens),
      }
    : null;
  const fields = {
    input: "inputTokens",
    cached: "cachedInputTokens",
    output: "outputTokens",
    reasoning: "reasoningOutputTokens",
    total: "totalTokens",
  };
  const turn = threadTotal
    ? Object.fromEntries(
        Object.entries(threadTotal).map(([key, value]) => {
          const before = baseline === undefined ? 0 : count(baseline?.[fields[key]]);
          return [
            key,
            value !== null && before !== null && value >= before ? value - before : null,
          ];
        }),
      )
    : null;
  const windowUsage = (window) =>
    window
      ? {
          usedPercent: count(window.usedPercent),
          windowMinutes: count(window.windowDurationMins),
          resetsAt: timestampSeconds(window.resetsAt),
        }
      : null;
  // The context window's fill: the last response's total (its input holds the
  // thread so far) over the model's window. The cumulative total sums every
  // request of the turn, so it overstates.
  const window = count(tokenUsage?.modelContextWindow);
  const inContext = count(tokenUsage?.last?.totalTokens);
  return {
    context:
      window && inContext !== null
        ? {
            usedTokens: inContext,
            windowTokens: window,
            percent: Math.min(PERCENT, Math.round((inContext * PERCENT) / window)),
          }
        : null,
    turn,
    threadTotal,
    limit: windowUsage(rateLimits?.primary),
    secondaryLimit: windowUsage(rateLimits?.secondary),
    credits: typeof rateLimits?.credits?.balance === "string" ? rateLimits.credits.balance : null,
    creditStatus: rateLimits?.credits
      ? {
          balance:
            typeof rateLimits.credits.balance === "string" ? rateLimits.credits.balance : null,
          unlimited: rateLimits.credits.unlimited === true,
          hasCredits:
            typeof rateLimits.credits.hasCredits === "boolean"
              ? rateLimits.credits.hasCredits
              : null,
        }
      : null,
  };
}

const windowLabel = (minutes) =>
  !Number.isFinite(minutes)
    ? "-"
    : minutes % MINUTES_PER_DAY === 0
      ? `${minutes / MINUTES_PER_DAY}d`
      : minutes % MINUTES_PER_HOUR === 0
        ? `${minutes / MINUTES_PER_HOUR}h`
        : `${minutes}m`;
export const tokensField = (usage) =>
  usage?.turn
    ? ["input", "cached", "output", "reasoning"].map((name) => usage.turn[name] ?? "-").join("/")
    : "-";
export const limitField = (usage) =>
  Number.isFinite(usage?.limit?.usedPercent)
    ? `${usage.limit.usedPercent}%/${windowLabel(usage.limit.windowMinutes)}`
    : "-";

// The quota's printed fields: "-" for anything unknown, as in the footer.
export const percentText = (value) => (Number.isFinite(value) ? `${value}%` : "-");
export const remainingPercent = (window) =>
  Number.isFinite(window?.usedPercent) ? Math.max(0, PERCENT - window.usedPercent) : null;
// A reset time (seconds since the epoch) as a UTC minute: 2026-11-03T12:28Z.
export const utcMinute = (seconds) =>
  timestampSeconds(seconds) !== null
    ? new Date(seconds * SECOND_MS).toISOString().replace(/:\d\d\.\d+Z$/, "Z")
    : "-";
// A span as its two largest units: 2d11h, 3h5m, 12m or 40s.
export function spanText(ms) {
  if (!Number.isFinite(ms)) return "-";
  const value = Math.max(0, ms);
  const days = Math.floor(value / DAY_MS),
    hours = Math.floor((value % DAY_MS) / HOUR_MS),
    minutes = Math.floor((value % HOUR_MS) / MINUTE_MS);
  if (days) return `${days}d${hours}h`;
  if (hours) return `${hours}h${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${Math.floor(value / SECOND_MS)}s`;
}
// A balance cut, never rounded, to CREDIT_DECIMALS decimals.
export function creditsText(credits) {
  if (!credits) return "-";
  if (credits.unlimited) return "unlimited";
  const balance = /^(-?\d+)(?:\.(\d+))?$/.exec(credits.balance ?? "");
  if (balance)
    return balance[2] ? `${balance[1]}.${balance[2].slice(0, CREDIT_DECIMALS)}` : balance[1];
  return credits.hasCredits === false ? "0" : "-";
}
// A window as used%/window, and its reset when known: 12%/5h@2026-11-01T10:00Z.
export const windowText = (window) =>
  Number.isFinite(window?.usedPercent)
    ? `${window.usedPercent}%/${windowLabel(window.windowMinutes)}${timestampSeconds(window.resetsAt) !== null ? `@${utcMinute(window.resetsAt)}` : ""}`
    : "-";
const token = (value) =>
  value == null || value === "" ? "-" : String(value).replace(/[\s\x00-\x1f\x7f]+/g, "?");
const yesNo = (value) => (value == null ? "-" : value ? "yes" : "no");

// The one --limits line. answer: { login, quota (a cached entry), source,
// ageMs }; now dates the time left to the reset.
export function limitsLine({ login = null, quota = null, source, ageMs = null }, now = Date.now()) {
  const window = bindingWindow(quota);
  const fields = [
    ["login", login],
    ["plan", quota?.planType],
    ["limit", quota?.limitId],
    ["used", percentText(window?.usedPercent)],
    ["remaining", percentText(remainingPercent(window))],
    ["window", windowLabel(window?.windowMinutes)],
    ["resets", utcMinute(window?.resetsAt)],
    [
      "resets-in",
      timestampSeconds(window?.resetsAt) !== null
        ? spanText(window.resetsAt * SECOND_MS - now)
        : "-",
    ],
    ["secondary", windowText(quota?.secondary)],
    ["credits", creditsText(quota?.credits)],
    ["reset-credits", quota?.resetCredits],
    ["reached", quota?.reachedType],
    ["ordinary-usage", yesNo(quota?.ordinaryUsageAllowed)],
    [
      "other-limits",
      (Array.isArray(quota?.buckets) ? quota.buckets : [])
        .filter((bucket) => bucket && typeof bucket.limitId === "string")
        .map((bucket) => `${bucket.limitId}:${windowText(bucket.primary)}`),
    ],
    ["source", source],
    ["age", spanText(ageMs)],
  ];
  return `${LIMITS_LINE} ${fields.map(([name, value]) => `${name}=${token(Array.isArray(value) ? value.join(",") : value)}`).join(" ")}\n`;
}

// The footer's quota line, after its first line and the touched lines. It
// names an absolute reset time only, so a durable copy and stdout agree.
export function quotaLine(usage) {
  const window = bindingWindow({ primary: usage?.limit, secondary: usage?.secondaryLimit });
  return (
    `${QUOTA_LINE} used=${percentText(window?.usedPercent)} remaining=${percentText(remainingPercent(window))}` +
    ` resets=${utcMinute(window?.resetsAt)} credits=${creditsText(usage?.creditStatus ?? (usage?.credits == null ? null : { balance: usage.credits }))}` +
    ` context=${percentText(usage?.context?.percent)}`
  );
}
