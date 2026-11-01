import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import test from "node:test";
import { readStdin } from "../src/cli/stdin.mjs";
import { MAX_PROMPT_BYTES } from "../src/shared/constants.mjs";
import { fixture } from "./support/codex-fixture.mjs";
import { gitDiagnostics } from "../src/shared/workspace.mjs";
import { gitInit, gitOut } from "./support/git-repos.mjs";

test("task continuations inherit model/effort without a role and accept explicit model selection", async (t) => {
  const f = fixture(t);
  const launch = await f.invoke(["--role", "gpt-6-sol", "--task-file", "-", "--wait-ms", "10000"], {
    stdin: Readable.from(["keep: yes\neffort: low\n\nRemember this."]),
  });
  assert.equal(launch.code, 0, launch.stderr);
  const run = f.metadata();
  for (const [role, header, model, effort] of [
    [null, "", "gpt-6-sol", "low"],
    ["gpt-6-1-sol", "", "gpt-6.1-sol", "low"],
    ["gpt-6-1-sol", "model: gpt-5-6-sol\neffort: high\n", "gpt-5.6-sol", "high"],
  ]) {
    const result = await f.invoke(
      ["--task-file", "-", "--wait-ms", "10000", ...(role ? ["--role", role] : [])],
      {
        stdin: Readable.from([`continue: ${run.runKey}\n${header}\nFollow up.`]),
      },
    );
    assert.equal(result.code, 0, result.stderr);
    const sent = f
      .events()
      .filter((e) => e.direction === "in" && e.method === "turn/start")
      .at(-1);
    assert.equal(sent.params.model, model);
    assert.equal(sent.params.effort, effort);
    assert.equal(sent.params.threadId, run.result.threadId);
  }
});

test("role-free task validation distinguishes an unknown continuation from an incomplete launch", async (t) => {
  const f = fixture(t),
    key = "b".repeat(32);
  const unknown = await f.invoke(["--task-file", "-"], {
    stdin: Readable.from([`continue: ${key}\n\nFollow up.`]),
  });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, new RegExp(`unknown run ${key}; use --list --mine`));
  const launch = await f.invoke(["--task-file", "-"], { stdin: Readable.from(["A new task."]) });
  assert.equal(launch.code, 1);
  assert.match(launch.stderr, /--role ROLE.*continue: RUN_KEY/);
  assert.deepEqual(f.runs(), []);
});

test("stdin rejects invalid UTF-8, overflow, unfinished streams and cancellation", async () => {
  await assert.rejects(
    readStdin(Readable.from([Buffer.from([255])]), { timeoutMs: 1000 }),
    /UTF-8/,
  );
  await assert.rejects(
    readStdin(Readable.from([Buffer.alloc(MAX_PROMPT_BYTES + 1)]), { timeoutMs: 1000 }),
    /8 MiB/,
  );
  await assert.rejects(readStdin(new PassThrough(), { timeoutMs: 10 }), /timed out/);
  const controller = new AbortController(),
    promise = readStdin(new PassThrough(), { timeoutMs: 1000, signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, /abort/i);
});

test("stdin task and prompt inputs launch once without deleting a file named dash", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.work, "-"), "untouched");
  const first = await f.invoke(["--role", "gpt-6-sol", "--task-file", "-", "--wait-ms", "10000"], {
    stdin: Readable.from(["keep: yes\n\nRead this task from stdin"]),
  });
  assert.equal(first.code, 0, first.stderr);
  const run = f.metadata();
  assert.equal(
    fs.readFileSync(path.join(f.state, run.runKey, "prompt.txt"), "utf8"),
    "Read this task from stdin",
  );
  const second = await f.invoke(
    ["--continue", run.runKey, "--prompt-file", "-", "--wait-ms", "10000"],
    { stdin: Readable.from(["Follow up"]) },
  );
  assert.equal(second.code, 0, second.stderr);
  assert.equal(fs.readFileSync(path.join(f.work, "-"), "utf8"), "untouched");
  assert.equal(
    f.events().filter((e) => e.direction === "in" && e.method === "turn/start").length,
    2,
  );
});

test("Git identity diagnostics honor caller author overrides and never edit configuration", async (t) => {
  const f = fixture(t);
  await gitInit(f.work);
  const before = await gitOut(["config", "--local", "--list"], f.work);
  const result = await gitDiagnostics(f.work, {
    env: { ...f.env, GIT_AUTHOR_NAME: "Explicit Author", GIT_AUTHOR_EMAIL: "author@sample.test" },
  });
  assert.equal(result["git-author"], "Explicit Author <author@sample.test>");
  assert.equal(await gitOut(["config", "--local", "--list"], f.work), before);
});
