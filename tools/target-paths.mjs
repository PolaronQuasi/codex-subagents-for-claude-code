// Inspect an installation destination without following links at any level.
import fs from "node:fs";
import path from "node:path";
import { ERRNO } from "../src/shared/errors.mjs";

// A file below target, with its current lstat, or null for an unsafe path.
// A missing path is safe to create. Every existing ancestor, including target
// and ancestors above it, must be a real directory. A leaf must be an ordinary
// file with no hard-link aliases, so writing or chmod cannot alter another copy.
export function inspectTargetFile(target, name) {
  if (
    /[\\:\x00-\x1f]/.test(name) ||
    !name.split("/").every((part) => part && part !== "." && part !== "..")
  )
    return null;
  const root = path.resolve(target),
    file = path.resolve(root, name);
  const relative = path.relative(root, file);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return null;
  const volume = path.parse(file).root;
  let current = volume;
  for (const part of file.slice(volume.length).split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === ERRNO.ENOENT) return { file, stat: null };
      if (error.code === ERRNO.ENOTDIR) return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return null;
    if (current === file) return stat.isFile() && stat.nlink === 1 ? { file, stat } : null;
    if (!stat.isDirectory()) return null;
  }
  return null;
}

export function requireTargetFile(target, name) {
  const inspected = inspectTargetFile(target, name);
  if (!inspected)
    throw new Error(
      `unsafe installation target: ${path.resolve(target, name)}; every ancestor must be a real directory and the file must be regular and unlinked`,
    );
  return inspected.file;
}
