// A CLI maintenance command owns its probe. Its durable identity keeps a
// successor from resuming/closing the thread after the CLI dies first.
import { inspectAppServer } from "../codex/driver-client.mjs";
import { isGoneWorkerState } from "../shared/constants.mjs";

export function assertMaintenanceIdle(run, processes) {
  if (
    run.maintenanceWorker &&
    !isGoneWorkerState(inspectAppServer(run.maintenanceWorker, { processes }))
  )
    throw new Error("maintenance app-server is active or unconfirmed; state retained");
}

export function validMaintenanceWorker(worker) {
  return (
    worker === undefined ||
    (worker &&
      Number.isSafeInteger(worker.pid) &&
      worker.pid > 0 &&
      typeof worker.processStart === "string" &&
      worker.processStart.length > 0)
  );
}
