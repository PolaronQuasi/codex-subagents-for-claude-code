// This authenticates ownership and generation, not a hostile same-user process.
// Windows' pipe DACL is also part of the boundary: sandbox users can read the
// state root. No secret is ever sent, logged, or included in a control frame.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import crypto from "node:crypto";
import { JsonlRpc } from "./rpc.mjs";
import { atomicWrite, readLimited, requireDirectory } from "../shared/io.mjs";
import { jobPaths } from "../state/job-store.mjs";
import {
  IS_WINDOWS,
  IS_LINUX,
  DRIVER_FILES,
  DRIVER_PROTOCOL_VERSION,
  DRIVER_IPC,
  DRIVER_PROBE_MS,
  DRIVER_REPLY_MS,
  DRIVER_INTERRUPT_MS,
  RPC_EVENT,
  IPC_AUTH,
  IPC_AUTH_MS,
  IPC_SECRET_BYTES,
  IPC_NONCE_BYTES,
  IPC_MAX_CONNECTIONS,
  IPC_MAX_FRAME_BYTES,
  IPC_PIPE_PREFIX,
  DRIVER_HASH,
  DRIVER_ENCODING,
  DRIVER_TEXT,
  IPC_SOCKET_PREFIX,
  IPC_SOCKET_SUFFIX,
  IPC_UNIX_PATH_BYTES,
  IPC_LINUX_PATH_BYTES,
  IPC_POSIX_TMP,
} from "../shared/constants.mjs";
import { CODES, RPC_ERROR, ERRNO, RunnerError } from "../shared/errors.mjs";

const authError = () => new RunnerError(CODES.IPC_AUTH_FAILED, DRIVER_TEXT.AUTH);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonce = () => crypto.randomBytes(IPC_NONCE_BYTES).toString(DRIVER_ENCODING);
const validNonce = (value) =>
  typeof value === "string" && /^[0-9a-f]+$/.test(value) && value.length === IPC_NONCE_BYTES * 2;
const same = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
export function ipcMac(secret, ...parts) {
  return crypto
    .createHmac(DRIVER_HASH, secret)
    .update(JSON.stringify(parts))
    .digest(DRIVER_ENCODING);
}
const identity = (record) => [
  record.protocol,
  record.runKey,
  record.jobId,
  record.generation,
  record.pid,
  record.processStart,
];
const scope = (record) => identity(record).slice(0, -2);
const sameScope = (params, record) =>
  JSON.stringify(params?.scope) === JSON.stringify(scope(record));

export function createIpcSecret(stateDir, jobId) {
  const directory = jobPaths(stateDir, jobId).directory;
  requireDirectory(directory);
  const file = path.join(directory, DRIVER_FILES.SECRET);
  if (fs.existsSync(file)) throw authError();
  atomicWrite(file, crypto.randomBytes(IPC_SECRET_BYTES));
  return file;
}
export function readIpcSecret(stateDir, jobId) {
  const file = path.join(jobPaths(stateDir, jobId).directory, DRIVER_FILES.SECRET);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw authError();
  const bytes = readLimited(file, IPC_SECRET_BYTES);
  if (bytes.length !== IPC_SECRET_BYTES) throw authError();
  return bytes;
}
// The name ipcEndpoint gives a socket outside the job folder.
const TEMPORARY_SOCKET = new RegExp(
  `^${IPC_SOCKET_PREFIX}[0-9a-f]{${IPC_SECRET_BYTES * 2}}${IPC_SOCKET_SUFFIX.replaceAll(".", "\\.")}$`,
);

