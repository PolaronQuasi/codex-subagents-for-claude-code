#!/usr/bin/env node
// An independent fake executable, built from the public generated contract.
// It never invokes another Codex executable or a model.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  RPC,
  NOTIFICATION,
  SERVER_REQUEST,
  TURN_STATUS,
  JOB_STATUS,
  CODEX_ITEM,
  CODEX_PHASE,
  CODEX_COMMAND,
  CODEX_VERSION_RANGE,
  CODEX_VALUE,
  DRIVER_POLL_MS,
  SECOND_MS,
} from "../../../src/shared/constants.mjs";
import { EXIT, RPC_ERROR } from "../../../src/shared/errors.mjs";

const control = () =>
  process.env.FIXTURE_CONTROL
    ? JSON.parse(fs.readFileSync(process.env.FIXTURE_CONTROL, "utf8"))
    : {};
const initial = control();
const args = process.argv.slice(2);
const pluginsOff = args.some(
  (arg, index) => arg === CODEX_COMMAND.DISABLE && args[index + 1] === "plugins",
);
const configuredServers = initial.mcpServers ?? [];
const pluginServers = initial.pluginMcpServers ?? [];
if (args[0] === CODEX_COMMAND.VERSION) {
  process.stdout.write(`codex-cli ${initial.version ?? CODEX_VERSION_RANGE.min}\n`);
  process.exit(EXIT.COMPLETED);
}
if (
  args[0] === CODEX_COMMAND.MCP &&
  args[1] === CODEX_COMMAND.LIST &&
  args[2] === CODEX_COMMAND.JSON
) {
  if (initial.mcpListFailure) {
    process.stderr.write(initial.mcpListFailure);
    process.exit(EXIT.FAILURE);
  }
  const servers = [...configuredServers, ...(pluginsOff ? [] : pluginServers)];
  process.stdout.write(JSON.stringify([...new Set(servers)].map((name) => ({ name }))));
  process.exit(EXIT.COMPLETED);
}
if (args[0] !== CODEX_COMMAND.APP_SERVER) process.exit(EXIT.FAILURE);
if (
  pluginsOff &&
  pluginServers.some(
    (name) =>
      !configuredServers.includes(name) && args.includes(`mcp_servers.${name}.enabled=false`),
  )
) {
  process.stderr.write("invalid transport: override names a disabled plugin's MCP server\n");
  process.exit(EXIT.FAILURE);
}
if (args.includes(CODEX_COMMAND.HELP)) {
  process.stdout.write(`Usage: codex app-server [--listen stdio://]\n`);
  process.exit(EXIT.COMPLETED);
}
// Watch before the start delay: a fixture cancelled during slow startup must
// still end through its own control file, before it begins reading stdin.
setInterval(() => {
  if (process.env.FIXTURE_WORKER_CONTROL && !fs.existsSync(process.env.FIXTURE_WORKER_CONTROL))
    process.exit(EXIT.COMPLETED);
}, DRIVER_POLL_MS);
if (initial.startDelayMs) await delay(initial.startDelayMs);

const record = (direction, message) => {
  if (process.env.FIXTURE_EVENTS)
    fs.appendFileSync(process.env.FIXTURE_EVENTS, `${JSON.stringify({ direction, ...message })}\n`);
};
const send = (message) => {
  record("out", message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() });
record("launch", {
  args,
  pid: process.pid,
  git: Object.keys(process.env)
    .filter((name) => name.startsWith("GIT_"))
    .sort(),
});
const reply = (id, result) => send({ id, result });
const error = (id, code, message) => send({ id, error: { code, message } });
const now = () => Math.floor(Date.now() / SECOND_MS);
// A TurnError; codexErrorInfo is a CodexErrorInfo name or one-key object.
const failure = (message, codexErrorInfo = null) => ({
  message,
  codexErrorInfo,
  additionalDetails: null,
  misalignment: null,
});
const zeroUsage = () => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
});
const historyFile = process.env.FIXTURE_HISTORY;
let history =
  historyFile && fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, "utf8")) : {};
const save = () => {
  if (historyFile) fs.writeFileSync(historyFile, JSON.stringify(history));
};
let initialized = false,
  ready = false,
  active = null,
  serial = 0;
const callbacks = new Map();

