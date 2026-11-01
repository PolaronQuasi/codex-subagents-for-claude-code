import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { alive, runProcess } from "../src/shared/io.mjs";
import { stopPosixTree } from "../src/shared/process-stop.mjs";
import { PLATFORM, STOP_OUTCOME } from "../src/shared/constants.mjs";
import { ERRNO } from "../src/shared/errors.mjs";
import { createScratch } from "../tools/scratch.mjs";

const mac = (query) => ({ platform: PLATFORM.DARWIN, query });

test("macOS liveness recognizes zombies despite a successful zero signal", () => {
  for (const state of ["Z", "Z+", "Zs"])
    assert.equal(
      alive(
        process.pid,
        mac((_command, _args, options) => {
          assert.ok(Number.isFinite(options.timeout) && options.timeout > 0);
          return { status: 0, stdout: ` ${state}\n` };
        }),
      ),
      false,
      state,
    );
  for (const state of ["R", "S+", "T", "I", "X"])
    assert.equal(
      alive(
        process.pid,
        mac(() => ({ status: 0, stdout: state })),
      ),
      true,
      state,
    );
});

test("macOS liveness retains ownership when its state query fails or is ambiguous", () => {
  for (const result of [
    { status: 1, stdout: "Z" },
    { status: 0, error: new Error("query timed out"), stdout: "Z" },
    { status: 0, stdout: "" },
    { status: 0, stdout: "Z\nS" },
    { status: 0, stdout: "?" },
  ])
    assert.equal(
      alive(
        process.pid,
        mac(() => result),
      ),
      true,
    );
  assert.equal(
    alive(
      process.pid,
      mac(() => {
        throw Object.assign(new Error("query denied"), { code: ERRNO.EACCES });
      }),
    ),
    true,
  );
});

test("an already exited macOS root needs no descendant capture or signal", async () => {
  const result = await stopPosixTree(
    { pid: process.pid, start: "owned birth" },
    {
      alive: (pid) =>
        alive(
          pid,
          mac(() => ({ status: 0, stdout: "Z" })),
        ),
      start: () => assert.fail("an exited root needs no birth probe"),
      descendants: () => assert.fail("an exited root cannot supply a live tree"),
      kill: () => assert.fail("a zombie is never signalled"),
    },
  );
  assert.equal(result.state, STOP_OUTCOME.GONE);
});

test(
  "native macOS liveness recognizes an owned zombie before its parent reaps it",
  {
    skip: process.platform !== PLATFORM.DARWIN && "native macOS ps state",
    timeout: 30_000,
  },
  async (t) => {
    const scratch = createScratch("codex-zombie-test-");
    let helper, exited;
    t.after(async () => {
      try {
        if (helper) {
          helper.stdin.end();
          assert.equal(await exited, 0);
        }
      } finally {
        scratch.remove();
      }
    });
    const executable = path.join(scratch.directory, "zombie-parent");
    const compiled = await runProcess(
      "cc",
      [fileURLToPath(new URL("./fixtures/zombie.c", import.meta.url)), "-o", executable],
      { timeoutMs: 15_000 },
    );
    assert.equal(compiled.status, 0, compiled.error?.message ?? compiled.stderr);
    helper = spawn(executable, [], { stdio: ["pipe", "pipe", "ignore"] });
    helper.stdin.on("error", () => {});
    exited = new Promise((resolve, reject) => {
      helper.once("exit", resolve);
      helper.once("error", reject);
    });
    exited.catch(() => {});
    const pid = await new Promise((resolve, reject) => {
      let output = "";
      helper.once("error", reject);
      helper.stdout.on("data", (data) => {
        output += data;
        if (/^[1-9]\d*\n$/.test(output)) resolve(Number(output));
      });
      helper.stdout.once("end", () => reject(new Error("fixture omitted its child PID")));
    });
    assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== helper.pid);
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await delay(25);
    assert.equal(alive(pid), false, "the exited child executes no work while awaiting waitpid");
    assert.equal(helper.exitCode, null, "its owned parent has not reaped it yet");
  },
);
