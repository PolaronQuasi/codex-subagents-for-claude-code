// Maintenance modes: --list, --doctor, --limits, --prepare and the manual
// sweeps (--close-idle, --collect-finished, --sleep-idle), which run existing
// commands in-process through the invoke function they are given.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { RUNNER_VERSION } from "../version.mjs";
import { environmentPaths, ROLES } from "../cli/options.mjs";
import {
  AGENT_INSTALLATION,
  PROBE_OUTPUT_BYTES,
  SESSION_ID,
  TERMINAL,
  GIT_PROBE_MS,
  EXCERPT_CHARS,
  OUTCOME,
  MIN_NODE_MAJOR,
  CODEX_VERSION_RANGE,
  CODEX_LOGIN,
  CODEX_ENV,
  RPC,
  APP_SERVER_MODE,
  LIMITS_SOURCE,
  LIMITS_LOGIN,
  MINUTE_MS,
  SECOND_MS,
  MODEL_TEXT,
  TASK_FOLDER,
  TASK_NAME_ATTEMPTS,
  TASK_NAME_BYTES,
} from "../shared/constants.mjs";
import { agentDefinitions, ensureRuntime, pluginInstallation } from "../shared/runtime-release.mjs";
import {
  absoluteOverride,
  alive,
  readJson,
  requireDirectory,
  runProcess,
  withoutLocalGit,
  writeOutput,
} from "../shared/io.mjs";
import { ERRNO, EXIT } from "../shared/errors.mjs";
import { jobStatus as jobFileStatus, readJob, readDriver } from "../state/job-store.mjs";
import { createDriverClient } from "../codex/driver-client.mjs";
import {
  selectCodex as selectDirectCodex,
  requireSupportedCodex,
  codexSupports,
} from "../codex/cli.mjs";
import { CodexSession } from "../codex/session.mjs";
import { doctorDetails } from "../codex/diagnostics.mjs";
import { quotaFromRead, readAccountQuota } from "../codex/account.mjs";
import { readQuotaCache, writeQuotaCache, writeQuotaLogout } from "../state/quota-cache.mjs";
import { findModel, listModels } from "../codex/models.mjs";
import { utcDay, writeModelCache } from "../state/model-cache.mjs";
import { limitsLine, percentText, utcMinute, windowText } from "../delivery/usage.mjs";
import {
  isDelivered,
  liveWaiter,
  resultFetchedAt,
  retainedRuns,
  writerOwners,
} from "../state/state.mjs";
import { gitToplevel, gitDiagnostics } from "../shared/workspace.mjs";
import { runFile } from "../state/run-store.mjs";
import { turnInTransition } from "../state/turn-transition.mjs";
import { isForkSeed } from "../shared/fork.mjs";

function finishedAt(dir, run) {
  const record = run.jobId ? readJob(dir, run.jobId)?.record : null;
  for (const value of [record?.completedAt, record?.updatedAt, run.createdAt]) {
    const at = Date.parse(value ?? "");
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  return null;
}

// Runs one command, receiving its outcome (io.onOutcome): its delivery, or the
// reason it delivered nothing. What it prints is discarded, the answer and
// its diagnostics alike: a sweep reads outcomes, never text. It gets no
// --quiet: a delivery flag would be recorded on the run it touches.
async function runInProcess(
  args,
  { invoke, parentEnv, cwd, signal, commandMs, requireDurableCopy = false },
) {
  let outcome = null;
  const discard = () =>
    new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    });
  const code = await invoke([...args, "--command-timeout-ms", String(commandMs)], {
    env: parentEnv,
    cwd,
    stdout: discard(),
    stderr: discard(),
    signal,
    requireDurableCopy,
    onOutcome: (value) => {
      outcome = value;
    },
  });
  return { code, outcome };
}

// Why an in-process command delivered nothing, on one line: the reason its
// last outcome gave (its error's message, or its STILL RUNNING notice), else
// its exit code.
function failure({ code, outcome }) {
  const reason = outcome && outcome.kind !== OUTCOME.DELIVERED ? outcome.reason : null;
  return String(reason ?? `exit ${code}`)
    .split("\n")[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EXCERPT_CHARS);
}

