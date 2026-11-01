#!/usr/bin/env node
// Regenerate the installed CLI's public schema in scratch, certify our small
// protocol surface, then exercise the driver with the independent fake only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectCodex,
  requireSupportedCodex,
  codexLaunch,
  codexEnvironment,
} from "../src/codex/cli.mjs";
import {
  RPC,
  NOTIFICATION,
  SERVER_REQUEST,
  CODEX_COMMAND,
  MCP_OFF_FEATURES,
  CODEX_VALUE,
  CODEX_ERROR_INFO,
  TURN_STATUS,
  CODEX_PHASE,
  CODEX_ITEM,
  CODEX_READY,
  RECOVERY_SORT,
  EFFORTS,
  SUMMARY_MODES,
  MODEL_REROUTE_REASON,
  REVIEW_TARGET,
} from "../src/shared/constants.mjs";
import { EXIT } from "../src/shared/errors.mjs";
import { runProcess, readLimited } from "../src/shared/io.mjs";
import { answerServerRequest } from "../src/codex/policy.mjs";
import { createScratch } from "./scratch.mjs";
import { ROOT, testArguments } from "./test-files.mjs";

const SCHEMA_GENERATE_MS = 60_000;
const SCHEMA_MAX_BYTES = 64 * 1024 * 1024;
const SCHEMA_MAX_DEPTH = 128;
// Includes native Windows process identity/settlement checks across the full
// fake-driver contract group. This is a gate budget, not a model turn timeout.
const FAKE_TEST_MS = 600_000;
const FAKE_TESTS = [
  "test/codex-driver.test.mjs",
  "test/codex-ipc.test.mjs",
  "test/codex-recovery.test.mjs",
  "test/backend-delivery.test.mjs",
  "test/progress.test.mjs",
  "test/steer.test.mjs",
  "test/summary.test.mjs",
  "test/output-schema.test.mjs",
  "test/doctor-details.test.mjs",
  "test/service-tier.test.mjs",
  "test/bundle.test.mjs",
  "test/history-edit.test.mjs",
  "test/fork.test.mjs",
  "test/model-events.test.mjs",
  "test/review.test.mjs",
  "test/transcript.test.mjs",
  "test/threads.test.mjs",
];
const SCRATCH_PREFIX = "codex-protocol-contract-";
const REQUIRED = "required";
const TYPES = Object.freeze({
  OBJECT: "object",
  ARRAY: "array",
  STRING: "string",
  BOOLEAN: "boolean",
  INTEGER: "integer",
  NUMBER: "number",
  NULL: "null",
});
const RESPONSE_FILES = Object.freeze({
  [SERVER_REQUEST.COMMAND_APPROVAL]: "CommandExecutionRequestApprovalResponse.json",
  [SERVER_REQUEST.FILE_APPROVAL]: "FileChangeRequestApprovalResponse.json",
  [SERVER_REQUEST.PERMISSIONS_APPROVAL]: "PermissionsRequestApprovalResponse.json",
  [SERVER_REQUEST.APPLY_PATCH_APPROVAL]: "ApplyPatchApprovalResponse.json",
  [SERVER_REQUEST.EXEC_COMMAND_APPROVAL]: "ExecCommandApprovalResponse.json",
  [SERVER_REQUEST.USER_INPUT]: "ToolRequestUserInputResponse.json",
  [SERVER_REQUEST.TOOL_CALL]: "DynamicToolCallResponse.json",
  [SERVER_REQUEST.MCP_ELICITATION]: "McpServerElicitationRequestResponse.json",
});

const ensure = (ok, message) => {
  if (!ok) throw new Error(`Codex schema contract: ${message}`);
};

function dereference(document, node) {
  const seen = new Set();
  while (node?.$ref) {
    ensure(node.$ref.startsWith("#/"), "only local schema references are accepted");
    ensure(!seen.has(node.$ref), "cyclic schema alias");
    seen.add(node.$ref);
    node = node.$ref
      .slice(2)
      .split("/")
      .reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], document);
    ensure(
      typeof node === TYPES.BOOLEAN || (node && typeof node === TYPES.OBJECT),
      "unresolved schema reference",
    );
  }
  return node;
}

