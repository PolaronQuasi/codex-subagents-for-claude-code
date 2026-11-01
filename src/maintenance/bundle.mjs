import fs from "node:fs";
import path from "node:path";
import { withIdleRun } from "./idle-run.mjs";
import { requireDurableDestination } from "../delivery/result-path.mjs";
import { requireDirectory, sameFolder, writeOutput } from "../shared/io.mjs";
import { RPC, BUNDLE_MAX_BYTES, BUNDLE_CLASSIFICATION } from "../shared/constants.mjs";
import { EXIT } from "../shared/errors.mjs";

export async function bundle(options, context) {
  return withIdleRun(
    options,
    context,
    async ({ run, stateDir, session, threadId, resultsDir, stdout, signal, commandMs }) => {
      requireDurableDestination(path.join(resultsDir, "bundle.zip"), run, stateDir);
      fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
      requireDirectory(resultsDir);
      const folder = fs.mkdtempSync(path.join(resultsDir, `bundle-${run.runKey}-`));
      const file = path.join(folder, "diagnostics.zip");
      // Keep an explicit intent after a disconnect: the server may still write
      // this caller-owned file. Never reuse the path or silently retry the RPC.
      fs.writeFileSync(
        path.join(folder, "request.json"),
        JSON.stringify({
          runKey: run.runKey,
          threadId,
          at: new Date().toISOString(),
          includeLogs: true,
        }),
        { flag: "wx", mode: 0o600 },
      );
      await writeOutput(
        stdout,
        `Diagnostic bundle may contain prompts, credentials and logs. Saving locally to ${file}; nothing is uploaded.\n`,
        { signal, timeoutMs: commandMs },
      );
      try {
        const reply = await session.request(RPC.FEEDBACK_SAVE, {
          threadId,
          classification: BUNDLE_CLASSIFICATION,
          includeLogs: true,
          savePath: file,
        });
        if (!sameFolder(reply.savedPath ?? "", file) || reply.threadId !== threadId)
          throw new Error("bundle identity mismatch");
        requireDurableDestination(file, run, stateDir, { existing: true });
        const stat = fs.lstatSync(file);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > BUNDLE_MAX_BYTES
        )
          throw new Error("bundle is unsafe or exceeds the 64 MiB acceptance limit");
        await writeOutput(
          stdout,
          `codex-subagents-for-claude-code-bundle: run=${run.runKey} bytes=${stat.size} file=${file}\n`,
          { signal, timeoutMs: commandMs },
        );
        return EXIT.COMPLETED;
      } catch {
        throw new Error(
          `bundle not confirmed; inspect ${folder}. The request is not retried; any partial file is retained.`,
        );
      }
    },
  );
}
