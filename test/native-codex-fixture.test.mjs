import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fixture } from "./support/codex-fixture.mjs";

test("native fake delivers initialize while stdin remains open and exits on EOF", async (t) => {
  const f = fixture(t);
  const child = spawn(f.executable, ["app-server", "--listen", "stdio://"], {
    cwd: f.work,
    env: f.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  f.trackChild(child);
  const lines = createInterface({ input: child.stdout });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  t.after(() => clearTimeout(timeout));
  const response = once(lines, "line", { signal: controller.signal });
  child.stdin.write(
    `${JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "fixture-test", version: "1" } },
    })}\n`,
  );
  const [line] = await response;
  const message = JSON.parse(line);
  assert.equal(message.id, 1);
  assert.ok(message.result);
  assert.equal(child.stdin.writableEnded, false);
  const closed = once(child, "close", { signal: controller.signal });
  child.stdin.end();
  assert.deepEqual(await closed, [0, null]);
});
