import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fitOutput, truncateOutput } from "../src/index.mjs";
import { findResultsByRequestId, resultFileName, renderFooter } from "../src/delivery/output.mjs";
import { REQUEST_DIGEST_VERSION } from "../src/shared/constants.mjs";

import { delivered } from "./support/capture.mjs";
import { TEXT, LAUNCH, fixture } from "./support/runner-fixture.mjs";
import { workspace } from "./support/workspace-fixture.mjs";
import { ERRNO, EXIT } from "../src/shared/errors.mjs";

test("delivery persists its durable milestone before the first stdout byte", async (t) => {
  const f = fixture(t);
  let writes = 0;
  const stdout = new Writable({
    write(chunk, encoding, callback) {
      try {
        const run = f.metadata();
        assert.ok(run.result.durableSavedAt);
        assert.equal(run.result.acknowledgedAt, undefined);
        assert.ok(fs.readFileSync(run.result.resultFile, "utf8").startsWith(TEXT));
        writes++;
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
  const result = await f.invoke(LAUNCH, { stdout });
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  assert.ok(writes > 0);
});

test("the footer and durable copy describe the delivered job", async (t) => {
  const f = fixture(t, {
    storedJob: {
      threadId: "thread-abc",
      startedAt: "2026-10-22T10:00:00.000Z",
      completedAt: "2026-10-22T10:00:31.400Z",
      result: { touchedFiles: ["src/a.ts", { path: "src/b.ts" }, 7, "bad\nname"] },
    },
  });
  const result = await f.invoke([...LAUNCH, "--write"]);
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  const { body, footer, touched } = delivered(result.stdout);
  assert.equal(body, TEXT);
  assert.deepEqual(touched, ["src/a.ts", "src/b.ts", "bad?name"]);
  assert.match(footer.run, /^[0-9a-f]{32}$/);
  assert.deepEqual(footer, {
    status: "completed",
    run: footer.run,
    turn: 1,
    job: footer.job,
    thread: "thread-abc",
    model: "gpt-6.1-sol",
    effort: "xhigh",
    mode: "workspace-write",
    duration: "31s",
    touched: 3,
    omitted: 0,
    request: "-",
    branch: "-",
    commit: "-",
    keep: "no",
    tokens: "-",
    limit: "-",
    file: footer.file,
  });
  assert.equal(path.dirname(footer.file), f.resultsDir);
  assert.match(path.basename(footer.file), /^\d{8}T\d{6}Z-gpt-6\.1-sol-task-[0-9a-f]+\.md$/);
  assert.deepEqual(f.results(), [path.basename(footer.file)]);
  assert.equal(fs.readFileSync(footer.file, "utf8"), result.stdout);
  assert.deepEqual(f.runs(), []);
});

test("a re-delivered cached result reuses its durable copy", async (t) => {
  const f = fixture(t, {});
  const first = await f.invoke([...LAUNCH, "--keep-state"]);
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  const file = delivered(first.stdout).footer.file;
  assert.equal(f.metadata().result.resultFile, file);
  f.configure({});
  const next = await f.invoke(f.resume());
  assert.equal(next.code, EXIT.COMPLETED, next.stderr);
  assert.equal(delivered(next.stdout).footer.file, file);
  assert.equal(next.stdout, first.stdout);
  assert.deepEqual(f.results(), [path.basename(file)]);
  assert.equal(fs.readFileSync(file, "utf8"), next.stdout);
  assert.equal(f.runs().length, 1);
});

test("a failed durable write can recover in a different results directory", async (t) => {
  const f = fixture(t);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (path.dirname(to) === f.resultsDir && to.endsWith(".md"))
      throw Object.assign(new Error("result volume is full"), { code: ERRNO.ENOSPC });
    return rename(from, to);
  });
  const first = await f.invoke([...LAUNCH, "--keep-state"]);
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  assert.match(first.stderr, /Could not write the durable result copy/);
  const key = f.runs()[0];
  assert.equal(f.metadata(key).result.resultFile, undefined, "no failed path is persisted");
  assert.equal(f.metadata(key).result.durableSavedAt, undefined);
  const resultsDir = path.join(f.root, "replacement-results");
  const recovered = await f.invoke(f.resume(), {
    env: { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: resultsDir },
  });
  assert.equal(recovered.code, EXIT.COMPLETED, recovered.stderr);
  assert.doesNotMatch(recovered.stderr, /Could not write the durable result copy/);
  const file = delivered(recovered.stdout).footer.file;
  assert.equal(path.dirname(file), resultsDir);
  assert.ok(fs.readFileSync(file, "utf8").startsWith(TEXT));
  assert.ok(f.metadata(key).result.durableSavedAt);
});

test("current durable copies keep their recorded destination and recreate missing bytes there", async (t) => {
  for (const prior of ["missing", "existing"]) {
    const f = fixture(t);
    assert.equal((await f.invoke([...LAUNCH, "--keep-state"])).code, EXIT.COMPLETED);
    const key = f.runs()[0];
    const record = f.metadata(key);
    const original = record.result.resultFile;
    assert.ok(record.result.durableSavedAt);
    if (prior === "missing") fs.unlinkSync(original);
    fs.writeFileSync(path.join(f.state, key, "run.json"), JSON.stringify(record));
    const resultsDir = path.join(f.root, "replacement-results");
    const recovered = await f.invoke(f.resume(), {
      env: { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: resultsDir },
    });
    assert.equal(recovered.code, EXIT.COMPLETED, recovered.stderr);
    assert.doesNotMatch(recovered.stderr, /Could not write the durable result copy/);
    const file = delivered(recovered.stdout).footer.file;
    assert.equal(file, original);
    assert.ok(fs.readFileSync(file, "utf8").startsWith(TEXT));
  }
});

test("broken stdout preserves the result and skips teardown", async (t) => {
  const f = fixture(t);
  const broken = new Writable({
    write(chunk, encoding, cb) {
      cb(Object.assign(new Error("broken pipe"), { code: ERRNO.EPIPE }));
    },
  });
  const first = await f.invoke(LAUNCH, { stdout: broken });
  assert.equal(first.code, EXIT.FAILURE);
  assert.match(first.stderr, /broken pipe/);
  assert.equal(
    f.events().some((e) => e.command === "cleanup"),
    false,
  );
  assert.equal(f.metadata().result.status, "completed");
  assert.equal(f.results().length, 1, "the durable copy is written before stdout");
  assert.equal(delivered((await f.invoke(f.resume())).stdout).body, TEXT);
});

test("cached output tampering refuses cleanup", async (t) => {
  const f = fixture(t, { retainForTest: true });
  await f.invoke([...LAUNCH, "--keep-state"]);
  fs.writeFileSync(path.join(f.state, f.runs()[0], "result.txt"), "corrupted");
  const next = await f.invoke(f.resume());
  assert.equal(next.code, EXIT.FAILURE);
  assert.match(next.stderr, /checksum mismatch/);
  assert.equal(f.runs().length, 1);
});

test("stalled stdout is bounded and retains a recoverable result", async (t) => {
  const f = fixture(t);
  // Prepare a cached result with the normal helper budget. The short deadline
  // below must exercise stdout, not the host's Node subprocess startup speed.
  const disconnected = new Writable({
    write(chunk, encoding, callback) {
      callback(new Error("disconnected"));
    },
  });
  assert.equal((await f.invoke(LAUNCH, { stdout: disconnected })).code, EXIT.FAILURE);
  assert.ok(f.metadata().result.cachedAt);
  assert.equal(f.metadata().result.acknowledgedAt, undefined);
  const blocked = new Writable({ write() {} });
  const result = await f.invoke(f.resume(["--command-timeout-ms", "300"]), { stdout: blocked });
  assert.equal(result.code, EXIT.FAILURE, result.stderr);
  assert.match(result.stderr, /output write timed out/);
  assert.equal(f.metadata().result.status, "completed");
  assert.equal(
    f.events().some((e) => e.command === "cleanup"),
    false,
  );
  assert.equal(delivered((await f.invoke(f.resume())).stdout).body, TEXT);
});

test("abort interrupts stdout backpressure without deleting a result", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const blocked = new Writable({
    write() {
      setImmediate(() => controller.abort(new Error("stop output")));
    },
  });
  const result = await f.invoke(LAUNCH, { stdout: blocked, signal: controller.signal });
  assert.equal(result.code, EXIT.FAILURE, result.stderr);
  assert.match(result.stderr, /stop output/);
  assert.equal(f.metadata().result.status, "completed");
  assert.equal(
    f.events().some((e) => e.command === "cleanup"),
    false,
  );
});

test("quiet is inherited by attach and still reports a durable-copy warning", async (t) => {
  const f = fixture(t);
  const env = { ...f.env, CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: f.controlFile };
  const first = await f.invoke([...LAUNCH, "--quiet", "--keep-state"], { env });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /Could not write the durable result copy/);
  assert.doesNotMatch(first.stderr, /Recover this run with/);
  assert.equal(f.metadata().quiet, true);
  const next = await f.invoke(f.resume());
  assert.equal(next.code, 0, next.stderr);
  assert.equal(next.stderr, "");
});

