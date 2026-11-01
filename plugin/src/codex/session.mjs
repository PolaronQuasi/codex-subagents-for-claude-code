// One dedicated app-server, with a held child handle for its entire lifetime.
// Checkpoints are synchronous: dispatch intent reaches disk before turn/start.
import { EventEmitter } from "node:events";
import { JsonlRpc } from "./rpc.mjs";
import { ProgressFold } from "./progress.mjs";
import { compactThread, compactNotification } from "./compact.mjs";
import { trackedStop } from "./shutdown.mjs";
import { reviewTarget } from "../shared/review.mjs";
import { threadName } from "../shared/thread-name.mjs";
import { answerServerRequest } from "./policy.mjs";
import { appServerArgs, assertCodexIdentity, mcpServerNames, spawnCodex } from "./cli.mjs";
import { startReader } from "../shared/process-identity.mjs";
import { mapCodexError, quotaRefusal } from "./account.mjs";
import { listModels, modelNotice, modelRefusal, findModel } from "./models.mjs";
import { utcDay } from "../state/model-cache.mjs";
import { foldModelEvent } from "../shared/model-events.mjs";
import { PROCESSES, stopOwnedChild } from "../shared/process-stop.mjs";
import { REAL_TIMING } from "../shared/timing.mjs";
import { RUNNER_VERSION } from "../version.mjs";
import {
  RPC,
  RPC_EVENT,
  NOTIFICATION,
  CODEX_ITEM,
  CODEX_PHASE,
  CODEX_VALUE,
  TURN_STATUS,
  JOB_STATUS,
  DRIVER_PHASE,
  POLICY_EFFECT,
  DRIVER_TEXT,
  APP_SERVER_START_MS,
  APP_SERVER_REQUEST_MS,
  APP_SERVER_INTERRUPT_MS,
  APP_SERVER_PROBE_MS,
  DRIVER_POLL_MS,
  OPT_OUT_NOTIFICATIONS,
  CLIENT_NAME,
  MCP_MODE,
  APP_SERVER_MODE,
  QUOTA_SOURCE,
  IS_WINDOWS,
  CODEX_READY,
  STOP_OUTCOME,
  MAX_OUTPUT_BYTES,
  JOB_MAX_LOG_BYTES,
  PROGRESS_MODE,
  STEER_REQUEST_MS,
  STEER_TEXT,
  DEFAULT_SERVICE_TIER,
  ARCHIVABLE_THREAD_STATES,
} from "../shared/constants.mjs";
import { CODES, RunnerError } from "../shared/errors.mjs";

const fault = (code, message) => new RunnerError(code, message);
const terminal = (status) =>
  [TURN_STATUS.COMPLETED, TURN_STATUS.FAILED, TURN_STATUS.INTERRUPTED].includes(status);
const knownEnd = (result) =>
  [STOP_OUTCOME.STOPPED, STOP_OUTCOME.GONE, STOP_OUTCOME.REUSED].includes(result.state);

// Reused by history recovery: only completed items supply answer text.
export function foldItems(items = [], { review = false } = {}) {
  let final = null,
    fallback = null,
    reviewed = null;
  const touchedFiles = new Set();
  for (const item of items) {
    if (item?.type === CODEX_ITEM.AGENT_MESSAGE && typeof item.text === "string") {
      if (item.phase === CODEX_PHASE.FINAL_ANSWER) final = item.text;
      else if (item.phase == null) fallback = item.text;
    }
    if (item?.type === CODEX_ITEM.FILE_CHANGE)
      for (const change of item.changes ?? [])
        if (typeof change.path === "string") touchedFiles.add(change.path);
    if (review && item?.type === CODEX_ITEM.REVIEW_EXITED && typeof item.review === "string")
      reviewed = item.review;
  }
  return { text: final ?? reviewed ?? fallback, touchedFiles: [...touchedFiles] };
}

