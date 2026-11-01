// Complement the inline-literal guard with whole-file lexical checks and
// cross-file facts. Test inputs and expected wire values deliberately remain
// independent of the implementation registries.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CODES, ERRNO, SIGNALS } from "../src/shared/errors.mjs";
import { JOB_STATUS, PLATFORM } from "../src/shared/constants.mjs";
import { ROLES } from "../src/roles.mjs";
import { moduleFiles } from "../tools/test-files.mjs";
import { codeOnly } from "./support/code-text.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const PRODUCT = [
  ...moduleFiles(ROOT, "src"),
  ...moduleFiles(ROOT, "tools").filter((file) => !file.endsWith(".contract.mjs")),
  "install.mjs",
  "run-codex-task.mjs",
];

// codeOnly preserves a string's delimiters and columns, blanking its body.
// Consequently only a complete static string/template is whitespace between
// matching quotes. Comments, regex text and template interpolation are not.
// Decode escapes without evaluating source (ES modules forbid octal escapes).
function literals(text) {
  const escape = /\\(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|\r?\n|([\s\S]))/gi;
  return [...codeOnly(text).matchAll(/(["'`])\s*?\1/g)].map((match) => ({
    at: match.index,
    raw: text.slice(match.index, match.index + match[0].length),
    value: text
      .slice(match.index + 1, match.index + match[0].length - 1)
      .replace(escape, (_, point, unicode, hex, other) =>
        point || unicode || hex
          ? String.fromCodePoint(Number.parseInt(point ?? unicode ?? hex, 16))
          : ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" }[other] ??
            other ??
            ""),
      ),
  }));
}

test("literal scanning reads escaped and multiline static words, without reading comments or regex prose", () => {
  const source = [
    '// "ENOENT" is prose',
    'const pattern = /"SIGKILL"/;',
    'const code = "E\\x4eOENT";',
    "const signal = `SIG\\u004bILL`;",
    'const status = "run\\\nning";',
    'const value = `message ${pick("failed")}`;',
  ].join("\n");
  assert.deepEqual(
    literals(source).map(({ value }) => value),
    ["ENOENT", "SIGKILL", "running", "failed"],
  );
});

test("escaped errno, signal, code, status and platform words cannot bypass the named-literal guard", () => {
  const reserved = new Set([CODES, ERRNO, SIGNALS, JOB_STATUS, PLATFORM].flatMap(Object.values));
  const violations = [];
  for (const file of PRODUCT) {
    if (["src/shared/errors.mjs", "src/shared/constants.mjs"].includes(file)) continue;
    for (const literal of literals(read(file)))
      if (literal.raw.includes("\\") && reserved.has(literal.value))
        violations.push(`${file}:${read(file).slice(0, literal.at).split("\n").length}`);
  }
  assert.deepEqual(violations, [], "escaped spellings are the same literal, not an exemption");
});

test("production model slugs belong to the role catalogue; docs retain checked independent model facts", () => {
  const violations = PRODUCT.filter((file) => file !== "src/roles.mjs").flatMap((file) =>
    literals(read(file))
      .filter(({ value }) => /^gpt-\d/.test(value))
      .map(() => file),
  );
  assert.deepEqual(violations, [], "model-specific production behavior must use the catalogue");
  const readme = read("README.md");
  for (const [role, { model }] of Object.entries(ROLES)) {
    assert.ok(readme.includes(`\`${role}\``), `${role} documented`);
    assert.ok(readme.includes(`\`${model}\``), `${model} documented`);
  }
  assert.doesNotMatch(read("docs/DEVELOPMENT.md"), /Effort is `xhigh` at\s+most/);
  assert.doesNotMatch(readme, /accepts efforts only up to\s+`xhigh`/);
  assert.doesNotMatch(
    read("claude/skills/codex-subagents-for-claude-code/SKILL.md"),
    /PID alone decides|before plugin [\d.]+ may kill/,
  );
});

test("current installer and delivery code contain no previous-catalogue or pre-write destination migration", () => {
  // These are retired behaviors, not current rollback, partial publication,
  // identity refusal or explicit correction of an unsafe destination.
  assert.doesNotMatch(
    read("install.mjs"),
    /checkout\.DISPLAY|new Set\(\[releaseRoot\(\), HERE\]\)/,
  );
  assert.doesNotMatch(read("src/run/deliver.mjs"), /destination && !run\.result\.durableSavedAt/);
});

