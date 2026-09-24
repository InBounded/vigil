import { fileURLToPath } from "node:url";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { loadFixtureFile } from "../rpc/fixture-file.js";
import { detectChanges } from "./detect.js";
import { readWatchSnapshot } from "./snapshot.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/watch/${name}.json`, import.meta.url));
}

/** Real mainnet multisig recorded by scripts/capture-watch.ts on 2026-09-24 (two cycles). */
const MULTISIG = address("6TXHbBaU8rRk3yJAY42RMymtzoTQFRfz3TKGuALiPqqA");

describe("readWatchSnapshot + detectChanges, against two real recorded cycles", () => {
  it("first run: reads the newest indices and reports the pending proposals; next cycle: #12 executed", async () => {
    const first = new FixtureRpcClient(await loadFixtureFile(fixture("6TXHbBaU-000")));
    const snapshot = await readWatchSnapshot(first, MULTISIG, undefined);
    expect(snapshot.cluster).toBe("mainnet");
    expect(snapshot.skipped).toBeNull();
    const tip = snapshot.multisig.transactionIndex;
    expect(snapshot.entries.map((e) => e.transactionIndex)).toEqual(
      Array.from({ length: Number(tip) }, (_, i) => BigInt(i + 1)),
    );
    const changes = detectChanges(snapshot, undefined);
    expect(
      changes.events.map((e) => [e.transactionIndex, e.kind === "new-proposal" && e.initial]),
    ).toEqual([
      [5n, true],
      [7n, true],
      [11n, true],
      [12n, true],
    ]);
    expect(changes.events.every((e) => e.kind === "new-proposal" && e.status === "Approved")).toBe(
      true,
    );

    const second = new FixtureRpcClient(await loadFixtureFile(fixture("6TXHbBaU-001")));
    const next = await readWatchSnapshot(second, MULTISIG, changes.nextState);
    // Only the tracked indices (and any new one) are read on later cycles.
    expect(next.entries.map((e) => e.transactionIndex)).toEqual([5n, 7n, 11n, 12n]);
    const later = detectChanges(next, changes.nextState);
    expect(later.events).toEqual([
      {
        from: "Approved",
        kind: "status-change",
        timestamp: expect.any(BigInt),
        to: "Executed",
        transactionIndex: 12n,
        transactionKind: "batch",
      },
    ]);
    expect(later.nextState.tracked.map((t) => t.transactionIndex)).toEqual([5n, 7n, 11n]);
  });

  it("reads at most maxNewPerCycle new indices and reports the rest as skipped", async () => {
    const rpc = new FixtureRpcClient(await loadFixtureFile(fixture("6TXHbBaU-000")));
    const snapshot = await readWatchSnapshot(rpc, MULTISIG, undefined, {
      initialWindow: 12,
      maxNewPerCycle: 5,
    });
    const tip = snapshot.multisig.transactionIndex;
    expect(snapshot.skipped).toEqual({ from: 1n, to: tip - 5n });
    expect(snapshot.entries.map((e) => e.transactionIndex)).toEqual(
      [4n, 3n, 2n, 1n, 0n].map((d) => tip - d),
    );
  });
});
