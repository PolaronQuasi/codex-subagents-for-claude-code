// What a run printed: a stream that keeps it, the delivered text split from its
// codex-subagents-for-claude-code footer, and the digest the runner records of a result.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Writable } from "node:stream";

// Every current footer includes tokens= and limit=, using - when unknown.
export const FOOTER =
  /^codex-subagents-for-claude-code: status=(\S+) run=([0-9a-f]+) turn=(\d+) job=(\S+) thread=(\S+) model=(\S+) effort=(\S+) mode=(\S+) duration=(\S+) touched=(\d+) omitted=(\d+) request=(\S+) branch=(\S+) commit=(\S+) keep=(yes|no) tokens=(\S+) limit=(\S+) result=(.*)\n/;

// The footer's additive quota line, written out independently of the runner.
const QUOTA_PREFIX = "codex-subagents-for-claude-code-quota: ";
export const QUOTA =
  /^codex-subagents-for-claude-code-quota: used=(\S+) remaining=(\S+) resets=(\S+) credits=(\S+) context=(\S+)$/;

// A writable stream that keeps what it is given; text() reads it as UTF-8.
export function sink() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

// Splits delivered stdout into the Codex text and the parsed codex-subagents-for-claude-code footer.
export function delivered(stdout) {
  const at = stdout.lastIndexOf("codex-subagents-for-claude-code: status=");
  assert.ok(
    at >= 0 && (at === 0 || stdout[at - 1] === "\n"),
    `footer present: ${JSON.stringify(stdout.slice(-300))}`,
  );
  const tail = stdout.slice(at);
  const match = FOOTER.exec(tail);
  assert.ok(match, `footer well-formed: ${JSON.stringify(tail)}`);
  const touched = tail.slice(match[0].length).split("\n").filter(Boolean);
  // The quota line, when present, is the footer's last line, after the touched ones.
  const quota = touched.at(-1)?.startsWith(QUOTA_PREFIX) ? touched.pop() : null;
  if (quota !== null) assert.match(quota, QUOTA, tail);
  assert.ok(
    touched.every((line) => line.startsWith("codex-subagents-for-claude-code-touched: ")),
    tail,
  );
  const [
    ,
    status,
    run,
    turn,
    job,
    thread,
    model,
    effort,
    mode,
    duration,
    count,
    omitted,
    request,
    branch,
    commit,
    keep,
    tokens,
    limit,
    file,
  ] = match;
  let body = stdout.slice(0, at),
    notice = null;
  const noticeAt = body.lastIndexOf("codex-subagents-for-claude-code-omitted: ");
  if (
    noticeAt >= 0 &&
    (noticeAt === 0 || body[noticeAt - 1] === "\n") &&
    body.endsWith("\n") &&
    !body.slice(noticeAt, -1).includes("\n")
  ) {
    notice = body.slice(noticeAt, -1);
    body = body.slice(0, noticeAt);
  }
  return {
    body,
    notice,
    touched: touched.map((line) => line.slice("codex-subagents-for-claude-code-touched: ".length)),
    quota,
    footer: {
      status,
      run,
      turn: Number(turn),
      job,
      thread,
      model,
      effort,
      mode,
      duration,
      touched: Number(count),
      omitted: Number(omitted),
      request,
      branch,
      commit,
      keep,
      tokens,
      limit,
      file,
    },
  };
}

export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
