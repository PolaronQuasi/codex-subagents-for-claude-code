import { EXIT, SIGNALS } from "../shared/errors.mjs";
import { SECOND_MS, VERIFY_IPC } from "../shared/constants.mjs";
// Held group leader for one trusted-local verification. It stays alive after
// the command exits so the owner can drain the complete process group.
import { spawn } from "node:child_process";
let launched = false;
const hold = setInterval(() => {}, SECOND_MS);
process.on("message", (message) => {
  if (launched || message?.kind !== VERIFY_IPC.START) return;
  launched = true;
  const child = spawn(message.executable, message.args, {
    cwd: message.cwd,
    env: message.env,
    shell: false,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.on("error", (error) => process.send?.({ kind: VERIFY_IPC.ERROR, message: error.message }));
  child.on("exit", (code, signal) => process.send?.({ kind: VERIFY_IPC.EXIT, code, signal }));
});
process.on("disconnect", () => {
  clearInterval(hold);
  // Parent loss must not leave the trusted-local command running indefinitely.
  // This worker is created as its own group leader before receiving any task.
  try {
    process.kill(-process.pid, SIGNALS.SIGKILL);
  } catch {
    process.exit(EXIT.FAILURE);
  }
});
