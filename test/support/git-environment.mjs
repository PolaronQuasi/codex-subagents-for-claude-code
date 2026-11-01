// A test's disposable repositories must never inherit a hook's repository, nor
// the developer's own git configuration. Every git a test starts runs without
// the GIT_* variables it inherited, with no system configuration and with a
// private, empty global one, so global hooks (core.hooksPath), signing
// (commit.gpgsign, tag.gpgsign), init.defaultBranch and the like never reach a
// fixture repository. GIT_CONFIG_GLOBAL needs git 2.32; an older git ignores it
// and reads the global configuration after all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const withoutGit = (env) =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  );

// One empty global configuration per test process, removed when it exits.
const folder = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-subagents-for-claude-code-git-config-"),
);
export const PRIVATE_GLOBAL_CONFIG = path.join(folder, "gitconfig");
fs.writeFileSync(PRIVATE_GLOBAL_CONFIG, "");
process.once("exit", () => fs.rmSync(folder, { recursive: true, force: true }));

export const GIT_ISOLATION = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: PRIVATE_GLOBAL_CONFIG,
});

export const gitEnvironment = (env = process.env) => ({ ...withoutGit(env), ...GIT_ISOLATION });

// Protect release functions invoked in-process by tests as well as helpers, and
// the runner's own git commands, which read process.env.
for (const name of Object.keys(process.env))
  if (name.toUpperCase().startsWith("GIT_")) delete process.env[name];
Object.assign(process.env, GIT_ISOLATION);

// A fixture repository: git init, the unborn branch named with symbolic-ref
// (git init -b needs git 2.28), and a local configuration with an identity and
// signing off. Nothing sets core.hooksPath, so no hook runs in it.
export function initRepository(
  dir,
  { branch = "main", name = "fixture", email = "fixture@localhost" } = {},
) {
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true,
      env: gitEnvironment(),
    });
    if (result.error || result.status !== 0)
      throw new Error(`git ${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
  };
  // A long fixture may need this before init can even copy its hook templates.
  git("-c", "core.longpaths=true", "init", "-q");
  git("symbolic-ref", "HEAD", `refs/heads/${branch}`);
  for (const [key, value] of [
    ["user.name", name],
    ["user.email", email],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.longpaths", "true"],
  ])
    git("config", key, value);
}
