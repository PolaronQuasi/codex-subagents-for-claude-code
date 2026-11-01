// Prompt inputs for this thread, used only for redaction, never stored in
// progress or diagnostics. Any unreadable input makes scrubbing fail closed.
import fs from "node:fs";
import path from "node:path";
import { PromptRedactor } from "../shared/prompt-redactor.mjs";
import { readLimited } from "../shared/io.mjs";
import { readDriver, readSteer } from "./job-store.mjs";
import {
  JOB_READ_POLICY,
  MAX_PROMPT_BYTES,
  PROMPT_REDACTION_MAX_HISTORY,
  STEER_MAX_COUNT,
  validJobId,
  FORK_REDACTION_FILE,
  PROMPT_REDACTION_MAX_FRAGMENTS,
} from "../shared/constants.mjs";

export function jobPromptRedactor(stateDir, driver, { prompt, marker } = {}) {
  const redactor = new PromptRedactor(marker);
  const addFile = (name) => {
    const file = path.join(stateDir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("unsafe prompt input");
    redactor.addPrompt(readLimited(file, MAX_PROMPT_BYTES).toString("utf8"));
  };
  const addSteers = (record) => {
    if (redactor.blocked) return;
    if (!record) throw new Error("missing prompt owner");
    const steers = record.steers ?? [];
    if (!Array.isArray(steers) || steers.length > STEER_MAX_COUNT)
      throw new Error("invalid steering inputs");
    for (const entry of steers) {
      if (redactor.blocked) break;
      redactor.addPrompt(readSteer(stateDir, record, entry.n).text);
    }
  };
  try {
    if (driver.forkRedaction) {
      const file = path.join(stateDir, FORK_REDACTION_FILE);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("unsafe inherited redaction input");
      const saved = JSON.parse(readLimited(file, MAX_PROMPT_BYTES).toString("utf8"));
      if (saved.blocked) redactor.withhold();
      else {
        if (
          !Array.isArray(saved.fragments) ||
          saved.fragments.length > PROMPT_REDACTION_MAX_FRAGMENTS ||
          saved.fragments.some((s) => typeof s !== "string")
        )
          throw new Error("invalid inherited redaction input");
        for (const fragment of saved.fragments) {
          redactor.addFragment(fragment);
          if (redactor.blocked) break;
        }
      }
    }
    if (prompt === undefined) addFile("prompt.txt");
    else redactor.addPrompt(prompt);
    const history = driver.redactionHistory ?? [];
    if (!Array.isArray(history) || history.length > PROMPT_REDACTION_MAX_HISTORY)
      throw new Error("too many prior inputs");
    addSteers(driver);
    for (const previous of history) {
      if (redactor.blocked) break;
      if (!Number.isSafeInteger(previous.turn) || previous.turn < 1 || !validJobId(previous.jobId))
        throw new Error("invalid prior input identity");
      addFile(`turn-${previous.turn}-prompt.txt`);
      addSteers(readDriver(stateDir, previous.jobId, { policy: JOB_READ_POLICY.STRICT }));
    }
  } catch {
    redactor.withhold();
  }
  return redactor;
}
