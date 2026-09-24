import type { Address } from "@solana/kit";
import type { Cluster } from "../rpc/types.js";
import type {
  ProposalStatusKind,
  SquadsMultisigSummary,
  SquadsProposalListEntry,
  SquadsTransactionKind,
} from "../squads/types.js";

/** A tracked proposal's last seen status; `NoProposal`: the transaction exists, its proposal not yet. */
export type TrackedStatus = ProposalStatusKind | "NoProposal";

/** A proposal the watcher follows until it can no longer be voted on or executed. */
export interface TrackedProposal {
  readonly transactionIndex: bigint;
  readonly transactionKind: SquadsTransactionKind;
  readonly status: TrackedStatus;
}

/** What the watcher remembers about one multisig between cycles. */
export interface WatchState {
  readonly version: 1;
  readonly multisig: Address;
  readonly cluster: Cluster;
  /** The highest transaction index already seen (alerted or recorded). */
  readonly lastTransactionIndex: bigint;
  /** Pending proposals, by ascending index. */
  readonly tracked: readonly TrackedProposal[];
}

/** One read of the multisig and the transactions the watcher cares about. */
export interface WatchSnapshot {
  readonly multisig: SquadsMultisigSummary;
  readonly cluster: Cluster;
  /** The new indices read this cycle plus every tracked index, in any order. */
  readonly entries: readonly SquadsProposalListEntry[];
  /** New indices not read because there were more than a cycle reads (oldest first), if any. */
  readonly skipped: { readonly from: bigint; readonly to: bigint } | null;
}

export type WatchEvent =
  | {
      readonly kind: "new-proposal";
      readonly transactionIndex: bigint;
      /** `null` when the transaction account was already closed when it was first read. */
      readonly transactionKind: SquadsTransactionKind | null;
      readonly status: TrackedStatus | "Closed";
      readonly isStale: boolean;
      /** First run: a proposal that was already pending when watching started. */
      readonly initial: boolean;
    }
  | {
      readonly kind: "status-change";
      readonly transactionIndex: bigint;
      readonly transactionKind: SquadsTransactionKind;
      readonly from: TrackedStatus;
      /** `Closed`: the accounts are gone, so the final status could not be read. */
      readonly to: ProposalStatusKind | "Closed";
      /** Unix seconds of the new status, when the program recorded one. */
      readonly timestamp: bigint | null;
    };

/** A proposal no longer followed, and why (for logs: only some of these are alerts). */
export interface Untracked {
  readonly transactionIndex: bigint;
  readonly reason: "final" | "stale" | "closed";
}

export interface WatchChanges {
  readonly events: readonly WatchEvent[];
  readonly untracked: readonly Untracked[];
  readonly nextState: WatchState;
  readonly skipped: WatchSnapshot["skipped"];
}

export type WatchErrorCode = "MULTISIG_MISMATCH" | "CLUSTER_MISMATCH" | "STATE_INVALID";

export class WatchError extends Error {
  readonly code: WatchErrorCode;

  constructor(code: WatchErrorCode, message: string) {
    super(message);
    this.name = "WatchError";
    this.code = code;
  }
}

/** Statuses a proposal can still be voted on or executed from. */
export const PENDING_STATUSES: ReadonlySet<TrackedStatus> = new Set([
  "NoProposal",
  "Draft",
  "Active",
  "Approved",
  "Executing",
]);

/** Statuses whose arrival is an alert: ready to execute, and every way a proposal ends. */
export const ALERT_STATUSES: ReadonlySet<ProposalStatusKind> = new Set([
  "Approved",
  "Executed",
  "Rejected",
  "Cancelled",
]);

function statusOf(entry: SquadsProposalListEntry): TrackedStatus | "Closed" {
  if (entry.transactionKind === null) {
    return "Closed";
  }
  return entry.proposal === null ? "NoProposal" : entry.proposal.status.kind;
}

function isPending(entry: SquadsProposalListEntry): boolean {
  const status = statusOf(entry);
  return status !== "Closed" && !entry.isStale && PENDING_STATUSES.has(status);
}

/**
 * Compares a fresh snapshot with what the watcher remembered. Pure and deterministic.
 *
 * - New proposals: every index above `lastTransactionIndex` (on the first run, with no previous
 *   state: only the proposals still pending, so an open proposal is never hidden). A transaction
 *   already closed when first read is still reported (`status: "Closed"`).
 * - Status changes of tracked proposals into Approved, Executed, Rejected or Cancelled. A step
 *   skipped between two reads (Active → Executed) is one change; nothing in between is invented.
 *   A tracked proposal whose accounts disappeared is a change to `Closed`.
 * - Other transitions (NoProposal → Draft → Active, → Executing) update the state silently.
 * - A proposal leaves the state once it is final, stale or closed.
 */