// The waiter records this path in driver.json before the spawn, and the
// driver binds exactly the recorded path. The job folder's own socket is used
// whenever its path fits sockaddr_un on this platform.
export function ipcEndpoint(stateDir, jobId) {
  if (IS_WINDOWS) return `${IPC_PIPE_PREFIX}${nonce()}`;
  const limit = IS_LINUX ? IPC_LINUX_PATH_BYTES : IPC_UNIX_PATH_BYTES;
  const inJob = path.join(jobPaths(stateDir, jobId).directory, DRIVER_FILES.SOCKET);
  if (Buffer.byteLength(inJob) <= limit) return inJob;
  // sockaddr_un is much smaller than an ordinary filesystem path. Long
  // state roots use a random 0600 socket in the OS temp directory instead.
  const name = `${IPC_SOCKET_PREFIX}${crypto.randomBytes(IPC_SECRET_BYTES).toString(DRIVER_ENCODING)}${IPC_SOCKET_SUFFIX}`;
  const inTemp = path.join(os.tmpdir(), name);
  return Buffer.byteLength(inTemp) <= limit ? inTemp : path.join(IPC_POSIX_TMP, name);
}

// Called only after the bound driver's identity is proved ended. A collision
// before bind never grants permission to remove that endpoint. It removes
// exactly the recorded endpoint: the job folder's socket, or an absolute path
// under the random name ipcEndpoint gives, in whichever temporary folder the
// launch used. That folder is never judged by this process's os.tmpdir(),
// which another shell, service or container may set differently.
export function removeEndedEndpoint(record, stateDir) {
  if (IS_WINDOWS || !record.ipcBound) return;
  const local = path.join(jobPaths(stateDir, record.jobId).directory, DRIVER_FILES.SOCKET);
  const temporary =
    typeof record.endpoint === "string" &&
    path.isAbsolute(record.endpoint) &&
    TEMPORARY_SOCKET.test(path.basename(record.endpoint));
  if (record.endpoint !== local && !temporary) throw authError();
  try {
    const stat = fs.lstatSync(record.endpoint);
    if (!stat.isSocket() || stat.isSymbolicLink()) throw authError();
    fs.unlinkSync(record.endpoint);
  } catch (error) {
    if (error.code !== ERRNO.ENOENT) throw error;
  }
}

