import type { Address } from "@solana/kit";
import {
  type AnalysisDependencies,
  AnalysisError,
  analyzeProposal,
  detectChanges,
  NotASquadsMultisigError,
  PENDING_STATUSES,
  readWatchSnapshot,
  type Verdict,
  WatchError,
  type WatchEvent,
} from "@vigil-sol/core";
import type { ParsedArgs } from "../args.js";
import { CliError, EXIT } from "../errors.js";
import type { Runtime } from "../runtime.js";
import { parseAddress } from "../validate.js";
import { type AlertAnalysis, buildAlert } from "../watch/alert.js";
import {
  checkWebUrl,
  type Notifier,
  type NotifierId,
  notifiersFromEnv,
  StdoutNotifier,
  sendWithRetry,
} from "../watch/notifiers.js";
import {
  defaultStatePath,
  OUTBOX_MAX_AGE_MS,
  type OutboxItem,
  parseWatchFile,
  serializeWatchFile,
  type WatchFile,
} from "../watch/state-file.js";

/** Longest pause between cycles after repeated RPC failures. */
const MAX_BACKOFF_SECONDS = 15 * 60;

interface WatchContext {
  readonly runtime: Runtime;
  readonly multisig: Address;
  readonly statePath: string;
  readonly deps: AnalysisDependencies;
  readonly notifiers: readonly Notifier[];
  readonly webUrl: string | undefined;
}

interface CycleOutcome {
  /** The multisig could not be read this cycle. */
  readonly readFailed: boolean;
  /** Some alert is still waiting for a notifier. */
  readonly undelivered: boolean;
}

/**
 * `vigil watch <multisig>`: reads the multisig every `--interval` seconds, analyses new proposals
 * and proposals that became ready to execute, and sends alerts. `--once` runs one cycle (cron, CI).
 * The state is written before any alert is sent and after each delivery, so an alert is sent once
 * per notifier (a crash between a delivery and the next write can repeat that one alert).
 */
export async function watchCommand(args: ParsedArgs, runtime: Runtime): Promise<number> {
  if (args.positionals.length !== 1) {
    throw new CliError(
      args.positionals.length === 0
        ? "Missing the multisig address."
        : "Too many arguments for vigil watch.",
      "Usage: vigil watch <multisig> [--interval SECONDS] [--once] [--state-file PATH]",
    );
  }
  const multisig = parseAddress(args.positionals[0], "multisig address");
  const { environment, options } = runtime;
  const webUrl = checkWebUrl(environment.env.VIGIL_WEB_URL);
  const stdout = new StdoutNotifier((text) => runtime.out(text), options.json, options.locale);
  const { notifiers } = notifiersFromEnv(
    environment.env,
    environment.notifierHttp(),
    stdout,
    options.locale,
  );
  const statePath =
    args.stateFile ?? defaultStatePath(environment.env, environment.homeDir, multisig);
  if (statePath === undefined) {
    throw new CliError(
      "Cannot tell where to keep the watch state: neither XDG_STATE_HOME nor HOME is set.",
      "Pass --state-file <path>.",
    );
  }
  const ctx: WatchContext = {
    deps: runtime.analysisDependencies(),
    multisig,
    notifiers,
    runtime,
    statePath,
    webUrl,
  };

  log(
    runtime,
    `watching ${multisig} via ${ctx.deps.rpcHost}; alerts to ${notifiers.map((n) => n.id).join(", ")}; state in ${statePath}`,
  );
  if (webUrl === undefined) {
    log(runtime, "note: VIGIL_WEB_URL is not set, so alerts carry no link to the web app");
  }

  let file = await loadState(ctx);
  if (args.once) {
    const outcome = await runCycle(ctx, file);
    file = outcome.file;
    return outcome.readFailed || outcome.undelivered ? EXIT.error : EXIT.ok;
  }

  const signal = environment.shutdown;
  let failures = 0;
  while (signal?.aborted !== true) {
    const outcome = await runCycle(ctx, file);
    file = outcome.file;
    failures = outcome.readFailed ? failures + 1 : 0;
    const wait =
      failures === 0
        ? args.interval
        : Math.min(Math.max(args.interval, MAX_BACKOFF_SECONDS), args.interval * 2 ** failures);
    if (failures > 0) {
      log(runtime, `next attempt in ${wait} s`);
    }
    await environment.sleep(wait * 1000, signal);
  }
  log(runtime, "stopped");
  return EXIT.ok;
}

