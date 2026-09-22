import type { Address } from "@solana/kit";
import type { MemberPermission } from "./decode.js";

export interface SquadsMember {
  readonly key: Address;
  readonly permissions: readonly MemberPermission[];
}

export interface SquadsMultisigSummary {
  readonly address: Address;
  readonly createKey: Address;
  readonly configAuthority: Address;
  /** `true` when `configAuthority` is not the default (all-zero) address — a "controlled" multisig. */
  readonly isControlled: boolean;
  readonly threshold: number;
  readonly timeLockSeconds: number;
  readonly transactionIndex: bigint;
  readonly staleTransactionIndex: bigint;
  readonly rentCollector: Address | null;
  readonly members: readonly SquadsMember[];
}

export type ProposalStatusKind =
  | "Draft"
  | "Active"
  | "Rejected"
  | "Approved"
  | "Executing"
  | "Executed"
  | "Cancelled";

export interface SquadsProposalStatus {
  readonly kind: ProposalStatusKind;
  /** Unix seconds. `null` only for `Executing`, the one status with no recorded timestamp. */
  readonly timestamp: bigint | null;
}

export interface SquadsProposalVotes {
  readonly approved: readonly Address[];
  readonly rejected: readonly Address[];
  readonly cancelled: readonly Address[];
}

export interface SquadsProposalInfo {
  readonly address: Address;
  readonly status: SquadsProposalStatus;
  readonly votes: SquadsProposalVotes;
}

export type SquadsTransactionKind = "vault" | "config" | "batch";

/** One entry in `listProposals`'s walk-down from `transactionIndex`. */
export interface SquadsProposalListEntry {
  readonly transactionIndex: bigint;
  /** `null` if no transaction exists at this index (shouldn't happen for indices <= the multisig's
   * current `transactionIndex`, but the RPC is treated as untrusted input regardless). */
  readonly transactionKind: SquadsTransactionKind | null;
  readonly transactionAddress: Address | null;
  /** `null` — a created transaction may still be a draft with no proposal yet. */
  readonly proposal: SquadsProposalInfo | null;
  readonly isStale: boolean;
}

export interface SquadsBatchTransactionEntry {
  readonly index: number;
  readonly address: Address;
}

export interface SquadsProposalBundle {
  readonly multisig: SquadsMultisigSummary;
  readonly transactionIndex: bigint;
  readonly transactionKind: SquadsTransactionKind;
  readonly transactionAddress: Address;
  readonly proposal: SquadsProposalInfo | null;
  /** Present only when `transactionKind === "batch"`: every `VaultBatchTransaction` found for it. */
  readonly batchTransactions?: readonly SquadsBatchTransactionEntry[];
}

export interface ListProposalsOptions {
  /** How many transaction indices to walk down from `transactionIndex`. @defaultValue 20 */
  readonly limit?: number;
}

export interface MultisigAdapter {
  fetchMultisig(address: Address): Promise<SquadsMultisigSummary>;
  listProposals(
    multisig: Address,
    options?: ListProposalsOptions,
  ): Promise<readonly SquadsProposalListEntry[]>;
  fetchProposalBundle(multisig: Address, transactionIndex: bigint): Promise<SquadsProposalBundle>;
}
