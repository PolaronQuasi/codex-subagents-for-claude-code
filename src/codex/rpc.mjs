// Bidirectional JSON-RPC envelopes over JSONL streams. No app-server methods,
// turn states or policy decisions belong here. The wire omits jsonrpc.
import { EventEmitter } from "node:events";
import {
  APP_SERVER_REQUEST_MS,
  RPC_MAX_FRAME_BYTES,
  RPC_MAX_PENDING,
  RPC_MAX_SERVER_REQUESTS,
  RPC_MAX_QUEUED_BYTES,
  RPC_EVENT,
} from "../shared/constants.mjs";
import { CODES, RPC_ERROR, RunnerError } from "../shared/errors.mjs";

const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value) => typeof value === "string" || Number.isSafeInteger(value);
const fault = (message, fields) => new RunnerError(CODES.CODEX_RPC_ERROR, message, fields);
const ignoreLateStreamError = () => {};
const validReply = (reply) =>
  object(reply) &&
  own(reply, "result") !== own(reply, "error") &&
  (!own(reply, "result") || reply.result !== undefined) &&
  (!own(reply, "error") ||
    (object(reply.error) &&
      Number.isInteger(reply.error.code) &&
      typeof reply.error.message === "string"));

/**
 * onRequest(method, params, {id}) returns {result} or {error:{code,message}}.
 * onNotification(method, params) runs independently of outstanding requests.
 * Events: notification({method,params}), close(error). close releases this
 * transport's listeners and timers; its owner closes the actual child streams.
 */
export class JsonlRpc extends EventEmitter {
  constructor(
    readable,
    writable,
    {
      onRequest,
      onNotification,
      requestMs = APP_SERVER_REQUEST_MS,
      maxFrameBytes = RPC_MAX_FRAME_BYTES,
      maxPending = RPC_MAX_PENDING,
      maxServerRequests = RPC_MAX_SERVER_REQUESTS,
      maxQueuedBytes = RPC_MAX_QUEUED_BYTES,
    } = {},
  ) {
    super();
    for (const value of [requestMs, maxFrameBytes, maxPending, maxServerRequests, maxQueuedBytes])
      if (!Number.isSafeInteger(value) || value <= 0) throw fault("invalid RPC transport limit");
    Object.assign(this, {
      readable,
      writable,
      onRequest,
      onNotification,
      requestMs,
      maxFrameBytes,
      maxPending,
      maxServerRequests,
      maxQueuedBytes,
    });
    this.pending = new Map();
    this.serving = new Map();
    this.queue = [];
    this.queuedBytes = 0;
    this.frameBuffer = Buffer.alloc(0);
    this.frameBytes = 0;
    this.nextId = 0;
    this.closed = false;
    this.writing = false;
    this.decode = new TextDecoder("utf-8", { fatal: true });
    this.data = (chunk) => {
      try {
        this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (error) {
        this.close(fault("invalid RPC input", { cause: error }));
      }
    };
    this.eof = () => this.close(fault(this.frameBytes ? "truncated RPC frame" : "RPC input ended"));
    this.streamError = (error) => this.close(fault("RPC stream failed", { cause: error }));
    readable.on("data", this.data);
    readable.on("end", this.eof);
    readable.on("close", this.eof);
    readable.on("error", this.streamError);
    writable.on("error", this.streamError);
    writable.on("close", this.eof);
  }

  consume(chunk) {
    let offset = 0;
    while (offset < chunk.length && !this.closed) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      this.frameBytes += part.length;
      if (this.frameBytes > this.maxFrameBytes) throw fault("RPC frame exceeds its byte limit");
      if (this.frameBytes > this.frameBuffer.length) {
        const grown = Buffer.alloc(
          Math.min(
            this.maxFrameBytes,
            Math.max(this.frameBytes, this.frameBuffer.length + this.frameBuffer.length),
          ),
        );
        this.frameBuffer.copy(grown);
        this.frameBuffer = grown;
      }
      part.copy(this.frameBuffer, this.frameBytes - part.length);
      if (newline < 0) return;
      const frame = this.decode.decode(this.frameBuffer.subarray(0, this.frameBytes));
      this.frameBytes = 0;
      if (!frame.trim()) throw fault("empty RPC frame");
      this.dispatch(JSON.parse(frame));
      offset = end + 1;
    }
  }