export class CodexSession extends EventEmitter {
  constructor(
    plan,
    {
      env = process.env,
      checkpoint = () => {},
      event = () => {},
      log = () => {},
      progress = () => {},
      steerObserved = () => {},
      processes = PROCESSES,
      timing = REAL_TIMING,
      spawnChild = spawnCodex,
      beforeDispatch = () => {},
    } = {},
  ) {
    super();
    Object.assign(this, {
      plan,
      env,
      checkpoint,
      event,
      log,
      progress,
      steerObserved,
      processes,
      timing,
      spawnChild,
      beforeDispatch,
    });
    this.threadId = plan.threadId ?? null;
    this.turnId = null;
    this.items = new Map();
    this.steerMessages = new Set();
    this.tokenUsage = null;
    this.rateLimits = null;
    this.terminal = null;
    this.failure = null;
    this.cancelRequested = false;
    this.stderr = "";
    this.completion = new Promise((resolve, reject) => {
      this.completed = resolve;
      this.failed = reject;
    });
    // A child can exit before the orchestration begins awaiting completion.
    this.completion.catch(() => {});
  }

  fail(error) {
    this.failure ??= error;
    this.failed(this.failure);
  }

  notification(method, params = {}) {
    // Notifications may omit params or explicitly send null. Such frames
    // carry no state transition; ignore invalid containers before dispatch.
    if (params === null || typeof params !== "object" || Array.isArray(params)) return;
    // Terminal evidence is immutable, even when several frames share a read.
    // Account-level accounting may still arrive during the final quota read.
    if (this.terminal && method !== NOTIFICATION.RATE_LIMITS_UPDATED) return;
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    if (compactNotification(this, method, params)) return;
    const notifiedTurn =
      params.turnId ??
      ([NOTIFICATION.TURN_STARTED, NOTIFICATION.TURN_COMPLETED].includes(method)
        ? params.turn?.id
        : null);
    // Native reviews emit nested turns. Only review/start's response identifies
    // the review we own. Buffer early frames until that reply, then filter by
    // its ID; never let a nested turn/started replace the dispatch identity.
    if (this.reviewDispatching && !this.reviewTurnBound && notifiedTurn) {
      this.reviewPendingBytes =
        (this.reviewPendingBytes ?? 0) + Buffer.byteLength(JSON.stringify(params));
      if (this.reviewPendingBytes > MAX_OUTPUT_BYTES)
        throw fault(CODES.CODEX_RPC_ERROR, "Early review notifications exceed their byte limit");
      (this.reviewPending ??= []).push({ method, params });
      return;
    }
    if (notifiedTurn && this.turnId && notifiedTurn !== this.turnId) return;
    if (
      this.threadId &&
      params.threadId === this.threadId &&
      (method === NOTIFICATION.GUARDIAN_WARNING || (this.turnId && params.turnId === this.turnId))
    ) {
      const updated = foldModelEvent(this.modelEvents, method, params);
      if (updated) {
        this.modelEvents = updated;
        this.checkpoint({ modelEvents: updated });
      }
    }
    if (
      this.progressFold &&
      !this.terminal &&
      params.threadId === this.threadId &&
      params.turnId === this.turnId &&
      this.turnId
    ) {
      const update = this.progressFold.fold(method, params);
      if (update) {
        try {
          this.progress(update);
        } catch {
          // Progress is optional evidence, not the turn's outcome. Preserve a
          // durable diagnostic, with no arbitrary error text, and never resend.
          if (!this.progressWriteFailed) {
            this.progressWriteFailed = true;
            this.checkpoint({ progressWriteFailed: true });
            this.log("Progress storage failed; the saved patch may be incomplete.\n");
          }
        }
      }
    }
    this.event({
      method,
      at: new Date().toISOString(),
      threadId: params.threadId ?? null,
      turnId: params.turnId ?? params.turn?.id ?? null,
      itemType: params.item?.type ?? null,
    });
    if (method === NOTIFICATION.THREAD_STARTED && !this.threadId) {
      this.threadId = params.thread?.id ?? null;
      this.checkpoint({ threadId: this.threadId });
    }
    if (method === NOTIFICATION.TURN_STARTED && params.turn?.id) {
      this.turnId = params.turn.id;
      this.checkpoint({ turnId: this.turnId, phase: DRIVER_PHASE.RUNNING });
      if (this.cancelRequested || this.failure)
        void this.interrupt().catch((error) => this.fail(error));
    }
    if (method === NOTIFICATION.ITEM_COMPLETED && params.item?.id) this.remember(params.item);
    if (method === NOTIFICATION.TOKEN_USAGE_UPDATED) {
      const next = params.tokenUsage ?? null;
      const previous = this.tokenUsage?.total ?? this.usageBaseline;
      if (
        this.usageBaseline !== undefined &&
        previous &&
        next?.total &&
        Object.keys(previous).some(
          (key) =>
            Number.isFinite(previous[key]) &&
            Number.isFinite(next.total[key]) &&
            next.total[key] < previous[key],
        )
      ) {
        this.usageBaseline = null; // A native counter reset cannot yield a defensible delta.
        this.checkpoint({ usageBaseline: null });
      }
      this.tokenUsage = next;
    }
    if (method === NOTIFICATION.RATE_LIMITS_UPDATED)
      this.noteRateLimits(params.rateLimits, QUOTA_SOURCE.TURN);
    if (method === NOTIFICATION.ERROR && params.willRetry === false)
      this.failure ??=
        this.codexFault(params.error) ??
        fault(CODES.CODEX_RPC_ERROR, params.error?.message ?? DRIVER_TEXT.CHILD_DIED);
    if (
      method === NOTIFICATION.TURN_COMPLETED &&
      params.turn?.id &&
      (!this.turnId || params.turn.id === this.turnId)
    ) {
      if (!terminal(params.turn.status)) return; // Unknown means active.
      try {
        for (const item of params.turn.items ?? []) this.remember(item);
        this.turnId = params.turn.id;
        this.terminalFailure = this.failure;
        this.terminal = params.turn;
        this.completed(params.turn);
      } catch (error) {
        // The server supplied a terminal frame, but its summary violated item
        // integrity. Preserve that definite failure instead of treating it as
        // a missing acknowledgement eligible for history reconstruction.
        this.terminal = params.turn;
        this.terminalFailure = error;
        this.fail(error);
      }
    }
  }

