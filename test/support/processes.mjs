// The disposable processes the tests start, and how a test is rid of one: by
// its own exit, or killed only as the process it was started as.
import { setTimeout as delay } from "node:timers/promises";
import { SIGNALS } from "../../src/shared/errors.mjs";
import { START_RETRY_MS } from "../../src/shared/constants.mjs";
import { alive } from "../../src/shared/io.mjs";
import { processStart } from "../../src/shared/process-identity.mjs";

// Whether pid's process still runs, as the runner decides it: a Linux zombie,
// which a container that reaps nothing keeps, does not.
export const isAlive = (pid) => alive(pid);

// Waits waitMs for a disposable process whose control file is gone to end. One
// still alive afterwards is killed only while its PID provably holds the same
// process: start, read when it was launched, still equals its OS start time,
// asked once more with a longer timeout when a busy host gives no answer. A
// PID that cannot be proved is never killed: it gets graceMs more to end on
// its own, and only one that still runs then is reported, through warn.
// Returns "ended", "killed" or "unproved".
export async function retire(
  { pid, start },
  { waitMs = 5000, graceMs = 5000, warn = (message) => process.emitWarning(message) } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "ended";
  const gone = async (ms) => {
    const deadline = Date.now() + ms;
    while (isAlive(pid)) {
      if (Date.now() >= deadline) return false;
      await delay(20);
    }
    return true;
  };
  if (await gone(waitMs)) return "ended";
  let now = processStart(pid);
  if (now === null && isAlive(pid)) now = processStart(pid, { timeoutMs: START_RETRY_MS });
  // It may have ended while it was asked about.
  if (!isAlive(pid)) return "ended";
  if (typeof start === "string" && now === start) {
    process.kill(pid, SIGNALS.SIGKILL);
    await gone(3000);
    return "killed";
  }
  if (await gone(graceMs)) return "ended";
  warn(`fixture process ${pid} did not end and could not be identified; left alone`);
  return "unproved";
}