// What each manual sweep picks and does. pick returns null to pass a run over,
// { at, label, skip } to report it skipped, or { at, label, note } to act on
// it; act runs one existing command for the run in this process. A delivered
// run's age counts from when its result was fetched (resultFetchedAt), the
// moment before its delivery.
const SWEEP_KINDS = {
  "close-idle": {
    verb: "close",
    done: "closed",
    who: "closes",
    pick: (run, dir) =>
      isDelivered(run) && !turnInTransition(run)
        ? { at: resultFetchedAt(dir, run), label: "delivered" }
        : null,
    act: (key, run, context) =>
      runInProcess(["--close", key], context).then((done) =>
        done.code === EXIT.COMPLETED ? { ok: true } : { ok: false, error: failure(done) },
      ),
  },
  // A job that ended while nobody waited, or a cached result that never reached
  // anyone: deliver it through the normal attach, which writes its durable copy
  // and then lets a kept run sleep or removes the rest. Only the outcome's status
  // and copy are printed, not the result, so the copy is required: without it
  // the attach fails and the run stays.
  "collect-finished": {
    verb: "collect",
    done: "collected",
    who: "collects",
    pick: (run, dir) => {
      if (turnInTransition(run)) return null;
      if (run.result)
        return isDelivered(run)
          ? null
          : { at: run.result.cachedAt ?? resultFetchedAt(dir, run), label: "cached" };
      if (!run.jobId)
        return { at: run.createdAt ?? null, label: "created", skip: "job-not-identified" };
      const status = jobFileStatus(dir, run.jobId);
      if (status === null)
        return { at: run.createdAt ?? null, label: "created", skip: "job-record-missing" };
      return TERMINAL.has(status) ? { at: finishedAt(dir, run), label: "finished" } : null;
    },
    act: async (key, run, context) => {
      const done = await runInProcess(["--attach", run.jobId, "--run", key, "--wait-ms", "0"], {
        ...context,
        requireDurableCopy: true,
      });
      const outcome = done.outcome;
      // A delivered failed or cancelled job is still collected.
      if (
        (done.code !== EXIT.COMPLETED && done.code !== EXIT.NOT_COMPLETED) ||
        outcome?.kind !== OUTCOME.DELIVERED
      )
        return { ok: false, error: failure(done) };
      return {
        ok: true,
        note: `status=${outcome.status} keep=${outcome.keep} result=${outcome.resultFile ?? "-"}`,
      };
    },
  },
  "sleep-idle": {
    verb: "sleep",
    done: "slept",
    who: "puts to sleep",
    pick: (run, dir) => {
      const driver =
        run.result && !run.dormant && !turnInTransition(run) ? driverPid(dir, run) : null;
      return driver
        ? { at: resultFetchedAt(dir, run), label: "delivered", note: `driver=${driver}` }
        : null;
    },
    verify: async (run, dir) => {
      try {
        await createDriverClient(run, { stateDir: dir }).hello();
        return null;
      } catch {
        return `driver-not-answering`;
      }
    },
    act: (key, run, context) =>
      runInProcess(["--sleep", key], context).then((done) =>
        done.code === EXIT.COMPLETED ? { ok: true } : { ok: false, error: failure(done) },
      ),
  },
};

