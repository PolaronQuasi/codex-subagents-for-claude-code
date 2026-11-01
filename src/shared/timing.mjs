// Policy clocks can be injected through main's IO. Persisted timestamps and
// subprocess, socket and output deadlines always keep their real clocks.
import { setTimeout as delay } from "node:timers/promises";

export const REAL_TIMING = Object.freeze({
  now: () => performance.now(),
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
});
