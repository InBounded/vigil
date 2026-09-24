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
import { parseArgs } from "node:util";
import { type Address, address } from "@solana/kit";
import { KitRpcClient } from "../packages/core/src/rpc/kit-client.js";
import type { WatchState } from "../packages/core/src/watch/detect.js";
import { watchStateToJson } from "../packages/core/src/watch/state.js";
import {
  describeEvent,
  fixturesDir,
  type RecordedCycle,
  recordCycle,
  throttled,
  writeCycleFixture,
} from "./lib/watch-recording.js";

const RPC_URLS: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

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
  if (url === undefined) {
    throw new Error("unknown --cluster");
  }
  const live = throttled(new KitRpcClient(url), 300);
  const outDir = fixturesDir(values.out);
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
      let cycle: RecordedCycle;
      try {
        cycle = await recordCycle(live, url, w.multisig, w.state);
      } catch (error) {
        console.warn(
          `${w.prefix}: read failed (${error instanceof Error ? error.name : "?"}), retrying next round`,
        );
        continue;
      }
      const { changes, reports } = cycle;
      if (w.cycle > 0) {
        for (const event of changes.events) {
          const seen = w.steps.get(event.transactionIndex) ?? new Set<string>();
          seen.add(event.kind === "new-proposal" ? "new" : event.to);
          w.steps.set(event.transactionIndex, seen);
        }
      }
      const before = JSON.stringify(w.state === undefined ? null : watchStateToJson(w.state));
      const after = JSON.stringify(watchStateToJson(changes.nextState));
      if (before !== after || changes.events.length > 0) {
        const name = `${w.prefix}-${String(w.written).padStart(3, "0")}`;
        const events = changes.events.map(describeEvent).join("; ");
        await writeCycleFixture(
          outDir,
          name,
          values.cluster,
          `vigil watch cycle ${w.cycle} of multisig ${w.multisig} (written as step ${w.written}); events: ${events || "none (silent state change)"}`,
          cycle,
        );
        w.written++;
        console.log(
          `${new Date().toISOString()} ${name}: ${events || "silent change"} ${reports.join(", ")}`,
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
