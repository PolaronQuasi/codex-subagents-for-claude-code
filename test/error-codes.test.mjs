// The guards against inline literals: codes, errno codes, signals, exit
// values, platform names, job statuses, the vocabularies and the timing, retry
// and size policies are named once, in src/shared/errors.mjs and src/shared/constants.mjs (a
// tool names its own policies at its top), and every reference names a key
// they define. Each check is a detector that must catch a planted line and
// leave a planted look-alike alone.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as errors from "../src/shared/errors.mjs";
import * as constants from "../src/shared/constants.mjs";
import { PROCESSES } from "../src/shared/process-stop.mjs";
import { PROCESS_PROBE } from "../src/shared/process-identity.mjs";
import { moduleFiles } from "../tools/test-files.mjs";
import { codeOnly } from "./support/code-text.mjs";

const { CODES, ERRNO, EXIT, RUN_LOCK_CODES, SIGNALS, isMissing } = errors;
const {
  AUDIT_TRANSITION,
  STOP_OUTCOME,
  JOB_STATUS,
  LOST_JOB,
  OUTCOME,
  PLATFORM,
  RUN_JOB,
  WORKER_STATE,
  isGoneWorkerState,
} = constants;

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CODE_VALUES = new Set(Object.values(CODES));
// SCREAMING_CASE names that are not runner codes: environment variables
// (CODEX_*, CLAUDE_*, GIT_*, NODE_*, NPM_*, LC_*, XDG_*, GITEA_*, GITHUB_*)
// Git operation marker filenames and getconf's CLK_TCK.
const NOT_A_CODE =
  /^(?:CODEX_|CLAUDE_|GIT_|NODE_|NPM_|LC_|XDG_|GITEA_|GITHUB_)|^(?:CLK_TCK|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD)$/;
