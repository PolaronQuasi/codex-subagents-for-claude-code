// A result is durable only when its path survives removal of run state and
// the run's disposable workspace. Inspect existing ancestors too: a junction
// can enter a cleanup tree even when the spelling of the path is outside it.
import fs from "node:fs";
import path from "node:path";
import { CODES, ERRNO } from "../shared/errors.mjs";

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function canonical(target) {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch (error) {
      if (error.code !== ERRNO.ENOENT) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function requireDurableDestination(file, run, stateDir, { existing = false } = {}) {
  const roots = [stateDir, ...(run.worktree ? [run.cwd] : [])].map((root) => ({
    lexical: path.resolve(root),
    real: canonical(root),
  }));
  const destination = path.resolve(file);
  const reject = (root) => {
    const error = new Error(
      `result destination ${file} is inside a cleanup tree (${root}); choose a results directory outside run state and disposable workspaces`,
    );
    error.code = CODES.UNSAFE_RESULT_DESTINATION;
    error.root = root;
    throw error;
  };
  for (const root of roots) {
    if (contains(root.lexical, destination)) reject(root.lexical);
  }
  // A new atomic write replaces the final file link; cleanup of an existing
  // copy must follow it. Inspect link targets as well as canonical paths: a
  // chain can enter a run directory and leave it again, yet break on cleanup.
  const pending = [existing ? destination : path.dirname(destination)];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const real = canonical(current);
    for (const root of roots) {
      if (contains(root.lexical, current) || contains(root.real, real)) reject(root.lexical);
    }
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        pending.push(path.resolve(path.dirname(current), fs.readlinkSync(current)));
    } catch (error) {
      if (error.code !== ERRNO.ENOENT) throw error;
    }
    const parent = path.dirname(current);
    if (parent !== current) pending.push(parent);
  }
}
