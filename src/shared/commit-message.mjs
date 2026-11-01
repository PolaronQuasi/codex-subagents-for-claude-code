import {
  COMMIT_SUBJECT_CHARS,
  COMMIT_TRAILERS_MAX,
  COMMIT_TRAILER_CHARS,
  COMMIT_TRAILERS_BYTES,
} from "./constants.mjs";
import { readLimited } from "./io.mjs";

export const validCommitSubject = (value) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= COMMIT_SUBJECT_CHARS &&
  !/[\x00-\x1f\x7f]/.test(value);
export function validCommitTrailers(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length <= COMMIT_TRAILERS_MAX &&
    Object.entries(value).every(
      ([key, text]) =>
        /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(key) &&
        !/^Codex-/i.test(key) &&
        typeof text === "string" &&
        text.trim() === text &&
        text.length > 0 &&
        text.length <= COMMIT_TRAILER_CHARS &&
        !/[\x00-\x1f\x7f]/.test(text) &&
        (!/^Co-authored-by$/i.test(key) || /^[^<>]+ <[^<>\s@]+@[^<>\s@]+>$/.test(text)),
    )
  );
}
export function loadCommitTrailers(file) {
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(readLimited(file, COMMIT_TRAILERS_BYTES)),
  );
  if (!validCommitTrailers(value))
    throw new Error(
      "invalid commit trailers: use at most 16 single-line key/value pairs; Codex-* keys are reserved",
    );
  return value;
}
export function commitMessage(run, label) {
  const subject =
    run.commitSubject ??
    `codex-subagents-for-claude-code ${run.runKey} ${label}: ${run.model ?? "codex"} ${run.effort ?? ""}`.trim();
  const trailers = {
    ...run.commitTrailers,
    "Codex-Run": run.runKey,
    "Codex-Model": run.model ?? "codex",
    ...(run.turnRequestId || run.requestId
      ? { "Codex-Request": run.turnRequestId ?? run.requestId }
      : {}),
  };
  return (
    subject +
    "\n\n" +
    Object.entries(trailers)
      .map(([key, value]) => key + ": " + value)
      .join("\n")
  );
}
