import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fixture } from "./support/codex-fixture.mjs";
import { writeModelCache, readModelCache } from "../src/state/model-cache.mjs";
import { writeQuotaCache, readQuotaCache } from "../src/state/quota-cache.mjs";

const earlier = "2026-10-31T10:00:00Z";
const later = "2026-10-31T11:00:00Z";
const kinds = [
  {
    name: "models",
    entry: (at) => ({ build: "fixture", day: "2026-10-31", at, models: [] }),
    write: writeModelCache,
    read: (root) => readModelCache(root, "fixture", "2026-10-31"),
  },
  {
    name: "quota",
    entry: (at) => ({ at, source: "read", primary: { usedPercent: 50 } }),
    write: writeQuotaCache,
    read: readQuotaCache,
  },
];

for (const kind of kinds)
  for (const heldAt of [earlier, later])
    test(`${kind.name} cache serializes overlapping writers (${heldAt})`, async (t) => {
      const f = fixture(t);
      const child = spawn(
        process.execPath,
        [
          `--import=${new URL("./support/hermetic.mjs", import.meta.url).href}`,
          fileURLToPath(new URL("./fixtures/cache-writer.mjs", import.meta.url)),
          f.state,
          kind.name,
          JSON.stringify(kind.entry(heldAt)),
        ],
        { env: f.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      f.trackChild(child);
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      try {
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(path.join(f.state, "ready"))) {
          assert.ok(Date.now() < deadline, `writer reached rename: ${stderr}`);
          await delay(10);
        }
        assert.equal(
          kind.write(f.state, kind.entry(heldAt === earlier ? later : earlier)),
          false,
          "a contending best-effort update must not replace an active publisher's cache",
        );
      } finally {
        fs.writeFileSync(path.join(f.state, "resume"), "");
        assert.equal(await exited, 0, stderr);
      }
      assert.equal(kind.read(f.state).at, heldAt);
      assert.equal(kind.write(f.state, kind.entry(later)), true, "the guard is released");
      assert.equal(kind.write(f.state, kind.entry(earlier)), false);
      assert.equal(kind.read(f.state).at, later);
    });