// One manual sweep over retained runs: this Claude session's (or, with
// --all-sessions, every session's), at least --older-than old, never one a
// live waiter holds. Prints one line per run and a count line.
export async function sweep(
  mode,
  { invoke, options, parentEnv, cwd, stateBase, stdout, signal, commandMs },
) {
  const kind = SWEEP_KINDS[mode];
  const session = parentEnv.CLAUDE_CODE_SESSION_ID;
  if (!options["all-sessions"] && !SESSION_ID.test(session ?? "")) {
    throw new Error(
      `--${mode} ${kind.who} this Claude session's runs, but CLAUDE_CODE_SESSION_ID is not set; use --all-sessions --older-than AGE`,
    );
  }
  const cutoff = Date.now() - options.olderThanMs;
  const lines = [];
  const counts = { [kind.done]: 0, [`would-${kind.verb}`]: 0, skipped: 0, failed: 0 };
  for (const { key, dir, run, root } of retainedRuns(stateBase)) {
    if (run && !options["all-sessions"] && run.session !== session) continue;
    if (!run) {
      lines.push(
        `skipped run=${key} reason=damaged-or-missing-metadata; inspect with --inspect ${key}; retire with --close ${key} --force`,
      );
      counts.skipped++;
      continue;
    }
    if (!options["all-sessions"] && run.session !== session) continue;
    const picked = kind.pick(run, dir);
    if (!picked || !(Date.parse(picked.at ?? "") <= cutoff)) continue;
    const described = `run=${key} model=${run.model ?? "-"} ${picked.label}=${picked.at} session=${run.session ?? "-"}`;
    const refused = picked.skip ?? (kind.verify ? await kind.verify(run, dir) : null);
    const waiter = refused ? null : liveWaiter(root, key);
    if (refused || waiter) {
      lines.push(`skipped ${described} reason=${refused ?? `waiter-pid-${waiter}`}`);
      counts.skipped++;
      continue;
    }
    if (options["dry-run"]) {
      lines.push(`would-${kind.verb} ${described}${picked.note ? ` ${picked.note}` : ""}`);
      counts[`would-${kind.verb}`]++;
      continue;
    }
    const done = await kind.act(key, run, { invoke, parentEnv, cwd, signal, commandMs });
    const note = done.note ?? picked.note;
    if (done.ok) {
      lines.push(`${kind.done} ${described}${note ? ` ${note}` : ""}`);
      counts[kind.done]++;
    } else {
      lines.push(`failed ${described} error=${done.error}`);
      counts.failed++;
    }
  }
  lines.push(
    `${mode}: ${Object.entries(counts)
      .map(([name, count]) => `${name}=${count}`)
      .join(" ")}`,
  );
  await writeOutput(stdout, `${lines.join("\n")}\n`, { signal, timeoutMs: commandMs });
  return counts.failed ? EXIT.FAILURE : EXIT.COMPLETED;
}

// session limits the rows to runs that Claude session launched; active to runs
// without a delivered result, a cached one that no copy or caller has among them.
export function listRuns(stateBase, { session = null, active = false } = {}) {
  const field = (value) =>
    value == null || value === "" ? "-" : String(value).replace(/[\x00-\x20\x7f]/g, "?");
  const writers = new Set(writerOwners(stateBase));
  const rows = [];
  for (const { key, dir, run, root } of retainedRuns(stateBase)) {
    if (session && run?.session !== session) continue;
    if (active && (isDelivered(run) || (run && isForkSeed(run)))) continue;
    // "cached": a result this runner holds that no copy or caller has yet.
    const status = !run
      ? fs.existsSync(runFile(dir))
        ? "damaged-metadata"
        : "no-metadata"
      : run.result
        ? isDelivered(run)
          ? run.result.status
          : "cached"
        : run.forkSeed && !run.continuing
          ? `fork-${run.forkState}`
          : run.jobId
            ? (jobFileStatus(dir, run.jobId) ?? "unknown")
            : "launching";
    // By PID liveness alone: a listing starts no process, so it does not ask
    // the OS for start times. The paths that act on a lock compare them.
    let lock = "-";
    try {
      const owner = readJson(path.join(root, `${key}.lock`, "owner.json"));
      lock = alive(owner.pid) ? String(owner.pid) : "stale";
    } catch (error) {
      if (error.code !== ERRNO.ENOENT) lock = "?";
    }
    rows.push({
      createdAt: run?.createdAt ?? "",
      line:
        `run=${key} status=${status} turn=${(run?.turns?.length ?? 0) + 1}` +
        ` model=${field(run?.model)} effort=${field(run?.effort)} mode=${run ? (run.write ? "workspace-write" : "read-only") : "-"}` +
        ` created=${field(run?.createdAt)} job=${field(run?.jobId)} request=${field(run?.requestId)} keep=${!run ? "unknown" : run.keepState || (run.result && !run.result.resultFile) ? "yes" : "no"}` +
        ` writer=${writers.has(key) ? "yes" : "no"} lock=${lock} delivered=${field(resultFetchedAt(dir, run))} driver=${driverPid(dir, run) ?? "-"} context=${percentText(run?.result?.usage?.context?.percent)}` +
        ` session=${field(run?.session)} cwd=${run ? run.cwd : "-"}\n`,
    });
  }
  if (!rows.length)
    return `No ${session || active ? "matching " : ""}retained runs under ${stateBase}.\n`;
  return rows
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((row) => row.line)
    .join("");
}

