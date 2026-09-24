import { isAddress } from "@solana/kit";
import type { Cluster } from "../rpc/types.js";
import type { ProposalStatusKind, SquadsTransactionKind } from "../squads/types.js";
import { type TrackedProposal, type TrackedStatus, WatchError, type WatchState } from "./detect.js";

const CLUSTERS: readonly Cluster[] = ["mainnet", "devnet", "testnet", "unknown"];
const KINDS: readonly SquadsTransactionKind[] = ["vault", "config", "batch"];
const STATUSES: readonly TrackedStatus[] = [
  "NoProposal",
  "Draft",
  "Active",
  "Rejected",
  "Approved",
  "Executing",
  "Executed",
  "Cancelled",
] satisfies readonly (ProposalStatusKind | "NoProposal")[];
const U64_MAX = 2n ** 64n - 1n;

/** The state as plain JSON (bigints as decimal strings). */
export function watchStateToJson(state: WatchState): Record<string, unknown> {
  return {
    cluster: state.cluster,
    lastTransactionIndex: state.lastTransactionIndex.toString(),
    multisig: state.multisig,
    tracked: state.tracked.map((proposal) => ({
      status: proposal.status,
      transactionIndex: proposal.transactionIndex.toString(),
      transactionKind: proposal.transactionKind,
    })),
    version: state.version,
  };
}

/**
 * Reads a state back, field by field. A state file is local, but it can be edited, truncated or
 * written by another version: anything unexpected is a `STATE_INVALID` error, never a guess.
 */
export function parseWatchState(value: unknown): WatchState {
  const record = asRecord(value, "state");
  if (record.version !== 1) {
    throw invalid("unsupported state version");
  }
  const multisig = record.multisig;
  if (typeof multisig !== "string" || !isAddress(multisig)) {
    throw invalid("multisig is not an address");
  }
  const cluster = record.cluster;
  if (typeof cluster !== "string" || !(CLUSTERS as readonly string[]).includes(cluster)) {
    throw invalid("unknown cluster");
  }
  const tracked = record.tracked;
  if (!Array.isArray(tracked)) {
    throw invalid("tracked is not a list");
  }
  const proposals: TrackedProposal[] = tracked.map((item: unknown) => {
    const entry = asRecord(item, "tracked proposal");
    const kind = entry.transactionKind;
    const status = entry.status;
    if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
      throw invalid("unknown transaction kind");
    }
    if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) {
      throw invalid("unknown proposal status");
    }
    return {
      status: status as TrackedStatus,
      transactionIndex: parseIndex(entry.transactionIndex, true),
      transactionKind: kind as SquadsTransactionKind,
    };
  });
  return {
    cluster: cluster as Cluster,
    lastTransactionIndex: parseIndex(record.lastTransactionIndex, false),
    multisig,
    tracked: proposals.sort((a, b) => (a.transactionIndex < b.transactionIndex ? -1 : 1)),
    version: 1,
  };
}

function parseIndex(value: unknown, positive: boolean): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw invalid("an index is not a decimal string");
  }
  const index = BigInt(value);
  if (index > U64_MAX || (positive && index === 0n)) {
    throw invalid("an index is out of range");
  }
  return index;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function invalid(detail: string): WatchError {
  return new WatchError("STATE_INVALID", `the watch state is not valid: ${detail}`);
}