  dispatch(message) {
    if (!object(message)) throw fault("RPC envelope must be an object");
    if (own(message, "method")) {
      if (
        typeof message.method !== "string" ||
        !message.method ||
        own(message, "result") ||
        own(message, "error")
      )
        throw fault("invalid RPC method envelope");
      if (!own(message, "id")) {
        this.emit(RPC_EVENT.NOTIFICATION, message);
        Promise.resolve(this.onNotification?.(message.method, message.params)).catch(
          this.streamError,
        );
        return;
      }
      if (!validId(message.id) || this.serving.has(message.id))
        throw fault("invalid or duplicate RPC request id");
      if (this.serving.size >= this.maxServerRequests)
        throw fault("too many concurrent RPC server requests");
      const timer = setTimeout(
        () => this.close(fault("RPC server request timed out")),
        this.requestMs,
      );
      this.serving.set(message.id, timer);
      // Invoke synchronous handlers in wire order: a policy request may precede
      // a completion notification in the same input chunk.
      let response;
      try {
        response = this.onRequest
          ? this.onRequest(message.method, message.params, { id: message.id })
          : { error: { code: RPC_ERROR.METHOD_NOT_FOUND, message: "Method not found" } };
      } catch (error) {
        response = Promise.reject(error);
      }
      Promise.resolve(response)
        .then((reply) => {
          if (this.closed) return;
          if (!validReply(reply)) throw fault("invalid RPC handler reply");
          return this.send({ id: message.id, ...reply });
        })
        .catch(this.streamError)
        .finally(() => {
          clearTimeout(timer);
          this.serving.delete(message.id);
        });
      return;
    }
    if (!validId(message.id) || !validReply(message)) throw fault("invalid RPC response envelope");
    const waiting = this.pending.get(message.id);
    if (!waiting) return; // A late response to a timed-out request.
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (own(message, "error"))
      waiting.reject(
        fault(message.error.message, { rpcError: message.error, method: waiting.method }),
      );
    else waiting.resolve(message.result);
  }

  request(method, params = {}, { timeoutMs = this.requestMs } = {}) {
    if (this.closed) return Promise.reject(this.failure);
    if (typeof method !== "string" || !method || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(fault("invalid RPC request"));
    if (this.pending.size >= this.maxPending)
      return Promise.reject(fault("too many pending RPC requests"));
    if (!Number.isSafeInteger(this.nextId + 1))
      return Promise.reject(fault("RPC request ids exhausted"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fault(`RPC request timed out: ${method}`, { method }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ id, method, params }, () => this.pending.has(id)).catch((error) => {
        const waiting = this.pending.get(id);
        if (!waiting) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  notify(method, params = {}) {
    if (typeof method !== "string" || !method)
      return Promise.reject(fault("invalid RPC notification"));
    return this.send({ method, params });
  }

  send(message, current = () => true) {
    if (this.closed) return Promise.reject(this.failure);
    let frame;
    try {
      frame = Buffer.from(`${JSON.stringify(message)}\n`);
      if (
        frame.length - 1 > this.maxFrameBytes ||
        this.queuedBytes + frame.length > this.maxQueuedBytes
      )
        throw fault("RPC output exceeds its byte limit");
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ frame, resolve, reject, current });
      this.queuedBytes += frame.length;
      this.flush();
    });
  }

  flush() {
    if (this.closed || this.writing || !this.queue.length) return;
    const entry = this.queue[0];
    this.writing = true;
    const done = (error) => {
      if (this.closed) return;
      if (error) {
        this.streamError(error);
        return;
      }
      this.queue.shift();
      this.queuedBytes -= entry.frame.length;
      this.writing = false;
      entry.resolve();
      this.flush();
    };
    try {
      if (entry.current()) this.writable.write(entry.frame, done);
      else done();
    } catch (error) {
      done(error);
    }
  }

  close(error = fault("RPC transport closed")) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.readable
      .off("data", this.data)
      .off("end", this.eof)
      .off("close", this.eof)
      .off("error", this.streamError);
    this.writable.off("error", this.streamError).off("close", this.eof);
    // Writable may emit error after calling its failed write callback. Keep a
    // stateless fallback, without retaining the closed peer, for that late event.
    for (const stream of new Set([this.readable, this.writable]))
      if (!stream.listenerCount("error")) stream.on("error", ignoreLateStreamError);
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    for (const timer of this.serving.values()) clearTimeout(timer);
    for (const entry of this.queue) entry.reject(error);
    this.pending.clear();
    this.serving.clear();
    this.queue = [];
    this.queuedBytes = 0;
    this.frameBuffer = Buffer.alloc(0);
    this.frameBytes = 0;
    this.emit(RPC_EVENT.CLOSE, error);
  }
}

export const createRpc = ({ readable, writable, ...options }) =>
  new JsonlRpc(readable, writable, options);
