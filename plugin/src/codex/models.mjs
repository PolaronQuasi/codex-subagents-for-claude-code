// model/list: the CLI's model catalogue. It can prove a model unknown to this
// CLI build, an effort the model does not offer, or a retirement, before a
// turn is sent; it never proves the account may use a listed model (a backend
// can refuse one, as modelNotFound).
import {
  RPC,
  APP_SERVER_PROBE_MS,
  MODEL_LIST_MAX_PAGES,
  MAX_CATALOG_MODELS,
  MAX_LISTED_MODELS,
  MODEL_TEXT,
  SERVICE_TIER,
  MODEL_MAX_TIERS,
} from "../shared/constants.mjs";
import { CODES, RunnerError } from "../shared/errors.mjs";
import { utcMinute } from "../delivery/usage.mjs";

const word = (value) => (typeof value === "string" && value ? value : null);

// One Model as the runner keeps it, or null.
export function catalogModel(model) {
  if (!word(model?.id)) return null;
  return {
    id: model.id,
    model: word(model.model) ?? model.id,
    hidden: model.hidden === true,
    isDefault: model.isDefault === true,
    defaultEffort: word(model.defaultReasoningEffort),
    efforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
      .map((option) => word(option?.reasoningEffort))
      .filter(Boolean),
    serviceTiers: (Array.isArray(model.serviceTiers) ? model.serviceTiers : [])
      .slice(0, MODEL_MAX_TIERS)
      .map((t) => t?.id)
      .filter((id) => typeof id === "string" && SERVICE_TIER.test(id)),
    upgrade: word(model.upgradeInfo?.model) ?? word(model.upgrade),
    retirementAt: Number.isFinite(model.upgradeInfo?.retirementAt)
      ? model.upgradeInfo.retirementAt
      : null,
  };
}

// Every page of model/list, hidden models included (a hidden model is never
// refused, only noted), bounded in pages and models. Throws when it fails.
export async function listModels(session) {
  const incomplete = () =>
    new RunnerError(
      CODES.CODEX_RPC_ERROR,
      "Model catalogue is incomplete or exceeds lookup limits",
    );
  const models = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < MODEL_LIST_MAX_PAGES; page++) {
    const answer = await session.request(
      RPC.MODEL_LIST,
      { cursor, includeHidden: true },
      APP_SERVER_PROBE_MS,
    );
    if (!Array.isArray(answer?.data) || (answer.nextCursor != null && !word(answer.nextCursor)))
      throw incomplete();
    for (const model of answer.data) {
      const entry = catalogModel(model);
      if (!entry || models.length >= MAX_CATALOG_MODELS) throw incomplete();
      models.push(entry);
    }
    if (answer.nextCursor == null) return models;
    cursor = answer.nextCursor;
    if (seen.has(cursor)) throw incomplete();
    seen.add(cursor);
    if (models.length >= MAX_CATALOG_MODELS) throw incomplete();
  }
  throw incomplete();
}

export const findModel = (models, name) =>
  models.find((entry) => entry.id === name) ?? models.find((entry) => entry.model === name) ?? null;

// Why the catalogue proves a turn's model or effort unsupported, as
// { code, message }, or null. A model that lists no efforts proves none.
export function modelRefusal(models, model, effort, version = null) {
  const entry = findModel(models, model);
  if (!entry) {
    const listed = models
      .filter((candidate) => !candidate.hidden)
      .map((candidate) => candidate.id)
      .slice(0, MAX_LISTED_MODELS)
      .join(", ");
    return {
      code: CODES.CODEX_MODEL_UNLISTED,
      message: `${CODES.CODEX_MODEL_UNLISTED}: model ${model} ${MODEL_TEXT.UNLISTED}${version ? ` (codex-cli ${version})` : ""}; ${MODEL_TEXT.LISTED} ${listed || "-"}. ${MODEL_TEXT.CATALOGUE}; ${MODEL_TEXT.NOT_SENT}.`,
    };
  }
  if (!entry.hidden && entry.efforts.length && !entry.efforts.includes(effort))
    return {
      code: CODES.CODEX_EFFORT_UNSUPPORTED,
      message: `${CODES.CODEX_EFFORT_UNSUPPORTED}: effort ${effort} ${MODEL_TEXT.EFFORT} ${model}; ${MODEL_TEXT.OFFERED} ${entry.efforts.join(", ")}; ${MODEL_TEXT.NOT_SENT}.`,
    };
  return null;
}

// What a listed model's upgrade information asks of its users, or null.
export function modelNotice(models, model) {
  const entry = findModel(models, model);
  if (!entry?.retirementAt) return null;
  return `model ${model} ${MODEL_TEXT.RETIRES} ${utcMinute(entry.retirementAt)}${entry.upgrade ? `; ${MODEL_TEXT.UPGRADE} ${entry.upgrade}` : ""}.`;
}