function alternatives(document, input) {
  const node = dereference(document, input);
  if (node?.anyOf || node?.oneOf)
    return (node.anyOf ?? node.oneOf).flatMap((child) => alternatives(document, child));
  if (node?.allOf) {
    const { allOf, ...base } = node;
    return allOf.reduce(
      (parents, child) =>
        parents.flatMap((parent) =>
          alternatives(document, child).map((branch) => ({
            ...parent,
            ...branch,
            properties: { ...parent.properties, ...branch.properties },
            required: [...new Set([...(parent.required ?? []), ...(branch.required ?? [])])],
          })),
        ),
      [base],
    );
  }
  return [node];
}

// The generator's validation keywords needed by this contract. Do not accept a
// shape merely because a method name still exists. Request examples must also
// satisfy newly required fields, enums, references and nested unions.
export function assertSchema(document, value, schema = document, label = "value") {
  const accepts = (input, data, depth) => {
    ensure(depth < SCHEMA_MAX_DEPTH, "schema/value nesting limit exceeded");
    if (input === true) return true;
    if (input === false) return false;
    const node = dereference(document, input);
    if (node === true) return true;
    if (!node) return false;
    if (node.allOf && !node.allOf.every((child) => accepts(child, data, depth + 1))) return false;
    if (node.anyOf && !node.anyOf.some((child) => accepts(child, data, depth + 1))) return false;
    if (node.oneOf && node.oneOf.filter((child) => accepts(child, data, depth + 1)).length !== 1)
      return false;
    if (Object.hasOwn(node, "const") && JSON.stringify(data) !== JSON.stringify(node.const))
      return false;
    if (node.enum && !node.enum.some((item) => JSON.stringify(data) === JSON.stringify(item)))
      return false;
    const type = data === null ? TYPES.NULL : Array.isArray(data) ? TYPES.ARRAY : typeof data;
    if (
      node.type &&
      ![]
        .concat(node.type)
        .some(
          (expected) =>
            expected === type ||
            (expected === TYPES.INTEGER && type === TYPES.NUMBER && Number.isInteger(data)),
        )
    )
      return false;
    if (type === TYPES.OBJECT) {
      if (node.required?.some((key) => !Object.hasOwn(data, key))) return false;
      for (const [key, child] of Object.entries(data)) {
        if (
          Object.hasOwn(node.properties ?? {}, key) &&
          !accepts(node.properties[key], child, depth + 1)
        )
          return false;
        if (!Object.hasOwn(node.properties ?? {}, key)) {
          if (node.additionalProperties === false) return false;
          if (
            node.additionalProperties &&
            typeof node.additionalProperties === TYPES.OBJECT &&
            !accepts(node.additionalProperties, child, depth + 1)
          )
            return false;
        }
      }
    }
    if (
      type === TYPES.ARRAY &&
      (data.length < (node.minItems ?? 0) ||
        data.length > (node.maxItems ?? Infinity) ||
        (Object.hasOwn(node, "items") &&
          data.some((child) => !accepts(node.items, child, depth + 1))))
    )
      return false;
    if (
      type === TYPES.STRING &&
      (data.length < (node.minLength ?? 0) ||
        data.length > (node.maxLength ?? Infinity) ||
        (node.pattern && !new RegExp(node.pattern, "u").test(data)))
    )
      return false;
    if (
      type === TYPES.NUMBER &&
      (!Number.isFinite(data) ||
        data < (node.minimum ?? -Infinity) ||
        data > (node.maximum ?? Infinity))
    )
      return false;
    return true;
  };
  ensure(accepts(schema, value, 0), `${label} no longer matches the declared shape`);
}

