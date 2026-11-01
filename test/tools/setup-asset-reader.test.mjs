// ci/gitea/setup-asset-reader.ps1 against a local stand-in for the Gitea 1.24 API: no
// network and no real credential. git credential fill reads a helper from a private config, never
// the user's own, and nothing here changes PowerShell's execution policy.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanGitEnvironment, ROOT } from "../../tools/distribution.mjs";

const SCRIPT = path.join(ROOT, "ci", "gitea", "setup-asset-reader.ps1");
const READER = "codex-subagents-for-claude-code-assets";
const TOKEN = "codex-subagents-for-claude-code-asset-download";
const SYSTEM = process.env.SystemRoot ?? "C:\\Windows";
const IS_WINDOWS = process.platform === "win32";
const POWERSHELL = IS_WINDOWS
  ? path.join(SYSTEM, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : null;

function scratch(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-subagents-for-claude-code-asset-reader-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // Test values only: the helper answers every lookup with them.
  const config = path.join(root, "gitconfig");
  fs.writeFileSync(
    config,
    '[credential]\n\thelper = "!f() { echo username=admin; echo password=admin-test-value; }; f"\n',
  );
  const env = {
    ...cleanGitEnvironment(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: config,
    GIT_TERMINAL_PROMPT: "0",
  };
  return { root, env };
}

// Why the script cannot run here, or false when it can.
function unavailable() {
  if (!POWERSHELL || !fs.existsSync(POWERSHELL)) return "needs Windows PowerShell";
  const policy = spawnSync(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"],
    { encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  const value = policy.stdout?.trim();
  return ["RemoteSigned", "Unrestricted", "Bypass"].includes(value)
    ? false
    : `the execution policy ${value || "(unknown)"} does not run a local script`;
}
const skip = unavailable();

// Gitea's routes the script uses: a second token with a used name is refused, and only the reader,
// who owns the token, deletes it here (the script's choice works whichever account Gitea checks).
// description is the existing reader's profile text, which records the repository it serves.
async function fakeGitea(
  t,
  { reader = false, leftover = false, deleteStatus = 0, description } = {},
) {
  const state = {
    reader: reader ? { password: "unknown", tokens: leftover ? [TOKEN] : [], description } : null,
    calls: [],
    secret: null,
    issued: 0,
  };
  const server = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const [scheme, value = ""] = (request.headers.authorization ?? "").split(" ");
    const basic = scheme === "Basic" ? Buffer.from(value, "base64").toString("utf8") : "";
    const user = basic.slice(0, basic.indexOf(":"));
    const as = scheme === "Basic" ? user : scheme === "token" ? `token ${value}` : "anonymous";
    const route = `${request.method} ${new URL(request.url, "http://gitea").pathname}`;
    state.calls.push(`${route} as ${as}`);
    const send = (status, json) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(json === undefined ? "" : JSON.stringify(json));
    };
    if (as === READER && basic.slice(user.length + 1) !== state.reader?.password)
      return send(401, { message: "user does not exist or the password is wrong" });
    const api = "/api/v1",
      repo = `${api}/repos/owner/repo`,
      tokens = `${api}/users/${READER}/tokens`;
    switch (route) {
      case `GET ${repo}/actions/secrets`:
        return send(200, []);
      case `GET ${api}/user`:
        return send(200, { login: "admin", is_admin: true });
      case `GET ${api}/users/${READER}`:
        return state.reader
          ? send(200, {
              login: READER,
              is_admin: false,
              full_name: "codex-subagents-for-claude-code asset verifier",
              email: `${READER}@users.noreply.invalid`,
              ...(state.reader.description ? { description: state.reader.description } : {}),
            })
          : send(404, { message: "user does not exist" });
      case `POST ${api}/admin/users`:
        state.reader = { password: body.password, tokens: [] };
        return send(201, { login: READER });
      case `PATCH ${api}/admin/users/${READER}`:
        state.reader.password = body.password;
        state.reader.description = body.description;
        return send(200, { login: READER });
      case `PUT ${repo}/collaborators/${READER}`:
        return send(204);
      case `DELETE ${tokens}/${TOKEN}`: {
        if (deleteStatus) return send(deleteStatus, { message: "injected failure" });
        const own = as === READER ? state.reader.tokens : [];
        if (!own.includes(TOKEN)) return send(404, { message: "token does not exist" });
        state.reader.tokens = own.filter((name) => name !== TOKEN);
        return send(204);
      }
      case `POST ${tokens}`:
        if (as !== READER) return send(401, { message: "basic authentication as the user" });
        if (state.reader.tokens.includes(body.name))
          return send(400, { message: "access token name has been used already" });
        state.reader.tokens.push(body.name);
        return send(201, { id: ++state.issued, name: body.name, sha1: `new-${state.issued}` });
      case `GET ${repo}`:
        return send(200, { permissions: { pull: true, push: false, admin: false } });
      case `PUT ${repo}/actions/secrets/CODEX_SUBAGENTS_FOR_CLAUDE_CODE_ASSET_TOKEN`:
        state.secret = body.data;
        return send(201);
      default:
        return send(500, { message: `unexpected ${route}` });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

async function provision(t, gitea, ...args) {
  const { root, env } = scratch(t);
  const child = spawn(
    POWERSHELL,
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      SCRIPT,
      "-Server",
      gitea.url,
      "-Repository",
      "owner/repo",
      ...args,
    ],
    { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stdout, stderr, calls: gitea.state.calls };
}
const deleted = `DELETE /api/v1/users/${READER}/tokens/${TOKEN} as ${READER}`;
const created = `POST /api/v1/users/${READER}/tokens as ${READER}`;

test(
  "repair deletes, as the reader, the token an interrupted run created but never stored, then stores a new one",
  { skip, timeout: 120_000 },
  async (t) => {
    const gitea = await fakeGitea(t, { reader: true, leftover: true });
    const result = await provision(t, gitea, "-RepairIncomplete");
    assert.equal(result.code, 0, `${result.stderr}\n${result.calls.join("\n")}`);
    assert.match(
      result.stdout,
      /Configured codex-subagents-for-claude-code-assets with read-only access to owner\/repo/,
    );
    assert.ok(result.calls.indexOf(deleted) >= 0, result.calls.join("\n"));
    assert.ok(
      result.calls.indexOf(created) > result.calls.indexOf(deleted),
      "deleted, then created",
    );
    assert.deepEqual(gitea.state.reader.tokens, [TOKEN], "one token of that name, the new one");
    assert.equal(gitea.state.secret, "new-1", "the secret holds the new token");
  },
);

test(
  "repair refuses a reader provisioned for another repository and leaves that repository's token alone",
  { skip, timeout: 120_000 },
  async (t) => {
    const other = await fakeGitea(t, {
      reader: true,
      leftover: true,
      description: "Read-only asset verification for owner/other",
    });
    const refused = await provision(t, other, "-RepairIncomplete");
    assert.notEqual(refused.code, 0, refused.stdout);
    assert.match(refused.stderr.replace(/\s+/g, " "), /provisioned for another repository/);
    assert.equal(
      refused.calls.some((call) => /^(DELETE|PATCH|POST) /.test(call)),
      false,
      refused.calls.join("\n"),
    );
    assert.deepEqual(other.state.reader.tokens, [TOKEN], "the other repository's token remains");
    assert.equal(other.state.secret, null);
    // A reader that serves this repository is still repaired.
    const own = await fakeGitea(t, {
      reader: true,
      leftover: true,
      description: "Read-only asset verification for owner/repo",
    });
    const repaired = await provision(t, own, "-RepairIncomplete");
    assert.equal(repaired.code, 0, `${repaired.stderr}\n${repaired.calls.join("\n")}`);
    assert.equal(own.state.secret, "new-1");
  },
);

test(
  "repair without a leftover token goes on after the 404, a first provisioning deletes nothing, and any other refusal stops before a token exists",
  { skip, timeout: 120_000 },
  async (t) => {
    const clean = await fakeGitea(t, { reader: true });
    const repaired = await provision(t, clean, "-RepairIncomplete");
    assert.equal(repaired.code, 0, `${repaired.stderr}\n${repaired.calls.join("\n")}`);
    assert.ok(repaired.calls.includes(deleted), repaired.calls.join("\n"));
    assert.equal(clean.state.secret, "new-1");
    const fresh = await fakeGitea(t);
    const first = await provision(t, fresh);
    assert.equal(first.code, 0, `${first.stderr}\n${first.calls.join("\n")}`);
    assert.equal(first.calls.filter((call) => call.startsWith("DELETE ")).length, 0);
    assert.equal(fresh.state.secret, "new-1");
    const failing = await fakeGitea(t, { reader: true, leftover: true, deleteStatus: 500 });
    const stopped = await provision(t, failing, "-RepairIncomplete");
    assert.notEqual(stopped.code, 0, stopped.stdout);
    assert.ok(stopped.calls.includes(deleted), stopped.calls.join("\n"));
    assert.equal(stopped.calls.includes(created), false, "no token is created after the failure");
    assert.equal(failing.state.secret, null);
  },
);