function makeThread(params) {
  const id = params.threadId ?? control().threadId ?? crypto.randomUUID();
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: CODEX_VALUE.PAGINATED,
    modelProvider: CODEX_VALUE.OPENAI,
    model: params.model ?? control().model ?? "fixture-model",
    reasoningEffort: null,
    createdAt: now(),
    updatedAt: now(),
    recencyAt: null,
    status: { type: CODEX_VALUE.IDLE },
    path: null,
    cwd: params.cwd ?? process.cwd(),
    cliVersion: control().version ?? CODEX_VERSION_RANGE.min,
    source: { custom: CODEX_VALUE.APP_SERVER },
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function requestParams(method, threadId, turnId) {
  const base = { threadId, turnId, itemId: "request-item", startedAtMs: Date.now() };
  switch (method) {
    case SERVER_REQUEST.COMMAND_APPROVAL:
      return {
        ...base,
        kind: CODEX_VALUE.COMMAND,
        environmentId: null,
        command: "fixture command",
        cwd: process.cwd(),
      };
    case SERVER_REQUEST.FILE_APPROVAL:
      return base;
    case SERVER_REQUEST.PERMISSIONS_APPROVAL:
      return { ...base, environmentId: null, cwd: process.cwd(), reason: null, permissions: {} };
    case SERVER_REQUEST.USER_INPUT:
      return { ...base, questions: [], isBlocking: true, autoResolutionMs: null };
    case SERVER_REQUEST.TOOL_CALL:
      return {
        threadId,
        turnId,
        callId: "fixture-call",
        namespace: null,
        tool: "fixture-tool",
        arguments: {},
      };
    case SERVER_REQUEST.MCP_ELICITATION:
      return {
        threadId,
        turnId,
        serverName: "fixture-server",
        mode: CODEX_VALUE.FORM,
        _meta: null,
        message: "Fixture",
        requestedSchema: { type: CODEX_VALUE.OBJECT, properties: {} },
      };
    case SERVER_REQUEST.AUTH_REFRESH:
      return { reason: CODEX_VALUE.AUTH_UNAUTHORIZED, previousAccountId: null };
    case SERVER_REQUEST.ATTESTATION:
      return {};
    case SERVER_REQUEST.APPLY_PATCH_APPROVAL:
      return {
        conversationId: threadId,
        callId: "fixture-call",
        fileChanges: {},
        reason: null,
        grantRoot: null,
      };
    case SERVER_REQUEST.EXEC_COMMAND_APPROVAL:
      return {
        conversationId: threadId,
        callId: "fixture-call",
        approvalId: null,
        command: [],
        cwd: process.cwd(),
        reason: null,
        parsedCmd: [],
      };
    default:
      return base;
  }
}

function finish(turn, status) {
  if (active !== turn) return;
  active = null;
  turn.status = status;
  turn.completedAt = now();
  turn.durationMs = control().durationMs ?? Date.now() - turn.began;
  turn.error =
    status === TURN_STATUS.FAILED
      ? failure(control().failure ?? "Fixture turn failed", control().failureInfo ?? null)
      : null;
  if (!control().omitRateLimitsUpdate)
    notify(NOTIFICATION.RATE_LIMITS_UPDATED, {
      rateLimits: control().rateLimits ?? {
        primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: null },
      },
    });
  save();
  const { began, threadId, ...wire } = turn;
  notify(NOTIFICATION.TURN_COMPLETED, {
    threadId,
    turn: { ...wire, items: control().completedItems ?? wire.items },
  });
}