export async function doctor({
  parentEnv,
  cwd,
  commandMs,
  signal,
  stdout,
  readOnly = false,
  verbose = false,
}) {
  const lines = [],
    problems = [];
  const put = (key, value) => lines.push(`${key}=${value}`);
  put("runner", RUNNER_VERSION);
  put("codex-tested-version", CODEX_VERSION_RANGE.maxTested);
  put("node", process.versions.node);
  if (Number(process.versions.node.split(".")[0]) < MIN_NODE_MAJOR)
    problems.push(`Node.js ${MIN_NODE_MAJOR} or later is required`);
  const { stateBase, resultsDir, resultsSource } = environmentPaths(parentEnv, (error) =>
    problems.push(error.message),
  );
  put("results-source", resultsSource);

  for (const name of [CODEX_ENV.PATH, CODEX_ENV.DIRECTORY]) {
    try {
      absoluteOverride(parentEnv, name);
    } catch (error) {
      problems.push(error.message);
    }
  }
  try {
    const codex = await selectDirectCodex(parentEnv, cwd, commandMs, signal);
    put("codex", codex.version);
    put("codex-path", codex.realPath);
    try {
      requireSupportedCodex(codex, parentEnv);
      put("codex-version-tested", codex.version === CODEX_VERSION_RANGE.maxTested ? "yes" : "no");
    } catch (error) {
      put("codex-supported", "no");
      problems.push(error.message);
    }
    const supported = await codexSupports(codex, parentEnv, cwd, commandMs, signal);
    put("codex-app-server", supported ? "yes" : "no");
    if (!supported) throw new Error("Codex app-server protocol is unavailable");
    const session = new CodexSession({ codex, cwd }, { env: parentEnv });
    try {
      await session.open();
      put("codex-supported", "yes");
      const account = await session.request(RPC.ACCOUNT_READ, {});
      put("codex-login", account.account ? CODEX_LOGIN.IN : CODEX_LOGIN.OUT);
      if (!account.account) {
        problems.push("run codex login before launching a task");
        if (!readOnly && stateBase) {
          try {
            writeQuotaLogout(stateBase);
          } catch {
            /* Cache is best-effort. */
          }
        }
      }
      put("codex-quota", account.account ? await doctorQuota(session, stateBase, readOnly) : "-");
      await doctorModels(session, {
        codex,
        stateBase,
        readOnly,
        loggedIn: Boolean(account.account),
        put,
        problems,
      });
      if (verbose) await doctorDetails(session, { cwd, put, problems, signal });
    } finally {
      await session.close();
    }
  } catch (error) {
    for (const [key, value] of [
      ["codex", "missing"],
      ["codex-path", "-"],
      ["codex-app-server", "no"],
      ["codex-supported", "no"],
      ["codex-login", CODEX_LOGIN.UNKNOWN],
      ["codex-quota", CODEX_LOGIN.UNKNOWN],
      ["codex-models", CODEX_LOGIN.UNKNOWN],
    ])
      if (!lines.some((line) => line.startsWith(`${key}=`))) put(key, value);
    if (!problems.includes(error.message)) problems.push(error.message);
  }

  const git = await runProcess("git", ["--version"], {
    cwd,
    timeoutMs: Math.min(commandMs, GIT_PROBE_MS),
    maxBuffer: PROBE_OUTPUT_BYTES,
    signal,
    env: withoutLocalGit(),
  });
  put(
    "git",
    !git.error && git.status === 0
      ? git.stdout.trim().replace(/^git version /, "")
      : "missing (worktree jobs unavailable)",
  );
  if (!git.error && git.status === 0) {
    try {
      for (const [key, value] of Object.entries(
        await gitDiagnostics(cwd, { signal, env: parentEnv }),
      ))
        put(key, value);
    } catch (error) {
      put("git-identity", "unavailable: " + error.message);
    }
  }
  for (const [name, dir] of [
    ["state", stateBase],
    ["results", resultsDir],
  ]) {
    put(name, dir ?? "invalid");
    if (dir === null) {
      put(`${name}-writable`, "not-tested");
      continue;
    }
    if (readOnly) {
      put(`${name}-exists`, fs.existsSync(dir) ? "yes" : "no");
      put(`${name}-writable`, "not-tested");
      try {
        if (fs.existsSync(dir)) requireDirectory(dir);
      } catch (error) {
        problems.push(`${name} directory is invalid: ${error.message}`);
      }
      continue;
    }
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      requireDirectory(dir);
      const probe = path.join(dir, `.doctor-${crypto.randomBytes(4).toString("hex")}`);
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      put(`${name}-writable`, "yes");
    } catch (error) {
      put(`${name}-writable`, "no");
      problems.push(`${name} directory is not writable: ${error.message}`);
    }
  }
  const stateRepo = stateBase && fs.existsSync(stateBase) ? gitToplevel(stateBase) : null;
  put(
    "state-in-repository",
    !stateBase || (readOnly && !fs.existsSync(stateBase)) ? "not-tested" : stateRepo ? "yes" : "no",
  );
  if (stateRepo)
    problems.push(
      `the state root lies inside the git repository ${stateRepo}; scratch workspaces would run in that repository`,
    );
  try {
    put("retained-runs", stateBase ? retainedRuns(stateBase).length : "not-tested");
  } catch (error) {
    put("retained-runs", "unreadable");
    problems.push(error.message);
  }
  // Runs kept where the state root used to be are still found and operated.

  put("roles", Object.keys(ROLES).join(","));
  doctorAgents(parentEnv, put, problems);
  put("doctor", problems.length ? `${problems.length} problem(s)` : "ok");
  for (const problem of problems) put("problem", problem.replace(/[\x00-\x1f\x7f]/g, " "));
  await writeOutput(stdout, `${lines.join("\n")}\n`, { signal, timeoutMs: commandMs });
  return problems.length ? EXIT.FAILURE : EXIT.COMPLETED;
}