function object(document, schema = document) {
  const node = alternatives(document, schema).find((candidate) => candidate?.properties);
  ensure(node, "expected an object with named fields");
  return node;
}
function field(document, schema, key, type, { required = true, nullable = false } = {}) {
  const parent = object(document, schema);
  ensure(parent.properties[key], `missing field ${key}`);
  if (required) ensure(parent[REQUIRED]?.includes(key), `${key} must remain required`);
  const nodes = alternatives(document, parent.properties[key]);
  const types = new Set(
    nodes.flatMap((node) => [].concat(node.type ?? (node.properties ? TYPES.OBJECT : []))),
  );
  ensure(
    types.has(type) &&
      [...types].every((value) => value === type || (nullable && value === TYPES.NULL)),
    `${key} must have type ${type}${nullable ? " or null" : ""}`,
  );
  return parent.properties[key];
}
function method(document, name) {
  const branch = document.oneOf?.find((node) => node.properties?.method?.enum?.includes(name));
  ensure(branch, `missing method ${name}`);
  ensure(branch.required?.includes("method"), `${name} needs its discriminator`);
  return branch;
}
function variant(document, schema, tag) {
  const node = alternatives(document, schema).find((candidate) =>
    candidate?.properties?.type?.enum?.includes(tag),
  );
  ensure(node, `missing item variant ${tag}`);
  return node;
}

