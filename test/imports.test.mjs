// U-08: every test module imports only what it uses, so its dependencies are
// the ones it names.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ROOT, moduleFiles } from "../tools/test-files.mjs";
import { codeOnly } from "./support/code-text.mjs";

const IMPORT =
  /^import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+([\w$]+)\s*)?from\s+"([^"]+)";/gms;
// The local names a module imports but never uses, as "name<-source". A name
// in a comment, a string or as an object's key is no use.
function unusedImports(text) {
  const body = codeOnly(text.replace(IMPORT, ""))
    .replace(/(?<=[{,]\s*)[\w$]+(?=\s*:(?!:))/g, " ")
    .replaceAll("...", " ... ");
  const used = (name) =>
    new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(body);
  const unused = [];
  for (const [, defaultName, named, star, source] of text.matchAll(IMPORT)) {
    const locals = [
      defaultName,
      star,
      ...(named ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.split(/\s+as\s+/).at(-1)),
    ].filter(Boolean);
    for (const name of locals) if (!used(name)) unused.push(`${name}<-${source}`);
  }
  return unused;
}

test("every test module imports only what it uses", () => {
  assert.deepEqual(
    unusedImports(
      [
        'import { fixture, LAUNCH, sink, quiet, keyed, worded, shown, matched, inside, after } from "./runner-fixture.mjs";',
        "// sink: named in this comment only",
        "/* quiet, in this one */",
        "const f = fixture(t);",
        'f.invoke([...LAUNCH], "worded");',
        "const options = { keyed: true, at: /keyed|quiet/ };",
        "const line = `${shown} worded ${f.at(matched)}`;",
        "const quoted = (text) => {",
        "  return /inside'/.test(text) && after;",
        "};",
      ].join("\n"),
    ),
    [
      "sink<-./runner-fixture.mjs",
      "quiet<-./runner-fixture.mjs",
      "keyed<-./runner-fixture.mjs",
      "worded<-./runner-fixture.mjs",
      "inside<-./runner-fixture.mjs",
    ],
    "a name in a comment, a string, a regular expression (one after return too) or as a key is unused; a spread one, one in a template's ${...} and one after a regular expression are used",
  );
  const files = [...moduleFiles(ROOT, "test", { skip: ["fixtures"] })];
  const findings = files.flatMap((file) =>
    unusedImports(fs.readFileSync(path.join(ROOT, file), "utf8")).map((name) => `${file} ${name}`),
  );
  assert.deepEqual(findings, [], "drop the imports a module does not use");
});
