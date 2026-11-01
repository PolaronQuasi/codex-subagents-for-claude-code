// Hold only this child's cache rename to exercise overlapping real writers.
import fs from "node:fs";
import path from "node:path";
import { writeModelCache } from "../../src/state/model-cache.mjs";
import { writeQuotaCache } from "../../src/state/quota-cache.mjs";

const [root, kind, encoded] = process.argv.slice(2);
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (path.basename(to) === `${kind}.json`) {
    fs.writeFileSync(path.join(root, "ready"), "");
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(root, "resume"))) {
      if (Date.now() > deadline) throw new Error("cache writer barrier timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return rename.call(this, from, to);
};
const write = kind === "models" ? writeModelCache : writeQuotaCache;
process.stdout.write(JSON.stringify(write(root, JSON.parse(encoded))));
