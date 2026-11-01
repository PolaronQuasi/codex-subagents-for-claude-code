// Deliberately project effective config rather than print its open-ended map:
// it can contain credentials, instructions, hook commands and exporter headers.
import { RPC, DOCTOR_MAX_ROWS, DOCTOR_WORD_CHARS, DOCTOR_DETAIL } from "../shared/constants.mjs";

const word = (value) =>
  typeof value === "string" && value.length <= DOCTOR_WORD_CHARS && /^[A-Za-z0-9._/-]+$/.test(value)
    ? value
    : null;
const words = (value) =>
  Array.isArray(value) ? value.slice(0, DOCTOR_MAX_ROWS).map(word).filter(Boolean) : null;
const rows = (value) => {
  if (!Array.isArray(value) || value.length > DOCTOR_MAX_ROWS)
    throw new Error("diagnostic inventory exceeds its bound or is malformed");
  return value;
};
export async function doctorDetails(session, { cwd, put, problems, signal }) {
  const read = async (key, method, params, project) => {
    signal?.throwIfAborted();
    try {
      put(key, JSON.stringify(project(await session.request(method, params))));
    } catch {
      put(key, "unavailable");
      problems.push(`${key} unavailable; details were not recorded`);
    }
  };
  await read(
    "codex-mcp",
    RPC.MCP_STATUS_LIST,
    { detail: DOCTOR_DETAIL, limit: DOCTOR_MAX_ROWS },
    (r) => ({
      servers: rows(r.data).map((s) => ({
        name: word(s.name),
        auth: word(s.authStatus),
        tools: Object.keys(s.tools ?? {}).length,
        error: Boolean(s.toolsError),
      })),
      truncated: Boolean(r.nextCursor),
    }),
  );
  await read("codex-hooks", RPC.HOOKS_LIST, { cwds: [cwd] }, (r) => ({
    scopes: rows(r.data).map((s) => ({
      hooks: rows(s.hooks).map((h) => ({
        event: word(h.eventName),
        handler: word(h.handlerType),
        enabled: typeof h.enabled === "boolean" ? h.enabled : null,
      })),
      warnings: Array.isArray(s.warnings) ? s.warnings.length : null,
      errors: Array.isArray(s.errors) ? s.errors.length : null,
    })),
  }));
  await read("codex-defaults", RPC.CONFIG_READ, { cwd, includeLayers: false }, (r) => {
    if (!r.config || typeof r.config !== "object") throw new Error("missing config");
    return Object.fromEntries(
      [
        "model",
        "review_model",
        "model_provider",
        "model_reasoning_effort",
        "model_reasoning_summary",
        "approval_policy",
        "sandbox_mode",
        "web_search",
        "service_tier",
      ].map((k) => [k, word(r.config[k])]),
    );
  });
  await read("codex-requirements", RPC.CONFIG_REQUIREMENTS_READ, null, (r) => ({
    managed: r.requirements != null,
    allowedSandboxModes: words(r.requirements?.allowedSandboxModes),
    allowedApprovalPolicies: words(r.requirements?.allowedApprovalPolicies),
    modelProvider: word(r.requirements?.modelProvider),
    supportsIndependentSpeedModes:
      typeof r.supportsIndependentSpeedModes === "boolean" ? r.supportsIndependentSpeedModes : null,
  }));
}
