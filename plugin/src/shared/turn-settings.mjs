// Optional settings shared by current, archived and fork-seed turns. Keeping
// their copy/restore and validation rules together prevents rollback drift.
import { MCP_MODE, PROGRESS_MODE, PERCENT, SERVICE_TIER, validSummary } from "./constants.mjs";
import { validReview } from "./review.mjs";
import { validOutputSchema } from "./output-schema.mjs";
import { validCommitSubject, validCommitTrailers } from "./commit-message.mjs";

export const TURN_SETTINGS = Object.freeze([
  "commitSubject",
  "commitTrailers",
  "mcp",
  "progress",
  "summary",
  "review",
  "outputSchema",
  "tier",
  "compact",
  "quotaFloor",
]);
export const turnSettings = (run) =>
  Object.fromEntries(
    TURN_SETTINGS.filter((key) => run[key] !== undefined).map((key) => [key, run[key]]),
  );
export function restoreTurnSettings(run, source) {
  for (const key of TURN_SETTINGS) {
    if (source[key] !== undefined) run[key] = source[key];
    else delete run[key];
  }
}
export function validTurnSettings(run) {
  return (
    Boolean(run) &&
    (run.commitSubject === undefined || validCommitSubject(run.commitSubject)) &&
    (run.commitTrailers === undefined || validCommitTrailers(run.commitTrailers)) &&
    (run.mcp === undefined || Object.values(MCP_MODE).includes(run.mcp)) &&
    (run.progress === undefined || Object.values(PROGRESS_MODE).includes(run.progress)) &&
    (run.quotaFloor === undefined ||
      (Number.isInteger(run.quotaFloor) && run.quotaFloor >= 0 && run.quotaFloor <= PERCENT)) &&
    (run.summary === undefined || validSummary(run.summary)) &&
    (run.review === undefined || (validReview(run.review) && !run.write)) &&
    (run.outputSchema === undefined || (!run.review && validOutputSchema(run.outputSchema))) &&
    (run.tier === undefined || (!run.review && SERVICE_TIER.test(run.tier))) &&
    (run.compact === undefined || typeof run.compact === "boolean")
  );
}
