#!/usr/bin/env -S pnpm exec tsx
/**
 * Creates the created → approved → executed sequence on DEVNET and records a `vigil watch` cycle
 * after every step, for the CLI's exactly-once test (fixtures/watch-devnet/devnet-sequence-*).
 *
 * Signs and sends devnet transactions under the AGENTS.md carve-out (scripts/lib/devnet.ts):
 * devnet only (genesis-hash guard), fresh in-memory keys, public keys printed, nothing written
 * but the fixtures. Recording is read-only (allowlisted methods via KitRpcClient).
 *
 *   1. a 2-of-3 multisig (members A, B, C; A pays), vault 0 funded with 0.02 SOL
 *   2. cycle 000: first run, nothing pending
 *   3. A proposes: vault 0 sends 0.001 SOL to B          → cycle 001: new proposal #1 (Active)
 *   4. A approves (1 of 2)                                → cycle 002: nothing to alert
 *   5. B approves (2 of 2)                                → cycle 003: #1 Active → Approved
 *   6. A executes                                         → cycle 004: #1 Approved → Executed
 *
 *   pnpm exec tsx scripts/devnet-watch-sequence.ts [--rpc https://api.devnet.solana.com]
 */
import { parseArgs } from "node:util";
import { type Address, address } from "@solana/kit";
import { LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { KitRpcClient } from "../packages/core/src/rpc/kit-client.js";
import { SquadsV4Adapter } from "../packages/core/src/squads/adapter.js";
import type { SquadsProposalListEntry } from "../packages/core/src/squads/types.js";
import type { WatchState } from "../packages/core/src/watch/detect.js";
import {
  connectDevnet,
  DEVNET_RPC,
  DevnetSquads,
  ensureFunded,
  throwawayKeypair,
} from "./lib/devnet.js";
import {
  describeEvent,
  fixturesDir,
  recordCycle,
  throttled,
  writeCycleFixture,
} from "./lib/watch-recording.js";

const OUT = "watch-devnet";
const PREFIX = "devnet-sequence";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { rpc: { default: DEVNET_RPC, type: "string" } } });
  const url = values.rpc;
  // Guard first: no key exists until the endpoint has proved to be devnet.
  const connection = await connectDevnet(url);
  const [a, b, c] = [throwawayKeypair(), throwawayKeypair(), throwawayKeypair()];
  console.log(
    `members (throwaway, in memory): A ${a.publicKey.toBase58()}, B ${b.publicKey.toBase58()}, C ${c.publicKey.toBase58()}`,
  );
  await ensureFunded(connection, a.publicKey, 0.1 * LAMPORTS_PER_SOL);

  const squads = await DevnetSquads.create(connection, a, [a, b, c], 2);
  const multisig = address(squads.address.toBase58());
  console.log(`multisig ${multisig} (2 of 3), vault 0 ${squads.vault().toBase58()}`);
  await squads.fundVault(0.02 * LAMPORTS_PER_SOL);

  const live = throttled(new KitRpcClient(url), 250);
  const adapter = new SquadsV4Adapter(live);
  let state: WatchState | undefined;
  let step = 0;

  /** Waits until the RPC shows the step's effect, then records one watch cycle. */
  const record = async (
    what: string,
    expected: readonly string[],
    visible: (entry: SquadsProposalListEntry | undefined) => boolean,
  ): Promise<void> => {
    await waitUntil(adapter, multisig, visible);
    const cycle = await recordCycle(live, url, multisig, state);
    const events = cycle.changes.events.map(describeEvent);
    if (JSON.stringify(events) !== JSON.stringify(expected)) {
      throw new Error(
        `${what}: expected events ${JSON.stringify(expected)}, got ${JSON.stringify(events)}`,
      );
    }
    const name = `${PREFIX}-${String(step).padStart(3, "0")}`;
    await writeCycleFixture(
      fixturesDir(OUT),
      name,
      "devnet",
      `DEVNET. vigil watch cycle after "${what}" on the 2-of-3 multisig ${multisig} created by scripts/devnet-watch-sequence.ts; events: ${events.join("; ") || "none"}`,
      cycle,
    );
    console.log(
      `${name}: ${what} → ${events.join("; ") || "no events"} ${cycle.reports.join(", ")}`,
    );
    state = cycle.changes.nextState;
    step++;
  };

  await record("multisig created, nothing proposed", [], () => true);

  const index = await squads.propose([
    SystemProgram.transfer({
      fromPubkey: squads.vault(),
      lamports: 0.001 * LAMPORTS_PER_SOL,
      toPubkey: b.publicKey,
    }),
  ]);
  const is = (status: string, approvals: number) => (entry: SquadsProposalListEntry | undefined) =>
    entry?.proposal?.status.kind === status && entry.proposal.votes.approved.length === approvals;
  await record("A proposed", [`#${index} new (Active)`], is("Active", 0));

  await squads.approve(index, 0);
  await record("A approved (1 of 2)", [], is("Active", 1));

  await squads.approve(index, 1);
  await record("B approved (2 of 2)", [`#${index} Active → Approved`], is("Approved", 2));

  await squads.execute(index, 0);
  await record("A executed", [`#${index} Approved → Executed`], is("Executed", 2));

  console.log(`done: ${step} cycles in fixtures/${OUT}/`);
}

async function waitUntil(
  adapter: SquadsV4Adapter,
  multisig: Address,
  visible: (entry: SquadsProposalListEntry | undefined) => boolean,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const summary = await adapter.fetchMultisig(multisig);
    const [entry] =
      summary.transactionIndex === 0n
        ? []
        : await adapter.readProposals(summary, [summary.transactionIndex]);
    if (visible(entry)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("the RPC did not show the expected state within 90 s");
}

await main();
