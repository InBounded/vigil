import { type Address, address } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  ProposalStatusKind,
  SquadsMultisigSummary,
  SquadsProposalListEntry,
} from "../squads/types.js";
import { detectChanges, type WatchSnapshot, type WatchState } from "./detect.js";
import { parseWatchState, watchStateToJson } from "./state.js";

// detectChanges is pure logic over already-decoded entries; the account reading it depends on
// (readWatchSnapshot) is tested against real captured data in snapshot.test.ts.
const MULTISIG = address("3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt");
const PROPOSAL = address("11111111111111111111111111111111");

function summary(tip: bigint, stale = 0n): SquadsMultisigSummary {
  return {
    address: MULTISIG,
    configAuthority: PROPOSAL,
    createKey: PROPOSAL,
    isControlled: false,
    members: [],
    rentCollector: null,
    staleTransactionIndex: stale,
    threshold: 2,
    timeLockSeconds: 0,
    transactionIndex: tip,
  };
}

type Status = ProposalStatusKind | "NoProposal" | "Closed";

function entry(index: bigint, status: Status, stale = false): SquadsProposalListEntry {
  return {
    isStale: stale,
    proposal:
      status === "NoProposal" || status === "Closed"
        ? null
        : {
            address: PROPOSAL,
            status: { kind: status, timestamp: status === "Executing" ? null : 1_700_000_000n },
            votes: { approved: [], cancelled: [], rejected: [] },
          },
    transactionAddress: status === "Closed" ? null : PROPOSAL,
    transactionIndex: index,
    transactionKind: status === "Closed" ? null : "vault",
  };
}

function snapshot(tip: bigint, entries: SquadsProposalListEntry[], stale = 0n): WatchSnapshot {
  return { cluster: "mainnet", entries, multisig: summary(tip, stale), skipped: null };
}

