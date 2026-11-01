// The runner's command line as the tests drive it in process: the source
// main() with the stable entry path the printed commands name.
import { fileURLToPath } from "node:url";
// The suite's private git configuration, for the runner's own git commands.
import "./git-environment.mjs";
import { main as sourceMain } from "../../src/index.mjs";

export const SCRIPT = fileURLToPath(new URL("../../run-codex-task.mjs", import.meta.url));
export const main = (argv, io) => sourceMain(argv, { ...io, script: SCRIPT });
