// Snapshot the schema before claiming a request. No driver reads a caller's path.
import fs from "node:fs";
import { readLimited, isAbsolutePath } from "./io.mjs";
import { OUTPUT_SCHEMA_MAX_BYTES } from "./constants.mjs";

export const validOutputSchema = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Buffer.byteLength(JSON.stringify(value)) <= OUTPUT_SCHEMA_MAX_BYTES;

export function loadOutputSchema(file) {
  if (!isAbsolutePath(file)) throw new Error("output-schema needs an absolute path");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("output-schema must be a regular file, not a link");
  let schema;
  try {
    schema = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(readLimited(file, OUTPUT_SCHEMA_MAX_BYTES)),
    );
  } catch {
    throw new Error("output-schema must be UTF-8 JSON within the 64 KiB limit");
  }
  if (!validOutputSchema(schema)) throw new Error("output-schema must contain a JSON object");
  return schema;
}

export function structuredResult(text) {
  try {
    JSON.parse(text);
    return { status: "valid", text: text.endsWith("\n") ? text : `${text}\n` };
  } catch {
    return { status: "invalid", text: null };
  }
}
