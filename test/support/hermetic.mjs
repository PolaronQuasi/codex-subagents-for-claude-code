// Preloaded by the ordinary suite, including each Node test worker. Check the
// path before calling fs: even exists/stat/copy probes must stay in fixtures.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

// The profile folders no test reads or probes: Claude Code's (the live agents,
// skills, settings and plugins, this tool's live installation and the state
// root beside it) and Codex's.
const GUARDED = [".claude", ".codex"];
// An OpenAI plugin tree is refused under any folder, a fixture profile's too,
// and no allowed folder opens it.
const PLUGIN_TREE = /(?:^|\/)\.claude\/plugins\/(?:cache|marketplaces)\/openai-codex(?:\/|$)/;

// Whether target is folder or lies inside it, by whole names: the state root
// beside the installation is not inside the installation.
const within = (target, folder) =>
  target === folder || target.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

// The rule for one profile: whether a test may not touch a path. profile and
// allowed give each folder in every spelling a test may meet: as configured,
// as Node loaded it and as the file system resolves it (through a junction, a
// symlink or an 8.3 short name). The allowed folders, the repository's own
// tree and the temporary folder, open only the guarded folders that contain
// them: the live installation is a clone inside ~/.claude, so its suite loads
// its own files, while the folders above and beside it stay refused. An
// allowed folder never opens a guarded folder it contains.
export function profileRule({ profile, allowed, platform = process.platform }) {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  // Absolute and "/"-separated; on Windows without the namespace prefix of
  // \\?\C:\… or \\?\UNC\server\…, which name the same files.
  const spell = (value) =>
    windows
      ? paths
          .resolve(value)
          .replaceAll("\\", "/")
          .replace(/^\/\/[?.]\/(?=[a-z]:)/i, "")
          .replace(/^\/\/[?.]\/unc\//i, "//")
      : paths.resolve(value);
  // A refusal ignores case everywhere, an allowance only where the file system
  // does by default (Windows and macOS).
  const fold = (value) => value.toLowerCase();
  const caseless = windows || platform === "darwin";
  const opens = (folder, target) =>
    caseless ? within(fold(target), fold(folder)) : within(target, folder);
  const open = [...new Set(allowed.map(spell))];
  const guards = [
    ...new Set(
      profile.flatMap((home) => GUARDED.map((name) => fold(spell(paths.join(home, name))))),
    ),
  ].map((folder) => ({
    folder,
    inside: open.filter((inner) => fold(inner) !== folder && within(fold(inner), folder)),
  }));
  return (value) => {
    const target = spell(value);
    return (
      PLUGIN_TREE.test(fold(target)) ||
      guards.some(
        ({ folder, inside }) =>
          within(fold(target), folder) && !inside.some((inner) => opens(inner, target)),
      )
    );
  };
}

// A folder in the spellings a test may meet: as given, and as the file system
// resolves it both ways (fs.realpathSync keeps an 8.3 short name, the native
// one does not). Resolved before the fs functions below are guarded.
const spellings = (folder) => [
  folder,
  ...[fs.realpathSync, fs.realpathSync.native].flatMap((resolve) => {
    try {
      return [resolve(folder)];
    } catch {
      return [];
    }
  }),
];
// This repository: the folder above test/support, from this guard's location.
const REPOSITORY = fileURLToPath(new URL("../..", import.meta.url));
const refused = profileRule({
  profile: spellings(os.homedir()),
  allowed: [...spellings(REPOSITORY), ...spellings(os.tmpdir())],
});

export function assertHermetic(value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== "string") return;
  if (refused(value)) throw new Error(`test attempted profile filesystem access: ${value}`);
}

for (const name of [
  "readFile",
  "readdir",
  "opendir",
  "stat",
  "lstat",
  "access",
  "realpath",
  "readlink",
  "open",
  "cp",
  "copyFile",
  "exists",
  "watch",
  "createReadStream",
  "glob",
])
  for (const suffix of ["", "Sync"]) {
    const key = `${name}${suffix}`;
    const original = fs[key];
    if (!original) continue;
    const guarded = (...args) => {
      assertHermetic(args[0]);
      return original(...args);
    };
    if (original.native)
      guarded.native = (...args) => {
        assertHermetic(args[0]);
        return original.native(...args);
      };
    fs[key] = guarded;
  }
for (const name of [
  "readFile",
  "readdir",
  "opendir",
  "stat",
  "lstat",
  "access",
  "realpath",
  "readlink",
  "open",
  "cp",
  "copyFile",
  "glob",
]) {
  const original = fs.promises[name];
  if (!original) continue;
  fs.promises[name] = async (...args) => {
    assertHermetic(args[0]);
    return original(...args);
  };
}
syncBuiltinESMExports();
