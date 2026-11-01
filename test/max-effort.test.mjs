import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseArgs, parseTaskFile, applyDirectives, ROLES } from "../src/index.mjs";
import { EFFORTS } from "../src/shared/constants.mjs";
import { EXIT } from "../src/shared/errors.mjs";

import { fixture, launchWith } from "./support/runner-fixture.mjs";

test("max and, above it, ultra are selectable through CLI and directives while defaults stay xhigh", () => {
  assert.deepEqual([...EFFORTS].slice(-3), ["xhigh", "max", "ultra"]);
  for (const role of Object.keys(ROLES)) {
    assert.equal(ROLES[role].effort, "xhigh");
    for (const effort of ["max", "ultra"])
      assert.equal(
        parseArgs(["--role", role, "--effort", effort, "--prompt-file", "p"]).effort,
        effort,
      );
    // ultra is never a default: a role's own effort applies without an explicit choice.
    assert.equal(parseArgs(["--role", role, "--prompt-file", "p"]).effort, "xhigh");
  }
  for (const effort of ["max", "ultra"]) {
    const task = parseTaskFile(Buffer.from(`effort: ${effort}\nThe exact task.\n`));
    assert.equal(task.directives.effort, effort);
    assert.equal(
      applyDirectives({ model: "gpt-6-astra", effort: "xhigh" }, task.directives).effort,
      effort,
    );
  }
  assert.throws(() => parseArgs(launchWith("gpt-6-astra", "beyond")), /unsupported effort/);
  assert.throws(
    () => applyDirectives({}, parseTaskFile(Buffer.from("effort: beyond\nTask\n")).directives),
    /unsupported effort/,
  );
});

test("max persists through initial delivery, inherited and explicitly changed continued turns", async (t) => {
  const f = fixture(t);
  const initial = await f.invoke(
    launchWith("gpt-6-astra", "max", ["--keep-state", "--keep-prompt"]).map((value) =>
      value === "0" ? "10000" : value,
    ),
  );
  assert.equal(initial.code, EXIT.COMPLETED, initial.stderr);
  const key = f.runs()[0];
  assert.match(initial.stdout, / effort=max /);
  assert.equal(f.metadata(key).effort, "max");
  for (const effort of [null, "xhigh", "max"]) {
    const next = await f.invoke([
      "--continue",
      key,
      "--prompt-file",
      "prompt.md",
      "--keep-prompt",
      "--wait-ms",
      "10000",
      ...(effort ? ["--effort", effort] : []),
    ]);
    assert.equal(next.code, EXIT.COMPLETED, next.stderr);
    assert.equal(f.metadata(key).effort, effort ?? "max");
  }
  assert.deepEqual(
    f.metadata(key).turns.map((turn) => turn.effort),
    ["max", "max", "xhigh"],
  );
  const max = f.events().filter((event) => event.effort === "max");
  assert.equal(max.length, 3);
  assert.deepEqual(
    max.map((event) => event.resume),
    [false, true, true],
  );
});

test("a max task-file launch binds the full request digest to its literal effort", async (t) => {
  // Keep the asynchronous worker queued through the first status request. A
  // real plugin long poll must wait; immediate fake replies mask this race.
  const f = fixture(t);
  const task = path.join(f.work, "max-task.md");
  fs.writeFileSync(task, "effort: max\nkeep: yes\nrequest-id: max-request\n\nExact task.\n");
  const started = await f.invoke([
    "--role",
    "gpt-6-astra",
    "--task-file",
    task,
    "--keep-prompt",
    "--wait-ms",
    "10000",
  ]);
  assert.equal(started.code, EXIT.COMPLETED, started.stderr);
  const key = f.runs()[0],
    run = f.metadata(key);
  assert.equal(run.effort, "max");
  assert.match(run.requestDigest, /^[0-9a-f]{64}$/);
  fs.writeFileSync(task, "effort: xhigh\nkeep: yes\nrequest-id: max-request\n\nExact task.\n");
  const refused = await f.invoke(["--role", "gpt-6-astra", "--task-file", task]);
  assert.equal(refused.code, EXIT.FAILURE);
  assert.match(refused.stderr, /different task/);
  assert.equal(f.events().filter((event) => event.command === "task").length, 1);
  assert.equal(f.metadata(key).effort, "max");

  // A pending max worker must still return active without --wait and after a
  // bounded wait expires. Waiting must not manufacture terminal state.
  const pending = fixture(t, { status: "running" });
  const immediate = await pending.invoke(launchWith("gpt-6-astra", "max", ["--keep-state"]));
  assert.equal(immediate.code, EXIT.STILL_RUNNING, immediate.stderr);
  const timed = await pending.invoke(["--run", pending.metadata().runKey, "--wait-ms", "100"]);
  assert.equal(timed.code, EXIT.STILL_RUNNING, timed.stderr);
  assert.equal(pending.events().filter((event) => event.command === "task").length, 1);
});