export function checkGeneratedSchema(directory) {
  const cache = new Map();
  const load = (file) => {
    if (!cache.has(file))
      cache.set(
        file,
        JSON.parse(readLimited(path.join(directory, file), SCHEMA_MAX_BYTES).toString("utf8")),
      );
    return cache.get(file);
  };
  const requests = load("ClientRequest.json"),
    server = load("ServerRequest.json"),
    notifications = load("ServerNotification.json");
  for (const name of Object.values(RPC).filter((name) => name !== RPC.INITIALIZED))
    method(requests, name);
  method(load("ClientNotification.json"), RPC.INITIALIZED);
  for (const name of Object.values(SERVER_REQUEST)) method(server, name);
  for (const name of Object.values(NOTIFICATION)) method(notifications, name);
  const cwd = path.resolve(directory);
  const thread = {
    model: "contract-model",
    cwd,
    approvalPolicy: CODEX_VALUE.NEVER,
    sandbox: CODEX_VALUE.READ_ONLY,
  };
  const inputs = {
    [RPC.THREAD_FORK]: {
      threadId: "thread",
      lastTurnId: "turn",
      excludeTurns: true,
      model: "contract-model",
      cwd: path.resolve("."),
      approvalPolicy: CODEX_VALUE.NEVER,
      sandbox: CODEX_VALUE.READ_ONLY,
      ephemeral: false,
    },
    [RPC.THREAD_COMPACT]: { threadId: "thread" },
    [RPC.THREAD_REVERT]: { threadId: "thread", beforeTurnId: "turn" },
    [RPC.FEEDBACK_SAVE]: {
      threadId: "thread",
      classification: "bug",
      includeLogs: true,
      savePath: path.resolve("diagnostics.zip"),
    },
    [RPC.MCP_STATUS_LIST]: { detail: "toolsAndAuthOnly", limit: 100 },
    [RPC.HOOKS_LIST]: { cwds: [path.resolve(".")] },
    [RPC.CONFIG_READ]: { includeLayers: false, cwd: path.resolve(".") },
    [RPC.CONFIG_REQUIREMENTS_READ]: null,
    [RPC.INITIALIZE]: {
      clientInfo: { name: "contract", version: "0" },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    },
    [RPC.THREAD_START]: { ...thread, ephemeral: false },
    [RPC.THREAD_RESUME]: { ...thread, threadId: "thread", excludeTurns: true },
    [RPC.THREAD_READ]: { threadId: "thread", includeTurns: false },
    [RPC.THREAD_NAME_SET]: { threadId: "thread", name: "csfcc contract" },
    [RPC.THREAD_ARCHIVE]: { threadId: "thread" },
    [RPC.THREAD_LIST]: {
      cursor: null,
      limit: 100,
      archived: false,
      searchTerm: "csfcc ",
      sourceKinds: ["appServer"],
      useStateDbOnly: true,
    },
    [RPC.TURN_START]: {
      threadId: "thread",
      input: [{ type: CODEX_VALUE.TEXT, text: "contract", text_elements: [] }],
      model: "contract-model",
      clientUserMessageId: "task-contract",
      serviceTierForTurn: "default",
      outputSchema: {
        type: "object",
        properties: { pass: { type: "boolean" } },
        required: ["pass"],
        additionalProperties: false,
      },
    },
    [RPC.TURN_INTERRUPT]: { threadId: "thread", turnId: "turn" },
    [RPC.REVIEW_START]: {
      threadId: "thread",
      target: { type: REVIEW_TARGET.UNCOMMITTED },
      delivery: "inline",
    },
    [RPC.TURN_STEER]: {
      threadId: "thread",
      expectedTurnId: "turn",
      clientUserMessageId: "task-contract/steer-1",
      input: [{ type: CODEX_VALUE.TEXT, text: "contract", text_elements: [] }],
    },
    [RPC.THREAD_TURNS_LIST]: {
      threadId: "thread",
      cursor: null,
      limit: 1,
      sortDirection: RECOVERY_SORT,
      itemsView: CODEX_VALUE.FULL,
    },
    [RPC.THREAD_ITEMS_LIST]: {
      threadId: "thread",
      turnId: "turn",
      cursor: null,
      limit: 1,
      sortDirection: "asc",
    },
    [RPC.ACCOUNT_READ]: {},
    [RPC.RATE_LIMITS_READ]: null,
    [RPC.WINDOWS_SANDBOX_READINESS]: null,
    [RPC.MODEL_LIST]: { cursor: null, includeHidden: true },
  };
  for (const [name, params] of Object.entries(inputs))
    assertSchema(
      requests,
      { id: 1, method: name, params },
      method(requests, name),
      `${name} request`,
    );
  for (const effort of EFFORTS)
    assertSchema(
      requests,
      { id: 1, method: RPC.TURN_START, params: { ...inputs[RPC.TURN_START], effort } },
      method(requests, RPC.TURN_START),
      `turn effort ${effort}`,
    );
  for (const target of [
    { type: REVIEW_TARGET.UNCOMMITTED },
    { type: REVIEW_TARGET.BASE, branch: "main" },
    { type: REVIEW_TARGET.COMMIT, sha: "a".repeat(40) },
    { type: REVIEW_TARGET.CUSTOM, instructions: "Review this" },
  ])
    assertSchema(
      requests,
      {
        id: 1,
        method: RPC.REVIEW_START,
        params: { threadId: "thread", target, delivery: "inline" },
      },
      method(requests, RPC.REVIEW_START),
      "review target",
    );
  for (const name of [RPC.THREAD_START, RPC.THREAD_RESUME])
    assertSchema(
      requests,
      {
        id: 1,
        method: name,
        params: {
          ...inputs[name],
          config: {
            review_model: "contract-model",
            model_reasoning_effort: "low",
            model_reasoning_summary: "none",
          },
        },
      },
      method(requests, name),
      "review config",
    );
  for (const summary of SUMMARY_MODES)
    assertSchema(
      requests,
      { id: 1, method: RPC.TURN_START, params: { ...inputs[RPC.TURN_START], summary } },
      method(requests, RPC.TURN_START),
      `turn summary ${summary}`,
    );
  for (const name of [RPC.THREAD_START, RPC.THREAD_RESUME])
    assertSchema(
      requests,
      { id: 1, method: name, params: { ...inputs[name], sandbox: CODEX_VALUE.WORKSPACE_WRITE } },
      method(requests, name),
      `${name} write request`,
    );
  const initialized = load("v1/InitializeResponse.json");
  for (const file of ["ThreadSetNameResponse", "ThreadArchiveResponse"])
    assertSchema(load(`v2/${file}.json`), {}, undefined, file);
  const listDoc = load("v2/ThreadListResponse.json");
  const listed = dereference(listDoc, field(listDoc, listDoc, "data", TYPES.ARRAY)).items;
  field(listDoc, listDoc, "nextCursor", TYPES.STRING, { required: false, nullable: true });
  field(listDoc, listed, "id", TYPES.STRING);
  field(listDoc, listed, "name", TYPES.STRING, { required: false, nullable: true });
  const readDoc = load("v2/ThreadReadResponse.json");
  const readThread = field(readDoc, readDoc, "thread", TYPES.OBJECT);
  field(readDoc, readThread, "id", TYPES.STRING);
  field(readDoc, readThread, "name", TYPES.STRING, { required: false, nullable: true });
  for (const [doc, schema] of [
    [listDoc, listed],
    [readDoc, readThread],
  ]) {
    const status = field(doc, schema, "status", TYPES.OBJECT);
    for (const type of ["notLoaded", "idle"])
      assertSchema(doc, { type }, status, "archivable thread state");
  }
  field(initialized, initialized, "userAgent", TYPES.STRING);
  for (const file of ["ThreadStartResponse", "ThreadResumeResponse", "ThreadForkResponse"]) {
    const doc = load(`v2/${file}.json`),
      result = field(doc, doc, "thread", TYPES.OBJECT);
    field(doc, result, "id", TYPES.STRING);
    if (file === "ThreadForkResponse") {
      field(doc, result, "forkedFromId", TYPES.STRING, { required: false, nullable: true });
      field(doc, result, "cwd", TYPES.STRING);
      field(doc, doc, "cwd", TYPES.STRING);
    }
    field(doc, doc, "model", TYPES.STRING);
    assertSchema(
      doc,
      CODEX_VALUE.NEVER,
      object(doc).properties.approvalPolicy,
      `${file} approval policy`,
    );
    const sandbox = field(doc, doc, "sandbox", TYPES.OBJECT);
    for (const tag of [CODEX_VALUE.READ_ONLY_POLICY, CODEX_VALUE.WORKSPACE_WRITE_POLICY])
      variant(doc, sandbox, tag);
  }
  const start = load("v2/TurnStartResponse.json"),
    turn = field(start, start, "turn", TYPES.OBJECT);
  const review = load("v2/ReviewStartResponse.json");
  field(review, review, "reviewThreadId", TYPES.STRING);
  field(review, field(review, review, "turn", TYPES.OBJECT), "id", TYPES.STRING);
  const steer = load("v2/TurnSteerResponse.json");
  field(steer, steer, "turnId", TYPES.STRING);
  field(start, turn, "id", TYPES.STRING);
  field(start, turn, "status", TYPES.STRING);
  const statuses = object(start, turn).properties.status;
  for (const value of Object.values(TURN_STATUS))
    assertSchema(start, value, statuses, `turn status ${value}`);
  const usageDoc = load("v2/ThreadTokenUsageUpdatedNotification.json");
  const usage = field(usageDoc, usageDoc, "tokenUsage", TYPES.OBJECT);
  for (const name of ["last", "total"]) {
    const counts = field(usageDoc, usage, name, TYPES.OBJECT);
    for (const key of [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ])
      field(usageDoc, counts, key, TYPES.INTEGER);
  }
  const rateDoc = load("v2/GetAccountRateLimitsResponse.json"),
    limits = field(rateDoc, rateDoc, "rateLimits", TYPES.OBJECT);
  const window = field(rateDoc, limits, "primary", TYPES.OBJECT, {
    required: false,
    nullable: true,
  });
  field(rateDoc, window, "usedPercent", TYPES.INTEGER);
  field(rateDoc, window, "windowDurationMins", TYPES.INTEGER, { required: false, nullable: true });
  field(rateDoc, window, "resetsAt", TYPES.INTEGER, { required: false, nullable: true });
  const credits = field(rateDoc, limits, "credits", TYPES.OBJECT, {
    required: false,
    nullable: true,
  });
  field(rateDoc, credits, "balance", TYPES.STRING, { required: false, nullable: true });
  // What --limits, doctor and the quota cache read beyond the footer's fields.
  for (const name of ["hasCredits", "unlimited"]) field(rateDoc, credits, name, TYPES.BOOLEAN);
  field(rateDoc, limits, "secondary", TYPES.OBJECT, { required: false, nullable: true });
  for (const name of ["limitId", "planType", "rateLimitReachedType"])
    field(rateDoc, limits, name, TYPES.STRING, { required: false, nullable: true });
  field(rateDoc, rateDoc, "ordinaryUsageAllowed", TYPES.BOOLEAN, {
    required: false,
    nullable: true,
  });
  field(rateDoc, rateDoc, "rateLimitsByLimitId", TYPES.OBJECT, { required: false, nullable: true });
  const resetCredits = field(rateDoc, rateDoc, "rateLimitResetCredits", TYPES.OBJECT, {
    required: false,
    nullable: true,
  });
  field(rateDoc, resetCredits, "availableCount", TYPES.INTEGER);
  // What the model check and doctor read of model/list.
  const modelDoc = load("v2/ModelListResponse.json");
  for (const file of ["ListMcpServerStatusResponse", "HooksListResponse"]) {
    const doc = load(`v2/${file}.json`);
    field(doc, doc, "data", TYPES.ARRAY);
  }
  const configDoc = load("v2/ConfigReadResponse.json");
  const compactDoc = load("v2/ThreadCompactStartResponse.json");
  assertSchema(compactDoc, {});
  const revertDoc = load("v2/ThreadRevertResponse.json");
  field(revertDoc, field(revertDoc, revertDoc, "thread", TYPES.OBJECT), "id", TYPES.STRING);
  const bundleDoc = load("v2/FeedbackSaveResponse.json");
  field(bundleDoc, bundleDoc, "savedPath", TYPES.STRING);
  field(bundleDoc, bundleDoc, "threadId", TYPES.STRING);
  field(configDoc, configDoc, "config", TYPES.OBJECT);
  const requirementsDoc = load("v2/ConfigRequirementsReadResponse.json");
  field(requirementsDoc, requirementsDoc, "requirements", TYPES.OBJECT, {
    required: false,
    nullable: true,
  });
  field(modelDoc, modelDoc, "nextCursor", TYPES.STRING, { required: false, nullable: true });
  const model = dereference(modelDoc, field(modelDoc, modelDoc, "data", TYPES.ARRAY)).items;
  for (const name of ["id", "model"]) field(modelDoc, model, name, TYPES.STRING);
  for (const name of ["hidden", "isDefault"]) field(modelDoc, model, name, TYPES.BOOLEAN);
  field(modelDoc, model, "defaultReasoningEffort", TYPES.STRING);
  const tiers = field(modelDoc, model, "serviceTiers", TYPES.ARRAY, { required: false });
  field(modelDoc, dereference(modelDoc, tiers).items, "id", TYPES.STRING);
  const efforts = field(modelDoc, model, "supportedReasoningEfforts", TYPES.ARRAY);
  field(modelDoc, dereference(modelDoc, efforts).items, "reasoningEffort", TYPES.STRING);
  field(modelDoc, model, "upgrade", TYPES.STRING, { required: false, nullable: true });
  const upgrade = field(modelDoc, model, "upgradeInfo", TYPES.OBJECT, {
    required: false,
    nullable: true,
  });
  field(modelDoc, upgrade, "model", TYPES.STRING);
  field(modelDoc, upgrade, "retirementAt", TYPES.INTEGER, { required: false, nullable: true });
  const account = load("v2/GetAccountResponse.json");
  field(account, account, "account", TYPES.OBJECT, { required: false, nullable: true });
  const turnDoc = load("v2/ThreadTurnsListResponse.json"),
    turns = field(turnDoc, turnDoc, "data", TYPES.ARRAY);
  field(turnDoc, turnDoc, "nextCursor", TYPES.STRING, { required: false, nullable: true });
  const turnItem = dereference(turnDoc, turns).items;
  field(turnDoc, turnItem, "id", TYPES.STRING);
  field(turnDoc, turnItem, "status", TYPES.STRING);
  field(turnDoc, turnItem, "itemsView", TYPES.STRING, { required: false });
  const items = field(turnDoc, turnItem, "items", TYPES.ARRAY),
    item = dereference(turnDoc, items).items;
  const message = variant(turnDoc, item, CODEX_ITEM.AGENT_MESSAGE);
  variant(turnDoc, item, "contextCompaction");
  for (const type of [CODEX_ITEM.REVIEW_ENTERED, CODEX_ITEM.REVIEW_EXITED])
    field(turnDoc, variant(turnDoc, item, type), "review", TYPES.STRING);
  field(turnDoc, message, "id", TYPES.STRING);
  field(turnDoc, message, "text", TYPES.STRING);
  const phase = field(turnDoc, message, "phase", TYPES.STRING, { required: false, nullable: true });
  assertSchema(turnDoc, CODEX_PHASE.FINAL_ANSWER, phase, "final answer phase");
  const user = variant(turnDoc, item, CODEX_VALUE.USER_MESSAGE);
  field(turnDoc, user, "clientId", TYPES.STRING, { required: false, nullable: true });
  const files = variant(turnDoc, item, CODEX_ITEM.FILE_CHANGE),
    changes = field(turnDoc, files, "changes", TYPES.ARRAY);
  field(turnDoc, dereference(turnDoc, changes).items, "path", TYPES.STRING);
  const history = load("v2/ThreadItemsListResponse.json"),
    entries = field(history, history, "data", TYPES.ARRAY);
  field(history, history, "nextCursor", TYPES.STRING, { required: false, nullable: true });
  const entry = dereference(history, entries).items;
  field(history, entry, "turnId", TYPES.STRING);
  field(history, entry, "item", TYPES.OBJECT);
  const readiness = load("v2/WindowsSandboxReadinessResponse.json");
  const status = field(readiness, readiness, "status", TYPES.STRING);
  assertSchema(readiness, CODEX_READY, status, "Windows sandbox readiness");
  for (const name of [NOTIFICATION.TURN_STARTED, NOTIFICATION.TURN_COMPLETED]) {
    const params = method(notifications, name).properties.params;
    field(notifications, params, "threadId", TYPES.STRING);
    const notifiedTurn = field(notifications, params, "turn", TYPES.OBJECT);
    field(notifications, notifiedTurn, "id", TYPES.STRING);
    field(notifications, notifiedTurn, "status", TYPES.STRING);
    field(notifications, notifiedTurn, "items", TYPES.ARRAY);
  }
  const completed = method(notifications, NOTIFICATION.ITEM_COMPLETED).properties.params;
  const modelNotifications = {
    [NOTIFICATION.MODEL_REROUTED]: {
      threadId: "thread",
      turnId: "turn",
      fromModel: "from",
      toModel: "to",
      reason: MODEL_REROUTE_REASON,
    },
    [NOTIFICATION.MODEL_SAFETY_BUFFERING]: {
      threadId: "thread",
      turnId: "turn",
      model: "model",
      reasons: [],
      useCases: [],
      showBufferingUi: true,
    },
    [NOTIFICATION.GUARDIAN_WARNING]: { threadId: "thread", message: "warning" },
    [NOTIFICATION.STRICT_REVIEW_REQUIRED]: { threadId: "thread", turnId: "turn", startedAtMs: 1 },
  };
  for (const [name, params] of Object.entries(modelNotifications)) {
    const schema = method(notifications, name);
    assertSchema(notifications, { method: name, params }, schema, `${name} notification`);
    field(notifications, schema.properties.params, "threadId", TYPES.STRING);
    if (name !== NOTIFICATION.GUARDIAN_WARNING)
      field(notifications, schema.properties.params, "turnId", TYPES.STRING);
  }
  const planUpdate = method(notifications, NOTIFICATION.PLAN_UPDATED).properties.params;
  field(notifications, planUpdate, "threadId", TYPES.STRING);
  field(notifications, planUpdate, "turnId", TYPES.STRING);
  const planSteps = field(notifications, planUpdate, "plan", TYPES.ARRAY);
  const planStep = dereference(notifications, planSteps).items;
  field(notifications, planStep, "step", TYPES.STRING);
  field(notifications, planStep, "status", TYPES.STRING);
  const diffUpdate = method(notifications, NOTIFICATION.DIFF_UPDATED).properties.params;
  for (const name of ["threadId", "turnId", "diff"])
    field(notifications, diffUpdate, name, TYPES.STRING);
  const command = variant(turnDoc, item, CODEX_ITEM.COMMAND);
  field(turnDoc, command, "command", TYPES.STRING);
  for (const name of ["exitCode", "durationMs"])
    field(turnDoc, command, name, TYPES.INTEGER, { required: false, nullable: true });
  field(turnDoc, variant(turnDoc, item, CODEX_ITEM.SEARCH), "query", TYPES.STRING);
  field(turnDoc, variant(turnDoc, item, CODEX_ITEM.REASONING), "summary", TYPES.ARRAY, {
    required: false,
  });
  const mcp = variant(turnDoc, item, CODEX_ITEM.MCP);
  for (const name of ["server", "tool"]) field(turnDoc, mcp, name, TYPES.STRING);
  field(notifications, completed, "threadId", TYPES.STRING);
  field(notifications, completed, "turnId", TYPES.STRING);
  field(notifications, completed, "item", TYPES.OBJECT);
  const startedThread = field(
    notifications,
    method(notifications, NOTIFICATION.THREAD_STARTED).properties.params,
    "thread",
    TYPES.OBJECT,
  );
  field(notifications, startedThread, "id", TYPES.STRING);
  const error = method(notifications, NOTIFICATION.ERROR).properties.params;
  field(notifications, error, "willRetry", TYPES.BOOLEAN);
  const turnError = field(notifications, error, "error", TYPES.OBJECT);
  field(notifications, turnError, "message", TYPES.STRING);
  // The failure names the runner maps to its own codes.
  const errorInfo = object(notifications, turnError).properties.codexErrorInfo;
  ensure(errorInfo, "missing field codexErrorInfo");
  for (const name of Object.values(CODEX_ERROR_INFO))
    assertSchema(notifications, name, errorInfo, `codexErrorInfo ${name}`);
  field(usageDoc, usage, "modelContextWindow", TYPES.INTEGER, { required: false, nullable: true });
  field(
    notifications,
    method(notifications, NOTIFICATION.TOKEN_USAGE_UPDATED).properties.params,
    "tokenUsage",
    TYPES.OBJECT,
  );
  field(
    notifications,
    method(notifications, NOTIFICATION.RATE_LIMITS_UPDATED).properties.params,
    "rateLimits",
    TYPES.OBJECT,
  );
  for (const [name, file] of Object.entries(RESPONSE_FILES))
    assertSchema(load(file), answerServerRequest(name).reply.result, undefined, `${name} refusal`);
  return { methods: Object.keys(inputs).length, policyReplies: Object.keys(RESPONSE_FILES).length };
}

