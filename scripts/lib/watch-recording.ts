/**
 * Records one `vigil watch` cycle exactly as the CLI runs it (`readWatchSnapshot`,
 * `detectChanges`, then `analyzeProposal` for the events the CLI analyses) through
 * `RecordingRpcClient` and a recording HTTP client, and writes it as a fixture pair that the CLI
 * tests replay. Shared by scripts/capture-watch.ts (mainnet polling) and
 * scripts/devnet-watch-sequence.ts. Read-only: allowlisted RPC methods only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "@solana/kit";
import { analyzeProposal, rpcHostOf } from "../../packages/core/src/analyze/index.js";
import { systemClock } from "../../packages/core/src/io/clock.js";
import {
  FetchHttpClient,
  type HttpClient,
  type HttpGetOptions,
  type HttpResponse,
} from "../../packages/core/src/io/http.js";
import {
  VERIFICATION_API,
  VerificationCache,
} from "../../packages/core/src/programs/verification.js";
import type { RpcClient } from "../../packages/core/src/rpc/types.js";
import {
  detectChanges,
  PENDING_STATUSES,
  type WatchChanges,
  type WatchEvent,
  type WatchState,
} from "../../packages/core/src/watch/detect.js";
import { readWatchSnapshot } from "../../packages/core/src/watch/snapshot.js";
import { RecordingRpcClient, recordingToFixture } from "./recording-rpc.js";

export class RecordingHttpClient implements HttpClient {
  readonly responses: Record<string, HttpResponse> = {};
  readonly #inner = new FetchHttpClient();

  async get(url: string, options: HttpGetOptions): Promise<HttpResponse> {
    const response = await this.#inner.get(url, options);
    if (url.startsWith(VERIFICATION_API)) {
      this.responses[url.slice(VERIFICATION_API.length)] = response;
    }
    return response;
  }
}

/** Spaces calls out so the public RPC's rate limits are respected. */
export function throttled(inner: RpcClient, gapMs: number): RpcClient {
  let next = 0;
  const wait = async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at > now) {
      await new Promise((resolve) => setTimeout(resolve, at - now));
    }
  };
  const go = <T>(call: () => Promise<T>): Promise<T> => wait().then(call);
  return {
    getAccountInfo: (...a) => go(() => inner.getAccountInfo(...a)),
    getGenesisHash: () => go(() => inner.getGenesisHash()),
    getMultipleAccounts: (...a) => go(() => inner.getMultipleAccounts(...a)),
    getSignaturesForAddress: (...a) => go(() => inner.getSignaturesForAddress(...a)),
    getSlot: (...a) => go(() => inner.getSlot(...a)),
    getTransaction: (...a) => go(() => inner.getTransaction(...a)),
    limitations: () => inner.limitations(),
    simulateTransaction: (...a) => go(() => inner.simulateTransaction(...a)),
  };
}

/** The CLI's rule (packages/cli/src/commands/watch.ts `analyse`). */
export function analysed(event: WatchEvent): boolean {
  return event.kind === "new-proposal"
    ? event.transactionKind !== null &&
        !event.isStale &&
        event.status !== "Closed" &&
        PENDING_STATUSES.has(event.status)
    : event.to === "Approved";
}

export function describeEvent(event: WatchEvent): string {
  return event.kind === "new-proposal"
    ? `#${event.transactionIndex} new (${event.status}${event.initial ? ", initial" : ""})`
    : `#${event.transactionIndex} ${event.from} → ${event.to}`;
}

export interface RecordedCycle {
  readonly changes: WatchChanges;
  /** "#<index> <verdict>" or "#<index> analysis failed (...)" per analysed event. */
  readonly reports: readonly string[];
  readonly rpc: RecordingRpcClient;
  readonly http: RecordingHttpClient;
}

/** One cycle through fresh recorders. Throws if the snapshot cannot be read. */
export async function recordCycle(
  live: RpcClient,
  rpcUrl: string,
  multisig: Address,
  state: WatchState | undefined,
): Promise<RecordedCycle> {
  const rpc = new RecordingRpcClient(live);
  const http = new RecordingHttpClient();
  const deps = {
    clock: systemClock,
    http,
    rpc,
    rpcHost: rpcHostOf(rpcUrl),
    verificationCache: new VerificationCache(systemClock),
  };
  const changes = detectChanges(await readWatchSnapshot(rpc, multisig, state), state);
  const reports: string[] = [];
  for (const event of changes.events) {
    if (!analysed(event)) {
      continue;
    }
    try {
      const report = await analyzeProposal(
        deps,
        { multisig, transactionIndex: event.transactionIndex },
        { rules: { historyDepth: 0 }, simulate: true, verification: true },
      );
      reports.push(`#${event.transactionIndex} ${report.verdict}`);
    } catch (error) {
      reports.push(
        `#${event.transactionIndex} analysis failed (${error instanceof Error ? error.message : "?"})`,
      );
    }
  }
  return { changes, http, reports, rpc };
}

/** `fixtures/<out>/`, checked to be a plain subdirectory name. */
export function fixturesDir(out: string): string {
  if (!/^[a-z-]+$/.test(out)) {
    throw new Error("the fixtures subdirectory must be lower-case letters and dashes");
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", out);
}

/** Writes `<name>.json` (RPC answers) and `<name>.http.json` (verification API answers). */
export async function writeCycleFixture(
  dir: string,
  name: string,
  cluster: string,
  description: string,
  cycle: RecordedCycle,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const capturedAt = new Date().toISOString();
  const fixture = {
    capturedAt,
    cluster,
    contextSlot: cycle.rpc.contextSlot.toString(),
    description,
    ...recordingToFixture(cycle.rpc),
  };
  const bigints = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
  await writeFile(path.join(dir, `${name}.json`), `${JSON.stringify(fixture, bigints, 2)}\n`);
  await writeFile(
    path.join(dir, `${name}.http.json`),
    `${JSON.stringify(
      {
        capturedAt,
        description: `Verification API answers recorded with ${name}.json`,
        endpoint: VERIFICATION_API,
        responses: cycle.http.responses,
      },
      null,
      2,
    )}\n`,
  );
}