test("max-stdout-lines truncates stdout only, names the omission, and keeps the durable copy complete", async (t) => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}\n`).join("");
  const f = fixture(t, { result: lines, retainForTest: true });
  const first = await f.invoke([...LAUNCH, "--max-stdout-lines", "10"]);
  assert.equal(first.code, EXIT.COMPLETED, first.stderr);
  const { body, notice, footer } = delivered(first.stdout);
  assert.equal(body, lines.split("\n").slice(0, 10).join("\n") + "\n");
  assert.equal(
    notice,
    `codex-subagents-for-claude-code-omitted: 40 lines not shown; full text in ${footer.file}`,
  );
  assert.equal(footer.omitted, 40);
  const copy = delivered(fs.readFileSync(footer.file, "utf8"));
  assert.deepEqual(
    [copy.body, copy.notice, copy.footer.omitted],
    [lines, null, 0],
    "the durable copy is complete and says so",
  );
  assert.equal(f.metadata().maxStdoutLines, 10);
  f.configure({ retainForTest: false });
  const next = await f.invoke(f.resume());
  assert.equal(next.code, EXIT.COMPLETED, next.stderr);
  assert.equal(delivered(next.stdout).footer.omitted, 40, "re-delivery inherits the limit");
  assert.equal((await f.invoke(["--close", f.metadata().runKey])).code, 0);
  assert.deepEqual(f.runs(), []);
});

test("max-stdout-lines 0, an exact fit, and a missing durable copy leave the result untouched", async (t) => {
  const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}\n`).join("");
  const f = fixture(t, { result: lines });
  const exact = await f.invoke([...LAUNCH, "--max-stdout-lines", "5"]);
  assert.equal(exact.code, EXIT.COMPLETED, exact.stderr);
  let shown = delivered(exact.stdout);
  assert.deepEqual([shown.body, shown.notice, shown.footer.omitted], [lines, null, 0]);
  fs.writeFileSync(path.join(f.work, "prompt.md"), "again");
  const unlimited = await f.invoke([...LAUNCH, "--max-stdout-lines", "0"]);
  assert.equal(unlimited.code, EXIT.COMPLETED, unlimited.stderr);
  shown = delivered(unlimited.stdout);
  assert.deepEqual([shown.body, shown.notice, shown.footer.omitted], [lines, null, 0]);
  fs.writeFileSync(path.join(f.work, "prompt.md"), "again");
  const unsaved = await f.invoke([...LAUNCH, "--max-stdout-lines", "2"], {
    env: {
      ...f.env,
      CODEX_SUBAGENTS_FOR_CLAUDE_CODE_RESULTS_DIR: path.join(f.root, "control.json"),
    },
  });
  assert.equal(unsaved.code, EXIT.COMPLETED, unsaved.stderr);
  shown = delivered(unsaved.stdout);
  assert.deepEqual(
    [shown.body, shown.notice, shown.footer.omitted, shown.footer.file],
    [lines, null, 0, "-"],
    "never truncate without a complete copy",
  );
});