  // A failure Codex named (codexErrorInfo) as the runner's code, keeping the
  // TurnError so the result can name a reset time that arrived after it.
  codexFault(turnError) {
    const mapped = mapCodexError(turnError, this.rateLimits);
    return mapped ? new RunnerError(mapped.code, mapped.message, { codexError: turnError }) : null;
  }

  // Before any thread, the catalogue refuses a model or an effort it proves
  // unsupported: the plan's (the state root's cache for this CLI build and
  // day), else model/list, which the result then carries for the waiter to
  // cache. A cached refusal is refreshed first: the account's catalogue may
  // have changed today. A failed fresh list proves nothing, so launch goes on.
  async checkModel() {
    let models = Array.isArray(this.plan.models) ? this.plan.models : null;
    if (
      !models ||
      (this.plan.tier !== undefined && this.plan.tier !== DEFAULT_SERVICE_TIER) ||
      modelRefusal(models, this.plan.model, this.plan.effort, this.plan.codex?.version)
    ) {
      try {
        models = await listModels(this);
      } catch (error) {
        this.event({ method: RPC.MODEL_LIST, code: error.code ?? CODES.CODEX_RPC_ERROR });
        if (this.plan.tier !== undefined && this.plan.tier !== DEFAULT_SERVICE_TIER)
          throw fault(
            CODES.CODEX_UNSUPPORTED,
            "Cannot verify the requested service tier; no turn sent",
          );
        return;
      }
      this.modelCatalog = {
        build: this.plan.codex?.build ?? null,
        day: utcDay(),
        at: new Date().toISOString(),
        models,
      };
    }
    const refusal = modelRefusal(
      models,
      this.plan.model,
      this.plan.effort,
      this.plan.codex?.version,
    );
    if (refusal) throw fault(refusal.code, refusal.message);
    if (
      this.plan.tier !== undefined &&
      this.plan.tier !== DEFAULT_SERVICE_TIER &&
      !findModel(models, this.plan.model)?.serviceTiers?.includes(this.plan.tier)
    )
      throw fault(
        CODES.CODEX_UNSUPPORTED,
        "Requested service tier is not offered for this model; no turn sent",
      );
    this.modelNotice = modelNotice(models, this.plan.model);
  }