describe("detectChanges", () => {
  it("first run: reports only pending proposals and remembers the tip", () => {
    const changes = detectChanges(
      snapshot(10n, [
        entry(7n, "Executed"),
        entry(8n, "Active"),
        entry(9n, "Approved"),
        entry(10n, "NoProposal"),
        entry(6n, "Active", true),
      ]),
      undefined,
    );
    expect(changes.events).toEqual([
      expect.objectContaining({
        initial: true,
        kind: "new-proposal",
        status: "Active",
        transactionIndex: 8n,
      }),
      expect.objectContaining({ initial: true, status: "Approved", transactionIndex: 9n }),
      expect.objectContaining({ initial: true, status: "NoProposal", transactionIndex: 10n }),
    ]);
    expect(changes.nextState.lastTransactionIndex).toBe(10n);
    expect(changes.nextState.tracked.map((t) => t.transactionIndex)).toEqual([8n, 9n, 10n]);
  });

  it("created → approved → executed: one alert each, then nothing", () => {
    const first = detectChanges(snapshot(4n, [entry(4n, "Executed")]), undefined);
    expect(first.events).toEqual([]);

    const created = detectChanges(snapshot(5n, [entry(5n, "Active")]), first.nextState);
    expect(created.events).toEqual([
      expect.objectContaining({ initial: false, kind: "new-proposal", transactionIndex: 5n }),
    ]);

    const again = detectChanges(snapshot(5n, [entry(5n, "Active")]), created.nextState);
    expect(again.events).toEqual([]);

    const approved = detectChanges(snapshot(5n, [entry(5n, "Approved")]), again.nextState);
    expect(approved.events).toEqual([
      expect.objectContaining({ from: "Active", kind: "status-change", to: "Approved" }),
    ]);

    const executed = detectChanges(snapshot(5n, [entry(5n, "Executed")]), approved.nextState);
    expect(executed.events).toEqual([
      expect.objectContaining({ from: "Approved", to: "Executed" }),
    ]);
    expect(executed.untracked).toEqual([{ reason: "final", transactionIndex: 5n }]);
    expect(executed.nextState.tracked).toEqual([]);

    const after = detectChanges(snapshot(5n, [entry(5n, "Executed")]), executed.nextState);
    expect(after.events).toEqual([]);
  });

  it("a skipped step is one change, nothing in between invented", () => {
    const state = detectChanges(snapshot(5n, [entry(5n, "Active")]), undefined).nextState;
    const changes = detectChanges(snapshot(5n, [entry(5n, "Executed")]), state);
    expect(changes.events).toEqual([expect.objectContaining({ from: "Active", to: "Executed" })]);
  });

  it("silent transitions update the state without an alert", () => {
    let state = detectChanges(snapshot(5n, [entry(5n, "NoProposal")]), undefined).nextState;
    for (const status of ["Draft", "Active"] as const) {
      const changes = detectChanges(snapshot(5n, [entry(5n, status)]), state);
      expect(changes.events).toEqual([]);
      state = changes.nextState;
      expect(state.tracked[0]?.status).toBe(status);
    }
  });

  it("Rejected and Cancelled are alerts; stale drops tracking silently; closed is an alert", () => {
    const state = detectChanges(
      snapshot(4n, [
        entry(1n, "Active"),
        entry(2n, "Approved"),
        entry(3n, "Active"),
        entry(4n, "Approved"),
      ]),
      undefined,
    ).nextState;
    const changes = detectChanges(
      snapshot(
        4n,
        [
          entry(1n, "Rejected"),
          entry(2n, "Cancelled"),
          entry(3n, "Active", true),
          entry(4n, "Closed"),
        ],
        3n,
      ),
      state,
    );
    expect(changes.events.map((e) => (e.kind === "status-change" ? e.to : e.kind))).toEqual([
      "Rejected",
      "Cancelled",
      "Closed",
    ]);
    expect(changes.untracked).toEqual([
      { reason: "final", transactionIndex: 1n },
      { reason: "final", transactionIndex: 2n },
      { reason: "stale", transactionIndex: 3n },
      { reason: "closed", transactionIndex: 4n },
    ]);
    expect(changes.nextState.tracked).toEqual([]);
  });

  it("later runs report every new index, even one already executed or closed", () => {
    const state = detectChanges(snapshot(4n, []), undefined).nextState;
    const changes = detectChanges(
      snapshot(7n, [entry(5n, "Executed"), entry(6n, "Closed"), entry(7n, "Draft")]),
      state,
    );
    expect(changes.events).toEqual([
      expect.objectContaining({ status: "Executed", transactionIndex: 5n }),
      expect.objectContaining({ status: "Closed", transactionIndex: 6n, transactionKind: null }),
      expect.objectContaining({ status: "Draft", transactionIndex: 7n }),
    ]);
    expect(changes.nextState.tracked.map((t) => t.transactionIndex)).toEqual([7n]);
    expect(changes.nextState.lastTransactionIndex).toBe(7n);
  });

  it("skipped indices count as seen", () => {
    const state = detectChanges(snapshot(4n, []), undefined).nextState;
    const changes = detectChanges(
      { ...snapshot(300n, [entry(300n, "Active")]), skipped: { from: 5n, to: 200n } },
      state,
    );
    expect(changes.skipped).toEqual({ from: 5n, to: 200n });
    expect(changes.nextState.lastTransactionIndex).toBe(300n);
  });

  it("refuses a state of another multisig or cluster", () => {
    const state = detectChanges(snapshot(1n, []), undefined).nextState;
    expect(() => detectChanges({ ...snapshot(1n, []), cluster: "devnet" }, state)).toThrow(
      expect.objectContaining({ code: "CLUSTER_MISMATCH" }),
    );
    const other: WatchState = { ...state, multisig: PROPOSAL as Address };
    expect(() => detectChanges(snapshot(1n, []), other)).toThrow(
      expect.objectContaining({ code: "MULTISIG_MISMATCH" }),
    );
  });

  it("property: re-reading the same chain state never alerts twice, and the state round-trips", () => {
    const statuses: Status[] = [
      "NoProposal",
      "Draft",
      "Active",
      "Approved",
      "Executing",
      "Executed",
      "Rejected",
      "Cancelled",
      "Closed",
    ];
    const step = fc.array(
      fc.record({
        index: fc.bigInt({ max: 12n, min: 1n }),
        stale: fc.boolean(),
        status: fc.constantFrom(...statuses),
      }),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(fc.array(step, { maxLength: 6, minLength: 1 }), (steps) => {
        let state: WatchState | undefined;
        const alerted = new Set<string>();
        for (const items of steps) {
          const byIndex = new Map(items.map((i) => [i.index, entry(i.index, i.status, i.stale)]));
          const tip = [...byIndex.keys()].reduce(
            (a, b) => (a > b ? a : b),
            state?.lastTransactionIndex ?? 1n,
          );
          const snap = snapshot(tip, [...byIndex.values()]);
          const changes = detectChanges(snap, state);
          for (const event of changes.events) {
            const id = `${event.transactionIndex}:${event.kind === "status-change" ? event.to : "new"}`;
            expect(alerted.has(id)).toBe(false);
            alerted.add(id);
          }
          expect(detectChanges(snap, changes.nextState).events).toEqual([]);
          expect(
            parseWatchState(JSON.parse(JSON.stringify(watchStateToJson(changes.nextState)))),
          ).toEqual(changes.nextState);
          state = changes.nextState;
        }
      }),
    );
  });
});

describe("parseWatchState", () => {
  const valid = {
    cluster: "mainnet",
    lastTransactionIndex: "5",
    multisig: MULTISIG,
    tracked: [{ status: "Active", transactionIndex: "5", transactionKind: "vault" }],
    version: 1,
  };

  it("reads a valid state", () => {
    expect(parseWatchState(valid).tracked[0]?.transactionIndex).toBe(5n);
  });

  it.each([
    ["not an object", null],
    ["wrong version", { ...valid, version: 2 }],
    ["bad multisig", { ...valid, multisig: "nope" }],
    ["bad cluster", { ...valid, cluster: "localnet" }],
    ["number index", { ...valid, lastTransactionIndex: 5 }],
    ["index above u64", { ...valid, lastTransactionIndex: (2n ** 64n).toString() }],
    ["tracked index 0", { ...valid, tracked: [{ ...valid.tracked[0], transactionIndex: "0" }] }],
    ["bad status", { ...valid, tracked: [{ ...valid.tracked[0], status: "Closed" }] }],
    ["bad kind", { ...valid, tracked: [{ ...valid.tracked[0], transactionKind: "other" }] }],
    ["tracked not a list", { ...valid, tracked: {} }],
  ])("refuses %s", (_name, value) => {
    expect(() => parseWatchState(value)).toThrow(
      expect.objectContaining({ code: "STATE_INVALID" }),
    );
  });
});