function doctorAgents(env, put, problems) {
  // Finding files, including captured snapshot evidence, cannot establish that
  // Claude enabled this plugin or loaded any of its namespaced components.
  put("claude-agents-loaded", "unverified");
  let installation;
  try {
    const override = absoluteOverride(env, "CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR");
    installation = override ? null : pluginInstallation(undefined, env);
    if (!installation || installation.mode === AGENT_INSTALLATION.AMBIGUOUS) {
      const bundled = installation;
      const agentsDir = override ?? path.join(os.homedir(), ".claude", "agents");
      const definitions = agentDefinitions(agentsDir);
      installation = {
        mode: override
          ? AGENT_INSTALLATION.OVERRIDE
          : bundled
            ? AGENT_INSTALLATION.AMBIGUOUS
            : Object.values(definitions).every((state) => state === "missing")
              ? AGENT_INSTALLATION.STANDALONE
              : AGENT_INSTALLATION.CHECKOUT,
        namespace: "none",
        agentsDir,
        definitions,
        bundled,
      };
    }
  } catch (error) {
    put("installation-mode", AGENT_INSTALLATION.INVALID);
    put("agent-namespace", "unknown");
    put("agents-dir", "invalid");
    put("agents-available", "unknown");
    problems.push(
      env.CODEX_SUBAGENTS_FOR_CLAUDE_CODE_AGENTS_DIR !== undefined
        ? error.message
        : `agent installation could not be inspected: ${error.message}`,
    );
    return;
  }
  const { mode, namespace, agentsDir, definitions } = installation;
  const snapshot = mode === AGENT_INSTALLATION.SNAPSHOT;
  const states = Object.values(definitions);
  const required =
    mode === AGENT_INSTALLATION.PLUGIN || snapshot || states.some((state) => state !== "missing");
  put("installation-mode", mode);
  put("agent-namespace", namespace);
  put("agents-dir", agentsDir ?? "snapshot-inventory");
  put("agents-evidence", snapshot ? "captured-at-prepare" : "local-files");
  put("agents-available", `${states.filter((state) => state === "ok").length}/${states.length}`);
  put("agents-required", required ? "yes" : "no");
  if (installation.bundled) {
    const bundled = installation.bundled;
    put("bundled-agent-namespace", bundled.namespace);
    put(
      "bundled-agents-available",
      `${Object.values(bundled.definitions).filter((state) => state === "ok").length}/${states.length}`,
    );
    put("bundled-agents-evidence", bundled.evidence);
    put(
      "installation-note",
      "dual-use source layout; checking checkout forwarders, bundled plugin definitions are not assumed installed",
    );
  }
  if (!required) put("agents-note", "forwarders are optional for direct CLI use");
  if (snapshot)
    put(
      "agents-note",
      "captured definitions only; current plugin files and Claude loading are unverified",
    );
  for (const [role, state] of Object.entries(definitions)) {
    put(`agent-${role}`, state);
    if (state === "ok" || (state === "missing" && !required)) continue;
    problems.push(
      `${snapshot ? "captured " : ""}agent definition ${role}.md is ${state}; ` +
        (state === "stale"
          ? `check its name and --role ${role} --task-file forwarding for runner ${RUNNER_VERSION}`
          : "restore the selected installation's forwarders"),
    );
  }
}