test("scratch containment never compares native path spellings with raw os.tmpdir", () => {
  for (const file of ["tools/distribution.mjs", "tools/ci.mjs"])
    assert.doesNotMatch(read(file), /path\.dirname\(scratch\)\s*!==\s*os\.tmpdir\(\)/, file);
});

test("current workspace and footer readers promise no historical reconstruction", () => {
  assert.doesNotMatch(
    read("src/run/launch.mjs"),
    /record\.pluginWorkspace\s*=|gitToplevel\(record\.cwd\)/,
  );
  assert.doesNotMatch(
    read("claude/skills/codex-subagents-for-claude-code/SKILL.md"),
    /older copy may lack `tokens=` and `limit=`/,
  );
});

// Read only the two executable PowerShell regions. The general JS lexer must
// keep help text opaque; a printed instruction such as "exit 3" is not code.
function embeddedExits(text) {
  const blocks = [
    /const WINDOWS_STOP = String\.raw`([\s\S]*?)`;/,
    /(`\$p = Get-Process[\s\S]*?\[Console\]::Out\.Write\(\$line\)`)/,
  ].flatMap((pattern) => pattern.exec(text)?.slice(1) ?? []);
  return blocks.flatMap((block) => [...block.matchAll(/\bexit\s+\d+/g)].map(([word]) => word));
}

test("executable PowerShell helper exits use named policies, while prose and structural numbers remain literals", () => {
  assert.deepEqual(embeddedExits("const WINDOWS_STOP = String.raw`if ($p) { exit 0 }`;"), [
    "exit 0",
  ]);
  assert.deepEqual(
    embeddedExits(
      "const query = `$p = Get-Process; if ($p) { exit 3 }; [Console]::Out.Write($line)`;",
    ),
    ["exit 3"],
  );
  assert.deepEqual(embeddedExits("const HELP = `exit 3 means still running`;"), []);
  assert.deepEqual(
    embeddedExits("const WINDOWS_STOP = String.raw`$x = 0; return 0; exit ${EXIT.COMPLETED}`;"),
    [],
  );
  for (const file of ["src/shared/process-identity.mjs", "src/shared/process-stop.mjs"])
    assert.deepEqual(embeddedExits(read(file)), [], file);
});

test("runner release-history notes stay out of current source and test commentary", () => {
  const files = [...PRODUCT, ...moduleFiles(ROOT, "test")];
  const found = files.flatMap((file) =>
    read(file)
      .split("\n")
      .flatMap((line, index) =>
        /^\s*\/\//.test(line) &&
        /\b(?:the|since|in|from) \d+\.\d+\.\d+ (?:order|release|runner)/i.test(line)
          ? [`${file}:${index + 1}`]
          : [],
      ),
  );
  assert.deepEqual(found, [], "describe current behavior without release-history commentary");
});

const scriptPolicy = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .flatMap((line) =>
      [
        ...line.matchAll(/(?:^|[;{}])\s*exit\s+\d+\b/g),
        ...line.matchAll(/AbortSignal\.timeout\(\s*\d+\s*\)/g),
        ...line.matchAll(/process\.exit\([^)]*\b[01]\b[^)]*\)/g),
        ...line.matchAll(/(?:\.StatusCode\s+-[en]e|\.status\s*[!=]==?)\s+\d{3}\b/g),
      ].map(([match]) => match.trim()),
    );

test("CI and forge executable scripts name their exits, HTTP statuses and timeout policies", () => {
  assert.deepEqual(
    scriptPolicy(
      "if ($bad) { exit 1 }; process.exit(1); AbortSignal.timeout(5000); response.status === 404",
    ),
    ["{ exit 1", "AbortSignal.timeout(5000)", "process.exit(1)", ".status === 404"],
  );
  assert.deepEqual(scriptPolicy("if ([int]$_.Exception.Response.StatusCode -ne 404) { throw }"), [
    ".StatusCode -ne 404",
  ]);
  assert.deepEqual(
    scriptPolicy('# exit 1\ninterval: 30s\ntimeout: 10s\nretries: 3\nexit "$EXIT_FAILURE"'),
    [],
  );
  for (const file of [
    "ci/gitea/compose.yml",
    "ci/gitea/entrypoint.sh",
    "ci/gitea/setup-runner.ps1",
    "ci/gitea/setup-asset-reader.ps1",
    "tools/publish-gitea.mjs",
    "tools/publish-github.mjs",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ])
    assert.deepEqual(scriptPolicy(read(file)), [], file);
});
