// Bounded metadata only. Warning messages, buffering reasons/use cases and
// other backend free text can echo inputs; none is retained or printed here.
import {
  MODEL,
  MODEL_EVENT_ID_CHARS,
  MODEL_EVENT_MAX_REROUTES,
  MODEL_EVENT_LINE,
  MODEL_REROUTE_REASON,
  MODEL_WARNING,
  NOTIFICATION,
} from "./constants.mjs";

const modelId = (value) =>
  typeof value === "string" && value.length <= MODEL_EVENT_ID_CHARS && MODEL.test(value);

export function modelEvents(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reroutes = (Array.isArray(value.reroutes) ? value.reroutes : [])
    .slice(-MODEL_EVENT_MAX_REROUTES)
    .filter((entry) => modelId(entry?.from) && modelId(entry?.to))
    .map((entry) => ({
      from: entry.from,
      to: entry.to,
      reason: entry.reason === MODEL_REROUTE_REASON ? MODEL_REROUTE_REASON : null,
    }));
  const warnings = Object.values(MODEL_WARNING).filter(
    (warning) => Array.isArray(value.warnings) && value.warnings.includes(warning),
  );
  const buffering = typeof value.buffering === "boolean" ? value.buffering : null;
  if (!reroutes.length && !warnings.length && buffering === null) return null;
  return {
    reroutes,
    warnings,
    buffering,
    buffered: value.buffered === true || buffering === true,
    truncated: value.truncated === true || value.reroutes?.length > MODEL_EVENT_MAX_REROUTES,
  };
}

export function foldModelEvent(previous, method, params) {
  const next = modelEvents(previous) ?? {
    reroutes: [],
    warnings: [],
    buffering: null,
    buffered: false,
    truncated: false,
  };
  if (method === NOTIFICATION.MODEL_REROUTED) {
    if (!modelId(params.fromModel) || !modelId(params.toModel)) return null;
    next.reroutes.push({ from: params.fromModel, to: params.toModel, reason: params.reason });
  } else if (method === NOTIFICATION.MODEL_SAFETY_BUFFERING) {
    if (typeof params.showBufferingUi !== "boolean") return null;
    next.buffering = params.showBufferingUi;
    next.buffered ||= next.buffering;
  } else if (method === NOTIFICATION.GUARDIAN_WARNING) next.warnings.push(MODEL_WARNING.GUARDIAN);
  else if (method === NOTIFICATION.STRICT_REVIEW_REQUIRED)
    next.warnings.push(MODEL_WARNING.STRICT_REVIEW);
  else return null;
  return modelEvents(next);
}

export function modelEventLine(value) {
  const data = modelEvents(value);
  if (!data) return null;
  const last = data.reroutes.at(-1);
  return (
    `${MODEL_EVENT_LINE} rerouted=${last?.to ?? "-"} reason=${last?.reason ?? "-"}` +
    ` buffered=${data.buffered ? "yes" : "no"} buffering=${data.buffering === null ? "-" : data.buffering ? "yes" : "no"}` +
    ` warnings=${data.warnings.join(",") || "-"} truncated=${data.truncated ? "yes" : "no"}`
  );
}