// The errno codes and signals POSIX names, with those Node.js knows on this
// host, so the guard reads the same on every host (Windows' os.constants has
// 11 signals and lacks ESTALE, EDQUOT and others), and a word like "ESM",
// "EOL" or "SIGNATURE" is neither.
const POSIX_ERRNO = `E2BIG EACCES EADDRINUSE EADDRNOTAVAIL EAFNOSUPPORT EAGAIN EALREADY EBADF
EBADMSG EBUSY ECANCELED ECHILD ECONNABORTED ECONNREFUSED ECONNRESET EDEADLK
EDESTADDRREQ EDOM EDQUOT EEXIST EFAULT EFBIG EHOSTUNREACH EIDRM EILSEQ
EINPROGRESS EINTR EINVAL EIO EISCONN EISDIR ELOOP EMFILE EMLINK EMSGSIZE
EMULTIHOP ENAMETOOLONG ENETDOWN ENETRESET ENETUNREACH ENFILE ENOBUFS ENODATA
ENODEV ENOENT ENOEXEC ENOLCK ENOLINK ENOMEM ENOMSG ENOPROTOOPT ENOSPC ENOSR
ENOSTR ENOSYS ENOTCONN ENOTDIR ENOTEMPTY ENOTRECOVERABLE ENOTSOCK ENOTSUP
ENOTTY ENXIO EOPNOTSUPP EOVERFLOW EOWNERDEAD EPERM EPIPE EPROTO
EPROTONOSUPPORT EPROTOTYPE ERANGE EROFS ESPIPE ESRCH ESTALE ETIME ETIMEDOUT
ETXTBSY EWOULDBLOCK EXDEV`.split(/\s+/);
const POSIX_SIGNALS = `SIGABRT SIGALRM SIGBUS SIGCHLD SIGCONT SIGFPE SIGHUP SIGILL SIGINT SIGKILL
SIGPIPE SIGPOLL SIGPROF SIGQUIT SIGSEGV SIGSTOP SIGSYS SIGTERM SIGTRAP
SIGTSTP SIGTTIN SIGTTOU SIGURG SIGUSR1 SIGUSR2 SIGVTALRM SIGWINCH SIGXCPU
SIGXFSZ`.split(/\s+/);
const ERRNO_NAMES = new Set([
  ...POSIX_ERRNO,
  ...Object.keys(os.constants.errno),
  ...Object.values(ERRNO),
]);
const SIGNAL_NAMES = new Set([
  ...POSIX_SIGNALS,
  ...Object.keys(os.constants.signals),
  ...Object.values(SIGNALS),
]);
// The names Windows' os.constants lacks, planted below.
const NOT_ON_WINDOWS = `SIGUSR1 SIGUSR2 SIGCHLD SIGPIPE SIGALRM SIGCONT SIGSTOP SIGTSTP ESTALE
EDQUOT EMULTIHOP EOWNERDEAD ENOTRECOVERABLE`.split(/\s+/);
// Vocabulary words no other vocabulary in src/ uses, so a bare one is always an
// inline copy. "unknown", "stale" and "interrupted" also name a job activity, a
// lock or agent state and an abort, so they are not checked.
const VOCABULARY = new Set(
  [
    WORKER_STATE.GONE,
    WORKER_STATE.REUSED,
    WORKER_STATE.WORKER,
    STOP_OUTCOME.STOPPED,
    STOP_OUTCOME.GONE,
    STOP_OUTCOME.ALIVE,
    OUTCOME.STILL_RUNNING,
    LOST_JOB.AMBIGUOUS,
    RUN_JOB.RECORDED,
    RUN_JOB.ROLLED_BACK,
  ].map((word) => word.toLowerCase()),
);
// Settlement replies that are everyday words too: inline copies only where a
// reply is compared, returned, switched on, printed or written (a helper's
// answer is a line it prints), resolved, or given as a value (an object's,
// or a branch of a condition).
const REPLY_WORDS = new Set(["ready", "changed", "live"]);
// Shared words need their semantic context: a cwd of "none", an error
// message "interrupted", or a display label "delivered" is not an outcome.
const CONTEXT_WORDS = new Set(
  [WORKER_STATE, STOP_OUTCOME, STOP_OUTCOME, OUTCOME, LOST_JOB, RUN_JOB]
    .flatMap(Object.values)
    .concat(["interrupted", "stale"]),
);
const VOCABULARY_CONTEXT =
  /\b(?:kind|outcome|reply|transition|workerState|brokerOutcome|stopOutcome|interruptOutcome)\s*(?::|=|[!=]==?)\s*(["'`])([a-z-]+)\1/g;
const REVERSED_VOCABULARY =
  /(["'`])([a-z-]+)\1\s*[!=]==?\s*(?:[\w$]+\.)?(?:kind|outcome|reply|transition|workerState|brokerOutcome|stopOutcome|interruptOutcome)\b/g;
const regexWords = (line, code = codeOnly(line)) =>
  [...line.matchAll(/\/(?![*/])(?:[^/\n\\]|\\.)+\/[dgimsuyv]*/g)]
    .filter((match) => code[match.index] === "/" && code[match.index + 1] === " ")
    .flatMap(([pattern]) =>
      [...pattern.matchAll(/(?:^\/|[|(:^])([A-Za-z][A-Za-z0-9_-]*)(?=[|)$/])/g)].map(
        (match) => match[1],
      ),
    );
// A quoted word, the line break a printed answer may carry included.
const QUOTED_WORD = String.raw`(["'\`])([a-z-]+)(?:\\r)?(?:\\n)?\1`;
const REPLY_CONTEXTS = [
  String.raw`[!=]==?\s*${QUOTED_WORD}`,
  String.raw`${QUOTED_WORD}\s*[!=]==?`,
  String.raw`\b(?:return|case)\s+${QUOTED_WORD}`,
  String.raw`(?:\bconsole\.\w+|\.write|\bresolve)\(\s*${QUOTED_WORD}`,
  String.raw`[?:]\s*${QUOTED_WORD}`,
].map((context) => new RegExp(context, "g"));
// A number other than 0 and 1 (and -1, where a sign may stand): those mean
// "none", "one" and "not found", not a policy. A literal may be hexadecimal,
// have digit separators, a fraction, an exponent or the BigInt suffix.
const POLICY_NUMBER = String.raw`(?![01](?![\w.]))\d[\w.]*`;
// Up to two levels of parentheses inside a call's arguments.
const ARGUMENTS = String.raw`(?:[^()]|\((?:[^()]|\([^()]*\))*\))*`;
// A name that says a time, a size or a count by its last word (...Ms,
// ...Bytes, ...Retries, ...Attempts, ...Rounds, ...Lines, ...Chars), in
// camelCase or SCREAMING_CASE, or is that word alone: timeoutMs, MAX_BYTES,
// retries.
const POLICY_SUFFIXES = ["Ms", "Bytes", "Retries", "Attempts", "Rounds", "Lines", "Chars"];
const POLICY_NAME = String.raw`(?:[\w$]*(?:${POLICY_SUFFIXES.join("|")})|[\w$]*_(?:${POLICY_SUFFIXES.map((word) => word.toUpperCase()).join("|")})|(?:${POLICY_SUFFIXES.map((word) => word.toLowerCase()).join("|")}))`;
// A name that says a limit or a count: limit, count or attempt(s), or one
// ending in Limit, Count or Attempt(s) (LIMIT, COUNT, ATTEMPTS); account is
// none.
const LIMIT_NAME = String.raw`(?:limit|count|attempts?|[\w$]*(?:Limit|Count|Attempts?)|[\w$]*_(?:LIMIT|COUNT|ATTEMPTS?))`;
// A number of three digits or more, as one token.
const LARGE_NUMBER = String.raw`(?<![\w$.])\d(?:_?\d){2,}(?:\.\d+)?n?(?![\w$.])`;
// The contexts of a timing, retry or size policy written as a number: a timer,
// a sleep, a deadline, a retry, round or probe counter, a loop bound, a
// comparison with a limit or with a number of three digits or more,
// Math.min/max of one, a slice cap, a default parameter or
// an option named for a time, a size or a count, a default named for a limit
// or a count, and the options and calls that take one.
const POLICY_CONTEXTS = [
  /\b(?:setTimeout|setInterval)\([^;]*,\s*\d/,
  /^\s*\},\s*\d[\d_]+\s*\)/,
  /\b(?:sleep|sleepSync|delay)\(\s*\d/,
  /Date\.now\(\)\s*[+-]\s*\d|\b[\w$]*deadline[\w$]*\s*=\s*[^;]*[+-]\s*\d[\d_]+/i,
  /\b(?:attempts?|retr(?:y|ies)|tries|rounds?|steps)(?:\+\+|--)?\s*[<>]=?\s*\d/,
  new RegExp(
    String.raw`\b(?:count|probes?|confirmations?)(?:\+\+|--)?\s*[<>]=?\s*${POLICY_NUMBER}`,
  ),
  new RegExp(String.raw`\bfor\s*\(let\s+[\w$]+\s*=\s*\d+;\s*[\w$]+\s*[<>]=?\s*${POLICY_NUMBER}`),
  /\b(?:max|limit|cap)\w*\s*[<>]=?\s*\d[\d_]+/i,
  /[<>]=?\s*\d[\d_]{2,}/,
  /\bMath\.(?:min|max)\([^)]*(?<![\w$.])\d[\d_]{2,}/,
  /\.slice\([^)]*?(?<![\w$.])-?\d[\d_]{2,}/,
  new RegExp(String.raw`\b${POLICY_NAME}\s*=\s*${POLICY_NUMBER}`),
  new RegExp(String.raw`\b${POLICY_NAME}["']?\s*:\s*${POLICY_NUMBER}`),
  new RegExp(String.raw`\b${LIMIT_NAME}\s*=\s*${POLICY_NUMBER}`),
  new RegExp(String.raw`\b${LIMIT_NAME}["']?\s*:\s*${POLICY_NUMBER}`),
  /\b(?:timeout|timeoutMs|maxBuffer|maxRetries|retryDelay|waitMs|highWaterMark)\s*:\s*\d/,
  new RegExp(String.raw`\bAtomics\.wait\(${ARGUMENTS},\s*${POLICY_NUMBER}\s*\)`),
  /\bAbortSignal\.timeout\(\s*\d|\.setTimeout\(\s*\d/,
  new RegExp(String.raw`\bBuffer\.alloc(?:Unsafe)?\(\s*${POLICY_NUMBER}`),
  new RegExp(String.raw`\breadLimited\(${ARGUMENTS},\s*\d`),
];
// The contexts read in a line's code alone (codeOnly, test/support/code-text.mjs): its
// comments and the insides of its strings, templates and regular expressions
// blanked, but a template's ${...} kept as code, where a date ("2026-10-28"),
// a note ("// 30 s + 1000 ms"), a bracket in a message or the prose of a
// template that spans lines ("exit 130/143") is no code:
// - arithmetic with a literal of three digits or more: start + 30_000,
//   60 * 60 * 1000, limit * 1024, total -= 500, minutes % 1440, inside a
//   template's ${...} too. Prettier spaces every binary operator, so arithmetic
//   is an operator with a space on each side;
// - a call given a number of three digits or more, truncate(text, 300);
// - an array of numbers on one line, [100, 200], an index (parts[2],
//   match?.[2]) being none, and a line of numbers alone, where Prettier wraps a
//   long array or argument list;
// - a comparison with a number of two digits, major < 22;
// - a decimal number given as a value: a branch of a condition,
//   cond ? 100 : value or a wrapped ": 100", whose ? and : Prettier spaces,
//   unlike a key's colon; a default after ?? or ||; and an object's value of
//   three digits or more, { s: 1000 }. A file mode or a mask (0o644, 0xff) is
//   a bit pattern, not a quantity.
const VALUE_NUMBER = String.raw`(?!0[xXoObB])${POLICY_NUMBER}`;
const CODE_CONTEXTS = [
  /\.slice\(\s*0\s*,\s*(?![01](?!\d))\d+\s*\)/,
  /\.slice\([^)]*?(?<![\w$.])-?\d\d[\d_]*(?![\w.])/,
  /\b(?:minutes|seconds|hours|\w+Ms)\s*[%/*]\s*(?![01](?![\w.]))\d[\d_]*/,
  new RegExp(String.raw`(?:^|\s)[-+*/%]=?\s+${LARGE_NUMBER}|${LARGE_NUMBER}\s+[-+*/%]=?(?:\s|$)`),
  new RegExp(String.raw`\b[\w$.]+\(\s*(?:${ARGUMENTS},\s*)?-?${LARGE_NUMBER}\s*[,)]`),
  new RegExp(String.raw`(?<![\w$)\].]\s*)\[\s*(?:[^\]]*,\s*)?-?${POLICY_NUMBER}\s*[,\]]`),
  new RegExp(
    String.raw`^\s*(?:-?\d[\w.]*\s*,\s*)*-?${POLICY_NUMBER}\s*(?:,\s*-?\d[\w.]*\s*)*,?\s*$`,
  ),
  /[<>]=?\s*\d\d(?![\w.])/,
  new RegExp(String.raw`(?:^|\s)(?:\?\?|\|\||[?:])\s+-?${VALUE_NUMBER}\s*(?:[;,)\]}:]|$)`),
  new RegExp(String.raw`[\w$]["']?:\s+-?${LARGE_NUMBER}`),
];
// Every number but 0, 1 and -1 is named, a unit (a day in milliseconds, a
// mebibyte) too: in src/shared/constants.mjs for src/, in a top-level definition for
// a tool or the shim. A const, let or var, or a variable or property, set to a
// number or to arithmetic of numbers alone anywhere else is an unnamed policy
// or unit. A for loop's initialiser (for (let i = 2; ...)) is no setting: its
// bound is the policy, and the loop-bound context reads that.
const NUMERAL = String.raw`\(?\s*-?\d[\w.]*\s*\)?`;
const NUMERIC_SETTING = new RegExp(
  String.raw`(?:(?<!\bfor\s*\(\s*)\b(?:const|let|var)\s+|^\s*)[\w$.]+\s*=\s*(${NUMERAL}(?:\s*(?:\*\*|<<|>>>?|[-+*/%|&^])\s*${NUMERAL})*)\s*(?:[;,]|$)`,
);
// A tool's policy: a top-level SCREAMING_CASE constant. The exemption covers
// the whole statement, however many lines Prettier wraps it over: it ends on
// the first line whose code (codeOnly, read over the whole file, so the
// brackets and quotes of strings, templates, regular expressions and comments
// are none, and a template's lines are text) closes its brackets with a
// semicolon.
const POLICY_DEFINITION = /^(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\s*=/;
function toolPolicies(lines) {
  const found = [];
  let statement = [];
  let open = null,
    depth = 0;
  for (const { at, line, code } of lines) {
    if (open === null && POLICY_DEFINITION.test(line)) open = at;
    if (open === null) {
      for (const kind of ["policy", "numericSetting"])
        found.push(...detect[kind](line, code).map((finding) => `${at} ${finding}`));
      continue;
    }
    statement.push({ at, line, code });
    for (const char of code) depth += "([{".includes(char) ? 1 : ")]}".includes(char) ? -1 : 0;
    if (depth <= 0 && code.trim().endsWith(";")) {
      // Naming a function in capitals does not turn the numbers in its body
      // into named policies. Read the complete initializer, including wrapped
      // arrows and object methods, before granting the data-only exemption.
      if (
        statement.some(({ code }) =>
          /=>|\bfunction\b|^\s*(?:async\s+)?\w+\s*\([^)]*\)\s*\{/.test(code),
        )
      )
        for (const item of statement)
          for (const kind of ["policy", "numericSetting"])
            found.push(
              ...detect[kind](item.line, item.code).map((finding) => `${item.at} ${finding}`),
            );
      open = null;
      depth = 0;
      statement = [];
    }
  }
  if (open !== null) found.push(`${open} a policy definition that never ends`);
  return found;
}
const PLATFORM_WORD = new RegExp(`(["'\`])(?:${Object.values(PLATFORM).join("|")})\\1`);
const STATUS_WORD = new RegExp(`(["'\`])(?:${Object.values(JOB_STATUS).join("|")})\\1`);

const isComment = (line) => /^\s*(?:\/\/|\/?\*)/.test(line);
// The code lines of a file, comments left out, as { at, line, code }: code is
// the line's code alone, read over the whole file (codeOnly), so every line of
// a template that spans lines is text, its ${...} code.
function codeLines(file) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const code = codeOnly(text).split("\n");
  return text
    .split("\n")
    .map((line, index) => ({ at: `${file}:${index + 1}`, line, code: code[index] }))
    .filter(({ line }) => !isComment(line));
}
// The modules of a folder (relative to the repository), at any depth, fixture
// folders left out, but the skipped files.
const modules = (folder, skip = []) =>
  moduleFiles(ROOT, folder, { skip: ["fixtures"] }).filter(
    (file) => !skip.includes(path.basename(file)),
  );
const linesOf = (files) => files.flatMap(codeLines);

// The detectors. Each takes one code line, and the policy detector its code
// alone too (codeOnly of the line by itself for a planted one), and answers
// what it writes inline.
const detect = {
  // A runner code as a string.
  code: (line) =>
    [...line.matchAll(/(["'`])([A-Z][A-Z0-9]*_[A-Z0-9_]*)\1/g)]
      .map(([, , literal]) => literal)
      .filter((literal) => !NOT_A_CODE.test(literal)),
  // A code tested or built from a fragment: a regular expression or a
  // startsWith/endsWith/includes on a part of one, a quoted part with a
  // leading underscore, or a template that pastes one together.
  codeFragment: (line) =>
    [
      // In a regular expression: a code, or a prefix of codes (it ends with _).
      ...[...line.matchAll(/\/(?![*/])(?:[^/\n\\]|\\.)+\/[dgimsuyv]*/g)]
        .flatMap(([regex]) => regex.match(/[A-Z][A-Z0-9_]*_[A-Z0-9_]*/g) ?? [])
        .filter((token) => CODE_VALUES.has(token) || token.endsWith("_")),
      ...[...line.matchAll(/\.(?:startsWith|endsWith|includes)\(\s*(["'`])(_?[A-Z][A-Z0-9_]*)\1/g)]
        .map((match) => match[2])
        .filter((part) => part.startsWith("_") || part.endsWith("_")),
      ...[...line.matchAll(/(["'`])(_[A-Z][A-Z0-9_]*)\1/g)].map((match) => match[2]),
      ...[...line.matchAll(/\b([A-Z][A-Z0-9_]*_)\$\{/g)].map((match) => match[1]),
      ...[...line.matchAll(/\}(_[A-Z][A-Z0-9_]*)/g)].map((match) => match[1]),
    ].filter((part) => !NOT_A_CODE.test(part)),
  // An errno code or a signal name (ERRNO_NAMES, SIGNAL_NAMES), as a string.
  errnoOrSignal: (line, code = codeOnly(line)) =>
    [
      ...[...line.matchAll(/(["'`])([A-Z][A-Z0-9]+)\1/g)].map(([, , word]) => word),
      ...regexWords(line, code),
    ].filter((word) => ERRNO_NAMES.has(word) || SIGNAL_NAMES.has(word)),
  // An exit value written as a number, or a runner exit code compared with
  // one (a numeric .code is a runner exit code; other programs' exits are
  // .status).
  exitValue: (line) =>
    /\bdone\(\s*\d|process\s*(?:\.\s*exit|\[\s*["']exit["']\s*\])\s*\(\s*\d|exitCode\s*[=:]\s*\d|["']exitCode["']\s*\]\s*=\s*\d|\.code\s*[!=]==?\s*\d/.test(
      line,
    )
      ? [line.trim()]
      : [],
  // A platform name as a string, or os.platform().
  platform: (line) =>
    PLATFORM_WORD.test(line) || /\bos\.platform\(\)/.test(line) ? [line.trim()] : [],
  // A job status as a whole string; a message that contains the word is no
  // status.
  status: (line) => (STATUS_WORD.test(line) ? [line.trim()] : []),
  statusPattern: (line, code = codeOnly(line)) =>
    regexWords(line, code).filter((word) => Object.values(JOB_STATUS).includes(word)),
  // Cross-function protocol contexts must name a registry even for a new
  // word that is not present in any registry yet.
  protocol: (line) => [
    ...[...line.matchAll(VOCABULARY_CONTEXT)].map((match) => match[2]),
    ...[...line.matchAll(REVERSED_VOCABULARY)].map((match) => match[2]),
    ...[...line.matchAll(/\b(?:canRetry|retryJob)\([^;]*?,\s*(["'`])([^"'`]+)\1/g)].map(
      (match) => match[2],
    ),
  ],
  activity: (line) =>
    /(?:\breturn\s+|[?:]\s*|\bactive\s*[!=]==?\s*)["'`](?:unknown|undelivered)["'`]|["'`](?:unknown|undelivered)["'`]\s*[!=]==?\s*active\b/.test(
      line,
    )
      ? [line.trim()]
      : [],
  // A vocabulary word as a whole string, a settlement reply that is an everyday
  // word as one in a reply's contexts (REPLY_CONTEXTS), or an audit transition
  // passed or compared as one.
  vocabulary: (line) => [
    ...[...line.matchAll(REVERSED_VOCABULARY)]
      .map((match) => match[2])
      .filter((word) => CONTEXT_WORDS.has(word)),
    ...[...line.matchAll(VOCABULARY_CONTEXT)]
      .map((match) => match[2])
      .filter((word) => CONTEXT_WORDS.has(word)),
    ...[...line.matchAll(/(["'`])([a-z][a-z-]*)\1/g)]
      .map(([, , word]) => word)
      .filter((word) => VOCABULARY.has(word)),
    ...REPLY_CONTEXTS.flatMap((context) =>
      [...line.matchAll(context)].map((match) => match[2]),
    ).filter((word) => REPLY_WORDS.has(word)),
    ...(/\bemit\(\s*["'`]|\btransition\s*[!=]==?\s*["'`]/.test(line) ? [line.trim()] : []),
  ],
  // A timing, retry or size policy written as a number: in a line
  // (POLICY_CONTEXTS), or in its code alone (CODE_CONTEXTS).
  policy: (line, code = codeOnly(line)) =>
    POLICY_CONTEXTS.some((pattern) => pattern.test(line)) ||
    CODE_CONTEXTS.some((pattern) => pattern.test(code))
      ? [line.trim()]
      : [],
  // A number set on its own, but 0, 1 and -1 (NUMERIC_SETTING).
  numericSetting: (line) => {
    const value = NUMERIC_SETTING.exec(line)?.[1].replace(/\s+/g, "");
    return value !== undefined && !["0", "1", "-1"].includes(value) ? [line.trim()] : [];
  },
};
// The findings of the detectors named over files, as "file:line finding".
const scan = (files, ...kinds) =>
  linesOf(files).flatMap(({ at, line, code }) =>
    kinds.flatMap((kind) => detect[kind](line, code).map((finding) => `${at} ${finding}`)),
  );

test("protocol methods and decisions use the registries throughout src, including codex", () => {
  const words = new Set([
    ...Object.values(constants.RPC),
    ...Object.values(constants.SERVER_REQUEST),
    ...Object.values(constants.NOTIFICATION).filter((word) => word.includes("/")),
    ...Object.values(constants.POLICY_DECISION),
  ]);
  const inline = (line) =>
    [...line.matchAll(/(["'`])([^"'`]+)\1/g)]
      .map((match) => match[2])
      .filter((word) => words.has(word));
  assert.deepEqual(inline('request("thread/start", {});'), [constants.RPC.THREAD_START]);
  assert.deepEqual(inline('const reply = { decision: "decline" };'), [
    constants.POLICY_DECISION.DECLINE,
  ]);
  assert.deepEqual(inline("request(RPC.THREAD_START, {});"), []);
  assert.deepEqual(
    linesOf(SRC.filter((file) => file !== "src/shared/constants.mjs")).flatMap(({ at, line }) =>
      inline(line).map((word) => `${at} ${word}`),
    ),
    [],
  );
});
// Each detector answers for a planted line, so none of them passes by missing
// everything, and stays quiet on a planted look-alike, so none of them trips
// on ordinary code.
function catches(kind, ...planted) {
  for (const line of planted) assert.notDeepEqual(detect[kind](line), [], `${kind}: ${line}`);
}
function ignores(kind, ...planted) {
  for (const line of planted) assert.deepEqual(detect[kind](line), [], `${kind}: ${line}`);
}

// The function a line starts, by the forms this code base uses: a function
// declaration, a function or arrow assigned to a name, an object property
// holding one, or a method; null when it starts none.
const DEFINITIONS = [
  /\bfunction\s*\*?\s*([\w$]+)\s*\(/,
  /\b([\w$]+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/,
  /\b([\w$]+)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/,
  /^\s*(?:async\s+)?(?!(?:if|for|while|switch|catch|return|function)\b)([\w$]+)\s*\([^)]*\)\s*\{/,
];
// A function handed to a sort is a comparator, though it has no name.
const SORT_COMPARATOR =
  /\.(?:sort|toSorted)\(\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/;
const definedName = (code) =>
  SORT_COMPARATOR.test(code)
    ? "compare"
    : DEFINITIONS.map((pattern) => pattern.exec(code)?.[1]).find(Boolean);
const LITERAL_RETURN = /\breturn\s+(?:[^;?]*\?\s*)?-?\d+(?:\s*:\s*(?:[^;?]*\?\s*)?-?\d+)*\s*;/;

// A return of a number (or of numbers picked by a condition): an exit status
// returned from main or a command. Comparators (compare*) return numbers. A
// return belongs to the innermost function open where it stands, an arrow or
// a method included, followed by its braces.
function literalReturns(lines) {
  const found = [];
  const scopes = [];
  let depth = 0;
  for (const { at, line } of lines) {
    // Strings and trailing comments hold no braces that count.
    const code = line.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""').replace(/\/\/.*$/, "");
    let pending = definedName(code) ?? null;
    const returnAt = code.search(/\breturn\b/);
    let owner = null;
    for (let index = 0; index <= code.length; index++) {
      if (index === returnAt) owner = scopes.at(-1)?.name ?? null;
      if (code[index] === "{") {
        depth++;
        if (pending) scopes.push({ name: pending, depth });
        pending = null;
      } else if (code[index] === "}") {
        if (scopes.at(-1)?.depth === depth) scopes.pop();
        depth--;
      }
    }
    if (LITERAL_RETURN.test(line) && !/^compare/i.test(owner ?? ""))
      found.push(`${at} ${line.trim()}`);
  }
  return found;
}
// Each file's lines on their own, so a function never spans two files.
const returnsIn = (files) => files.flatMap((file) => literalReturns(codeLines(file)));
// Planted lines as the lines of one file, { at, line, code }, the code read
// over all of them (codeOnly), as codeLines reads a file's.
const planted = (...lines) => {
  const code = codeOnly(lines.join("\n")).split("\n");
  return lines.map((line, index) => ({ at: `planted:${index + 1}`, line, code: code[index] }));
};

const SRC = modules("src");
// The tools' tests (test/tools/) and the fixture the release tests share are
// read with the tools, as when they lived in tools/, by every rule but the
// returns and the policies: tests set their own waits. The distribution tests'
// fixture, a module of tools/ then, is read by every rule.
const TOOL_TESTS = [...modules("test/tools"), "test/support/release-fixture.mjs"];
const TOOLS = [...modules("tools"), "test/support/distribution-fixture.mjs", ...TOOL_TESTS];
const INSTALL = ["install.mjs"];
const SHIM = "run-codex-task.mjs";

test("every runner code is named once in src/errors.mjs and never written or built inline", () => {
  assert.ok(Object.isFrozen(CODES));
  // Audit rows and --inspect show the values, so each one is its own name.
  for (const [name, value] of Object.entries(CODES)) assert.equal(value, name);
  for (const code of RUN_LOCK_CODES) assert.ok(code.startsWith("RUN_LOCK_") && CODES[code], code);
  catches("code", 'throw new RunnerError("RUN_GONE", message);');
  ignores(
    "code",
    'const options = process.env["NODE_OPTIONS"];',
    'delete env["NPM_CONFIG_USERCONFIG"];',
    'if (name === "XDG_CONFIG_HOME") skip();',
    'const marker = "MERGE_HEAD";',
  );
  catches(
    "codeFragment",
    "if (/^RUN_LOCK_/.test(error.code)) retry();",
    'if (error.code.endsWith("_BUSY")) wait();',
    'if (error.code.startsWith("RUN_")) wait();',
    "const code = `RUN_LOCK_${kind}`;",
    "const code = `${scope}_BUSY`;",
  );
  const files = [...SRC.filter((file) => file !== "src/shared/errors.mjs"), ...TOOLS, ...INSTALL];
  assert.deepEqual(
    scan(files, "code", "codeFragment"),
    [],
    "name these codes in CODES (src/shared/errors.mjs) and use CODES.<NAME>",
  );
});

test("worker states, stop, broker and interrupt outcomes, settlement replies and audit transitions are named, never written inline in src/", () => {
  for (const vocabulary of [WORKER_STATE, STOP_OUTCOME, AUDIT_TRANSITION, STOP_OUTCOME])
    assert.ok(Object.isFrozen(vocabulary));
  // The wire words stay as they were: helpers print them and records keep them.
  assert.deepEqual(Object.values(WORKER_STATE), ["gone", "reused", "worker", "unknown"]);
  assert.deepEqual(Object.values(STOP_OUTCOME), ["gone", "reused", "unknown", "stopped", "alive"]);
  assert.deepEqual(
    [WORKER_STATE.GONE, WORKER_STATE.REUSED, WORKER_STATE.WORKER, WORKER_STATE.UNKNOWN].map(
      isGoneWorkerState,
    ),
    [true, true, false, false],
  );
  catches(
    "vocabulary",
    'if (state === "reused") return;',
    'await audit.emit("close", run);',
    'if (reply === "ready") cleanup();',
    'return "changed";',
    'case "live":',
    'console.log("ready");',
    'process.stdout.write("live\\n");',
    'resolve("changed");',
    'return { reply: "changed" };',
    'const reply = gone ? "live" : answer;',
    'return { kind: "found" };',
    'return { kind: "none" };',
    'if (answer.kind === "delivered") return;',
    'if (result.outcome !== "interrupted") wait();',
    'return "still-running";',
    'return "rolled-back";',
    'if ("unknown" === workerState) return;',
    'if ("stale" !== result.brokerOutcome) return;',
  );
  ignores(
    "vocabulary",
    'warn("the job changed while it was settled");',
    'const mode = { kind: "live-tail" };',
    'console.log("ready to go");',
    'process.stdout.write("still live\\n");',
    "resolve(answer.trim());",
    'const options = { cwd: "none" };',
    'throw new Error("interrupted");',
    'const row = { label: "delivered" };',
  );
  const files = [
    ...SRC.filter((file) => !["src/shared/constants.mjs", "src/shared/errors.mjs"].includes(file)),
    ...modules("tools").filter((file) => !file.endsWith(".contract.mjs")),
    ...INSTALL,
    SHIM,
  ];
  assert.deepEqual(
    scan(files, "vocabulary"),
    [],
    "use the vocabularies in src/shared/constants.mjs",
  );
});

test("errno codes, signals and exit values are named, never written inline in src/, tools/ or install.mjs", () => {
  for (const registry of [ERRNO, SIGNALS, EXIT]) assert.ok(Object.isFrozen(registry));
  for (const [name, value] of [...Object.entries(ERRNO), ...Object.entries(SIGNALS)])
    assert.equal(value, name, "the values Node.js reports");
  assert.deepEqual(Object.values(EXIT), [0, 1, 2, 3, 130, 143], "the manual's exit codes");
  assert.equal(isMissing({ code: ERRNO.ENOENT }) && isMissing({ code: ERRNO.ENOTDIR }), true);
  assert.equal(isMissing({ code: ERRNO.EACCES }) || isMissing(null), false);
  catches("errnoOrSignal", 'if (error.code === "ENOENT") return;', 'child.kill("SIGKILL");');
  catches("errnoOrSignal", "if (/ENOENT|EACCES/.test(error.code)) return;");
  // POSIX's names count on every host, those Windows' os.constants lacks too.
  catches("errnoOrSignal", ...NOT_ON_WINDOWS.map((name) => `if (reason === "${name}") stop();`));
  ignores(
    "errnoOrSignal",
    'const kind = "ESM";',
    'if (style === "EOL") wrap();',
    'name + "EXE"',
    'const header = "SIGNATURE";',
    'const help = "SIGINT/SIGTERM stop the waiter with exit 130/143 and preserve the detached job.";',
  );
  catches(
    "exitValue",
    "process.exitCode = 1;",
    "process.exit(0);",
    "return done(3);",
    "if (done.code !== 0) fail();",
    'process["exit"](1);',
    'process["exitCode"] = 2;',
    "Object.assign(process, { exitCode: 1 });",
  );
  const files = [
    ...SRC.filter((file) => !["src/shared/constants.mjs", "src/shared/errors.mjs"].includes(file)),
    ...TOOLS,
    ...INSTALL,
  ];
  assert.deepEqual(
    scan(files, "errnoOrSignal", "exitValue"),
    [],
    "use ERRNO, SIGNALS and EXIT (src/shared/errors.mjs)",
  );
});

test("new cross-function kinds and retry reasons cannot evade the guard by missing a registry", () => {
  catches(
    "protocol",
    'return { kind: "held" };',
    'if (opened.kind === "prepared") launch();',
    'if ("future-state" === response.kind) return;',
    'return { outcome: "new-outcome" };',
    'canRetry(run, "worker-died");',
    'retryJob(run, "stale-job", context);',
  );
  ignores("protocol", 'const message = "held";', 'return { label: "prepared" };');
  catches(
    "activity",
    'return "undelivered";',
    'return active ? "unknown" : null;',
    'if ("unknown" === active) return;',
  );
  ignores("activity", 'throw new Error("unknown");');
  const files = [
    ...SRC.filter((file) => !["src/shared/constants.mjs", "src/shared/errors.mjs"].includes(file)),
    ...modules("tools").filter((file) => !file.endsWith(".contract.mjs")),
    ...INSTALL,
    SHIM,
  ];
  assert.deepEqual(scan(files, "protocol"), [], "name each cross-function protocol at its owner");
  assert.deepEqual(scan(["src/run/lifecycle.mjs"], "activity"), [], "name active-job observations");
});

test("an exit status is never returned as a number: only comparators return numbers", () => {
  assert.deepEqual(
    literalReturns(
      planted(
        "export function main() {",
        "  return failed ? 1 : 0;",
        "}",
        "export function compareThings(a, b) {",
        "  return a < b ? -1 : 1;",
        "}",
        "export function compareAll(list) {",
        "  const exitWith = () => {",
        "    return 1;",
        "  };",
        "}",
        "function main2() {",
        "  const compare = (a, b) => {",
        "    return a - b;",
        "  };",
        "  return 1;",
        "}",
        "function main3() {",
        "  runs.sort((a, b) => {",
        "    return a.at - b.at;",
        "  });",
        "  return 2;",
        "}",
      ),
    ),
    [
      "planted:2 return failed ? 1 : 0;",
      "planted:9 return 1;",
      "planted:16 return 1;",
      "planted:22 return 2;",
    ],
    "a return is its own function's: an arrow's, and the outer one's after it",
  );
  assert.deepEqual(
    literalReturns(
      planted(
        "export function main() {",
        "  const compare = (a, b) => {",
        "    if (a < b) return -1;",
        "    return a > b ? 1 : 0;",
        "  };",
        "  return EXIT.COMPLETED;",
        "}",
        "class Version {",
        "  compareTo(other) {",
        "    return this.n < other.n ? -1 : 1;",
        "  }",
        "}",
        "export function list() {",
        "  runs.sort((a, b) => {",
        "    if (a.at < b.at) return -1;",
        "    return a.at > b.at ? 1 : 0;",
        "  });",
        "  return EXIT.COMPLETED;",
        "}",
      ),
    ),
    [],
    "a comparator's returns stay its own, an arrow's or a method's too",
  );
  const files = [...SRC, ...TOOLS.filter((file) => !TOOL_TESTS.includes(file)), ...INSTALL, SHIM];
  assert.deepEqual(returnsIn(files), [], "return EXIT.<NAME>");
});

// In tools/, which imports no src/ module but errors.mjs, each file may define
// IS_WINDOWS and IS_LINUX once each at its top level, and use only those.
const PLATFORM_DEFINITION =
  /^const (IS_WINDOWS|IS_LINUX) = process\.platform === "(win32|linux)";$/;
const DEFINED_PLATFORM = { IS_WINDOWS: "win32", IS_LINUX: "linux" };
const toolPlatforms = (lines) => {
  const seen = new Set();
  const found = [];
  for (const { at, line } of lines) {
    const definition = PLATFORM_DEFINITION.exec(line);
    if (!definition) {
      found.push(...detect.platform(line).map((finding) => `${at} ${finding}`));
      continue;
    }
    const [, name, platform] = definition;
    if (seen.has(name)) found.push(`${at} a second ${name} definition`);
    if (DEFINED_PLATFORM[name] !== platform) found.push(`${at} ${name} names ${platform}`);
    seen.add(name);
  }
  return found;
};

test("platform names are named once: PLATFORM in src/, one IS_WINDOWS or IS_LINUX per tool", () => {
  assert.ok(Object.isFrozen(PLATFORM));
  assert.deepEqual(Object.values(PLATFORM), ["win32", "linux", "darwin"], "process.platform's");
  assert.equal(constants.IS_WINDOWS, process.platform === PLATFORM.WIN32);
  assert.equal(constants.IS_LINUX, process.platform === PLATFORM.LINUX);
  catches(
    "platform",
    'if (platform === "darwin") return;',
    'const COMPARABLE = new Set(["win32"]);',
    'if (os.platform() === "linux") read();',
    "const platform = os.platform();",
  );
  const src = SRC.filter((file) => file !== "src/shared/constants.mjs");
  assert.deepEqual(
    scan([...src, ...INSTALL, SHIM], "platform"),
    [],
    "use PLATFORM, IS_WINDOWS or IS_LINUX (src/shared/constants.mjs)",
  );
  assert.deepEqual(
    toolPlatforms(
      planted(
        'const IS_WINDOWS = process.platform === "win32";',
        'const IS_WINDOWS = process.platform === "win32";',
        'const IS_LINUX = process.platform === "win32";',
        'const tar = process.platform === "win32" ? "tar.exe" : "tar";',
      ),
    ),
    [
      "planted:2 a second IS_WINDOWS definition",
      "planted:3 IS_LINUX names win32",
      'planted:4 const tar = process.platform === "win32" ? "tar.exe" : "tar";',
    ],
  );
  assert.deepEqual(
    toolPlatforms(
      planted(
        'const IS_WINDOWS = process.platform === "win32";',
        'const IS_LINUX = process.platform === "linux";',
        "const shell = IS_WINDOWS ? POWERSHELL : IS_LINUX ? PROC : PS;",
      ),
    ),
    [],
    "a tool may need both",
  );
  assert.deepEqual(
    TOOLS.flatMap((file) => toolPlatforms(codeLines(file))),
    [],
    "one top-level IS_WINDOWS and IS_LINUX at most per tool",
  );
});

test("job statuses are named in JOB_STATUS, never written as whole strings in src/, tools/ or install.mjs", () => {
  assert.ok(Object.isFrozen(JOB_STATUS));
  assert.deepEqual(
    [...constants.ACTIVE, ...constants.TERMINAL],
    Object.values(JOB_STATUS),
    "every status is active or terminal",
  );
  catches("status", 'if (job.status === "running") wait();', 'return { status: "failed" };');
  assert.deepEqual(detect.status('warn("worker still running");'), [], "a message is no status");
  const files = [
    ...SRC.filter((file) => file !== "src/shared/constants.mjs"),
    ...TOOLS,
    ...INSTALL,
  ];
  assert.deepEqual(scan(files, "status"), [], "use JOB_STATUS (src/shared/constants.mjs)");
  catches(
    "statusPattern",
    "/^codex-subagents-for-claude-code: status=(completed|failed|cancelled) /",
    "/^codex-subagents-for-claude-code: status=(?:completed|failed|cancelled) /",
    "/^running$/",
  );
  ignores("statusPattern", "/^not-completed$/", "/jobStatusPattern/");
  // Assertions and fake plugin wire payloads remain independent protocol oracles.
  assert.deepEqual(
    scan(
      [
        ...SRC.filter((file) => file !== "src/shared/constants.mjs"),
        ...modules("tools").filter((file) => !file.endsWith(".contract.mjs")),
        ...INSTALL,
        SHIM,
      ],
      "statusPattern",
    ),
    [],
    "derive runtime status patterns from JOB_STATUS",
  );
});

// The shim chooses the release before it loads any runner module, so it names
// its few literals itself: exactly these definitions, and nothing inline.
const SHIM_LITERALS = [
  'const POINTER_MISSING = "ENOENT";',
  'const POINTER_BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);',
  "const POINTER_RETRIES = 20;",
  "const POINTER_RETRY_MS = 10;",
  "const EXIT_FAILURE = 1;",
  "const POINTER_DETAIL_CHARS = 80;",
];
const shimInline = (lines) =>
  lines
    .filter(({ line }) => !SHIM_LITERALS.includes(line.trim()))
    .flatMap(({ at, line, code }) =>
      ["errnoOrSignal", "exitValue", "policy", "numericSetting", "code", "platform"].flatMap(
        (kind) => detect[kind](line, code).map((finding) => `${at} ${finding}`),
      ),
    );

test("the entry shim, which loads no runner module before it picks a release, names its literals once, in these definitions only", () => {
  const lines = codeLines(SHIM);
  assert.deepEqual(
    lines.map(({ line }) => line.trim()).filter((line) => SHIM_LITERALS.includes(line)),
    SHIM_LITERALS,
    "each definition once, in this order",
  );
  // Every planted line is caught, a line two detectors read once.
  assert.deepEqual(
    new Set(
      shimInline(
        planted(
          "if (attempt < 30 && error.code === POINTER_BUSY) retry();",
          "sleepSync(5);",
          'if (error.code === "EPERM") wait();',
          "process.exit(2);",
          "const RETRY_PAUSE_MS = 25;",
        ),
      ).map((finding) => finding.split(" ")[0]),
    ),
    new Set(["planted:1", "planted:2", "planted:3", "planted:4", "planted:5"]),
  );
  assert.deepEqual(shimInline(lines), [], "name the shim's literals in its definitions above");
});

test("timing, retry and size policies are named, never written as numbers in src/, tools/ or install.mjs", () => {
  catches(
    "policy",
    "setTimeout(resolve, 1000);",
    "  }, 250);",
    "await delay(500);",
    "sleepSync(10);",
    "const deadline = Date.now() + 5000;",
    "if (attempt < 5) retry();",
    "for (let tries = 0; tries < 200; tries++) probe();",
    "if (bytes > 65_536) cut();",
    "const wait = Math.min(left, 1000);",
    "spawnSync(git, args, { timeout: 10_000 });",
    "fs.rmSync(dir, { maxRetries: 3, retryDelay: 100 });",
    "return text.slice(0, 1200);",
    "const tail = stderr.trim().slice(-2000);",
    "export async function waitFor(file, { timeoutMs = 3000 } = {}) {",
    "function settle(pid, waitMs = 5000) {",
    "const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
    "const response = await fetch(url, { signal: AbortSignal.timeout(5000) });",
    "socket.setTimeout(5000);",
    "const stream = fs.createReadStream(file, { highWaterMark: 65536 });",
    "const buffer = Buffer.alloc(65536);",
    "const text = readLimited(path.join(dir, name), 1024 * 1024);",
    "if (count >= 2) stop();",
    "while (probes < 3) probe();",
    "while (attempts++ < 5) retry();",
    "for (let i = 0; i < 5; i++) poll();",
  );
  // The suffix rule on keys and defaults, ...Lines and ...Chars included, in
  // camelCase, SCREAMING_CASE or as the word alone.
  catches(
    "policy",
    "fs.rmSync(dir, { recursive: true, retries: 3, delayMs: 100 });",
    "const text = render(output, { maxLines: 50 });",
    'const options = { "waitMs": 250 };',
    "const STOP = Object.freeze({ GRACE_MS: 3000 });",
    "export function render(text, { maxLines = 50, headChars = 300 } = {}) {",
    "function retry(run, retries = 3) {",
  );
  ignores(
    "policy",
    "const text = render(output, { maxLines: MAX_STDOUT_LINES, items: 5 });",
    "export function render(text, { maxLines = 0, maxChars = 1 } = {}) {",
    "const { items = 5 } = options;",
  );
  // A default or a key named for a limit or a count, without a suffix.
  catches(
    "policy",
    "function tail(text, limit = 50) {",
    "async function poll(job, attempts = 3) {",
    "const { lineLimit = 40, maxCount = 8 } = options;",
    "const read = readAll(file, { limit: 50 });",
  );
  ignores(
    "policy",
    "function tail(text, limit = MAX_TAIL_LINES) {",
    "function send({ account = 12 } = {}) {",
    "const read = readAll(file, { limit: MAX_READ, discount: 15 });",
  );
  // A deadline in any case.
  catches("policy", "const DEADLINE = started + 45;", "const stopDeadline = now + 50;");
  ignores("policy", "const deadline = Date.now() + STOP_TOTAL_MS;");
  // Arithmetic with a literal of three digits or more, in code.
  catches(
    "policy",
    "const late = started + 30_000;",
    "const hour = 60 * 60 * 1000;",
    "const cap = limit * 1024;",
    "remaining -= 500;",
    "  STOP_PREPARE_MS + 1000 +",
  );
  ignores(
    "policy",
    "const half = total / 2;",
    'log("built 2026-10-28 at 10:00");',
    "SIGINT/SIGTERM stop the waiter with exit 130/143 and preserve the detached job.",
    "run(); // 30 s + 1000 ms",
    "const mode = (stat.mode & 0o7777) | 0o200;",
  );
  // A call given a number of three digits or more, an array of numbers, a line
  // of numbers alone, and a comparison with two digits.
  catches(
    "policy",
    "const head = truncate(text, 300);",
    "const tail = lastLines(text, -500);",
    "const delays = [100, 200, 400];",
    "retry(run, { schedule: [250, 2] });",
    "  100, 200, 400,",
    "  300,",
    "if (major < 22) fail();",
    "while (seen.size > 50) evict();",
  );
  ignores(
    "policy",
    "const value = Number.parseInt(text, 10);",
    "fs.chmodSync(file, 0o644);",
    "const head = truncate(text, MAX_HEAD_CHARS);",
    "const pair = [0, 1, -1];",
    "const third = parts[2];",
    "const id = identity?.[2] === jobId;",
    "const digit = /[2-9]/.test(text);",
    'warn("expected [2, 3] or (300)");',
    "  0,",
    "if (lines.length > 2) fold();",
    "if (major < MIN_NODE_MAJOR) fail();",
  );
  // Arithmetic inside a template's ${...}, and with %.
  catches(
    "policy",
    "const duration = `${Math.round(result.durationMs / 1000)}s`;",
    "throw new Error(`the lock kept changing hands for ${LOCK_TAKEOVER_MS / 1000} s`);",
    "    : minutes % 1440 === 0",
    "      ? `${minutes / 1440}d`",
    "const hours = `${elapsed % 3600}`;",
    "return minutes % 60;",
    "return `${minutes / 60}h`;",
    "return id.slice(0, 80);",
    "return commit.slice(0, 7);",
    "return digest.slice(0, 16);",
    "return sha.slice(0, 12);",
  );
  ignores(
    "policy",
    "const duration = `${Math.round(result.durationMs / SECOND_MS)}s`;",
    "log(`exit 130/143 means a signal, after 1000 ms`);",
    "      ? `${minutes / MINUTES_PER_DAY}d`",
  );
  // A number given as a value: a branch of a condition, a default after ?? or
  // ||, an object's value of three digits or more.
  catches(
    "policy",
    "        : 100;",
    "for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {",
    "const pause = options.pause ?? 500;",
    "const width = columns || 80;",
    'return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? "s"];',
  );
  ignores(
    "policy",
    "const pick = found ? 1 : 0;",
    "const mode = POSIX ? 0o644 : 0o444;",
    "const next = (run.turns?.length ?? 0) + 1;",
    'const text = flag ? "130" : "143";',
    'const options = { depth: 12, label: "x" };',
    'return Number(match[1]) * { s: SECOND_MS, m: MINUTE_MS }[match[2] ?? "s"];',
  );
  // Over a whole file, a template that spans lines is text on every line, and
  // its ${...} is code.
  const help = [
    "const HELP_TEXT = `Usage:",
    "  exit 130/143 after a signal, 1000 ms later",
    "  waited ${LOCK_MS / 1000} s`;",
  ];
  const helpCode = codeOnly(help.join("\n")).split("\n");
  assert.deepEqual(
    help.map((line, index) => detect.policy(line, helpCode[index]).length),
    [0, 0, 1],
  );
  // A regular expression after a keyword that takes an expression (return,
  // typeof, case, of, in, do, else, yield, await, ...) is no division: its
  // insides are text, so a quote or a backtick in it opens nothing, and the
  // code after it is code. A property of such a name divides.
  catches(
    "policy",
    'if (typeof text === "string") return /"/.test(text) ? 100 : 0;',
    "const share = totals.in / 1000;",
    "const half = options.of / 1000;",
  );
  ignores(
    "policy",
    "return / - 1000 /.test(line);",
    "const kind = typeof / - 1000 /;",
    "case / - 1000 /:",
    "for (const match of / - 1000 /g.exec(line) ?? []) visit(match);",
    "if (key in / - 1000 /) skip();",
    "do / - 1000 /.exec(line);",
    "else / - 1000 /.test(line);",
    "yield / - 1000 /;",
    "const found = await / - 1000 /.test(line);",
    "throw / - 1000 /;",
    "if (value instanceof / - 1000 /) skip();",
    "void / - 1000 /;",
  );
  const quoted = [
    "const raw = (text) => {",
    "  return /`/.test(text);",
    "};",
    "const pause = options.pause ?? 500;",
  ];
  const quotedCode = codeOnly(quoted.join("\n")).split("\n");
  assert.deepEqual(
    quoted.map((line, index) => detect.policy(line, quotedCode[index]).length),
    [0, 0, 0, 1],
    "a backtick in a regular expression after return opens no template",
  );
  ignores(
    "policy",
    "if (lines.length > 2) fold();",
    "for (let i = 0; i < items.length; i++) visit(items[i]);",
    "return items.slice(1);",
    "return args.slice(2);",
    "const capture = match[2];",
    "const indentation = ' '.repeat(2);",
    "const head = text.slice(0, MAX_PROGRESS_CHARS);",
    "await delay(RETRY_MS);",
    "export function render(text, { maxLines = 0, maxBytes = 0 } = {}) {",
    "function settle(pid, waitMs = SETTLE_MS) {",
    "const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);",
    "const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_MS) });",
    "socket.setTimeout(SOCKET_IDLE_MS);",
    "const stream = fs.createReadStream(file, { highWaterMark: CHUNK_BYTES });",
    "let prefix = Buffer.alloc(0);",
    "const text = readLimited(path.join(dir, name), MAX_AUDIT_BYTES).slice(0, 1);",
    "if (count > 0) report();",
    "if (probes >= 1) settle();",
    "while (attempts++ < MAX_ATTEMPTS) retry();",
  );
  catches(
    "numericSetting",
    "const RETRY_MS = 500;",
    "const limit = 64 * 1024 * 1024;",
    "const ms = 1000",
    "let rounds = 8,",
    "  day = 86_400_000;",
    "const mebibyte = 1 << 20;",
    "const ticks = 10000n;",
  );
  ignores(
    "numericSetting",
    "let count = 0;",
    "let index = -1,",
    "  depth = 1;",
    "const limit = MAX_OUTPUT_BYTES;",
    "const half = total / 2;",
    "if (count === 2) stop();",
    "for (let i = 2; i < parts.length; i++) visit(parts[i]);",
  );
  // A for loop's initialiser is no setting, but its bound still is a policy.
  catches("numericSetting", "let i = 2;");
  catches("policy", "for (let i = 2; i < 5; i++) poll();");
  // A definition Prettier wraps is exempt as a whole, a template's lines too,
  // and nothing after it, a regular expression's brackets and quotes being no
  // code; one that never ends is reported.
  assert.deepEqual(
    toolPolicies(
      planted(
        "const SCRATCH_REMOVAL = Object.freeze({",
        "  maxRetries: 5,",
        "  retryDelay: 100,",
        "});",
        "const HELP = `Usage: wait (attempts < 3);",
        "  { timeout: 5000 }",
        "`;",
        "fs.rmSync(dir, { maxRetries: 3 });",
        "  const pause = 250;",
        "const QUOTE =",
        '  /["(]/;',
        "setTimeout(run, 250);",
        "const LATER = [",
        "  setTimeout(run, 250),",
      ),
    ),
    [
      "planted:8 fs.rmSync(dir, { maxRetries: 3 });",
      "planted:9 const pause = 250;",
      "planted:12 setTimeout(run, 250);",
      "planted:13 a policy definition that never ends",
    ],
  );
  assert.deepEqual(
    toolPolicies(
      planted(
        "const POLL =",
        "  () => {",
        "    setTimeout(run, 250);",
        "  };",
        "const ACTIONS = {",
        "  retry() {",
        "    sleepSync(200);",
        "  },",
        "};",
      ),
    ),
    ["planted:3 setTimeout(run, 250);", "planted:7 sleepSync(200);"],
  );
  // A tool names its policies at its top level (POLICY_DEFINITION); its tests
  // and the contract suite set their own waits. The registries, which name the
  // values (src/shared/errors.mjs the exit codes), are where numbers are written.
  const tools = TOOLS.filter(
    (file) => !TOOL_TESTS.includes(file) && !file.endsWith(".contract.mjs"),
  );
  const findings = [
    ...scan(
      SRC.filter((file) => !["src/shared/constants.mjs", "src/shared/errors.mjs"].includes(file)),
      "policy",
      "numericSetting",
    ),
    ...[...tools, ...INSTALL].flatMap((file) => toolPolicies(codeLines(file))),
  ];
  assert.deepEqual(
    findings,
    [],
    "name the policy in src/shared/constants.mjs, or at the top of the tool that uses it",
  );
});

// The registries a reference must name a key of: every frozen object
// src/shared/errors.mjs and src/shared/constants.mjs export, and the
// process seams.
const REGISTRIES = {
  ...Object.fromEntries(
    Object.entries({ ...errors, ...constants }).filter(
      ([, value]) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Set) &&
        Object.isFrozen(value),
    ),
  ),
  PROCESSES,
  PROCESS_PROBE,
};
const REFERENCE = new RegExp(
  `\\b(${Object.keys(REGISTRIES).join("|")})\\.([A-Za-z_$][\\w$]*)`,
  "g",
);
const unknownKeys = (lines) =>
  lines.flatMap(({ at, line }) =>
    [...line.matchAll(REFERENCE)]
      .filter(([, registry, key]) => !Object.hasOwn(REGISTRIES[registry], key))
      .map(([reference]) => `${at} ${reference}`),
  );

test("every reference to a registry names a key it defines, in src/, tools/, install.mjs and test/", () => {
  for (const name of [
    "CODES",
    "ERRNO",
    "SIGNALS",
    "EXIT",
    "PLATFORM",
    "JOB_STATUS",
    "WORKER_STATE",
    "RPC",
    "SERVER_REQUEST",
    "DRIVER_IPC",
    "POLICY_DECISION",
    "RPC_ERROR",
  ])
    assert.ok(REGISTRIES[name], name);
  assert.deepEqual(
    unknownKeys(
      planted(
        "if (error.code === CODES.RUN_LOCK_BUZY) wait();",
        "if (isMissing(error) || error.code === ERRNO.ENOENTT) return;",
        "if (process.platform === PLATFORM.WINDOWS) return;",
      ),
    ),
    ["planted:1 CODES.RUN_LOCK_BUZY", "planted:2 ERRNO.ENOENTT", "planted:3 PLATFORM.WINDOWS"],
  );
  // This file plants misspelt keys on purpose.
  const files = [
    ...new Set([
      ...SRC,
      ...TOOLS,
      ...INSTALL,
      SHIM,
      ...moduleFiles(ROOT, "test").filter((file) => file !== "test/error-codes.test.mjs"),
    ]),
  ];
  assert.deepEqual(
    unknownKeys(linesOf(files)),
    [],
    "a misspelt key reads undefined and never matches",
  );
});
