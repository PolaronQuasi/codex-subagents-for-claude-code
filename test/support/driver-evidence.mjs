import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

export async function until(read, message = "fixture evidence did not arrive", timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const value = read();
    if (value) return value;
    await delay(10);
  } while (performance.now() < deadline);
  assert.fail(message);
}

// Keep birth handles: a test can stop only children it actually started.
export function captureDrivers(t, onDriver = () => {}) {
  const spawn = childProcess.spawn,
    children = [];
  t.mock.method(childProcess, "spawn", (...args) => {
    const child = spawn(...args);
    if (args[1]?.[0]?.endsWith("driver.mjs")) {
      children.push(child);
      onDriver(child, args);
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return children;
}

export function clock(onSleep = () => {}) {
  let elapsed = Date.now();
  const waits = [];
  return {
    waits,
    now: () => elapsed,
    async sleep(ms, signal) {
      signal?.throwIfAborted();
      waits.push(ms);
      elapsed += ms;
      await onSleep(ms);
    },
  };
}