  // Before turn/start, a launch with a quota floor reads the quota and is
  // refused below it. A read that fails proves nothing, so the launch goes on.
  async checkQuotaFloor() {
    let read;
    try {
      read = await this.request(RPC.RATE_LIMITS_READ, null, APP_SERVER_PROBE_MS);
    } catch (error) {
      this.event({ method: RPC.RATE_LIMITS_READ, code: error.code ?? CODES.CODEX_RPC_ERROR });
      return;
    }
    this.noteRateLimits(read?.rateLimits, QUOTA_SOURCE.READ, read);
    const refusal = quotaRefusal(read, this.plan.quotaFloor);
    if (refusal) throw fault(CODES.CODEX_QUOTA_LOW, refusal);
  }

  // Absent fields preserve the previous observation; explicit null clears it.
  // A read also says whether ordinary usage is allowed.
  noteRateLimits(snapshot, source, read = null) {
    const hasSnapshot =
      snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot);
    const hasUsage =
      read &&
      Object.hasOwn(read, "ordinaryUsageAllowed") &&
      (read.ordinaryUsageAllowed === null || typeof read.ordinaryUsageAllowed === "boolean");
    const hasCredits =
      read &&
      Object.hasOwn(read, "rateLimitResetCredits") &&
      (read.rateLimitResetCredits === null ||
        Object.hasOwn(read.rateLimitResetCredits ?? {}, "availableCount"));
    if (!hasSnapshot && !hasUsage && !hasCredits) return;
    if (hasSnapshot)
      this.rateLimits = this.rateLimits
        ? {
            ...this.rateLimits,
            ...Object.fromEntries(
              Object.entries(snapshot).filter(([, value]) => value !== undefined),
            ),
          }
        : snapshot;
    this.rateLimitsAt = new Date().toISOString();
    this.rateLimitsSource = source;
    if (hasUsage) this.ordinaryUsageAllowed = read.ordinaryUsageAllowed;
    if (hasCredits) this.resetCredits = read.rateLimitResetCredits?.availableCount ?? null;
  }

  remember(item) {
    if (item?.type === CODEX_VALUE.USER_MESSAGE && this.steerMessages.has(item.clientId))
      this.steerObserved(item.clientId);
    // Discard user messages and tool content; no prompt or dynamic tool args
    // ever enter the job's bounded event log.
    if (
      ![
        CODEX_ITEM.AGENT_MESSAGE,
        CODEX_ITEM.FILE_CHANGE,
        ...(this.plan.review ? [CODEX_ITEM.REVIEW_EXITED] : []),
      ].includes(item.type)
    )
      return;
    const before = this.items.get(item.id);
    if (before && JSON.stringify(before) !== JSON.stringify(item))
      throw fault(CODES.CODEX_RPC_ERROR, "Inconsistent completed item");
    this.items.set(item.id, item);
    if (Buffer.byteLength(JSON.stringify([...this.items.values()])) > MAX_OUTPUT_BYTES)
      throw fault(CODES.CODEX_RPC_ERROR, "Completed items exceed their byte limit");
  }

  async open() {
    // History probes resume a thread and need per-server MCP isolation too.
    const mode = this.plan.mode ?? APP_SERVER_MODE.SESSION;
    const servers =
      this.plan.mcp === MCP_MODE.OFF && (mode !== APP_SERVER_MODE.PROBE || this.plan.loadsThread)
        ? await mcpServerNames(this.plan.codex, { env: this.env, cwd: this.plan.cwd })
        : [];
    if (this.failure || this.closing)
      throw this.failure ?? fault(CODES.CODEX_RPC_ERROR, DRIVER_TEXT.SHUTDOWN);
    const starts = startReader(this.processes.probe);
    try {
      this.child = this.spawnChild(
        this.plan.codex,
        appServerArgs({ mcp: this.plan.mcp, servers, mode, loadsThread: this.plan.loadsThread }),
        { env: this.env, cwd: this.plan.cwd, detached: !IS_WINDOWS },
      );
      this.child.stdin.on("error", () => {});
      this.child.once("error", (error) => this.fail(error));
      this.exit = new Promise((resolve) => {
        this.child.once("exit", () => {
          this.exited = true;
          if (!this.terminal && !this.closing)
            this.fail(fault(CODES.CODEX_RPC_ERROR, DRIVER_TEXT.CHILD_DIED));
          resolve();
        });
        this.child.once("error", () => {
          this.exited = true;
          resolve();
        });
      });
      this.child.stderr.setEncoding("utf8");
      this.child.stderr.on("data", (text) => {
        this.stderr = `${this.stderr}${text}`.slice(-JOB_MAX_LOG_BYTES);
        this.log(text);
      });
      this.rpc = new JsonlRpc(this.child.stdout, this.child.stdin, {
        onNotification: (method, params) => this.notification(method, params),
        onRequest: (method) => {
          const answer = answerServerRequest(method);
          // Latch before a following completion frame freezes terminal status.
          if (answer.effect !== POLICY_EFFECT.CONTINUE)
            this.failure ??= fault(answer.code, answer.reply.error?.message ?? answer.code);
          // Slow effects run after the reply, without changing frame ordering.
          setImmediate(() => {
            this.event({ method, effect: answer.effect, code: answer.code });
            if (answer.effect !== POLICY_EFFECT.CONTINUE) {
              if (answer.effect === POLICY_EFFECT.FAIL) this.fail(this.failure);
              void this.interrupt().catch((error) => this.fail(error));
            }
          });
          return answer.reply;
        },
      });
      this.rpc.on(RPC_EVENT.CLOSE, (error) => {
        if (!this.terminal && !this.closing) this.fail(error);
      });
      this.childStart = await starts.start(this.child.pid);
      if (this.childStart === null) throw fault(CODES.WORKER_UNCONFIRMED, DRIVER_TEXT.STOP);
      this.checkpoint({ appServer: { pid: this.child.pid, processStart: this.childStart } });
    } finally {
      starts.close();
    }
    const initialized = await this.request(
      RPC.INITIALIZE,
      {
        clientInfo: { name: CLIENT_NAME, version: RUNNER_VERSION },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: OPT_OUT_NOTIFICATIONS,
        },
      },
      APP_SERVER_START_MS,
    );
    this.userAgent = initialized.userAgent ?? null;
    await this.rpc.notify(RPC.INITIALIZED);
    return this;
  }

  request(method, params = null, timeoutMs = APP_SERVER_REQUEST_MS) {
    return this.rpc.request(method, params, { timeoutMs });
  }

  async run(prompt, redactor) {
    if (this.plan.progress !== PROGRESS_MODE.OFF)
      this.progressFold = new ProgressFold(prompt, redactor);
    this.began = this.timing.now();
    try {
      if (this.plan.review && this.plan.write)
        throw fault(CODES.CODEX_UNSUPPORTED, "Native review requires read-only mode");
      await this.open();
      if (IS_WINDOWS && this.plan.write) {
        const readiness = await this.request(RPC.WINDOWS_SANDBOX_READINESS);
        if (readiness.status !== CODEX_READY)
          throw fault(CODES.CODEX_UNSUPPORTED, DRIVER_TEXT.SANDBOX);
      }
      // No thread is started or resumed for a launch these checks refuse.
      await this.checkModel();
      if (this.plan.quotaFloor > 0) await this.checkQuotaFloor();
      const params = {
        model: this.plan.model,
        cwd: this.plan.cwd,
        approvalPolicy: CODEX_VALUE.NEVER,
        sandbox: this.plan.write ? CODEX_VALUE.WORKSPACE_WRITE : CODEX_VALUE.READ_ONLY,
        ...(this.plan.review
          ? {
              config: {
                review_model: this.plan.model,
                model_reasoning_effort: this.plan.effort,
                ...(this.plan.summary !== undefined
                  ? { model_reasoning_summary: this.plan.summary }
                  : {}),
              },
            }
          : {}),
      };
      const started = await this.request(
        this.threadId ? RPC.THREAD_RESUME : RPC.THREAD_START,
        this.threadId
          ? { ...params, threadId: this.threadId, excludeTurns: true }
          : { ...params, ephemeral: false },
      );
      if (!started.thread?.id || (this.threadId && started.thread.id !== this.threadId))
        throw fault(CODES.CODEX_RPC_ERROR, "Thread identity mismatch");
      if (
        started.approvalPolicy !== CODEX_VALUE.NEVER ||
        started.sandbox?.type !==
          (this.plan.write ? CODEX_VALUE.WORKSPACE_WRITE_POLICY : CODEX_VALUE.READ_ONLY_POLICY) ||
        started.model !== this.plan.model ||
        (this.plan.review && started.reasoningEffort !== this.plan.effort)
      )
        throw fault(CODES.CODEX_UNSUPPORTED, "Codex returned different model or safety settings");
      this.threadId = started.thread.id;
      if (this.plan.compact && !ARCHIVABLE_THREAD_STATES.has(started.thread.status?.type))
        throw fault(
          CODES.CODEX_UNSUPPORTED,
          "Compaction requires an idle thread; no summary or prompt sent",
        );
      this.checkpoint({ threadId: this.threadId });
      const name = threadName(this.plan.runKey, this.plan.model);
      if (name) {
        try {
          await this.request(RPC.THREAD_NAME_SET, { threadId: this.threadId, name });
          this.checkpoint({ threadName: name });
        } catch {
          this.threadNameFailed = true;
          this.checkpoint({ threadNameFailed: true });
        }
      }
      this.beforeDispatch();
      assertCodexIdentity(this.plan.codex, this.env);
      if (this.failure) throw this.failure;
      if (this.cancelRequested) return this.result(null, JOB_STATUS.CANCELLED);
      // Freeze before compaction/dispatch, not after the first model response.
      // Fresh threads start at zero; an inherited context without evidence is
      // unknown rather than charged as a new thread.
      this.usageBaseline =
        this.tokenUsage?.total ??
        this.plan.usageBaseline ??
        (this.plan.threadId
          ? null
          : {
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 0,
            });
      this.checkpoint({ usageBaseline: this.usageBaseline });
      if (this.plan.compact) {
        await compactThread(this);
        this.beforeDispatch();
        assertCodexIdentity(this.plan.codex, this.env);
        if (this.failure) throw this.failure;
        if (this.cancelRequested) return this.result(null, JOB_STATUS.CANCELLED);
      }
      // The durable intent is written before any bytes of turn/start.
      this.checkpoint({
        phase: DRIVER_PHASE.DISPATCHING,
        dispatching: true,
        clientUserMessageId: this.plan.review ? null : this.plan.jobId,
      });
      this.reviewDispatching = Boolean(this.plan.review);
      // A resumed parent may publish its earlier usage during thread/resume.
      // Native review delegates can omit usage entirely; do not present that
      // parent's context or counters as telemetry for this review.
      if (this.plan.review) this.tokenUsage = null;
      this.dispatching = true;
      const response = this.plan.review
        ? await this.request(RPC.REVIEW_START, {
            threadId: this.threadId,
            target: reviewTarget(this.plan.review, prompt),
            delivery: "inline",
          })
        : await this.request(RPC.TURN_START, {
            threadId: this.threadId,
            clientUserMessageId: this.plan.jobId,
            input: [{ type: CODEX_VALUE.TEXT, text: prompt, text_elements: [] }],
            model: this.plan.model,
            effort: this.plan.effort,
            ...(this.plan.tier !== undefined ? { serviceTierForTurn: this.plan.tier } : {}),
            ...(this.plan.summary !== undefined ? { summary: this.plan.summary } : {}),
            ...(this.plan.outputSchema !== undefined
              ? { outputSchema: this.plan.outputSchema }
              : {}),
          });
      if (this.plan.review && response.reviewThreadId !== this.threadId) {
        this.terminalFailure = fault(CODES.CODEX_RPC_ERROR, "Review thread identity mismatch");
        throw this.terminalFailure;
      }
      if (!response.turn?.id || (this.turnId && this.turnId !== response.turn.id))
        throw fault(CODES.CODEX_RPC_ERROR, "Turn identity mismatch");
      this.turnId = response.turn.id;
      this.checkpoint({ turnId: this.turnId, phase: DRIVER_PHASE.RUNNING });
      if (this.plan.review) {
        this.reviewTurnBound = true;
        const pending = this.reviewPending ?? [];
        this.reviewPending = null;
        for (const event of pending) this.notification(event.method, event.params);
      }
      if (terminal(response.turn.status) && !this.terminal)
        this.notification(NOTIFICATION.TURN_COMPLETED, {
          threadId: this.threadId,
          turn: response.turn,
        });
      if (this.cancelRequested) await this.interrupt();
      const ended = await this.completion;
      if (!this.rateLimits && ended.status !== TURN_STATUS.INTERRUPTED) {
        try {
          const read = await this.request(RPC.RATE_LIMITS_READ, null, APP_SERVER_PROBE_MS);
          this.noteRateLimits(read?.rateLimits, QUOTA_SOURCE.READ, read);
        } catch {
          /* Accounting must not block delivery. */
        }
      }
      return this.result(ended);
    } catch (error) {
      if (this.terminal) return this.result(this.terminal);
      if (this.cancelStopRequested) {
        this.failure = null;
        return this.result(this.terminal, JOB_STATUS.CANCELLED);
      }
      this.failure =
        this.dispatching &&
        !error.rpcError &&
        (!this.failure || this.failure.code === CODES.CODEX_RPC_ERROR)
          ? fault(
              CODES.SUBMISSION_UNCERTAIN,
              `${CODES.SUBMISSION_UNCERTAIN}: ${DRIVER_TEXT.UNCERTAIN}`,
            )
          : (this.failure ?? error);
      return this.result(this.terminal, JOB_STATUS.FAILED);
    }
  }

  result(turn, forced = null) {
    const folded = foldItems([...this.items.values()], { review: Boolean(this.plan.review) });
    // Shutdown and transport errors after a validated terminal notification
    // cannot relabel that turn. Earlier policy/protocol failures still apply.
    let failure = this.terminal ? this.terminalFailure : this.failure;
    let status =
      forced ??
      (turn?.status === TURN_STATUS.COMPLETED
        ? JOB_STATUS.COMPLETED
        : turn?.status === TURN_STATUS.INTERRUPTED && this.cancelRequested
          ? JOB_STATUS.CANCELLED
          : JOB_STATUS.FAILED);
    if (failure) status = JOB_STATUS.FAILED;
    if (status === JOB_STATUS.COMPLETED && folded.text === null) {
      status = JOB_STATUS.FAILED;
      this.failure = failure = fault(CODES.CODEX_RPC_ERROR, DRIVER_TEXT.NO_FINAL);
    }
    // A failure Codex named keeps its code; its message names the reset known
    // by now. An earlier policy or protocol failure still wins.
    const named = failure
      ? failure.codexError
        ? mapCodexError(failure.codexError, this.rateLimits)
        : null
      : turn?.error
        ? mapCodexError(turn.error, this.rateLimits)
        : null;
    const error = named
      ? named
      : failure
        ? { code: failure.code ?? CODES.CODEX_RPC_ERROR, message: failure.message }
        : turn?.error
          ? { code: CODES.CODEX_RPC_ERROR, message: turn.error.message }
          : status === JOB_STATUS.FAILED
            ? { code: CODES.CODEX_RPC_ERROR, message: DRIVER_TEXT.CHILD_DIED }
            : null;
    return {
      status,
      threadId: this.threadId,
      turnId: this.turnId,
      text:
        folded.text !== null && error && status === JOB_STATUS.FAILED
          ? `${folded.text.trimEnd()}\n\n${error.message.startsWith(`${error.code}:`) ? error.message : `${error.code}: ${error.message}`}`
          : (folded.text ??
            error?.message ??
            (status === JOB_STATUS.CANCELLED ? DRIVER_TEXT.CANCELLED : "")),
      touchedFiles: folded.touchedFiles,
      tokenUsage: turn?.status === TURN_STATUS.COMPLETED ? this.tokenUsage : null,
      usageBaseline: this.usageBaseline ?? null,
      rateLimits: this.rateLimits,
      rateLimitsAt: this.rateLimitsAt ?? null,
      rateLimitsSource: this.rateLimitsSource ?? null,
      ordinaryUsageAllowed: this.ordinaryUsageAllowed ?? null,
      resetCredits: this.resetCredits ?? null,
      modelCatalog: this.modelCatalog ?? null,
      modelNotice: this.modelNotice ?? null,
      ...(this.modelEvents ? { modelEvents: this.modelEvents } : {}),
      ...(this.progressWriteFailed ? { progressWriteFailed: true } : {}),
      ...(this.threadNameFailed ? { threadNameFailed: true } : {}),
      ...(this.compaction ? { compaction: this.compaction } : {}),
      error: error && this.stderr ? { ...error, stderr: this.stderr } : error,
      userAgent: this.userAgent ?? null,
      durationMs:
        turn?.durationMs ?? Math.max(0, this.timing.now() - (this.began ?? this.timing.now())),
    };
  }

  async steer({ text, expectedTurnId, clientUserMessageId, beforeDispatch }) {
    if (
      !this.threadId ||
      this.compacting ||
      !this.turnId ||
      this.terminal ||
      this.closing ||
      this.cancelRequested ||
      this.failure
    )
      throw fault(CODES.STEER_NOT_RUNNING, STEER_TEXT.INACTIVE);
    if (expectedTurnId !== this.turnId) throw fault(CODES.STEER_TURN_CHANGED, STEER_TEXT.CHANGED);
    this.progressFold?.addPrompt(text);
    this.steerMessages.add(clientUserMessageId);
    beforeDispatch(); // Synchronous durable checkpoint before any RPC bytes.
    const result = await this.request(
      RPC.TURN_STEER,
      {
        threadId: this.threadId,
        expectedTurnId,
        clientUserMessageId,
        input: [{ type: CODEX_VALUE.TEXT, text, text_elements: [] }],
      },
      STEER_REQUEST_MS,
    );
    if (result.turnId !== expectedTurnId)
      throw fault(CODES.SUBMISSION_UNCERTAIN, STEER_TEXT.UNCERTAIN);
    return result;
  }

  async interrupt({ cancel = false } = {}) {
    if (cancel) this.cancelRequested = true;
    if (this.terminal || !this.threadId || !this.turnId)
      return { terminal: Boolean(this.terminal) };
    this.interrupting ??= (async () => {
      try {
        await this.request(
          RPC.TURN_INTERRUPT,
          { threadId: this.threadId, turnId: this.turnId },
          APP_SERVER_INTERRUPT_MS,
        );
      } catch (error) {
        // Terminal evidence can precede the interrupt acknowledgement. A lost
        // transport reply must not override it or cause another interrupt.
        if (this.terminal) return { terminal: true };
        throw error;
      }
      const deadline = this.timing.now() + APP_SERVER_INTERRUPT_MS;
      while (!this.terminal && !this.exited && this.timing.now() < deadline)
        await this.timing.sleep(DRIVER_POLL_MS);
      return { terminal: Boolean(this.terminal) };
    })();
    return this.interrupting;
  }

  close() {
    this.closingPromise ??= this.closeChild();
    return this.closingPromise;
  }

  async closeChild() {
    this.closing = true;
    if (!this.child) return;
    // Interrupt RPCs are bounded. Let a pending acknowledgement settle before
    // tearing down the transport that carries it.
    await this.interrupting?.catch(() => {});
    // Capture and settle the owned tree before closing stdin can let its root
    // exit and orphan descendants. A terminal turn is not a tree-exit receipt.
    if (!this.exited) {
      const stopped = await trackedStop(
        { pid: this.child.pid, start: this.childStart },
        (onIdentified) =>
          stopOwnedChild(this.child, this.childStart, {
            stop: (target) => this.processes.stop({ ...target, onIdentified }),
          }),
        this.checkpoint,
      );
      if (!knownEnd(stopped) || stopped.detail) {
        throw fault(CODES.STOP_INCOMPLETE, DRIVER_TEXT.STOP);
      }
      await this.exit;
      this.checkpoint({
        shutdownIncomplete: false,
        shutdownTree: [],
        shutdownTreeUnknown: false,
        shutdownCapturePending: false,
        shutdownRoot: null,
      });
    }
    this.child.stdin.end();
    this.rpc?.close();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}
