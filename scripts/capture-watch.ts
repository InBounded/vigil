#!/usr/bin/env -S pnpm exec tsx
/**
 * Records real watch cycles for the `vigil watch` fixture tests. For each multisig it runs, every
 * `--interval` seconds, exactly what one `vigil watch --once` cycle reads: `readWatchSnapshot`,
 * `detectChanges`, then `analyzeProposal` for the events the CLI analyses (new pending proposals
 * and proposals that became Approved), all through `RecordingRpcClient` and a recording HTTP
 * client. Every cycle whose state changed is written as
 *   fixtures/<out>/<prefix>-<cycle>.json       RPC answers of that cycle
 *   fixtures/<out>/<prefix>-<cycle>.http.json  verification API answers of that cycle
 * so replaying the written cycles in order through the CLI reproduces the live run (cycles with
 * no change are not written: replaying them changes nothing). Stops when one proposal created
 * after the first cycle has been seen created, approved and executed, or at `--minutes`.
 *
 * Only allowlisted RPC methods are called (`KitRpcClient`); simulation is `sigVerify: false`.
 * Nothing is signed or sent.
 *
 *   pnpm exec tsx scripts/capture-watch.ts --multisig <address> [--multisig …]
 *     [--interval 20] [--minutes 240] [--out watch] [--cluster mainnet]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Address, address } from "@solana/kit";
import { analyzeProposal, rpcHostOf } from "../packages/core/src/analyze/index.js";
import { systemClock } from "../packages/core/src/io/clock.js";
import {
  FetchHttpClient,
  type HttpClient,
  type HttpGetOptions,
  type HttpResponse,
} from "../packages/core/src/io/http.js";
import { VERIFICATION_API, VerificationCache } from "../packages/core/src/programs/verification.js";
import { KitRpcClient } from "../packages/core/src/rpc/kit-client.js";
import type { RpcClient } from "../packages/core/src/rpc/types.js";
import {
  detectChanges,
  PENDING_STATUSES,
  type WatchEvent,
  type WatchState,
} from "../packages/core/src/watch/detect.js";
import { readWatchSnapshot } from "../packages/core/src/watch/snapshot.js";
import { watchStateToJson } from "../packages/core/src/watch/state.js";
import { RecordingRpcClient, recordingToFixture } from "./lib/recording-rpc.js";

const RPC_URLS: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

class RecordingHttpClient implements HttpClient {
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
function throttled(inner: RpcClient, gapMs: number): RpcClient {
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
function analysed(event: WatchEvent): boolean {
  return event.kind === "new-proposal"
    ? event.transactionKind !== null &&
        !event.isStale &&
        event.status !== "Closed" &&
        PENDING_STATUSES.has(event.status)
    : event.to === "Approved";
}

function describe(event: WatchEvent): string {
  return event.kind === "new-proposal"
    ? `#${event.transactionIndex} new (${event.status}${event.initial ? ", initial" : ""})`
    : `#${event.transactionIndex} ${event.from} → ${event.to}`;
}

interface Watched {
  readonly multisig: Address;
  readonly prefix: string;
  state: WatchState | undefined;
  cycle: number;
  written: number;
  /** Per index: which steps were seen after the first cycle. */
  readonly steps: Map<bigint, Set<string>>;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cluster: { default: "mainnet", type: "string" },
      interval: { default: "20", type: "string" },
      minutes: { default: "240", type: "string" },
      multisig: { multiple: true, type: "string" },
      out: { default: "watch", type: "string" },
    },
  });
  const url = RPC_URLS[values.cluster];
  if (url === undefined || !/^[a-z-]+$/.test(values.out)) {
    throw new Error("unknown --cluster or bad --out");
  }
  const live = throttled(new KitRpcClient(url), 300);
  const outDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    values.out,
  );
  await mkdir(outDir, { recursive: true });
  const watched: Watched[] = (values.multisig ?? []).map((m) => ({
    cycle: 0,
    multisig: address(m),
    prefix: m.slice(0, 8),
    state: undefined,
    steps: new Map(),
    written: 0,
  }));
  const deadline = Date.now() + Number(values.minutes) * 60_000;

  while (Date.now() < deadline) {
    const started = Date.now();
    for (const w of watched) {
      const rpc = new RecordingRpcClient(live);
      const http = new RecordingHttpClient();
      const deps = {
        clock: systemClock,
        http,
        rpc,
        rpcHost: rpcHostOf(url),
        verificationCache: new VerificationCache(systemClock),
      };
      let changes: ReturnType<typeof detectChanges>;
      try {
        const snapshot = await readWatchSnapshot(rpc, w.multisig, w.state);
        changes = detectChanges(snapshot, w.state);
      } catch (error) {
        console.warn(
          `${w.prefix}: read failed (${error instanceof Error ? error.name : "?"}), retrying next round`,
        );
        continue;
      }
      const before = JSON.stringify(w.state === undefined ? null : watchStateToJson(w.state));
      const after = JSON.stringify(watchStateToJson(changes.nextState));
      const reports: string[] = [];
      for (const event of changes.events) {
        if (analysed(event)) {
          try {
            const report = await analyzeProposal(
              deps,
              { multisig: w.multisig, transactionIndex: event.transactionIndex },
              { rules: { historyDepth: 0 }, simulate: true, verification: true },
            );
            reports.push(`#${event.transactionIndex} ${report.verdict}`);
          } catch (error) {
            reports.push(
              `#${event.transactionIndex} analysis failed (${error instanceof Error ? error.message : "?"})`,
            );
          }
        }
        if (w.cycle > 0) {
          const index = event.transactionIndex;
          const seen = w.steps.get(index) ?? new Set<string>();
          seen.add(event.kind === "new-proposal" ? "new" : event.to);
          w.steps.set(index, seen);
        }
      }
      if (before !== after || changes.events.length > 0) {
        const name = `${w.prefix}-${String(w.written).padStart(3, "0")}`;
        const capturedAt = new Date().toISOString();
        const fixture = {
          capturedAt,
          cluster: values.cluster,
          contextSlot: rpc.contextSlot.toString(),
          description: `vigil watch cycle ${w.cycle} of multisig ${w.multisig} (written as step ${w.written}); events: ${changes.events.map(describe).join("; ") || "none (silent state change)"}`,
          ...recordingToFixture(rpc),
        };
        const bigints = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
        await writeFile(
          path.join(outDir, `${name}.json`),
          `${JSON.stringify(fixture, bigints, 2)}\n`,
        );
        await writeFile(
          path.join(outDir, `${name}.http.json`),
          `${JSON.stringify({ capturedAt, description: `Verification API answers recorded with ${name}.json`, endpoint: VERIFICATION_API, responses: http.responses }, null, 2)}\n`,
        );
        w.written++;
        console.log(
          `${capturedAt} ${name}: ${changes.events.map(describe).join("; ") || "silent change"} ${reports.join(", ")}`,
        );
      }
      w.state = changes.nextState;
      w.cycle++;
      for (const [index, seen] of w.steps) {
        if (seen.has("new") && seen.has("Approved") && seen.has("Executed")) {
          console.log(
            `SEQUENCE COMPLETE: ${w.multisig} #${index} (fixtures ${w.prefix}-000..${String(w.written - 1).padStart(3, "0")})`,
          );
          return;
        }
      }
    }
    const pause = Number(values.interval) * 1000 - (Date.now() - started);
    if (pause > 0) {
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  console.log("deadline reached without a complete sequence");
  for (const w of watched) {
    for (const [index, seen] of w.steps) {
      console.log(`${w.multisig} #${index}: ${[...seen].join(", ")}`);
    }
  }
}

await main();