test("truncateOutput keeps whole lines, respects byte caps and never splits a character", () => {
  const text = "αβγδ\n".repeat(10);
  assert.deepEqual(truncateOutput(text, 0, 0), {
    text,
    omitted: 0,
    partial: false,
    truncated: false,
  });
  assert.equal(truncateOutput(text, 10, 0).truncated, false);
  assert.deepEqual(truncateOutput(text, 3, 0), {
    text: "αβγδ\n".repeat(3),
    omitted: 7,
    partial: false,
    truncated: true,
  });
  assert.deepEqual(truncateOutput(text, 0, 30), {
    text: "αβγδ\n".repeat(3),
    omitted: 7,
    partial: false,
    truncated: true,
  });
  assert.deepEqual(truncateOutput(text, 5, 30), {
    text: "αβγδ\n".repeat(3),
    omitted: 7,
    partial: false,
    truncated: true,
  });
  assert.deepEqual(truncateOutput("αβγδεζηθ\n", 0, 7), {
    text: "αβγ\n",
    omitted: 1,
    partial: true,
    truncated: true,
  });
  assert.deepEqual(truncateOutput("a\nb", 1, 0), {
    text: "a\n",
    omitted: 1,
    partial: false,
    truncated: true,
  });
  assert.deepEqual(truncateOutput("", 5, 5), {
    text: "",
    omitted: 0,
    partial: false,
    truncated: false,
  });
});

