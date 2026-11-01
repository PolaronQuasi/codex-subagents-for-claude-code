import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createScratch } from "../../tools/scratch.mjs";
import { BASE64, SHA256 } from "../fixtures/codex/launcher-linux.mjs";

let compiled;

// Linux x64 CI has no compiler: use the fixed static launcher built from the
// adjacent source. Other hosts use their existing native compiler once per
// worker. No dependency download, production bypass or live CLI is involved.
export function writeNativeCodex(file) {
  if (!compiled && process.platform === "linux" && process.arch === "x64") {
    compiled = Buffer.from(BASE64, "base64");
    if (crypto.createHash("sha256").update(compiled).digest("hex") !== SHA256)
      throw new Error("Corrupt fixed native Codex test launcher");
  }
  if (!compiled) {
    const scratch = createScratch("codex-native-fixture-");
    try {
      const windows = process.platform === "win32";
      const output = path.join(scratch.directory, windows ? "fake.exe" : "fake");
      const source = fileURLToPath(
        new URL(`../fixtures/codex/launcher.${windows ? "cs" : "c"}`, import.meta.url),
      );
      const compiler = windows
        ? path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "Microsoft.NET",
            "Framework64",
            "v4.0.30319",
            "csc.exe",
          )
        : "cc";
      const result = spawnSync(
        compiler,
        windows ? ["/nologo", "/target:exe", `/out:${output}`, source] : [source, "-o", output],
        {
          cwd: scratch.directory,
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
        },
      );
      if (result.error || result.status !== 0)
        throw new Error(
          `Fake Codex requires the existing host compiler: ${result.error?.message ?? result.stderr ?? result.stdout}`,
        );
      compiled = fs.readFileSync(output);
    } finally {
      scratch.remove();
    }
  }
  fs.writeFileSync(file, compiled, { mode: 0o700 });
}
