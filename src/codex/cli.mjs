// Resolve and identify one CLI explicitly. Native authentication and user
// configuration remain with Codex; this module never reads a login profile.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  PLATFORM,
  CODEX_NATIVE_SIGNATURE_BYTES,
  IS_WINDOWS,
  SEMVER_PARTS,
  CODEX_ENV,
  CODEX_OVERRIDE_REMEDY,
  CODEX_EXECUTABLES,
  CODEX_COMMAND,
  CODEX_VERSION_RANGE,
  VERSION_PROBE_MS,
  APP_SERVER_PROBE_MS,
  PROBE_OUTPUT_BYTES,
  MCP_MODE,
  MCP_OFF_FEATURES,
  MCP_OFF_CONFIG,
  APP_SERVER_MODE,
} from "../shared/constants.mjs";
import { CODES, RunnerError, isMissing } from "../shared/errors.mjs";
import { absoluteOverride, readLimited, runProcess, withoutLocalGit } from "../shared/io.mjs";

export { CODEX_VERSION_RANGE };
export function semver(value) {
  if (typeof value !== "string") return null;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (match?.[4]?.split(".").some((part) => /^0\d+$/.test(part))) return null;
  return match;
}

export function compareVersions(a, b) {
  const x = semver(a),
    y = semver(b);
  if (!x || !y) throw new Error(`invalid semantic version: ${!x ? a : b}`);
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  for (let i = 1; i <= SEMVER_PARTS; i++) {
    const order = compare(BigInt(x[i]), BigInt(y[i]));
    if (order) return order;
  }
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1;
  const xp = x[4].split("."),
    yp = y[4].split(".");
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    if (xp[i] === undefined || yp[i] === undefined) return xp[i] === undefined ? -1 : 1;
    const xn = /^\d+$/.test(xp[i]),
      yn = /^\d+$/.test(yp[i]);
    const order =
      xn && yn
        ? compare(BigInt(xp[i]), BigInt(yp[i]))
        : xn !== yn
          ? xn
            ? -1
            : 1
          : compare(xp[i], yp[i]);
    if (order) return order;
  }
  return 0;
}

export function childEnvironment(
  parent = process.env,
  codexDir = null,
  { platform = process.platform } = {},
) {
  const windows = platform === PLATFORM.WIN32;
  const env = {};
  let searchPath = "";
  for (const [key, value] of Object.entries(withoutLocalGit(parent, platform))) {
    const upper = key.toUpperCase();
    if (upper === "PATH") searchPath = value;
    else if (
      !upper.startsWith("CODEX_COMPANION_") &&
      upper !== "CLAUDE_PLUGIN_DATA" &&
      !(windows && (upper === "SHELL" || upper === "NODEFAULTCURRENTDIRECTORYINEXEPATH"))
    )
      env[key] = value;
  }
  const delimiter = windows ? path.win32.delimiter : path.posix.delimiter;
  env.PATH = codexDir ? `${codexDir}${delimiter}${searchPath}` : searchPath;
  if (windows) env.NoDefaultCurrentDirectoryInExePath = "1";
  return env;
}

export function codexEnvironment(parent = process.env, codexDir = null, options = {}) {
  const env = childEnvironment(parent, codexDir, options);
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("CLAUDE_PLUGIN_") || upper.startsWith("CODEX_SUBAGENTS_FOR_CLAUDE_CODE_"))
      delete env[key];
  }
  return env;
}

const unsupported = (message, fields) => new RunnerError(CODES.CODEX_UNSUPPORTED, message, fields);
const executableFile = (file) => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!IS_WINDOWS) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw unsupported(`cannot use Codex executable ${file}: ${error.message}`, { cause: error });
  }
};

function privateExecutable(file, env) {
  const normalized = (value) => value.replaceAll("\\", "/").toLowerCase();
  const real = normalized(fs.realpathSync.native(file));
  const found = normalized(path.resolve(file));
  const locals = env.LOCALAPPDATA ? [normalized(path.resolve(env.LOCALAPPDATA))] : [];
  if (env.LOCALAPPDATA) {
    try {
      locals.push(normalized(fs.realpathSync.native(env.LOCALAPPDATA)));
    } catch (error) {
      if (!isMissing(error))
        throw unsupported(`cannot resolve LOCALAPPDATA: ${error.message}`, { cause: error });
    }
  }
  return [real, found].some(
    (value) =>
      /(?:^|\/)windowsapps\//.test(value) ||
      /(?:^|\/)\.codex\/\.sandbox-bin\//.test(value) ||
      locals.some((local) => value.startsWith(`${local}/openai/codex/bin/`)),
  );
}