export function detectChanges(
  snapshot: WatchSnapshot,
  previous: WatchState | undefined,
): WatchChanges {
  const multisig = snapshot.multisig.address;
  if (previous !== undefined) {
    if (previous.multisig !== multisig) {
      throw new WatchError(
        "MULTISIG_MISMATCH",
        `the state belongs to multisig ${previous.multisig}, not ${multisig}`,
      );
    }
    if (previous.cluster !== snapshot.cluster) {
      throw new WatchError(
        "CLUSTER_MISMATCH",
        `the state was recorded on ${previous.cluster}, but the RPC is on ${snapshot.cluster}`,
      );
    }
  }

  const byIndex = new Map<bigint, SquadsProposalListEntry>();
  for (const entry of snapshot.entries) {
    byIndex.set(entry.transactionIndex, entry);
  }
  const lastSeen = previous?.lastTransactionIndex ?? 0n;
  const events: WatchEvent[] = [];
  const untracked: Untracked[] = [];
  const tracked = new Map<bigint, TrackedProposal>();

  for (const before of previous?.tracked ?? []) {
    const index = before.transactionIndex;
    const entry = byIndex.get(index);
    if (entry === undefined) {
      // Not read this cycle (it always is, unless the snapshot is partial): keep it as it was.
      tracked.set(index, before);
      continue;
    }
    const now = statusOf(entry);
    if (now === "Closed") {
      events.push({
        from: before.status,
        kind: "status-change",
        timestamp: null,
        to: "Closed",
        transactionIndex: index,
        transactionKind: before.transactionKind,
      });
      untracked.push({ reason: "closed", transactionIndex: index });
      continue;
    }
    if (now !== before.status && now !== "NoProposal" && ALERT_STATUSES.has(now)) {
      events.push({
        from: before.status,
        kind: "status-change",
        timestamp: entry.proposal?.status.timestamp ?? null,
        to: now,
        transactionIndex: index,
        transactionKind: entry.transactionKind ?? before.transactionKind,
      });
    }
    if (!PENDING_STATUSES.has(now)) {
      untracked.push({ reason: "final", transactionIndex: index });
    } else if (entry.isStale) {
      untracked.push({ reason: "stale", transactionIndex: index });
    } else {
      tracked.set(index, {
        status: now,
        transactionIndex: index,
        transactionKind: entry.transactionKind ?? before.transactionKind,
      });
    }
  }

  let highest = lastSeen;
  const fresh = snapshot.entries
    .filter((entry) => entry.transactionIndex > lastSeen && !tracked.has(entry.transactionIndex))
    .sort((a, b) => (a.transactionIndex < b.transactionIndex ? -1 : 1));
  for (const entry of fresh) {
    const index = entry.transactionIndex;
    if (index > highest) {
      highest = index;
    }
    const pending = isPending(entry);
    if (previous !== undefined || pending) {
      events.push({
        initial: previous === undefined,
        isStale: entry.isStale,
        kind: "new-proposal",
        status: statusOf(entry),
        transactionIndex: index,
        transactionKind: entry.transactionKind,
      });
    }
    if (pending && entry.transactionKind !== null) {
      tracked.set(index, {
        status: statusOf(entry) as TrackedStatus,
        transactionIndex: index,
        transactionKind: entry.transactionKind,
      });
    }
  }
  if (snapshot.skipped !== null && snapshot.skipped.to > highest) {
    highest = snapshot.skipped.to;
  }
  // The newest index the multisig has handed out is seen, even when nothing was read for it.
  if (snapshot.multisig.transactionIndex > highest && previous === undefined) {
    highest = snapshot.multisig.transactionIndex;
  }

  events.sort((a, b) => (a.transactionIndex < b.transactionIndex ? -1 : 1));
  return {
    events,
    nextState: {
      cluster: snapshot.cluster,
      lastTransactionIndex: highest,
      multisig,
      tracked: [...tracked.values()].sort((a, b) =>
        a.transactionIndex < b.transactionIndex ? -1 : 1,
      ),
      version: 1,
    },
    skipped: snapshot.skipped,
    untracked,
  };
}
