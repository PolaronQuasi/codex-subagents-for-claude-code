import assert from "node:assert/strict";
import test from "node:test";
import { doctorDetails } from "../src/codex/diagnostics.mjs";
import { fixture } from "./support/codex-fixture.mjs";

test("verbose doctor projects bounded fields and never emits config or hook secrets", async () => {
  const calls = [],
    lines = [],
    problems = [];
  const session = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "mcpServerStatus/list")
        return {
          data: [
            {
              name: "test",
              authStatus: "oAuth",
              tools: { a: { description: "SECRET" } },
              toolsError: "SECRET",
            },
          ],
          nextCursor: "MORE",
        };
      if (method === "hooks/list")
        return {
          data: [
            {
              cwd: "SECRET",
              hooks: [{ command: "SECRET", eventName: "stop", handlerType: "command" }],
              warnings: ["SECRET"],
              errors: [],
            },
          ],
        };
      if (method === "config/read")
        return {
          config: {
            model: "test-model",
            model_reasoning_effort: "low",
            developer_instructions: "SECRET",
            mcp_servers: { key: "SECRET" },
          },
          origins: { path: "SECRET" },
        };
      return {
        requirements: {
          allowedSandboxModes: ["read-only"],
          allowedApprovalPolicies: ["never"],
          otel: { headers: { key: "SECRET" } },
        },
      };
    },
  };
  await doctorDetails(session, {
    cwd: process.cwd(),
    put: (k, v) => lines.push(`${k}=${v}`),
    problems,
  });
  assert.equal(problems.length, 0);
  assert.equal(lines.length, 4);
  assert.doesNotMatch(lines.join("\n"), /SECRET|MORE/);
  assert.match(lines[0], /"truncated":true/);
  assert.equal(calls[0].params.threadId, undefined);
  assert.equal(calls[2].params.includeLayers, false);
});

test("diagnostic failures are independent and omit raw errors", async () => {
  const lines = [],
    problems = [];
  await doctorDetails(
    {
      request: async () => {
        throw new Error("SECRET");
      },
    },
    {
      cwd: process.cwd(),
      put: (k, v) => lines.push(`${k}=${v}`),
      problems,
    },
  );
  assert.equal(problems.length, 4);
  assert.equal(lines.length, 4);
  assert.doesNotMatch(lines.join() + problems.join(), /SECRET/);
});

test("verbose doctor is explicit and never starts or resumes a thread", async (t) => {
  const f = fixture(t);
  const r = await f.invoke(["--doctor", "--read-only", "--verbose"]);
  assert.match(r.stdout, /codex-mcp=/);
  assert.match(r.stdout, /codex-hooks=/);
  assert.doesNotMatch(r.stdout, /codex-(mcp|hooks|defaults|requirements)=unavailable/);
  const calls = f
    .events()
    .filter((e) => e.direction === "in")
    .map((e) => e.method);
  assert.ok(calls.includes("configRequirements/read"));
  assert.equal(
    calls.some((m) => ["thread/start", "thread/resume", "turn/start"].includes(m)),
    false,
  );
  assert.equal((await f.invoke(["--verbose"])).code, 1);
});
