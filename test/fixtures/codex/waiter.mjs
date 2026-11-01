// A disposable foreground owner used only to prove detached driver survival.
import fs from "node:fs";
import path from "node:path";
import { spawnDriver } from "../../../src/codex/driver-client.mjs";
const { plan, stateDir } = JSON.parse(fs.readFileSync(process.env.FIXTURE_PLAN_FILE, "utf8"));
const d = await spawnDriver(plan, {
  stateDir,
  onIdentity: (worker) =>
    fs.writeFileSync(path.join(stateDir, "waiter-identity.json"), JSON.stringify(worker)),
});
process.stdout.write(JSON.stringify({ jobId: d.jobId, worker: d.worker }));
if (process.env.FIXTURE_WAITER_HANG) setInterval(() => {}, 1000);
