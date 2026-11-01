import { observeRun } from "./progress.mjs";
import { loadPrompt } from "../cli/task-input.mjs";
import { createDriverClient } from "../codex/driver-client.mjs";
import { createSteer, readDriver, readTurn } from "../state/job-store.mjs";
import { writeOutput } from "../shared/io.mjs";
import {
  DRIVER_IPC,
  DRIVER_PHASE,
  JOB_READ_POLICY,
  STEER_STATUS,
  STEER_REPLY_MS,
  STEER_TEXT,
} from "../shared/constants.mjs";
import { CODES, EXIT, RunnerError } from "../shared/errors.mjs";

export async function steerRun(options, { stateBase, cwd, stdout, signal, commandMs }) {
  const { run, stateDir } = observeRun(options.key, stateBase);
  const strict = { policy: JOB_READ_POLICY.STRICT };
  const record = readDriver(stateDir, run.jobId, strict);
  if (
    readTurn(stateDir, run.jobId, strict) ||
    record?.phase !== DRIVER_PHASE.RUNNING ||
    !record.turnId
  )
    throw new RunnerError(CODES.STEER_NOT_RUNNING, STEER_TEXT.INACTIVE);
  const client = createDriverClient(run, { stateDir });
  // Authenticate before creating a reservation; never start another driver.
  const status = await client.status();
  if (status.phase !== DRIVER_PHASE.RUNNING || status.turnId !== record.turnId)
    throw new RunnerError(CODES.STEER_TURN_CHANGED, STEER_TEXT.CHANGED);
  const { prompt } = loadPrompt(options, null, cwd);
  signal?.throwIfAborted();
  const n = createSteer(stateDir, record, prompt.toString("utf8"));
  let result;
  try {
    result = await client.request(DRIVER_IPC.STEER, { n }, STEER_REPLY_MS);
  } catch {
    throw new RunnerError(CODES.SUBMISSION_UNCERTAIN, STEER_TEXT.UNCERTAIN);
  }
  if (result.n !== n || result.status !== STEER_STATUS.ACCEPTED) {
    const refused = result.status === STEER_STATUS.REJECTED;
    throw new RunnerError(
      refused ? CODES.STEER_REJECTED : CODES.SUBMISSION_UNCERTAIN,
      refused ? STEER_TEXT.REJECTED : STEER_TEXT.UNCERTAIN,
    );
  }
  await writeOutput(
    stdout,
    `codex-subagents-for-claude-code-steer: run=${run.runKey} job=${run.jobId} n=${n} status=${STEER_STATUS.ACCEPTED}\n`,
    { signal, timeoutMs: commandMs },
  );
  return EXIT.COMPLETED;
}
