// One owned temporary directory, with identity and canonical containment
// checked again before cleanup. Native and slash-spelled TEMP identify the
// same parent; a replaced directory or junction never gains cleanup authority.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_REMOVAL = Object.freeze({ maxRetries: 5, retryDelay: 100 });

export function createScratch(prefix, parent = os.tmpdir()) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-$/.test(prefix)) throw new Error("invalid scratch prefix");
  const base = fs.realpathSync.native(parent);
  const directory = fs.mkdtempSync(path.join(base, prefix));
  // Filesystem IDs can exceed Number's exact integer range, notably on NTFS.
  const identity = fs.lstatSync(directory, { bigint: true });
  const parentIdentity = fs.lstatSync(base, { bigint: true });
  return {
    directory,
    remove() {
      const current = fs.lstatSync(directory, { bigint: true });
      const currentParent = fs.lstatSync(base, { bigint: true });
      if (
        path.dirname(directory) !== base ||
        !path.basename(directory).startsWith(prefix) ||
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        currentParent.dev !== parentIdentity.dev ||
        currentParent.ino !== parentIdentity.ino ||
        fs.realpathSync.native(base) !== base ||
        fs.realpathSync.native(directory) !== directory
      )
        throw new Error("unexpected temporary path or identity");
      fs.rmSync(directory, { recursive: true, force: true, ...SCRATCH_REMOVAL });
    },
  };
}