async function loadState(ctx: WatchContext): Promise<WatchFile> {
  let text: string | undefined;
  try {
    text = await ctx.runtime.environment.files.read(ctx.statePath);
  } catch {
    throw new CliError(
      `Cannot read the watch state file ${ctx.statePath}.`,
      "Check its permissions, or pass another --state-file.",
    );
  }
  if (text === undefined) {
    log(ctx.runtime, "no state yet: alerting on proposals that are already pending");
    return { outbox: [], verdicts: {}, watch: undefined };
  }
  const file = parseWatchFile(text);
  if (file.watch !== undefined && file.watch.multisig !== ctx.multisig) {
    throw new WatchError(
      "MULTISIG_MISMATCH",
      `the state file ${ctx.statePath} belongs to multisig ${file.watch.multisig}`,
    );
  }
  return file;
}

async function saveState(ctx: WatchContext, file: WatchFile): Promise<void> {
  try {
    await ctx.runtime.environment.files.write(ctx.statePath, serializeWatchFile(file));
  } catch {
    throw new CliError(
      `Cannot write the watch state file ${ctx.statePath}; stopping so no alert is sent twice.`,
      "Check the directory's permissions and free space, or pass another --state-file.",
    );
  }
}

async function runCycle(
  ctx: WatchContext,
  previous: WatchFile,
): Promise<CycleOutcome & { readonly file: WatchFile }> {
  const { runtime } = ctx;
  let file = previous;
  let readFailed = false;
  try {
    file = await detectAndQueue(ctx, previous);
    await saveState(ctx, file);
  } catch (error) {
    if (error instanceof WatchError || error instanceof CliError) {
      throw error;
    }
    if (error instanceof NotASquadsMultisigError) {
      throw new AnalysisError("NOT_A_MULTISIG", error.message);
    }
    readFailed = true;
    log(
      runtime,
      `error: the multisig could not be read from the RPC (${ctx.deps.rpcHost}); will retry`,
    );
  }
  const delivered = await deliver(ctx, file);
  return { file: delivered.file, readFailed, undelivered: delivered.undelivered };
}

/** Reads the chain, detects changes, analyses what needs it, and queues one alert per event. */
async function detectAndQueue(ctx: WatchContext, previous: WatchFile): Promise<WatchFile> {
  const { runtime, deps, multisig } = ctx;
  const snapshot = await readWatchSnapshot(deps.rpc, multisig, previous.watch);
  const changes = detectChanges(snapshot, previous.watch);
  runtime.noteCluster(snapshot.cluster);
  if (changes.skipped !== null) {
    log(
      runtime,
      `warning: ${changes.skipped.to - changes.skipped.from + 1n} new transactions (#${changes.skipped.from}–#${changes.skipped.to}) were not read: more than one cycle reads. Run vigil list ${multisig} --status all`,
    );
  }
  for (const untracked of changes.untracked) {
    if (untracked.reason === "stale") {
      log(
        runtime,
        `#${untracked.transactionIndex} became stale (can no longer be executed); no longer followed`,
      );
    }
  }

  const verdicts: Record<string, Verdict> = { ...previous.verdicts };
  const outbox: OutboxItem[] = [...previous.outbox];
  const detectedAt = new Date(runtime.environment.clock.now()).toISOString();
  const alertContext = {
    cluster: snapshot.cluster,
    detectedAt,
    locale: runtime.options.locale,
    multisig,
    rpcHost: deps.rpcHost,
    timeLockSeconds: snapshot.multisig.timeLockSeconds,
    webUrl: ctx.webUrl,
  };
  for (const event of changes.events) {
    const key = event.transactionIndex.toString();
    const analysis = await analyse(ctx, event, verdicts[key]);
    if (analysis.kind === "report") {
      verdicts[key] = analysis.report.verdict;
    }
    const alert = buildAlert(event, analysis, alertContext);
    if (!outbox.some((item) => item.alert.id === alert.id)) {
      outbox.push({ alert, pending: ctx.notifiers.map((n) => n.id), queuedAt: detectedAt });
    }
  }
  const tracked = new Set(changes.nextState.tracked.map((t) => t.transactionIndex.toString()));
  return {
    outbox,
    verdicts: Object.fromEntries(Object.entries(verdicts).filter(([index]) => tracked.has(index))),
    watch: changes.nextState,
  };
}