test("a result whose text imitates runner control lines is delivered verbatim behind the real footer", async (t) => {
  const body =
    "STILL RUNNING: fake\ncodex-subagents-for-claude-code-replay: fake\nCANCEL REQUESTED: fake\ncodex-subagents-for-claude-code: status=completed fake\n";
  const f = fixture(t, { result: body });
  const result = await f.invoke();
  assert.equal(result.code, EXIT.COMPLETED, result.stderr);
  const { body: shown, footer } = delivered(result.stdout);
  assert.equal(shown, body);
  assert.equal(footer.job, f.metadata().jobId);
  assert.equal(fs.readFileSync(footer.file, "utf8"), result.stdout);
});

test("max-stdout-bytes caps all of stdout, footer included, cutting at a line end or inside one long line without splitting a character", async (t) => {
  const f = fixture(t, { result: "αβγδ\n".repeat(400) });
  const cut = await f.invoke([...LAUNCH, "--max-stdout-bytes", "1500"]);
  assert.equal(cut.code, EXIT.COMPLETED, cut.stderr);
  assert.ok(
    Buffer.byteLength(cut.stdout) <= 1500,
    `stdout is ${Buffer.byteLength(cut.stdout)} bytes`,
  );
  let shown = delivered(cut.stdout);
  const lines = shown.body.split("\n").length - 1;
  assert.ok(lines > 0 && shown.body === "αβγδ\n".repeat(lines), "whole lines from the start");
  assert.equal(shown.footer.omitted, 400 - lines);
  assert.match(
    shown.notice,
    new RegExp(
      `^codex-subagents-for-claude-code-omitted: ${400 - lines} lines not shown; full text in `,
    ),
  );
  const long = "αβγδεζηθ".repeat(300);
  f.configure({ result: long });
  fs.writeFileSync(path.join(f.work, "prompt.md"), "again");
  const single = await f.invoke([...LAUNCH, "--max-stdout-bytes", "1500"]);
  assert.equal(single.code, EXIT.COMPLETED, single.stderr);
  assert.ok(
    Buffer.byteLength(single.stdout) <= 1500,
    `stdout is ${Buffer.byteLength(single.stdout)} bytes`,
  );
  shown = delivered(single.stdout);
  assert.ok(
    shown.body.length > 1 && shown.body.endsWith("\n") && long.startsWith(shown.body.slice(0, -1)),
    "a prefix cut at a character boundary",
  );
  assert.equal(shown.footer.omitted, 1);
  assert.match(
    shown.notice,
    /^codex-subagents-for-claude-code-omitted: 1 lines not shown \(the last shown line is cut\); full text in /,
  );
  assert.equal(delivered(fs.readFileSync(shown.footer.file, "utf8")).body, `${long}\n`);
  fs.writeFileSync(path.join(f.work, "prompt.md"), "third");
  const tiny = await f.invoke([...LAUNCH, "--max-stdout-bytes", "10"]);
  assert.equal(tiny.code, EXIT.COMPLETED, tiny.stderr);
  shown = delivered(tiny.stdout);
  assert.deepEqual(
    [shown.body, shown.footer.omitted],
    ["", 1],
    "a cap the footer alone exceeds shows no text, and the whole footer",
  );
});

