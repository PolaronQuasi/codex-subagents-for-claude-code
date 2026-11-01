// Works with either wire or cached windows: both name usedPercent and resetsAt.
// Keep the primary on ties, matching the quota-floor policy.
export function bindingWindow(snapshot) {
  return [snapshot?.primary, snapshot?.secondary]
    .filter((window) => Number.isFinite(window?.usedPercent) && window.usedPercent >= 0)
    .reduce(
      (most, window) => (!most || window.usedPercent > most.usedPercent ? window : most),
      null,
    );
}
