// These types document the runner and help editors. They do not add a build or type-check step.
/**
 * @typedef {'completed'|'failed'|'cancelled'} TerminalStatus
 *
 * @typedef {object} DeliveryPreferences
 * @property {boolean} quiet
 * @property {boolean} relay
 * @property {number} maxLines
 * @property {number} maxBytes
 *
 * @typedef {object} Worktree
 * @property {string} base
 * @property {string|null} branch
 * @property {string|null} [startRef]
 * @property {string|null} [startCommit]
 *
 * @typedef {object} TokenUsage
 * @property {number|null} input
 * @property {number|null} cached
 * @property {number|null} output
 * @property {number|null} reasoning
 * @property {number|null} total
 *
 * @typedef {object} Usage
 * @property {TokenUsage|null} turn
 * @property {TokenUsage|null} threadTotal
 * @property {object|null} limit
 * @property {string|null} credits
 *
 * @typedef {object} CachedResult
 * @property {TerminalStatus} status
 * @property {string} sha256
 * @property {string|null} [threadId]
 * @property {number|null} [durationMs]
 * @property {string[]} [touchedFiles]
 * @property {{source: 'git'|'scratch', patch: string, base?: string, head?: string, sha256?: string}} [changes] Delivery-owned inventory and bounded patch evidence.
 * @property {boolean} [progressWriteFailed]
 * @property {'valid'|'invalid'} [schema] Whether the structured final answer parses as JSON.
 * @property {string} [jsonFile] Durable structured-output sidecar.
 * @property {string|null} [resultFile]
 * @property {string|null} [commit]
 * @property {string} [deliveredAt] When the result was fetched (cacheResult, with cachedAt): no evidence of delivery (state.mjs resultFetchedAt reads it).
 * @property {string} [cachedAt]
 * @property {string} [durableSavedAt]
 * @property {string} [acknowledgedAt]
 * @property {Usage|null} [usage]
 *
 * @typedef {object} Turn An archived turn with the current switchTurn shape (turn-transition.mjs).
 * @property {string} jobId
 * @property {string|null} model
 * @property {"auto"|"concise"|"detailed"|"none"} [summary]
 * @property {string} [review] This turn's native review target; not inherited.
 * @property {"none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"|null} effort
 * @property {boolean} write
 * @property {CachedResult} result
 * @property {string} [requestId]
 * @property {string} [requestDigest] Kept with requestId, so a rollback restores the turn exactly.
 * @property {false|null} [keepState] Absent when the run was kept by request; null when kept only for lack of a result copy.
 * @property {RetriedJob[]} [retriedJobs]
 *
 * @typedef {object} RetriedJob A job the turn gave up and submitted again.
 * @property {string} jobId
 * @property {string} reason "worker-died": its worker died before the job started;
 *
 * @typedef {object} RunRecord
 * @property {2} version
 * @property {string} runKey 32-character current key.
 * @property {string|null} jobId Null until a launch is confirmed/recovered.
 * @property {string} cwd
 * @property {{path:string,realPath:string,version:string,build:string}} codex
 * @property {number} driverProtocol
 * @property {string} [review] This turn's native review target; not inherited.
 * @property {string} [model]
 * @property {"auto"|"concise"|"detailed"|"none"} [summary]
 * @property {"none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"} [effort]
 * @property {boolean} [write]
 * @property {boolean} [keepState]
 * @property {boolean} [scratchWorkspace]
 * @property {boolean} [quiet]
 * @property {boolean} [relay]
 * @property {boolean} [dormant]
 * @property {boolean} [continuing]
 * @property {boolean} [compact] Explicit compaction before this continuation only.
 * @property {string} [tier] Explicit service tier for this turn only.
 * @property {object} [outputSchema] Snapshotted output schema for this turn only.
 * @property {{pid:number,processStart:string}} [maintenanceWorker] Owned probe birth identity.
 * @property {{runKey:string,threadId:string,turnId:string,at:number}} [forkedFrom]
 * @property {'prepared'|'dispatching'|'ready'} [forkState]
 * @property {true} [forkSeed] Context exists before the first local model turn.
 * @property {true} [forkRedaction] Private inherited prompt-redaction evidence exists.
 * @property {string} [contextThreadId]
 * @property {object} [seedReservation] Settings restored if the first fork turn never starts.
 * @property {object} [historyOperation] Durable, unconfirmed revert intent.
 * @property {object[]} [historyEdits] Bounded confirmed history-edit receipts.
 * @property {number} [maxStdoutLines]
 * @property {number} [maxStdoutBytes]
 * @property {string|null} [session]
 * @property {string|null} [hostSession]
 * @property {string} [createdAt]
 * @property {string|null} [requestId]
 * @property {string|null} [requestDigest]
 * @property {number} [requestDigestVersion] REQUEST_DIGEST_VERSION (constants.mjs), the form of requestDigest.
 * @property {string|null} [turnRequestId]
 * @property {string|null} [turnRequestDigest]
 * @property {Turn[]} [turns]
 * @property {Worktree} [worktree]
 * @property {CachedResult} [result]
 * @property {RetriedJob[]} [retriedJobs] The current turn's; archived with the turn.
 * @property {WorkerIdentity} [worker] The current job's worker, as first seen alive.
 * @property {LaunchingHelper} [launching] The launch helper of a launch in progress.
 *
 * @typedef {object} LaunchingHelper
 * @property {number} pid
 * @property {string|null} processStart The OS start time as processStart reads it (opaque), or null when not (yet) read.
 * @property {string} at When the helper was started.
 *
 * @typedef {object} WorkerIdentity
 * @property {string} jobId
 * @property {number} pid
 * @property {string} processStart The OS start time as processStart reads it (opaque).
 *
 * @typedef {(message: string) => void|Promise<void>} Diagnostic
 *
 * @typedef {object} Timing
 * @property {() => number} now
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} sleep
 *
 * @typedef {object} ProcessProbe
 * @property {(pid: number, options?: {timeoutMs?: number}) => string|null} start
 * @property {(pid: number, start: string, options?: {timeoutMs?: number}) => string|null} commandLine
 * @property {() => StartReader} [reader] A launch's start-time reader; without one, start is asked.
 *
 * @typedef {object} StartReader
 * @property {(pid: number) => Promise<string|null>} start The start time processStart would give.
 * @property {() => void} close
 *
 * @typedef {object} StopResult
 * @property {string} state A STOP_OUTCOME.
 * @property {string|null} interrupted The interrupt's answer, or null when none ran.
 * @property {string|null} [detail]
 *
 * @typedef {object} Processes
 * @property {ProcessProbe} probe
 * @property {(target: {pid: number, start: string, pattern?: string|null, interrupt?: (() => Promise<string>)|null}) => Promise<StopResult>} stop
 *
 * @typedef {object} Audit
 * @property {(run: RunRecord|{runKey?: string}) => void} bind
 * @property {(transition: string, run?: RunRecord) => Promise<void>} emit
 *
 * @typedef {object} HelperContext
 * @property {NodeJS.ProcessEnv} parentEnv
 * @property {string} stateDir
 * @property {number} commandMs
 * @property {AbortSignal} [signal]
 * @property {Timing} [timing]
 * @property {Processes} [processes]
 * @property {Audit} [audit]
 *
 * @typedef {HelperContext & {stateBase: string, warn: Diagnostic, save: () => void, driver: object, force?: boolean}} LifecycleContext
 * @typedef {HelperContext & {stateBase: string, resultsDir: string, base: string,
 *   delivery: DeliveryPreferences, script: string, info: Diagnostic, warn: Diagnostic}} LaunchContext
 * @typedef {{kind: 'prepared', run: RunRecord, stateDir: string, releaseRunLock: () => void}
 *   | {kind: 'attach', key: string} | {kind: 'replay', copy: string}
 *   | {kind: 'waiting', key: string|null}} LaunchOutcome
 * @typedef {{ended: false, snapshot: StatusAnswer}
 *   | {ended: true, status: TerminalStatus, snapshot: StatusAnswer, stale: boolean, deadWorker: number|null}} WaitOutcome
 *
 * @typedef {object} EnvironmentPaths
 * @property {string} stateBase
 * @property {string} resultsDir
 * @property {string} codexHome
 *
 * @typedef {object} DeliveryOutcome
 * @property {'delivered'} kind
 * @property {string} status
 * @property {string} keep
 * @property {string|null} resultFile
 *
 * @typedef {object} UndeliveredOutcome Why a command delivered nothing.
 * @property {'failed'|'still-running'} kind OUTCOME.FAILED or OUTCOME.STILL_RUNNING (constants.mjs).
 * @property {string} reason Its error's message, or its STILL RUNNING notice's first line.
 *
 * @typedef {object} RunnerIO
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [cwd]
 * @property {NodeJS.WritableStream} [stdout]
 * @property {NodeJS.WritableStream} [stderr]
 * @property {AbortSignal} [signal]
 * @property {boolean} [requireDurableCopy]
 * @property {string} [script]
 * @property {Timing} [timing] Retry/deadline policy only; process timeouts stay real.
 * @property {Processes} [processes] The OS process queries and the identity-bound stop.
 * @property {(outcome: DeliveryOutcome|UndeliveredOutcome) => void} [onOutcome] In-process collection; CLI still returns an integer.
 */
export {};