async function runTurn(turn) {
  const config = control();
  for (const event of config.progressEvents ?? [])
    notify(event.method, { threadId: turn.threadId, turnId: turn.id, ...event.params });
  const requests =
    config.serverRequests === true ? Object.values(SERVER_REQUEST) : (config.serverRequests ?? []);
  await Promise.all(
    requests.map((spec) => {
      const method = typeof spec === "string" ? spec : spec.method;
      const id = `server-${++serial}`;
      const wait = new Promise((resolve) => callbacks.set(id, resolve));
      send({
        id,
        method,
        params:
          typeof spec === "string"
            ? requestParams(method, turn.threadId, turn.id)
            : (spec.params ?? requestParams(method, turn.threadId, turn.id)),
      });
      return wait;
    }),
  );
  while (active === turn && [JOB_STATUS.QUEUED, JOB_STATUS.RUNNING].includes(control().status))
    await delay(DRIVER_POLL_MS);
  if (active !== turn) return;
  Object.assign(config, control());
  if (config.turnDelayMs) await delay(config.turnDelayMs);
  if (active !== turn || config.hangTurn) return;
  if (config.touchWorkspaceFile) {
    fs.writeFileSync(
      path.join(history[turn.threadId].cwd, config.touchWorkspaceFile),
      "fixture edit\n",
    );
    config.touchedFiles ??= [config.touchWorkspaceFile];
  }
  for (const event of config.errors ?? []) {
    const { message = "Fixture error", codexErrorInfo = null, ...fields } = event;
    notify(NOTIFICATION.ERROR, {
      threadId: turn.threadId,
      turnId: turn.id,
      error: failure(message, codexErrorInfo),
      ...fields,
    });
  }
  const item = {
    type: CODEX_ITEM.AGENT_MESSAGE,
    id: "agent-fixture",
    text: config.result ?? "Fixture final: λ 日本語 🚀\n",
    phase: config.phase === undefined ? CODEX_PHASE.FINAL_ANSWER : config.phase,
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  const answer =
    turn.review && config.reviewExitOnly
      ? { id: "review-exit", type: CODEX_ITEM.REVIEW_EXITED, review: item.text }
      : item;
  turn.items.push(answer);
  notify(NOTIFICATION.ITEM_COMPLETED, {
    threadId: turn.threadId,
    turnId: turn.id,
    item: answer,
    completedAtMs: Date.now(),
  });
  if (config.touchedFiles?.length) {
    const files = {
      type: CODEX_ITEM.FILE_CHANGE,
      id: "files-fixture",
      status: TURN_STATUS.COMPLETED,
      changes: config.touchedFiles.map((path) => ({
        path,
        kind: { type: CODEX_VALUE.UPDATE, move_path: null },
        diff: "",
      })),
    };
    turn.items.push(files);
    notify(NOTIFICATION.ITEM_COMPLETED, {
      threadId: turn.threadId,
      turnId: turn.id,
      item: files,
      completedAtMs: Date.now(),
    });
  }
  if (!config.omitUsage)
    notify(NOTIFICATION.TOKEN_USAGE_UPDATED, {
      threadId: turn.threadId,
      turnId: turn.id,
      tokenUsage: config.tokenUsage ?? {
        last: zeroUsage(),
        total: zeroUsage(),
        modelContextWindow: null,
      },
    });
  finish(
    turn,
    config.status === JOB_STATUS.CANCELLED
      ? TURN_STATUS.INTERRUPTED
      : (config.status ?? TURN_STATUS.COMPLETED),
  );
}

async function handle(message) {
  record("in", message);
  if (!Object.hasOwn(message, "method")) {
    callbacks.get(message.id)?.(message);
    callbacks.delete(message.id);
    return;
  }
  const { id, method, params = {} } = message;
  if ([RPC.RATE_LIMITS_READ, RPC.WINDOWS_SANDBOX_READINESS].includes(method) && params !== null)
    return error(id, RPC_ERROR.INVALID_PARAMS, "This method requires null params");
  if (
    method === RPC.ACCOUNT_READ &&
    (!params || typeof params !== "object" || Array.isArray(params))
  )
    return error(id, RPC_ERROR.INVALID_PARAMS, "account/read requires object params");
  const config = control();
  if (config.exitOnMethods?.includes(method)) process.exit(EXIT.FAILURE);
  while (control().pausedMethods?.includes(method)) await delay(DRIVER_POLL_MS);
  if (config.hangMethods?.includes(method)) return;
  if (config.delays?.[method]) await delay(config.delays[method]);
  if (config.rpcErrors?.[method]) {
    const { code, message } = config.rpcErrors[method];
    error(id, code, message);
    return;
  }
  if (method === RPC.INITIALIZED) {
    ready = true;
    return;
  }
  if (method === RPC.INITIALIZE) {
    if (initialized) {
      error(id, RPC_ERROR.INVALID_REQUEST, "Already initialized");
      return;
    }
    initialized = true;
    reply(id, {
      userAgent: "codex-fixture",
      codexHome: process.env.CODEX_HOME,
      platformFamily: process.platform,
      platformOs: process.platform,
    });
    return;
  }
  if (!initialized || !ready) {
    error(id, RPC_ERROR.INVALID_REQUEST, "Not initialized");
    return;
  }
  for (const notification of config.notificationsBeforeReply ?? [])
    notify(notification.method, notification.params);
  if (Object.hasOwn(config.responses ?? {}, method)) {
    reply(id, config.responses[method]);
    return;
  }
  switch (method) {
    case RPC.FEEDBACK_SAVE:
      fs.writeFileSync(params.savePath, "PK fixture diagnostic bundle", {
        flag: "wx",
        mode: 0o600,
      });
      reply(id, { savedPath: params.savePath, threadId: params.threadId, promptHash: null });
      return;
    case RPC.MCP_STATUS_LIST:
      reply(id, { data: [], nextCursor: null });
      return;
    case RPC.HOOKS_LIST:
      reply(id, { data: [{ cwd: params.cwds[0], hooks: [], warnings: [], errors: [] }] });
      return;
    case RPC.CONFIG_READ:
      reply(id, { config: {}, origins: {} });
      return;
    case RPC.CONFIG_REQUIREMENTS_READ:
      reply(id, { requirements: null, supportsIndependentSpeedModes: false });
      return;
    case RPC.THREAD_NAME_SET:
    case RPC.THREAD_REVERT: {
      if (method === RPC.THREAD_NAME_SET) {
        const thread = history[params.threadId];
        if (!thread) return error(id, RPC_ERROR.INVALID_PARAMS, "Unknown thread");
        thread.name = params.name;
        save();
        reply(id, {});
        return;
      }
      const thread = history[params.threadId];
      const index = thread?.turns.findIndex((t) => t.id === params.beforeTurnId);
      if (index === undefined || index < 0)
        return error(id, RPC_ERROR.INVALID_PARAMS, "Unknown turn");
      thread.turns = thread.turns.slice(0, index);
      save();
      if (config.exitAfterRevert) process.exit(EXIT.FAILURE);
      reply(id, {
        thread: { ...thread, turns: [] },
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
      });
      return;
    }
    case RPC.THREAD_COMPACT: {
      const thread = history[params.threadId];
      const turn = {
        id: `compact-${crypto.randomUUID()}`,
        status: TURN_STATUS.COMPLETED,
        itemsView: CODEX_VALUE.FULL,
        items: [{ id: "compact-item", type: "contextCompaction" }],
        error: null,
      };
      thread.turns.push(turn);
      save();
      if (config.exitAfterCompact) process.exit(EXIT.FAILURE);
      notify(NOTIFICATION.TURN_STARTED, {
        threadId: thread.id,
        turn: { ...turn, status: TURN_STATUS.IN_PROGRESS, items: [] },
      });
      reply(id, {});
      notify(NOTIFICATION.THREAD_COMPACTED, { threadId: thread.id, turnId: turn.id });
      notify(NOTIFICATION.TURN_COMPLETED, { threadId: thread.id, turn });
      return;
    }
    case RPC.THREAD_ARCHIVE: {
      const thread = history[params.threadId];
      if (!thread) return error(id, RPC_ERROR.INVALID_PARAMS, "Unknown thread");
      if (method === RPC.THREAD_NAME_SET) thread.name = params.name;
      else thread.archived = true;
      save();
      reply(id, {});
      return;
    }
    case RPC.THREAD_LIST: {
      const threads = Object.values(history).filter(
        (thread) =>
          Boolean(thread.archived) === Boolean(params.archived) &&
          (!params.searchTerm || thread.name?.includes(params.searchTerm)),
      );
      const offset = Number(params.cursor ?? 0),
        size = config.threadPageSize ?? params.limit;
      reply(id, {
        data: threads
          .slice(offset, offset + size)
          .map(({ turns, ...thread }) => ({ ...thread, turns: [] })),
        nextCursor: offset + size < threads.length ? String(offset + size) : null,
      });
      return;
    }
    case RPC.THREAD_START:
    case RPC.THREAD_FORK:
    case RPC.THREAD_RESUME: {
      const forkSource = method === RPC.THREAD_FORK ? history[params.threadId] : null;
      const thread =
        method === RPC.THREAD_RESUME && history[params.threadId]
          ? history[params.threadId]
          : makeThread(
              method === RPC.THREAD_FORK ? { ...params, threadId: crypto.randomUUID() } : params,
            );
      if (forkSource) {
        const index = forkSource.turns.findIndex((t) => t.id === params.lastTurnId);
        if (index < 0) return error(id, RPC_ERROR.INVALID_PARAMS, "Unknown fork turn");
        thread.forkedFromId = forkSource.id;
        thread.turns = JSON.parse(JSON.stringify(forkSource.turns.slice(0, index + 1)));
      }
      if (method === RPC.THREAD_RESUME && !active)
        for (const turn of thread.turns)
          if (turn.status === TURN_STATUS.IN_PROGRESS) turn.status = TURN_STATUS.INTERRUPTED;
      if (params.model) thread.model = params.model;
      history[thread.id] = thread;
      save();
      if (method === RPC.THREAD_FORK && config.exitAfterFork) process.exit(EXIT.FAILURE);
      const result = {
        thread: params.excludeTurns ? { ...thread, turns: [] } : thread,
        model: thread.model,
        modelProvider: CODEX_VALUE.OPENAI,
        serviceTier: null,
        cwd: thread.cwd,
        instructionSources: [],
        approvalPolicy: CODEX_VALUE.NEVER,
        approvalsReviewer: CODEX_VALUE.USER,
        sandbox: {
          type:
            params.sandbox === CODEX_VALUE.WORKSPACE_WRITE
              ? CODEX_VALUE.WORKSPACE_WRITE_POLICY
              : CODEX_VALUE.READ_ONLY_POLICY,
          networkAccess: false,
        },
        reasoningEffort: params.config?.model_reasoning_effort ?? null,
      };
      if (method === RPC.THREAD_RESUME)
        Object.assign(result, { turnsBackwardsCursor: null, itemsBackwardsCursor: null });
      if (config.notificationBeforeResponse !== false)
        notify(NOTIFICATION.THREAD_STARTED, { thread });
      if (method === RPC.THREAD_RESUME && config.resumedTokenUsage)
        notify(NOTIFICATION.TOKEN_USAGE_UPDATED, {
          threadId: thread.id,
          turnId: thread.turns.at(-1)?.id ?? "earlier-turn",
          tokenUsage: config.resumedTokenUsage,
        });
      reply(id, result);
      if (config.notificationBeforeResponse === false)
        notify(NOTIFICATION.THREAD_STARTED, { thread });
      return;
    }
    case RPC.REVIEW_START:
    case RPC.TURN_START: {
      const review = method === RPC.REVIEW_START;
      const turn = {
        id: config.turnId ?? `turn-fixture-${(history[params.threadId]?.turns.length ?? 0) + 1}`,
        threadId: params.threadId,
        ...(review ? { review: true } : {}),
        began: Date.now(),
        items: review
          ? [{ type: CODEX_ITEM.REVIEW_ENTERED, id: "review-enter", review: "reviewing" }]
          : [
              {
                type: CODEX_VALUE.USER_MESSAGE,
                id: "user-fixture",
                clientId: params.clientUserMessageId ?? null,
                content: params.input ?? [],
              },
            ],
        itemsView: CODEX_VALUE.FULL,
        status: TURN_STATUS.IN_PROGRESS,
        error: null,
        startedAt: now(),
        completedAt: null,
        durationMs: null,
      };
      active = turn;
      history[params.threadId]?.turns.push(turn);
      save();
      const { began, threadId, ...wire } = turn;
      if (config.notificationBeforeResponse !== false)
        notify(NOTIFICATION.TURN_STARTED, { threadId, turn: wire });
      if (config.exitAfterTurnStart) process.exit(EXIT.FAILURE);
      reply(id, {
        turn: wire,
        ...(review ? { reviewThreadId: config.reviewThreadId ?? threadId } : {}),
      });
      if (config.notificationBeforeResponse === false)
        notify(NOTIFICATION.TURN_STARTED, { threadId, turn: wire });
      if (review && config.nestedReviewTurn) {
        notify(NOTIFICATION.TURN_STARTED, {
          threadId,
          turn: { ...wire, id: "nested-review-turn" },
        });
        notify(NOTIFICATION.ITEM_COMPLETED, {
          threadId,
          turnId: "nested-review-turn",
          item: {
            id: "nested-answer",
            type: CODEX_ITEM.AGENT_MESSAGE,
            text: "wrong nested answer",
            phase: CODEX_PHASE.FINAL_ANSWER,
          },
        });
        notify(NOTIFICATION.TURN_COMPLETED, {
          threadId,
          turn: { ...wire, id: "nested-review-turn", status: TURN_STATUS.COMPLETED },
        });
      }
      void runTurn(turn).catch(() => process.exit(EXIT.FAILURE));
      return;
    }
    case RPC.TURN_STEER: {
      if (
        !active ||
        active.threadId !== params.threadId ||
        active.id !== params.expectedTurnId ||
        config.rejectSteer
      )
        return error(id, RPC_ERROR.INVALID_PARAMS, "activeTurnNotSteerable");
      const item = {
        type: CODEX_VALUE.USER_MESSAGE,
        id: `steer-${++serial}`,
        clientId: params.clientUserMessageId,
        content: params.input,
      };
      active.items.push(item);
      save();
      notify(NOTIFICATION.ITEM_COMPLETED, { threadId: active.threadId, turnId: active.id, item });
      if (!config.dropSteerReply) reply(id, { turnId: config.steerReplyTurn ?? active.id });
      if (config.steerProgressEcho)
        notify(NOTIFICATION.ITEM_COMPLETED, {
          threadId: active.threadId,
          turnId: active.id,
          item: { type: CODEX_ITEM.REASONING, id: "steer-echo", summary: [params.input[0].text] },
        });
      return;
    }
    case RPC.TURN_INTERRUPT:
      reply(id, {});
      if (
        active &&
        active.id === params.turnId &&
        active.threadId === params.threadId &&
        !config.ignoreInterrupt
      )
        finish(active, TURN_STATUS.INTERRUPTED);
      return;
    case RPC.ACCOUNT_READ:
      reply(id, {
        account: config.loggedOut
          ? null
          : { type: "chatgpt", email: "must-not-print@example.invalid", planType: "fixture" },
        requiresOpenaiAuth: true,
      });
      return;
    case RPC.RATE_LIMITS_READ:
      // Without a login the read fails, as codex-cli's does; account/read answers.
      if (config.loggedOut) return error(id, RPC_ERROR.INVALID_REQUEST, "authentication required");
      reply(id, {
        ordinaryUsageAllowed: config.ordinaryUsageAllowed ?? null,
        rateLimits: config.rateLimits ?? {
          limitId: null,
          limitName: null,
          normalModelSlug: null,
          primary: null,
          secondary: null,
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: null,
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: config.rateLimitsByLimitId ?? null,
        rateLimitResetCredits: config.rateLimitResetCredits ?? null,
        // A canary: the runner never prints, logs or caches the account ID.
        accountId: "account-id-must-not-print",
        rateLimitUpsell: null,
      });
      return;
    case RPC.MODEL_LIST: {
      // A control's models, in pages of its modelPageSize; without models the
      // method is unknown here, as a CLI without a catalogue would answer.
      if (!config.models) return error(id, RPC_ERROR.METHOD_NOT_FOUND, "Fixture method not found");
      const visible = config.models.filter((model) => params?.includeHidden || !model.hidden);
      const offset = Number(params?.cursor ?? 0),
        size = config.modelPageSize ?? visible.length;
      reply(id, {
        data: visible.slice(offset, offset + size),
        nextCursor: offset + size < visible.length ? String(offset + size) : null,
      });
      return;
    }
    case RPC.WINDOWS_SANDBOX_READINESS:
      reply(id, { status: config.readiness ?? "ready" });
      return;
    case RPC.THREAD_READ:
      reply(id, { thread: history[params.threadId] });
      return;
    case RPC.THREAD_TURNS_LIST:
      {
        const turns = [...(history[params.threadId]?.turns ?? [])];
        if (params.sortDirection !== "asc") turns.reverse();
        const offset = Number(params.cursor ?? 0),
          size = config.historyPageSize ?? turns.length;
        reply(id, {
          data: turns
            .slice(offset, offset + size)
            .map((turn) =>
              config.historyItemsUnloaded ? { ...turn, items: [], itemsView: "notLoaded" } : turn,
            ),
          nextCursor: offset + size < turns.length ? String(offset + size) : null,
        });
      }
      return;
    case RPC.THREAD_ITEMS_LIST: {
      const items = (history[params.threadId]?.turns ?? [])
        .filter((turn) => !params.turnId || turn.id === params.turnId)
        .flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })));
      if (params.sortDirection === "desc") items.reverse();
      const offset = Number(params.cursor ?? 0),
        size = config.historyItemPageSize ?? items.length;
      reply(id, {
        data: items.slice(offset, offset + size),
        nextCursor: offset + size < items.length ? String(offset + size) : null,
      });
      return;
    }
    default:
      error(id, RPC_ERROR.METHOD_NOT_FOUND, "Fixture method not found");
  }
}

// EOF policy is independent of the private lifetime control above.
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  void handle(JSON.parse(line)).catch(() => process.exit(EXIT.FAILURE));
});
lines.on("close", () => {
  if (control().exitOnStdinClose !== false) process.exit(EXIT.COMPLETED);
});
