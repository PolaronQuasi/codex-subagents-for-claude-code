import { ROLES } from "../roles.mjs";
import { RUN_KEY, MODEL, THREAD_NAME_PREFIX } from "./constants.mjs";

export function threadName(runKey, model) {
  if (!RUN_KEY.test(runKey ?? "") || !MODEL.test(model ?? "")) return null;
  const role = Object.entries(ROLES).find(([, value]) => value.model === model)?.[0] ?? model;
  return `${THREAD_NAME_PREFIX}${runKey} ${role}`;
}
export function namedRun(name) {
  if (typeof name !== "string" || !name.startsWith(THREAD_NAME_PREFIX)) return null;
  const parts = name.slice(THREAD_NAME_PREFIX.length).split(" ");
  return parts.length === 2 && RUN_KEY.test(parts[0]) && MODEL.test(parts[1])
    ? { runKey: parts[0], role: parts[1] }
    : null;
}