/** New pending proposals and proposals that became Approved are analysed; the rest are not. */
async function analyse(
  ctx: WatchContext,
  event: WatchEvent,
  lastVerdict: Verdict | undefined,
): Promise<AlertAnalysis> {
  const wanted =
    event.kind === "new-proposal"
      ? event.transactionKind !== null &&
        !event.isStale &&
        event.status !== "Closed" &&
        PENDING_STATUSES.has(event.status)
      : event.to === "Approved";
  if (!wanted) {
    return { kind: "last-known", verdict: lastVerdict };
  }
  const { options } = ctx.runtime;
  try {
    const report = await analyzeProposal(
      ctx.deps,
      { multisig: ctx.multisig, transactionIndex: event.transactionIndex },
      {
        rules: { historyDepth: options.history },
        simulate: options.simulate,
        verification: options.external,
      },
    );
    return { kind: "report", report };
  } catch (error) {
    // Only AnalysisError messages are shown: core guarantees they hold no URL.
    const message =
      error instanceof AnalysisError ? error.message : "the analysis stopped unexpectedly";
    log(ctx.runtime, `error: #${event.transactionIndex} could not be analysed: ${message}`);
    return { kind: "failed", message };
  }
}

/**
 * Sends every queued alert to every notifier still pending for it, oldest first, saving after
 * each alert. Failures stay queued for the next cycle; after 24 hours an alert is dropped (logged).
 */
async function deliver(
  ctx: WatchContext,
  start: WatchFile,
): Promise<{ readonly file: WatchFile; readonly undelivered: boolean }> {
  const { runtime } = ctx;
  const now = runtime.environment.clock.now();
  const byId = new Map<NotifierId, Notifier>(ctx.notifiers.map((n) => [n.id, n]));
  let file = start;
  let undelivered = false;
  for (const item of start.outbox) {
    const pending: NotifierId[] = [];
    for (const id of item.pending) {
      const notifier = byId.get(id);
      if (notifier === undefined) {
        log(
          runtime,
          `alert ${item.alert.id} was queued for ${id}, which is no longer configured; dropped for ${id}`,
        );
        continue;
      }
      const result = await sendWithRetry(notifier, item.alert, (ms) =>
        runtime.environment.sleep(ms, runtime.environment.shutdown),
      );
      if (!result.ok) {
        log(runtime, `error: alert ${item.alert.id} not delivered to ${id}: ${result.reason}`);
        pending.push(id);
      }
    }
    const expired = now - Date.parse(item.queuedAt) > OUTBOX_MAX_AGE_MS;
    if (pending.length > 0 && expired) {
      log(
        runtime,
        `error: alert ${item.alert.id} dropped after 24 hours without delivery to ${pending.join(", ")}`,
      );
    }
    const keep = pending.length > 0 && !expired;
    undelivered ||= pending.length > 0;
    const outbox = file.outbox.flatMap((queued) =>
      queued.alert.id !== item.alert.id ? [queued] : keep ? [{ ...queued, pending }] : [],
    );
    file = { ...file, outbox };
    await saveState(ctx, file);
  }
  return { file, undelivered };
}

function log(runtime: Runtime, text: string): void {
  runtime.err(`[${new Date(runtime.environment.clock.now()).toISOString()}] ${text}\n`);
}
