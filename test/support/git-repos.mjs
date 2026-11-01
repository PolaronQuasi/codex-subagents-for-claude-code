// Throwaway git repositories for the workspace tests, made with the suite's
// private git configuration (git-environment.mjs).
import fs from "node:fs";
import path from "node:path";
import { gitEnvironment, initRepository } from "./git-environment.mjs";
import { runProcess } from "../../src/index.mjs";

export async function gitOut(args, cwd) {
  const result = await runProcess("git", args, { cwd, env: gitEnvironment(), timeoutMs: 60_000 });
  if (result.error || result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

// A repository with one commit of README.md on main.
export async function gitInit(dir) {
  initRepository(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "base\n");
  await gitOut(["add", "README.md"], dir);
  await gitOut(
    ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "commit", "-q", "-m", "base"],
    dir,
  );
}

// A commit on a branch PROTOYPE-3 that main does not have; main is checked out
// again. Returns the commit.
export async function prototypeBranch(dir) {
  await gitOut(["switch", "-q", "-c", "PROTOYPE-3"], dir);
  fs.writeFileSync(path.join(dir, "prototype.txt"), "only on the prototype branch\n");
  await gitOut(["add", "prototype.txt"], dir);
  await gitOut(
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-q",
      "-m",
      "prototype",
    ],
    dir,
  );
  const commit = await gitOut(["rev-parse", "HEAD"], dir);
  await gitOut(["switch", "-q", "main"], dir);
  return commit;
}
