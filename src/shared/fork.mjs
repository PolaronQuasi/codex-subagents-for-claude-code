import { FORK_STATE } from "./constants.mjs";
export const isForkSeed = (run) =>
  Boolean(
    run.forkSeed &&
    run.forkState === FORK_STATE.READY &&
    run.contextThreadId &&
    !run.jobId &&
    !run.result,
  );
export const forkReceipt = (run) =>
  `codex-subagents-for-claude-code-fork: run=${run.runKey} thread=${run.contextThreadId ?? "-"} from=${run.forkedFrom.runKey} state=${run.forkState} at=${run.forkedFrom.at}. No model turn sent; use --continue ${run.runKey} --prompt-file FILE.\n`;
