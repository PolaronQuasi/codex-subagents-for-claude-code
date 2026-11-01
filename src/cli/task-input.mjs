// Task input: the task file's directive header and the near-miss check for a
// misspelt directive, applyDirectives, which turns directives into options,
// and the loading and removal of the task and prompt files.

import fs from "node:fs";
import path from "node:path";
import {
  GUESS_LONG_CHARS,
  GUESS_LONG_EDITS,
  GUESS_MIN_CHARS,
  MAX_PROMPT_BYTES,
  RPC_MAX_FRAME_BYTES,
  RPC_TURN_ENVELOPE_BYTES,
  DRIVER_TEXT,
  MCP_MODE,
  MCP_DIRECTIVE,
  PROGRESS_DIRECTIVE,
  PROGRESS_MODE,
  QUOTA_FLOOR_DIRECTIVE,
  parseQuotaFloor,
  isYesNo,
  validEffort,
  validSummary,
  MODEL,
  IS_WINDOWS,
  SERVICE_TIER,
  validGitRef,
  validRequestId,
  validRunHandle,
} from "../shared/constants.mjs";
import { digest, readLimited, isAbsolutePath, absoluteOverride } from "../shared/io.mjs";
import { ERRNO } from "../shared/errors.mjs";
import { applyRoleDefaults, ROLES } from "./options.mjs";
import { validReview, structuredReview } from "../shared/review.mjs";
import { loadOutputSchema } from "../shared/output-schema.mjs";
import { validCommitSubject, loadCommitTrailers } from "../shared/commit-message.mjs";

// A directive's cwd: none (a scratch workspace), worktree, or an absolute path.
const cwdDirective = (value) => value === "none" || value === "worktree" || isAbsolutePath(value);

const DIRECTIVES = new Set([
  "commit-subject",
  "commit-trailers",
  "compact",
  "tier",
  "output-schema",
  "review",
  PROGRESS_DIRECTIVE,
  MCP_DIRECTIVE,
  QUOTA_FLOOR_DIRECTIVE,
  "effort",
  "model",
  "summary",
  "keep",
  "write",
  "cwd",
  "worktree",
  "worktree-ref",
  "prompt-file",
  "request-id",
  "continue",
  "cancel",
  "close",
]);

// Whether value is one the named directive accepts; a capitalised line with
// such a value was meant as that directive, any other is prose.
function directiveValue(name, value) {
  switch (name) {
    case "commit-subject":
      return validCommitSubject(value);
    case "commit-trailers":
      return isAbsolutePath(value);
    case PROGRESS_DIRECTIVE:
      return Object.values(PROGRESS_MODE).includes(value);
    case MCP_DIRECTIVE:
      return Object.values(MCP_MODE).includes(value);
    case QUOTA_FLOOR_DIRECTIVE:
      return parseQuotaFloor(value) !== null;
    case "effort":
      return validEffort(value);
    case "model":
      return MODEL.test(value);
    case "summary":
      return validSummary(value);
    case "tier":
      return SERVICE_TIER.test(value);
    case "review":
      return validReview(value);
    case "keep":
    case "compact":
    case "write":
    case "worktree":
      return isYesNo(value);
    case "cwd":
      return cwdDirective(value);
    case "worktree-ref":
      return validGitRef(value);
    case "prompt-file":
    case "output-schema":
      return isAbsolutePath(value);
    case "request-id":
      return validRequestId(value);
    default:
      return validRunHandle(value);
  }
}

// Directive names are lowercase. A line such as "Effort: low", a known name in
// other case with a value that directive accepts, is refused rather than sent
// as text, which would silently drop the header; "Write: a parser for X" is
// prose and stays text.
function refuseCapitalised(line) {
  const match = /^([A-Za-z][A-Za-z-]*):[ \t]*(.*?)[ \t]*\r?$/.exec(line ?? "");
  const name = match?.[1].toLowerCase();
  if (match && name !== match[1] && DIRECTIVES.has(name) && directiveValue(name, match[2]))
    throw new Error(`directive names are lowercase: write \`${name}: ${match[2]}\``);
}

