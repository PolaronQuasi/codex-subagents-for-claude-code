// Shared runner scenarios observe semantic task submissions derived solely
// from the fake Codex's actual RPC traffic. Runtime protocol suites use the
// unadapted codex fixture directly.
import {
  fixture as codexFixture,
  LAUNCH,
  KEY,
  TEXT,
  ORIGINAL,
  JOB,
  launchWith,
} from "./codex-fixture.mjs";
import { until } from "./driver-evidence.mjs";
export { LAUNCH, KEY, TEXT, ORIGINAL, JOB, launchWith };

export function fixture(t, initial = {}) {
  const stored = initial.storedJob;
  const f = codexFixture(t, {
    omitUsage: true,
    rateLimits: {},
    ...(stored
      ? {
          threadId: stored.threadId,
          durationMs: Date.parse(stored.completedAt) - Date.parse(stored.startedAt),
          touchedFiles: stored.result?.touchedFiles
            ?.map((p) => (typeof p === "string" ? p : p?.path))
            .filter((p) => typeof p === "string"),
        }
      : {}),
    ...initial,
  });
  let config = { ...initial };
  let last = null;
  const metadata = (key) => {
    if (key ? f.runs().includes(key) : f.runs().length) return f.metadata(key);
    if (last && (!key || last.runKey === key)) return last;
    return f.metadata(key);
  };
  const configure = (patch) => {
    config = { ...config, ...patch };
    f.configure(patch);
  };
  const events = () => {
    const wire = f.events();
    return wire
      .filter((e) => e.direction === "in" && ["turn/start", "turn/interrupt"].includes(e.method))
      .map((e) => {
        const index = wire.indexOf(e),
          prior = wire.slice(0, index);
        const thread = prior.findLast(
          (row) => row.direction === "in" && ["thread/start", "thread/resume"].includes(row.method),
        );
        const launch = prior.findLast((row) => row.direction === "launch");
        return {
          ...e,
          command: e.method === "turn/start" ? "task" : "interrupt",
          cwd: thread?.params.cwd,
          prompt: e.params.input?.[0]?.text,
          model: e.params.model ?? thread?.params.model,
          effort: e.params.effort,
          write: thread?.params.sandbox === "workspace-write",
          resume: thread?.method === "thread/resume",
          data: e.params.clientUserMessageId,
          git: launch?.git ?? [],
          sessionId: e.params.threadId,
          args: [
            thread?.params.model,
            e.params.effort,
            ...(thread?.params.sandbox === "workspace-write" ? ["--write"] : []),
            ...(thread?.method === "thread/resume" ? ["--resume"] : []),
          ],
        };
      });
  };
  const argsFor = (args) => {
    const copy = [...args];
    if (
      config.retainForTest &&
      !copy.some((a) =>
        [
          "--run",
          "--continue",
          "--close",
          "--cancel",
          "--sleep",
          "--list",
          "--inspect",
          "--doctor",
        ].includes(a),
      ) &&
      !copy.includes("--keep-state")
    )
      copy.push("--keep-state");
    const index = copy.indexOf("--wait-ms");
    if (
      index >= 0 &&
      copy[index + 1] === "0" &&
      !["running", "queued"].includes(config.status) &&
      !config.hangTurn
    )
      copy[index + 1] = "8000";
    return copy;
  };
  const invoke = async (args = LAUNCH, options = {}) => {
    const result = await f.invoke(argsFor(args), {
      ...options,
      onOutcome(value) {
        try {
          if (f.runs().length) last = f.metadata();
        } catch {
          /* Damaged metadata is an intentional test input. */
        }
        options.onOutcome?.(value);
      },
    });
    // A zero-budget launch may return before Codex reads turn/start. Shared
    // scenarios that inspect the submission wait for that fixture evidence.
    if ((result.code === 3 || args.includes("--detach")) && f.runs().length) {
      const job =
        result.stdout.match(/(?:Codex job | job=)([a-zA-Z0-9_-]+)/)?.[1] ?? f.metadata().jobId;
      if (job)
        await until(
          () =>
            f
              .events()
              .some((e) => e.method === "turn/start" && e.params.clientUserMessageId === job),
          `dispatch for ${job}`,
        );
    }
    try {
      if (f.runs().length) last = f.metadata();
    } catch {
      /* Inspection also accepts damaged records. */
    }
    return result;
  };
  return {
    ...f,
    configure,
    events,
    invoke,
    metadata,
    cli: async (args = LAUNCH, options) => {
      const result = await f.cli(argsFor(args), options);
      const footer = [
        ...result.stdout.matchAll(
          /^codex-subagents-for-claude-code: status=\S+ run=(\S+) turn=\d+ job=(\S+) /gm,
        ),
      ].at(-1);
      if (footer) last = { runKey: footer[1], jobId: footer[2] };
      return result;
    },
    resume: (extra = []) => [
      "--attach",
      metadata().jobId,
      "--run",
      metadata().runKey,
      "--wait-ms",
      "0",
      ...extra,
    ],
  };
}