export function resolveExecutable(env = process.env) {
  const explicit = absoluteOverride(env, CODEX_ENV.PATH);
  if (explicit) {
    if (!executableFile(explicit))
      throw unsupported(
        `${CODEX_ENV.PATH}: no Codex executable at ${explicit}; ${CODEX_OVERRIDE_REMEDY}`,
      );
    if (privateExecutable(explicit, env))
      throw unsupported("Codex's private desktop or sandbox executable is excluded");
    return explicit;
  }
  const directory = absoluteOverride(env, CODEX_ENV.DIRECTORY);
  const search = directory
    ? [directory]
    : (Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "")
        .split(path.delimiter)
        .map((entry) =>
          IS_WINDOWS && entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry,
        )
        .filter((entry) => entry && path.isAbsolute(entry));
  const names = IS_WINDOWS ? CODEX_EXECUTABLES.WINDOWS : CODEX_EXECUTABLES.POSIX;
  for (const folder of search)
    for (const name of names) {
      const file = path.resolve(folder, name);
      if (executableFile(file) && !privateExecutable(file, env)) return file;
    }
  throw unsupported(
    directory
      ? `no Codex executable in ${CODEX_ENV.DIRECTORY}=${directory}; ${CODEX_OVERRIDE_REMEDY}`
      : "no Codex executable on PATH",
  );
}

function fileDigest(file) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.alloc(PROBE_OUTPUT_BYTES);
  const fd = fs.openSync(file, "r");
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, bytes));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

// Native file signatures, not extensions: renaming a script cannot make its
// mutable downstream program part of the retained executable's fingerprint.
function nativeExecutable(file) {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(CODEX_NATIVE_SIGNATURE_BYTES);
    const count = fs.readSync(fd, header, 0, header.length, 0);
    return (
      count === CODEX_NATIVE_SIGNATURE_BYTES &&
      (IS_WINDOWS
        ? header.subarray(0, 2).toString("ascii") === "MZ"
        : [
            "7f454c46",
            "feedface",
            "feedfacf",
            "cefaedfe",
            "cffaedfe",
            "cafebabe",
            "bebafeca",
            "cafebabf",
            "bfbafeca",
          ].includes(header.toString("hex")))
    );
  } finally {
    fs.closeSync(fd);
  }
}

const wrapperRemedy = () =>
  unsupported(
    `Cannot identify a native Codex payload for this launcher; set ${CODEX_ENV.PATH} to the native Codex executable. Unresolved wrappers are not executed.`,
  );

// Resolve the ordinary npm layouts without executing either the shell shim or
// bin/codex.js. Only the selected native payload is probed and dispatched.
// Unknown package-manager layouts require an explicit native executable.
function npmPayload(executable, realPath, env) {
  let root;
  if (path.basename(realPath) === "codex.js" && path.basename(path.dirname(realPath)) === "bin") {
    root = path.dirname(path.dirname(realPath));
  } else if (IS_WINDOWS && /\.cmd$/i.test(executable)) {
    const shim = readLimited(executable, PROBE_OUTPUT_BYTES).toString("utf8");
    if (!/"%(?:~dp0|dp0%)\\?node_modules\\@openai\\codex\\bin\\codex\.js"/i.test(shim))
      throw wrapperRemedy();
    root = path.join(path.dirname(executable), "node_modules", "@openai", "codex");
  } else throw wrapperRemedy();
  const manifest = JSON.parse(readLimited(path.join(root, "package.json"), PROBE_OUTPUT_BYTES));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.codex;
  if (manifest.name !== "@openai/codex" || bin !== "bin/codex.js") throw wrapperRemedy();
  const entry = path.join(root, bin);
  if (!executableFile(entry) && !IS_WINDOWS) throw wrapperRemedy();
  if (privateExecutable(entry, env)) throw wrapperRemedy();
  if (path.basename(realPath) === "codex.js" && fs.realpathSync.native(entry) !== realPath)
    throw wrapperRemedy();
  const cpu = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  const target = {
    win32: `${cpu}-pc-windows-msvc`,
    linux: `${cpu}-unknown-linux-musl`,
    darwin: `${cpu}-apple-darwin`,
  }[process.platform];
  if (!cpu || !target) throw wrapperRemedy();
  const packageName = `codex-${process.platform}-${process.arch}`;
  const roots = [
    path.join(root, "node_modules", "@openai", packageName),
    path.join(path.dirname(root), packageName),
    root,
  ];
  const payloads = new Set();
  for (const packageRoot of roots) {
    for (const directory of ["bin", "codex"]) {
      const candidate = path.join(
        packageRoot,
        "vendor",
        target,
        directory,
        IS_WINDOWS ? "codex.exe" : "codex",
      );
      if (!executableFile(candidate)) continue;
      if (privateExecutable(candidate, env) || !nativeExecutable(candidate)) throw wrapperRemedy();
      payloads.add(fs.realpathSync.native(candidate));
    }
  }
  if (payloads.size !== 1) throw wrapperRemedy();
  return [...payloads][0];
}

