// The command-line wrapper: SIGINT/SIGTERM stop the waiter with exit 130/143
// and keep the detached job; a closed stdout or stderr aborts the same way.
// script is the stable entry path the printed commands name.

import { main } from "./main.mjs";
import { EXIT, SIGNALS } from "../shared/errors.mjs";

export async function runCli(script) {
  const controller = new AbortController();
  let interrupted = 0;
  const onSignal = (name) => {
    interrupted = name === SIGNALS.SIGINT ? EXIT.SIGINT : EXIT.SIGTERM;
    controller.abort(new Error(`${name}: stopped waiting; the detached Codex job is retained`));
  };
  const onOutputError = (error) => controller.abort(error);
  process.on(SIGNALS.SIGINT, onSignal);
  process.on(SIGNALS.SIGTERM, onSignal);
  process.stdout.on("error", onOutputError);
  process.stderr.on("error", onOutputError);
  try {
    process.exitCode = await main(undefined, { signal: controller.signal, script });
  } catch {
    process.exitCode = EXIT.FAILURE;
  } finally {
    // stderr itself may be closed.
    process.off(SIGNALS.SIGINT, onSignal);
    process.off(SIGNALS.SIGTERM, onSignal);
    if (interrupted) process.exitCode = interrupted;
  }
}