// Directive lines come first, one per line, "name: value" with a known name;
// the first other line starts the task text, which is kept byte for byte
// (only leading blank lines between header and text are dropped).
export function parseTaskFile(buffer) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  const lines = text.split("\n");
  const directives = {};
  let index = 0;
  for (; index < lines.length; index++) {
    const match = /^([a-z-]+):[ \t]*(.*?)[ \t]*\r?$/.exec(lines[index]);
    if (!match || !DIRECTIVES.has(match[1])) {
      // A header line in the wrong case, or a letter or two off a directive,
      // is a mistake; sent as text, it would silently drop the whole header.
      refuseCapitalised(lines[index]);
      const shape = /^([a-z][a-z_-]*):[ \t]*\S/.exec(lines[index]);
      const near = shape && nearDirective(shape[1]);
      if (near) throw new Error(`unknown directive ${shape[1]} (did you mean ${near}?)`);
      break;
    }
    const [, name, value] = match;
    if (name in directives) throw new Error(`duplicate directive ${name}`);
    if (!value) throw new Error(`directive ${name} needs a value`);
    if (/[\x00-\x1f\x7f]/.test(value))
      throw new Error(`directive ${name} contains control characters`);
    directives[name] = value;
  }
  while (index < lines.length && /^\r?$/.test(lines[index])) index++;
  // A directive after a blank line would be task text, so it would be ignored.
  const stray = /^([a-z-]+):[ \t]*\S/.exec(lines[index] ?? "");
  if (stray && DIRECTIVES.has(stray[1])) {
    throw new Error(
      `directive ${stray[1]} comes after a blank line; directive lines must be the first lines of the task file`,
    );
  }
  refuseCapitalised(lines[index]);
  return { directives, body: lines.slice(index).join("\n") };
}

// Misspellings too close to a short directive for the edit-distance rule.
const MISSPELT = new Map([["kept", "keep"]]);

// The directive a header name was probably meant to be: a known misspelling,
// or a name one edit away from the directive, two (GUESS_LONG_EDITS) from a
// directive of seven letters or more (GUESS_LONG_CHARS); names under four
// letters (GUESS_MIN_CHARS) are not guessed.
function nearDirective(name) {
  if (name.length < GUESS_MIN_CHARS || DIRECTIVES.has(name)) return null;
  return (
    MISSPELT.get(name) ??
    [...DIRECTIVES].find(
      (directive) =>
        editDistance(name, directive) <=
        (directive.length >= GUESS_LONG_CHARS ? GUESS_LONG_EDITS : 1),
    ) ??
    null
  );
}

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