function nativePayload(executable, env) {
  const realPath = fs.realpathSync.native(executable);
  if (privateExecutable(executable, env)) throw wrapperRemedy();
  if (nativeExecutable(realPath)) return realPath;
  try {
    return npmPayload(executable, realPath, env);
  } catch (error) {
    if (error.code === CODES.CODEX_UNSUPPORTED) throw error;
    throw wrapperRemedy();
  }
}

export const validCodexVersion = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= PROBE_OUTPUT_BYTES &&
  !/[\s\x00-\x1f\x7f]/u.test(value);

export function assertCodexIdentity(codex, env = process.env) {
  if (
    !codex?.realPath ||
    !/^[0-9a-f]{64}$/.test(codex.payloadSha256 ?? "") ||
    nativePayload(codex.realPath, env) !== codex.realPath ||
    fileDigest(codex.realPath) !== codex.payloadSha256
  )
    throw unsupported(
      "The pinned Codex native payload changed or lacks a fingerprint; start a new run with an explicitly selected native executable.",
    );
}

async function probe(executable, args, { env, cwd, timeoutMs, signal }) {
  return runProcess(executable, args, {
    cwd,
    env: codexEnvironment(env, path.dirname(executable)),
    timeoutMs,
    maxBuffer: PROBE_OUTPUT_BYTES,
    signal,
  });
}

export async function selectCodex(
  env = process.env,
  cwd = process.cwd(),
  commandMs = VERSION_PROBE_MS,
  signal,
) {
  signal?.throwIfAborted();
  const executable = resolveExecutable(env);
  const realPath = nativePayload(executable, env);
  const before = fileDigest(realPath);
  const result = await probe(realPath, [CODEX_COMMAND.VERSION], {
    env,
    cwd,
    timeoutMs: Math.min(commandMs, VERSION_PROBE_MS),
    signal,
  });
  signal?.throwIfAborted();
  const version = /^codex-cli[ \t]+([^\s\x00-\x1f\x7f]+)(?:[ \t]+[^\r\n\x00-\x1f\x7f]*)?$/u.exec(
    result.stdout.trim(),
  )?.[1];
  if (result.error || result.status !== 0 || !validCodexVersion(version))
    throw unsupported(
      `cannot identify Codex at ${executable}: ${result.error?.message ?? (result.stderr.trim() || "invalid version response")}`,
    );
  if (realPath !== nativePayload(executable, env) || before !== fileDigest(realPath))
    throw unsupported(`Codex executable changed during its version probe: ${executable}`);
  const build = crypto
    .createHash("sha256")
    .update(before)
    .update("\0")
    .update(result.stdout.trim())
    .digest("hex");
  return {
    path: executable,
    realPath,
    dir: path.dirname(realPath),
    version,
    build,
    payloadSha256: before,
  };
}

export function requireSupportedCodex(codex) {
  // Version labels identify builds; protocol capabilities determine support.
  if (!validCodexVersion(codex?.version)) throw unsupported("Cannot identify Codex version");
  return codex;
}