test("fitOutput keeps the footer and omission line whole and the total within the byte cap", () => {
  const footer = (omitted) =>
    `codex-subagents-for-claude-code: status=completed omitted=${omitted} result=/r\n`;
  const text = "line\n".repeat(200);
  assert.equal(fitOutput(text, { footer, resultFile: "/r" }), text + footer(0));
  assert.equal(
    fitOutput(text, { footer, maxBytes: 5000, resultFile: "/r" }),
    text + footer(0),
    "a fit is not cut",
  );
  for (const cap of [200, 400, 999]) {
    const out = fitOutput(text, { footer, maxBytes: cap, resultFile: "/r" });
    const omitted = Number(/omitted=(\d+)/.exec(out)[1]);
    assert.ok(Buffer.byteLength(out) <= cap, `${cap}: ${Buffer.byteLength(out)}`);
    assert.equal(
      out,
      "line\n".repeat(200 - omitted) +
        `codex-subagents-for-claude-code-omitted: ${omitted} lines not shown; full text in /r\n` +
        footer(omitted),
    );
  }
  assert.equal(
    fitOutput(text, { footer, maxBytes: 10, resultFile: "/r" }),
    `codex-subagents-for-claude-code-omitted: 200 lines not shown; full text in /r\n${footer(200)}`,
    "a cap below the footer shows no text",
  );
  assert.equal(
    fitOutput(text, { footer, maxBytes: 10 }),
    text + footer(0),
    "never cut without a durable copy",
  );
  const prefixed = fitOutput(text, {
    footer,
    maxBytes: 300,
    resultFile: "/r",
    prefix: "codex-subagents-for-claude-code-replay: x\n",
  });
  assert.ok(
    prefixed.startsWith("codex-subagents-for-claude-code-replay: x\nline\n") &&
      Buffer.byteLength(prefixed) <= 300,
    prefixed,
  );
  assert.equal(
    fitOutput(text, { footer, maxLines: 2, resultFile: "/r" }),
    `line\nline\ncodex-subagents-for-claude-code-omitted: 198 lines not shown; full text in /r\n${footer(198)}`,
  );
});