export async function serveIpc(record, secret, handler) {
  const sockets = new Set();
  const unauthenticated = new Set();
  const server = net.createServer((socket) => {
    if (sockets.size >= IPC_MAX_CONNECTIONS) {
      // Idle peers must not reserve every slot until the login deadline.
      // Prefer the oldest unproved peer; an authenticated control stays live.
      const oldest = unauthenticated.values().next().value;
      if (!oldest) {
        socket.destroy();
        return;
      }
      unauthenticated.delete(oldest);
      sockets.delete(oldest);
      oldest.destroy();
    }
    sockets.add(socket);
    unauthenticated.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      unauthenticated.delete(socket);
    });
    let transcript = null,
      authenticated = false,
      sequence = 0,
      proving = false;
    const timer = setTimeout(() => socket.destroy(), IPC_AUTH_MS);
    const rpc = new JsonlRpc(socket, socket, {
      maxFrameBytes: IPC_MAX_FRAME_BYTES,
      requestMs: DRIVER_INTERRUPT_MS + DRIVER_REPLY_MS,
      onRequest: async (method, params) => {
        const refuse = () => {
          socket.destroy();
          throw authError();
        };
        if (method === DRIVER_IPC.HELLO) {
          if (
            record.protocol !== DRIVER_PROTOCOL_VERSION ||
            params?.scope?.[0] !== record.protocol
          ) {
            socket.end();
            return { error: { code: RPC_ERROR.UNSUPPORTED, message: DRIVER_TEXT.PROTOCOL } };
          }
          if (!sameScope(params, record) || authenticated) return refuse();
          if (params.stage === IPC_AUTH.CHALLENGE && !transcript && validNonce(params.nonce)) {
            const serverNonce = nonce();
            transcript = [...identity(record), params.nonce, serverNonce];
            return {
              result: {
                identity: identity(record),
                nonce: serverNonce,
                proof: ipcMac(secret, IPC_AUTH.SERVER, transcript),
              },
            };
          }
          if (
            params.stage !== IPC_AUTH.PROVE ||
            !transcript ||
            proving ||
            !same(params.proof, ipcMac(secret, IPC_AUTH.CLIENT, transcript))
          )
            return refuse();
          proving = true;
          authenticated = true;
          unauthenticated.delete(socket);
          clearTimeout(timer);
          return { result: { proof: ipcMac(secret, IPC_AUTH.ACK, transcript) } };
        }
        if (
          !authenticated ||
          !Number.isSafeInteger(params?.sequence) ||
          params.sequence !== sequence + 1 ||
          !same(
            params.proof,
            ipcMac(secret, IPC_AUTH.REQUEST, transcript, method, params.sequence, params.payload),
          )
        )
          return refuse();
        sequence = params.sequence; // Reserve before awaiting a slow interrupt.
        if (!Object.values(DRIVER_IPC).includes(method)) return refuse();
        const payload = await handler(method, params.payload);
        return {
          result: {
            sequence: params.sequence,
            payload,
            proof: ipcMac(secret, IPC_AUTH.RESPONSE, transcript, method, params.sequence, payload),
          },
        };
      },
    });
    rpc.on(RPC_EVENT.CLOSE, () => {
      clearTimeout(timer);
      socket.destroy();
    });
  });
  // Never unlink a pre-existing endpoint: a squatter causes a closed failure.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(record.endpoint, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  if (!IS_WINDOWS) fs.chmodSync(record.endpoint, 0o600);
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function connectIpc(record, secret, { timeoutMs = DRIVER_PROBE_MS } = {}) {
  if (record.protocol !== DRIVER_PROTOCOL_VERSION)
    throw new RunnerError(CODES.DRIVER_PROTOCOL_MISMATCH, DRIVER_TEXT.PROTOCOL);
  const socket = net.createConnection(record.endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(authError());
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", failed);
      resolve();
    });
    const failed = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once("error", failed);
  });
  const rpc = new JsonlRpc(socket, socket, {
    requestMs: DRIVER_REPLY_MS,
    maxFrameBytes: IPC_MAX_FRAME_BYTES,
  });
  rpc.on(RPC_EVENT.CLOSE, () => socket.destroy());
  try {
    const clientNonce = nonce();
    const reply = await rpc.request(DRIVER_IPC.HELLO, {
      stage: IPC_AUTH.CHALLENGE,
      scope: scope(record),
      nonce: clientNonce,
    });
    if (!object(reply)) throw authError();
    const transcript = [...identity(record), clientNonce, reply.nonce];
    if (
      !validNonce(reply.nonce) ||
      JSON.stringify(reply.identity) !== JSON.stringify(identity(record)) ||
      !same(reply.proof, ipcMac(secret, IPC_AUTH.SERVER, transcript))
    )
      throw authError();
    const ack = await rpc.request(DRIVER_IPC.HELLO, {
      stage: IPC_AUTH.PROVE,
      scope: scope(record),
      proof: ipcMac(secret, IPC_AUTH.CLIENT, transcript),
    });
    if (!object(ack) || !same(ack.proof, ipcMac(secret, IPC_AUTH.ACK, transcript)))
      throw authError();
    let sequence = 0;
    return {
      async request(method, payload = {}, options = {}) {
        const seq = ++sequence;
        const result = await rpc.request(
          method,
          {
            sequence: seq,
            payload,
            proof: ipcMac(secret, IPC_AUTH.REQUEST, transcript, method, seq, payload),
          },
          options,
        );
        if (
          !object(result) ||
          result.sequence !== seq ||
          !same(
            result.proof,
            ipcMac(secret, IPC_AUTH.RESPONSE, transcript, method, seq, result.payload),
          )
        ) {
          rpc.close();
          socket.destroy();
          throw authError();
        }
        return result.payload;
      },
      close() {
        rpc.close();
        socket.destroy();
      },
    };
  } catch (error) {
    rpc.close();
    socket.destroy();
    throw error.code === CODES.DRIVER_PROTOCOL_MISMATCH ? error : authError();
  }
}