export async function codexSupports(
  codex,
  env = process.env,
  cwd = process.cwd(),
  commandMs = APP_SERVER_PROBE_MS,
  signal,
) {
  assertCodexIdentity(codex, env);
  const result = await probe(codex.realPath, [CODEX_COMMAND.APP_SERVER, CODEX_COMMAND.HELP], {
    env,
    cwd,
    timeoutMs: Math.min(commandMs, APP_SERVER_PROBE_MS),
    signal,
  });
  signal?.throwIfAborted();
  return (
    !result.error &&
    result.status === 0 &&
    result.stdout.includes(CODEX_COMMAND.LISTEN) &&
    result.stdout.includes(CODEX_COMMAND.STDIO)
  );
}

function toml(value) {
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  throw unsupported("Codex configuration values must be TOML scalars or arrays");
}

// Discovery and startup must use the same integration policy. Otherwise a
// plugin-only server becomes an override with no transport after plugins stop.
function integrationOffArgs() {
  const args = [];
  for (const name of MCP_OFF_FEATURES) args.push(CODEX_COMMAND.DISABLE, name);
  for (const value of MCP_OFF_CONFIG) args.push(CODEX_COMMAND.CONFIG, value);
  return args;
}

// Ordinary probes start no thread. An explicit history probe that resumes one
// sets loadsThread and also supplies the discovered per-server off switches.
export function appServerArgs({
  config = {},
  mcp = MCP_MODE.INHERIT,
  servers = [],
  mode = APP_SERVER_MODE.SESSION,
  loadsThread = false,
} = {}) {
  const args = [CODEX_COMMAND.APP_SERVER, CODEX_COMMAND.LISTEN, CODEX_COMMAND.STDIO];
  for (const key of Object.keys(config).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key))
      throw unsupported(`invalid Codex configuration key: ${key}`);
    args.push(CODEX_COMMAND.CONFIG, `${key}=${toml(config[key])}`);
  }
  const probe = mode === APP_SERVER_MODE.PROBE;
  if (!probe && mode !== APP_SERVER_MODE.SESSION) throw unsupported("invalid app-server mode");
  if (mcp === MCP_MODE.OFF || probe) {
    args.push(...integrationOffArgs());
    for (const name of probe && !loadsThread ? [] : servers) {
      // Bare TOML segments avoid shell metacharacters on npm's cmd route.
      // Reject rather than silently leave any discovered server enabled.
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw unsupported("unsupported MCP server name");
      args.push(CODEX_COMMAND.CONFIG, `mcp_servers.${name}.enabled=false`);
    }
  } else if (mcp !== MCP_MODE.INHERIT) throw unsupported("invalid MCP policy");
  return args;
}

// A single native launch vector is shared by probes and sessions. No shell or
// package launcher is run; recheck the pinned payload before each process.
export function codexLaunch(codex, args, env = process.env) {
  assertCodexIdentity(codex, env);
  const executable = codex.realPath;
  const childEnv = codexEnvironment(env, codex.dir ?? path.dirname(executable));
  return { command: executable, args, options: { env: childEnv } };
}

export function spawnCodex(codex, args, { env = process.env, ...options } = {}) {
  const vector = codexLaunch(codex, args, env);
  return spawn(vector.command, vector.args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    ...vector.options,
    ...options,
  });
}

export async function mcpServerNames(
  codex,
  { env = process.env, cwd = process.cwd(), signal } = {},
) {
  const vector = codexLaunch(
    codex,
    [CODEX_COMMAND.MCP, CODEX_COMMAND.LIST, CODEX_COMMAND.JSON, ...integrationOffArgs()],
    env,
  );
  const response = await runProcess(vector.command, vector.args, {
    ...vector.options,
    cwd,
    signal,
    timeoutMs: APP_SERVER_PROBE_MS,
    maxBuffer: PROBE_OUTPUT_BYTES,
  });
  if (response.error || response.status !== 0)
    throw unsupported("cannot list configured MCP servers");
  let servers;
  try {
    servers = JSON.parse(response.stdout);
  } catch {
    throw unsupported("invalid MCP server list");
  }
  if (!Array.isArray(servers) || servers.some((server) => typeof server?.name !== "string"))
    throw unsupported("invalid MCP server list");
  return [...new Set(servers.map((server) => server.name))];
}