test("relay exits 0 for failed and cancelled results, is recorded, and is inherited by a later attach", async (t) => {
  const f = fixture(t, { status: "failed" });
  const failed = await f.invoke([...LAUNCH, "--relay"]);
  assert.equal(failed.code, EXIT.COMPLETED, failed.stderr);
  assert.equal(delivered(failed.stdout).footer.status, "failed");
  fs.writeFileSync(path.join(f.work, "prompt.md"), "again");
  assert.equal(
    (await f.invoke(LAUNCH)).code,
    EXIT.NOT_COMPLETED,
    "without --relay a failure still exits 2",
  );
  f.configure({ status: "running" });
  fs.writeFileSync(path.join(f.work, "prompt.md"), "third");
  assert.equal(
    (await f.invoke([...LAUNCH, "--relay"])).code,
    EXIT.STILL_RUNNING,
    "a running job still exits 3",
  );
  const key = f.runs()[0];
  assert.equal(f.metadata(key).relay, true);
  const later = await f.invoke(["--cancel", key]);
  assert.equal(later.code, EXIT.COMPLETED, later.stderr);
  assert.equal(delivered(later.stdout).footer.status, "cancelled");
  assert.deepEqual(f.runs(), []);
});

test("current durable-copy markers and full digests round-trip between writer and reader", (t) => {
  const { resultsDir } = workspace(t);
  const digest = "f".repeat(64);
  const run = {
    model: "gpt-6.1-sol",
    runKey: "a".repeat(32),
    jobId: "task-f",
    requestId: "same",
    requestDigest: digest,
    requestDigestVersion: REQUEST_DIGEST_VERSION,
    result: { status: "completed" },
  };
  const written = resultFileName(run),
    file = path.join(resultsDir, written);
  fs.writeFileSync(file, `answer\n${renderFooter(run, file)}`);
  assert.deepEqual(findResultsByRequestId(resultsDir, "same"), [
    { file: path.join(resultsDir, written), digest, version: REQUEST_DIGEST_VERSION },
  ]);
  assert.deepEqual(findResultsByRequestId(resultsDir, "other"), []);
});

test("receipt lookup uses the complete request identity across h2 and rq delimiter lookalikes", (t) => {
  const { resultsDir } = workspace(t);
  const digest = "b".repeat(64),
    own = [];
  for (const requestId of [
    "alpha-h2",
    "prefix-rq-alpha",
    "alpha-h10",
    "alpha-h2-h2",
    "alpha-h3",
    "alpha-h3-h2",
    "alpha",
  ]) {
    const run = {
      runKey: "c".repeat(32),
      jobId: "task-current",
      model: "gpt-6-astra",
      effort: "max",
      requestId,
      requestDigest: digest,
      requestDigestVersion: REQUEST_DIGEST_VERSION,
      result: { status: "completed" },
    };
    const file = path.join(resultsDir, resultFileName(run));
    fs.writeFileSync(file, `current result\n${renderFooter(run, file)}`);
    if (requestId === "alpha") own.push({ file, digest, version: REQUEST_DIGEST_VERSION });
    assert.deepEqual(findResultsByRequestId(resultsDir, "alpha"), own);
    assert.deepEqual(findResultsByRequestId(resultsDir, requestId), [
      { file, digest, version: REQUEST_DIGEST_VERSION },
    ]);
  }
  const bad = path.join(resultsDir, "task-current-rq-alpha-h10-" + digest + ".md");
  fs.writeFileSync(bad, "unsupported same-request receipt\n");
  assert.throws(() => findResultsByRequestId(resultsDir, "alpha"), /unsupported digest copy/);
  assert.equal(
    findResultsByRequestId(resultsDir, "alpha-h2").length,
    1,
    "another request remains unambiguous",
  );
});

test("unsupported digest markers cannot be mistaken for current request identities", (t) => {
  const { resultsDir } = workspace(t);
  for (const marker of ["h10-", "h123-", "h", "h2-"]) {
    const file = path.join(
      resultsDir,
      `task-a-rq-same-${marker}${"a".repeat(marker === "h2-" ? 8 : 64)}.md`,
    );
    fs.writeFileSync(file, "answer\n");
    assert.throws(() => findResultsByRequestId(resultsDir, "same"), /unsupported digest copy/);
    fs.unlinkSync(file);
  }
});