// Doctor's quota field: the primary window and its reset, and the secondary
// when the plan has one. A failed read is no setup problem: it is unknown.
async function doctorQuota(session, stateBase, readOnly) {
  try {
    const at = new Date().toISOString();
    const quota = quotaFromRead(await session.request(RPC.RATE_LIMITS_READ, null), at);
    if (!readOnly && stateBase) {
      try {
        writeQuotaCache(stateBase, quota);
      } catch {
        /* The state-writable probe reports an unwritable root. */
      }
    }
    if (!quota?.primary) return "-";
    const primary = windowText({ ...quota.primary, resetsAt: null });
    const secondary = quota.secondary ? ` secondary=${windowText(quota.secondary)}` : "";
    return `${primary} resets=${utcMinute(quota.primary.resetsAt)}${secondary}`;
  } catch {
    return CODEX_LOGIN.UNKNOWN;
  }
}

// Doctor's model rows: model/list (hidden models included) and, per role,
// whether its model is listed, its efforts, default and upgrade. An unlisted
// role model or an effort it does not offer is a problem; a listed one is
// still no proof of access. Only a logged-in catalogue refreshes the cache.
async function doctorModels(session, { codex, stateBase, readOnly, loggedIn, put, problems }) {
  let models;
  try {
    models = await listModels(session);
  } catch {
    put("codex-models", "unavailable");
    return;
  }
  put("codex-models", `${models.length} listed (${MODEL_TEXT.ACCESS})`);
  if (loggedIn && !readOnly && stateBase) {
    try {
      writeModelCache(stateBase, { build: codex.build, day: utcDay(), models });
    } catch {
      /* The state-writable probe reports an unwritable root. */
    }
  }
  for (const [role, { model, effort }] of Object.entries(ROLES)) {
    const entry = findModel(models, model);
    const offered =
      !entry || entry.hidden || !entry.efforts.length || entry.efforts.includes(effort);
    put(
      `model-${role}`,
      entry
        ? `${model} listed=yes hidden=${entry.hidden ? "yes" : "no"} efforts=${entry.efforts.join(",") || "-"} default=${entry.defaultEffort ?? "-"} effort=${effort}${offered ? "" : "(unsupported)"} upgrade=${entry.upgrade ?? "-"} retires=${entry.retirementAt ? utcMinute(entry.retirementAt) : "-"}`
        : `${model} listed=no`,
    );
    if (!entry) problems.push(`role ${role}'s model ${model} is not in Codex's model list`);
    else if (!offered) problems.push(`role ${role}'s effort ${effort} is not offered for ${model}`);
  }
}

