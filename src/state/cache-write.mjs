// A cache is best-effort, but an accepted update must not race another
// publisher's age check. Reuse identity-owned guards, including dead-owner
// recovery; contention skips this update without blocking task delivery.
import fs from "node:fs";
import path from "node:path";
import { holdGuard } from "./guards.mjs";
import { requireDirectory } from "../shared/io.mjs";
import { CODES } from "../shared/errors.mjs";

export function guardedCacheWrite(file, publish) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  requireDirectory(directory);
  let release;
  try {
    release = holdGuard(`${file}.guard`, "cache publisher is busy");
  } catch (error) {
    if (error.code === CODES.GUARD_BUSY) return false;
    throw error;
  }
  try {
    return publish();
  } finally {
    release();
  }
}