// Turns validated directives into the same options the command line would set.
export function applyDirectives(options, directives) {
  const lifecycle = ["continue", "cancel", "close"].filter(
    (name) => directives[name] !== undefined,
  );
  if (lifecycle.length > 1)
    throw new Error("use only one of the continue, cancel and close directives");
  const mode = lifecycle[0] ?? "launch";
  const allowed = {
    launch: DIRECTIVES,
    continue: new Set([
      "commit-subject",
      "commit-trailers",
      "compact",
      "tier",
      "output-schema",
      "review",
      PROGRESS_DIRECTIVE,
      "continue",
      "effort",
      "model",
      "summary",
      "write",
      "prompt-file",
      "request-id",
      MCP_DIRECTIVE,
      QUOTA_FLOOR_DIRECTIVE,
    ]),
    cancel: new Set(["cancel"]),
    close: new Set(["close"]),
  }[mode];
  if (directives[PROGRESS_DIRECTIVE] !== undefined) {
    if (!Object.values(PROGRESS_MODE).includes(directives[PROGRESS_DIRECTIVE]))
      throw new Error("directive progress needs on or off");
    options.progress = directives[PROGRESS_DIRECTIVE];
  }
  if (directives.mcp !== undefined) {
    if (!Object.values(MCP_MODE).includes(directives.mcp))
      throw new Error("directive mcp needs off or inherit");
    options.mcp = directives.mcp;
  }
  if (directives[QUOTA_FLOOR_DIRECTIVE] !== undefined) {
    const floor = parseQuotaFloor(directives[QUOTA_FLOOR_DIRECTIVE]);
    if (floor === null)
      throw new Error("directive quota-floor needs a whole percent from 0 to 100, such as 10%");
    options["quota-floor"] = floor;
  }
  for (const name of Object.keys(directives)) {
    if (!allowed.has(name)) throw new Error(`directive ${name} cannot be combined with ${mode}`);
  }
  if (IS_WINDOWS) {
    for (const name of ["cwd", "prompt-file", "output-schema", "commit-trailers"]) {
      const value = directives[name];
      if (value === undefined || (name === "cwd" && cwdDirective(value))) continue;
      // Use the same native-path guidance as CLI options and environment overrides.
      absoluteOverride({ [name]: value }, name);
    }
  }
  if (directives["commit-subject"] !== undefined) {
    if (!validCommitSubject(directives["commit-subject"]))
      throw new Error("invalid commit-subject");
    options["commit-subject"] = directives["commit-subject"];
  }
  if (directives["commit-trailers"] !== undefined) {
    if (!isAbsolutePath(directives["commit-trailers"]))
      throw new Error("commit-trailers needs an absolute JSON file path");
    options["commit-trailers"] = directives["commit-trailers"];
  }
  const yesNo = (name) => {
    if (directives[name] === undefined) return undefined;
    if (!isYesNo(directives[name])) throw new Error(`directive ${name} must be yes or no`);
    return directives[name] === "yes";
  };
  if (directives.effort !== undefined) {
    if (!validEffort(directives.effort))
      throw new Error(`unsupported effort ${directives.effort} in directive`);
    options.effort = directives.effort;
  }
  if (directives.model !== undefined) {
    if (!MODEL.test(directives.model)) throw new Error("directive model needs a model ID or role");
    options.model = ROLES[directives.model]?.model ?? directives.model;
  }
  if (directives.summary !== undefined) {
    if (!validSummary(directives.summary))
      throw new Error("directive summary needs auto, concise, detailed or none");
    options.summary = directives.summary;
  }
  if (directives["output-schema"] !== undefined) {
    if (!isAbsolutePath(directives["output-schema"]))
      throw new Error("output-schema needs an absolute path");
    options["output-schema"] = directives["output-schema"];
  }
  if (directives.review !== undefined) {
    if (!validReview(directives.review))
      throw new Error("review needs uncommitted, base:<ref>, commit:<hex>, or custom");
    options.review = directives.review;
  }
  if (directives.tier !== undefined) {
    if (!SERVICE_TIER.test(directives.tier))
      throw new Error("tier needs a lowercase service tier ID or default");
    options.tier = directives.tier;
  }
  if (directives["request-id"] !== undefined) {
    if (!validRequestId(directives["request-id"]))
      throw new Error(
        "directive request-id needs 1-64 letters, digits, dots, underscores or dashes",
      );
    options["request-id"] = directives["request-id"];
  }
  const write = yesNo("write");
  const compact = yesNo("compact");
  if (compact !== undefined) {
    if (mode !== "continue") throw new Error("compact requires continue");
    options.compact = compact;
  }
  if (write !== undefined) options.write = write;
  const keep = yesNo("keep");
  if (keep !== undefined) options["keep-state"] = keep;
  const worktree = yesNo("worktree");
  if (worktree !== undefined) options.worktree = worktree;
  if (directives.cwd !== undefined) {
    if (!cwdDirective(directives.cwd))
      throw new Error("directive cwd needs an absolute path, none or worktree");
    if (directives.cwd === "none") options["scratch-workspace"] = true;
    else if (directives.cwd === "worktree") options.worktree = true;
    else options.cwd = directives.cwd;
  }
  if (options.worktree && options["scratch-workspace"])
    throw new Error("cwd: none cannot be combined with a worktree");
  if (directives["worktree-ref"] !== undefined) {
    if (!validGitRef(directives["worktree-ref"]))
      throw new Error("directive worktree-ref needs a ref without whitespace or a leading dash");
    if (!options.worktree)
      throw new Error("directive worktree-ref needs worktree: yes or cwd: worktree");
    options["worktree-ref"] = directives["worktree-ref"];
  }
  if (directives["prompt-file"] !== undefined) {
    if (!isAbsolutePath(directives["prompt-file"]))
      throw new Error("directive prompt-file needs an absolute path");
    options["prompt-file"] = directives["prompt-file"];
  }
  options.mode = mode;
  if (mode !== "launch") {
    if (!validRunHandle(directives[mode]))
      throw new Error(`directive ${mode} needs a run key or rq:<request id>`);
    options.key = directives[mode];
  }
  return options;
}

// Reads the task file named by --task-file: its directives become options (a
// launch takes the role's model and effort as defaults; --default-keep keeps a
// launch unless the file says keep: no) and the returned task source carries
// the file, its bytes and the task text. Null when there is no task file.
export function prepareTask(options, cwd) {
  if (options.mode !== "task") return null;
  const fromStdin = options["task-file"] === "-";
  const taskFile = fromStdin ? null : path.resolve(cwd, options["task-file"]);
  if (!fromStdin && !fs.existsSync(taskFile))
    throw new Error(`task file does not exist: ${taskFile}; check --task-file`);
  if (!fromStdin && fs.lstatSync(taskFile).isSymbolicLink())
    throw new Error("task file must not be a symbolic link");
  const bytes = fromStdin ? options.stdinBytes : readLimited(taskFile, MAX_PROMPT_BYTES);
  if (!Buffer.isBuffer(bytes)) throw new Error("stdin has not been read");
  const { directives, body } = parseTaskFile(bytes);
  if ((directives.close !== undefined || directives.cancel !== undefined) && body.trim())
    throw new Error("close/cancel task files cannot contain a task body; nothing was consumed");
  applyDirectives(options, directives);
  if (options.mode === "launch") {
    applyRoleDefaults(options);
    if (!options.model || !options.effort)
      throw new Error(
        "--task-file needs --role ROLE, or --model and --effort as defaults; or start the file with continue: RUN_KEY to continue a kept run",
      );
  } else if (options.mode === "continue" && options.role) {
    // A supplied role explicitly selects its model, but does not reset the
    // retained effort. A model directive/option takes precedence over the role.
    options.model ??= ROLES[options.role].model;
  }
  if (options.detach && options.mode !== "launch" && options.mode !== "continue") {
    throw new Error(
      `--detach cannot be used with a ${options.mode} directive; it is for launches and continue`,
    );
  }
  // The agents keep every launch, so SendMessage can add a turn; the file can still say keep: no.
  if (options["default-keep"] && options.mode === "launch" && directives.keep === undefined)
    options["keep-state"] = true;
  if (directives["prompt-file"] !== undefined && body.trim()) {
    throw new Error(
      "the task file has a prompt-file: directive and task text too, and the text would be ignored; " +
        "remove the text, or drop prompt-file: and write the whole task in the file",
    );
  }
  // The command line refuses --force without --close, and --close with a task
  // file; this guards callers of the exported API, which skip parseArgs.
  if (options.force && options.mode !== "close") throw new Error("--force works with --close only");
  return { file: taskFile, bytes, body };
}