// --limits: the account's quota on one line (or as JSON), with no thread and
// no model call. Fresh by default: one probe app-server answers account/read
// and account/rateLimits/read, and the answer refreshes the cache. --cached
// prints the cache and starts nothing; --max-age MIN uses a cache younger
// than MIN minutes. A logout is an answer (login=out), not an error.
// --prepare ROLE: what the plugin's forwarders and skill run first. It makes
// sure the runtime snapshot of the release this entry loads exists
// (shared/runtime-release.mjs) and prints two lines: "runner: <path>", the
// snapshot's entry, which then runs the turn, so the plugin's cache folder can
// be replaced under a running job; and "task-file: <path>", an unused name in
// the temporary folder for the task, which Claude's Write tool may create (the
// state root is under ~/.claude, a folder Claude Code protects). script: the
// entry this invocation runs through. Forward slashes on every platform.
export async function prepare({ parentEnv, commandMs, signal, stdout, script, role }) {
  if (!script) throw new Error("--prepare needs the entry path; run it as run-codex-task.mjs");
  const { stateBase } = environmentPaths(parentEnv);
  const runtime = ensureRuntime({
    stateBase,
    entry: script,
    version: RUNNER_VERSION,
    env: parentEnv,
  });
  const folder = path.join(os.tmpdir(), TASK_FOLDER);
  // The task folder is private to this user: another user on a shared /tmp
  // could make it first, or read a task in it. It is made 0700, must be a
  // real folder, no link, and on Linux and macOS this user's own; one with a
  // wider mode (a forwarder's Write tool made it) is narrowed to 0700.
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  requireDirectory(folder);
  const owned = fs.lstatSync(folder);
  if (process.getuid && owned.uid !== process.getuid())
    throw new Error(
      `the task folder ${folder} belongs to another user; remove it, or set TMPDIR to a folder of your own`,
    );
  if (process.getuid && owned.mode & 0o077) fs.chmodSync(folder, 0o700);
  let task = null;
  for (let attempt = 0; attempt < TASK_NAME_ATTEMPTS && !task; attempt++) {
    const name = path.join(
      folder,
      `${role}-${crypto.randomBytes(TASK_NAME_BYTES).toString("hex")}.md`,
    );
    if (!fs.existsSync(name)) task = name;
  }
  if (!task) throw new Error(`no unused task file name in ${folder}`);
  const slashed = (file) => file.split(path.sep).join("/");
  await writeOutput(stdout, `runner: ${slashed(runtime.runner)}\ntask-file: ${slashed(task)}\n`, {
    signal,
    timeoutMs: commandMs,
  });
  return EXIT.COMPLETED;
}

export async function limits({ parentEnv, cwd, commandMs, signal, stdout, options }) {
  const { stateBase } = environmentPaths(parentEnv);
  const now = Date.now();
  const cached = readQuotaCache(stateBase);
  const ageMs = cached ? Math.max(0, now - Date.parse(cached.at)) : null;
  const maxAgeMs = options.cached
    ? Infinity
    : options["max-age"] === undefined
      ? null
      : options["max-age"] * MINUTE_MS;
  let answer;
  if (cached && maxAgeMs !== null && ageMs <= maxAgeMs)
    answer = {
      login: cached.login === LIMITS_LOGIN.OUT ? LIMITS_LOGIN.OUT : null,
      quota: cached.login === LIMITS_LOGIN.OUT ? null : cached,
      source: LIMITS_SOURCE.CACHE,
      ageMs,
    };
  else if (options.cached) answer = { source: LIMITS_SOURCE.NONE };
  else {
    const codex = requireSupportedCodex(
      await selectDirectCodex(parentEnv, cwd, commandMs, signal),
      parentEnv,
    );
    const session = new CodexSession(
      { codex, cwd, mode: APP_SERVER_MODE.PROBE },
      { env: parentEnv },
    );
    let read;
    try {
      await session.open();
      read = await readAccountQuota(session);
    } finally {
      await session.close();
    }
    answer = {
      login: read.login === CODEX_LOGIN.IN ? LIMITS_LOGIN.IN : LIMITS_LOGIN.OUT,
      quota: read.quota,
      source: LIMITS_SOURCE.FRESH,
      ageMs: 0,
    };
    try {
      if (read.quota) writeQuotaCache(stateBase, read.quota);
      else if (read.login === CODEX_LOGIN.OUT) writeQuotaLogout(stateBase);
    } catch {
      /* The answer stands without its cache. */
    }
  }
  const text = options.json
    ? `${JSON.stringify({
        login: answer.login ?? null,
        source: answer.source,
        ageSeconds: answer.ageMs == null ? null : Math.floor(answer.ageMs / SECOND_MS),
        quota: answer.quota ?? null,
      })}\n`
    : limitsLine(answer, now);
  await writeOutput(stdout, text, { signal, timeoutMs: commandMs });
  return EXIT.COMPLETED;
}

function driverPid(dir, run) {
  const record = run?.jobId ? readDriver(dir, run.jobId) : null;
  return record && alive(record.pid) ? record.pid : null;
}
