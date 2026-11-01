// Keep Node's live TAP output and repeat failures at the end of the CI step.
// The second TAP reporter writes incrementally, so completed failures survive
// a later subprocess timeout. Never let an oversized diagnostic flood the log.
import fs from "node:fs";

const LOG_BYTES = 16 * 1024 * 1024;
const FAILURE_LIMIT = 100;
const DETAIL_LINES = 100;
const LINE_CHARS = 2048;
const SUMMARY_CHARS = 256 * 1024;

export function failureSummary(tap) {
  const lines = tap.split(/\r?\n/);
  const blocks = [];
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)not ok \d+\b/.exec(lines[i]);
    if (!match || /#\s+(?:TODO|SKIP)\b/.test(lines[i])) continue;
    count++;
    if (blocks.length >= FAILURE_LIMIT) continue;
    const block = [lines[i].slice(0, LINE_CHARS)];
    const prefix = match[1] + "  ";
    let j = i + 1;
    for (; j < lines.length && lines[j].startsWith(prefix); j++) {
      if (block.length <= DETAIL_LINES) block.push(lines[j].slice(0, LINE_CHARS));
      if (lines[j] === prefix + "...") break;
    }
    if (j - i > DETAIL_LINES) block.push("  [diagnostic truncated; see full TAP output above]");
    blocks.push(block.join("\n"));
  }
  // TAP counters belong to Node's reporter, independently of runner job states.
  const totals = lines.filter((line) => /^# [a-z_]+ \d+(?:\.\d+)?$/.test(line));
  const complete = lines.some((line) => /^# duration_ms /.test(line));
  const summary = [
    "=== CI test failure summary ===",
    ...(blocks.length ? blocks : ["No completed failing-test diagnostic was recorded."]),
    ...(count > blocks.length
      ? [`${count - blocks.length} more failures: see full TAP output above.`]
      : []),
    ...totals,
    ...(!complete
      ? ["Test report is incomplete: the process stopped before its final totals."]
      : []),
  ].join("\n");
  return summary.length <= SUMMARY_CHARS
    ? summary
    : summary.slice(0, SUMMARY_CHARS) + "\n[summary truncated; see full TAP output above]";
}

export function printTestSummary(file, write = console.log) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) {
    write("CI test report unavailable: the test process did not create its TAP log.");
    return;
  }
  if (!stat.isFile() || stat.size > LOG_BYTES) {
    write("CI test report exceeds the summary limit; inspect the full TAP output above.");
    return;
  }
  write(failureSummary(fs.readFileSync(file, "utf8")));
}
