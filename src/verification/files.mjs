// Compare actual checkout bytes, never Git's mutable index or ignore flags.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readLimited, sameFolder } from "../shared/io.mjs";
import {
  GIT_LINK,
  IS_WINDOWS,
  VERIFY_TREE_ENTRIES_MAX,
  VERIFY_MUTATIONS_MAX,
  VERIFY_SCAN_BYTES_MAX,
  VERIFY_SCAN_MS,
  VERIFY_METADATA_BYTES,
} from "../shared/constants.mjs";

export async function snapshotFiles(root) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("verification snapshot root is not a regular directory");
  const files = new Map();
  const pending = [""];
  const deadline = performance.now() + VERIFY_SCAN_MS;
  let entries = 0,
    bytes = 0;
  const bounded = () => {
    if (
      entries > VERIFY_TREE_ENTRIES_MAX * 2 ||
      bytes > VERIFY_SCAN_BYTES_MAX ||
      performance.now() > deadline
    )
      throw new Error("verification filesystem comparison exceeded its bound");
  };
  while (pending.length) {
    const relative = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (!relative && (IS_WINDOWS ? entry.name.toLowerCase() : entry.name) === GIT_LINK) continue;
      entries++;
      bounded();
      const name = relative ? relative + "/" + entry.name : entry.name;
      const file = path.join(root, name),
        stat = fs.lstatSync(file);
      if (
        stat.isSymbolicLink() ||
        (!stat.isFile() && !stat.isDirectory()) ||
        (stat.isFile() && stat.nlink !== 1)
      ) {
        files.set(name, { type: "unsafe" });
      } else if (stat.isDirectory()) {
        pending.push(name);
      } else {
        const hash = crypto.createHash("sha256");
        const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const opened = fs.fstatSync(fd);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino
        ) {
          fs.closeSync(fd);
          throw new Error("verification file identity changed while opening it");
        }
        for await (const chunk of fs.createReadStream(file, { fd, autoClose: true })) {
          bytes += chunk.length;
          bounded();
          hash.update(chunk);
        }
        const after = fs.lstatSync(file);
        if (
          after.dev !== stat.dev ||
          after.ino !== stat.ino ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs
        )
          throw new Error("verification file changed during comparison");
        files.set(name, {
          type: "file",
          sha256: hash.digest("hex"),
          executable: !IS_WINDOWS && Boolean(stat.mode & 0o111),
        });
      }
    }
  }
  return { root: { dev: rootStat.dev, ino: rootStat.ino }, files };
}

export function compareSnapshotFiles(before, after) {
  const mutations = [];
  let count = 0;
  const add = (text) => {
    count++;
    if (mutations.length < VERIFY_MUTATIONS_MAX) mutations.push(text);
  };
  if (before.root.dev !== after.root.dev || before.root.ino !== after.root.ino)
    add("snapshot root identity changed");
  for (const name of new Set([...before.files.keys(), ...after.files.keys()])) {
    const a = before.files.get(name),
      b = after.files.get(name);
    if (!a) add("added: " + name);
    else if (!b) add("removed: " + name);
    else if (a.type !== b.type || a.sha256 !== b.sha256 || a.executable !== b.executable)
      add("changed: " + name);
  }
  return { mutations, mutationsTruncated: count > mutations.length };
}

function controlFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("verification Git control file is unsafe");
  return {
    file,
    dev: stat.dev,
    ino: stat.ino,
    bytes: readLimited(file, VERIFY_METADATA_BYTES).toString("utf8"),
  };
}

// Freeze the detached checkout's metadata before executing caller code. Later
// checks read these exact files, never Git configuration or a mutable index.
export function snapshotControl(root, common, commit) {
  const link = controlFile(path.join(root, GIT_LINK));
  const match = /^gitdir: (.+)\r?\n?$/.exec(link.bytes.trimEnd());
  if (!match) throw new Error("verification Git link is invalid");
  const directory = fs.realpathSync.native(path.resolve(root, match[1]));
  if (!sameFolder(path.dirname(directory), path.join(common, "worktrees")))
    throw new Error("verification Git metadata is outside the artifact repository");
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("verification Git metadata directory is unsafe");
  const head = controlFile(path.join(directory, "HEAD"));
  const backlink = controlFile(path.join(directory, "gitdir"));
  const commonLink = controlFile(path.join(directory, "commondir"));
  if (
    head.bytes.trim() !== commit ||
    !sameFolder(backlink.bytes.trim(), link.file) ||
    !sameFolder(path.resolve(directory, commonLink.bytes.trim()), common)
  )
    throw new Error("verification detached checkout identity mismatch");
  return { directory, dev: stat.dev, ino: stat.ino, files: [link, head, backlink, commonLink] };
}

export function unchangedControl(control) {
  try {
    const stat = fs.lstatSync(control.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== control.dev ||
      stat.ino !== control.ino
    )
      return false;
    return control.files.every((before) => {
      const after = controlFile(before.file);
      return before.dev === after.dev && before.ino === after.ino && before.bytes === after.bytes;
    });
  } catch {
    return false;
  }
}
