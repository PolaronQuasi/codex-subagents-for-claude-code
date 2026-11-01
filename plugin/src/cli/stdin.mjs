import { MAX_PROMPT_BYTES } from "../shared/constants.mjs";

// Buffer stdin before any launch reservation or detachment. No temporary task
// file and no deletion semantics: the stream is caller-owned input.
export async function readStdin(input, { signal, timeoutMs }) {
  signal?.throwIfAborted();
  if (input.isTTY)
    throw new Error("stdin input needs a pipe; use a task or prompt file interactively");
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    const finish = (error) => {
      clearTimeout(timer);
      input.pause();
      input.removeListener("data", data);
      input.removeListener("end", end);
      input.removeListener("error", fail);
      input.removeListener("close", closed);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else {
        const bytes = Buffer.concat(parts);
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          resolve(bytes);
        } catch {
          reject(new Error("stdin must be valid UTF-8"));
        }
      }
    };
    const data = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_PROMPT_BYTES) finish(new Error("stdin exceeds the 8 MiB input limit"));
      else parts.push(bytes);
    };
    const end = () => finish(),
      fail = (error) => finish(error);
    const closed = () => {
      if (!input.readableEnded) finish(new Error("stdin closed before EOF"));
    };
    const abort = () => finish(signal.reason ?? new Error("stdin cancelled"));
    const timer = setTimeout(
      () => finish(new Error("stdin timed out before EOF; no task submitted")),
      timeoutMs,
    );
    input.on("data", data);
    input.once("end", end);
    input.once("error", fail);
    input.once("close", closed);
    signal?.addEventListener("abort", abort, { once: true });
    if (input.readableEnded) end();
    else input.resume();
  });
}