// The prompt of a launch or a continued turn: --prompt-file resolved against
// base, else the task file's text. Returns the prompt bytes and the files to
// remove once the job has started: a prompt file the caller handed over (a
// directive's prompt file stays in place) and the task file.
export function loadPrompt(options, taskSource, base) {
  if (options["commit-subject"] !== undefined) options.commitSubject = options["commit-subject"];
  if (options["commit-trailers"] !== undefined)
    options.commitTrailers = loadCommitTrailers(path.resolve(base, options["commit-trailers"]));
  if (
    (options.commitSubject !== undefined || options.commitTrailers !== undefined) &&
    (!options.write || (options.mode === "launch" && !options.worktree))
  )
    throw new Error("commit metadata requires a write worktree turn");
  if (options.compact && options.mode !== "continue") throw new Error("compact requires continue");
  if (options.review && options.tier !== undefined)
    throw new Error("tier is not supported with native review");
  if (options["output-schema"] !== undefined) {
    if (options.review) throw new Error("output-schema is not supported with native review");
    options.outputSchema = loadOutputSchema(options["output-schema"]);
  }
  if (options.review && options.write) throw new Error("native review requires read-only mode");
  let prompt;
  const files = [];
  if (options["prompt-file"] === "-") {
    if (!Buffer.isBuffer(options.stdinBytes)) throw new Error("stdin has not been read");
    prompt = options.stdinBytes;
  } else if (options["prompt-file"]) {
    const promptFile = path.resolve(base, options["prompt-file"]);
    if (!fs.existsSync(promptFile))
      throw new Error(`prompt file does not exist: ${promptFile}; check --prompt-file`);
    if (fs.lstatSync(promptFile).isSymbolicLink())
      throw new Error("prompt file must not be a symbolic link");
    prompt = readLimited(promptFile, MAX_PROMPT_BYTES);
    if (!taskSource) files.push({ file: promptFile, bytes: prompt });
  } else if (taskSource) prompt = Buffer.from(taskSource.body, "utf8");
  else if (structuredReview(options.review)) prompt = Buffer.alloc(0);
  else throw new Error("no prompt given");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(prompt);
  if (structuredReview(options.review)) {
    if (text.trim())
      throw new Error(
        "structured review targets cannot include task text; use review: custom for instructions",
      );
  } else if (!text.trim()) throw new Error("prompt is empty");
  // Validate the wire representation before claiming a request or reserving
  // a turn. JSON escaping can multiply even a raw prompt below its byte cap.
  if (
    Buffer.byteLength(JSON.stringify(text)) +
      Buffer.byteLength(JSON.stringify(options.outputSchema ?? null)) +
      RPC_TURN_ENVELOPE_BYTES >
    RPC_MAX_FRAME_BYTES
  )
    throw new Error(DRIVER_TEXT.PROMPT_FRAME);
  if (taskSource?.file) files.push({ file: taskSource.file, bytes: taskSource.bytes });
  return { prompt, files };
}

// Removes the files the caller handed over, after a confirmed launch or a
// finished lifecycle action, when they are unchanged; --keep-prompt keeps them.
export async function consumeFiles(files, { keepPrompt, warn }) {
  if (keepPrompt) return;
  for (const { file, bytes } of files) {
    try {
      if (
        !fs.lstatSync(file).isSymbolicLink() &&
        digest(readLimited(file, MAX_PROMPT_BYTES)) === digest(bytes)
      )
        fs.unlinkSync(file);
      else await warn(`${path.basename(file)} changed after launch; leaving it in place.`);
    } catch (error) {
      if (error.code !== ERRNO.ENOENT) await warn(`Could not remove ${file}: ${error.message}`);
    }
  }
}

// When a repeated request attaches instead of launching, only the task file is
// removed; a prompt file the caller handed over stays.
export const onlyTaskFile = (files, taskSource) =>
  files.filter((item) => item.file === taskSource?.file);