export async function generateSchema(
  codex,
  directory,
  { env = process.env, run = runProcess } = {},
) {
  const home = path.join(directory, "home"),
    output = path.join(directory, "schema");
  fs.mkdirSync(home, { recursive: true });
  const args = [
    ...[...MCP_OFF_FEATURES].flatMap((name) => [CODEX_COMMAND.DISABLE, name]),
    CODEX_COMMAND.APP_SERVER,
    CODEX_COMMAND.GENERATE_SCHEMA,
    CODEX_COMMAND.OUT,
    output,
  ];
  const vector = codexLaunch(codex, args, { ...env, CODEX_HOME: home });
  const result = await run(vector.command, vector.args, {
    ...vector.options,
    cwd: directory,
    timeoutMs: SCHEMA_GENERATE_MS,
    maxBuffer: SCHEMA_MAX_BYTES,
  });
  ensure(
    !result.error && result.status === EXIT.COMPLETED,
    `schema generation failed: ${result.error?.message ?? result.stderr}`,
  );
  return output;
}

export async function contract({ env = process.env, write = console.log } = {}) {
  const temporary = createScratch(SCRATCH_PREFIX);
  try {
    const codex = requireSupportedCodex(await selectCodex(env, ROOT), env);
    const directory = await generateSchema(codex, temporary.directory, { env });
    const checked = checkGeneratedSchema(directory);
    write(
      `codex=${codex.version} schema=ok methods=${checked.methods} policy-replies=${checked.policyReplies}`,
    );
    const result = await runProcess(process.execPath, testArguments(ROOT, FAKE_TESTS), {
      cwd: ROOT,
      env: codexEnvironment(env),
      timeoutMs: FAKE_TEST_MS,
      maxBuffer: SCHEMA_MAX_BYTES,
    });
    if (result.stdout) write(result.stdout.trimEnd());
    ensure(
      !result.error && result.status === EXIT.COMPLETED,
      `fake driver contract failed: ${result.error?.message ?? result.stderr}`,
    );
  } finally {
    temporary.remove();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await contract();
  } catch (error) {
    console.error(error.message);
    process.exitCode = EXIT.FAILURE;
  }
}
