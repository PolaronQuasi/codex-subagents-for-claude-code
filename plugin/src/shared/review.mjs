// The stable review API has mutually exclusive targets: it cannot combine a
// structured diff target with arbitrary instructions. Never silently drop text.
import { validGitRef, REVIEW_TARGET } from "./constants.mjs";

export function validReview(value) {
  return (
    typeof value === "string" &&
    (value === "uncommitted" ||
      value === "custom" ||
      (value.startsWith("base:") && validGitRef(value.slice(5))) ||
      /^commit:[0-9a-fA-F]{7,40}$/.test(value))
  );
}
export const structuredReview = (value) => validReview(value) && value !== "custom";

export function reviewTarget(value, instructions) {
  if (!validReview(value))
    throw new Error("review needs uncommitted, base:<ref>, commit:<hex>, or custom");
  if (value === "custom") return { type: REVIEW_TARGET.CUSTOM, instructions };
  if (value === "uncommitted") return { type: REVIEW_TARGET.UNCOMMITTED };
  if (value.startsWith("base:")) return { type: REVIEW_TARGET.BASE, branch: value.slice(5) };
  return { type: REVIEW_TARGET.COMMIT, sha: value.slice(7) };
}
