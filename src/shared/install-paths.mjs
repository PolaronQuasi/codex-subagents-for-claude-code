// Inspect an installation destination, resolving only fixed system aliases.
import fs from "node:fs";
import path from "node:path";
import { ERRNO } from "./errors.mjs";

// macOS exposes these root-owned aliases. Recognize their exact link text,
// not a realpath of an arbitrary target: that would hide unsafe ancestors.
// This is a filesystem-layout check; Windows paths never match these keys.
const SYSTEM_DIRECTORY_ALIASES = new Map([
  ["/var", "/private/var"],
  ["/tmp", "/private/tmp"],
  ["/etc", "/private/etc"],
]);

function systemAlias(current, stat) {
  const physical = SYSTEM_DIRECTORY_ALIASES.get(current);
  if (!physical || !stat.isSymbolicLink() || stat.uid !== 0) return null;
  const destination = fs.readlinkSync(current);
  return destination === physical || destination === physical.slice(1) ? physical : null;
}

// Normalize only verified fixed OS prefixes; never inspect an unrelated path
// supplied as an optional plugin-root hint.
export function systemDirectoryPath(target) {
  const resolved = path.resolve(target);
  for (const [alias] of SYSTEM_DIRECTORY_ALIASES) {
    if (resolved !== alias && !resolved.startsWith(`${alias}/`)) continue;
    const stat = fs.lstatSync(alias, { throwIfNoEntry: false });
    const physical = stat && systemAlias(alias, stat);
    if (physical) return physical + resolved.slice(alias.length);
  }
  return resolved;
}

// A file below target, with its current lstat, or null for an unsafe path.
// A missing path is safe to create. Every existing ancestor, including target
// and ancestors above it, must be a real directory after resolving the fixed
// system aliases. A leaf must be an ordinary file with no hard-link aliases,
// so writing or chmod cannot alter another copy.
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
  return inspectPath(file, false);
}

function inspectPath(file, directory) {
  const volume = path.parse(file).root;
  if (file === volume) return directory ? { file, stat: fs.lstatSync(file) } : null;
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
    if (stat.isSymbolicLink()) {
      const physical = systemAlias(current, stat);
      if (!physical || (current === file && !directory)) return null;
      // Rewalk from the volume root, including /private itself. Only the
      // fixed root prefix is resolved; every remaining link is still refused.
      const inspected = inspectPath(path.join(physical, path.relative(current, file)), directory);
      // Keep the caller's spelling for all writes and fault-injection checks.
      return inspected ? { ...inspected, file } : null;
    }
    if (current === file)
      return (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1)
        ? { file, stat }
        : null;
    if (!stat.isDirectory()) return null;
  }
  return null;
}

export function inspectTargetDirectory(target) {
  return inspectPath(path.resolve(target), true);
}

export function requireTargetDirectory(target, { missing = false } = {}) {
  const inspected = inspectTargetDirectory(target);
  if (!inspected || (!missing && !inspected.stat))
    throw new Error(
      `unsafe runtime directory: ${path.resolve(target)}; every ancestor must be a real directory`,
    );
  return inspected.file;
}

export function requireTargetFile(target, name) {
  const inspected = inspectTargetFile(target, name);
  if (!inspected)
    throw new Error(
      `unsafe installation target: ${path.resolve(target, name)}; every ancestor must be a real directory and the file must be regular and unlinked`,
    );
  return inspected.file;
}
