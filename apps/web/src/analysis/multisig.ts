import type { Address } from "@solana/kit";
import {
  AnalysisError,
  type Clock,
  type Cluster,
  detectCluster,
  type Finding,
  type MultisigSummary,
  NotASquadsMultisigError,
  type RpcClient,
  type SquadsProposalListEntry,
  SquadsV4Adapter,
} from "@vigil-sol/core";
import { multisigHealth } from "./health.js";

/** Statuses a proposal can still be voted on or executed from (as `vigil list`). */
const PENDING = new Set(["Draft", "Active", "Approved", "Executing"]);

export const PROPOSALS_PAGE = 20;
export const MAX_PROPOSALS = 50;

export interface MultisigOverview {
  readonly cluster: Cluster;
  readonly multisig: MultisigSummary;
  readonly health: readonly Finding[];
  readonly entries: readonly SquadsProposalListEntry[];
}

/** Worth analysing: a transaction exists, it is not stale, and it can still be voted or executed. */
export function isPending(entry: SquadsProposalListEntry): boolean {
  return (
    entry.transactionKind !== null &&
    !entry.isStale &&
    (entry.proposal === null || PENDING.has(entry.proposal.status.kind))
  );
}

/** The multisig, its weaknesses (VGL-W010) and its last `limit` transactions, newest first. */
export async function loadMultisigOverview(
  rpc: RpcClient,
  clock: Clock,
  address: Address,
  limit: number,
): Promise<MultisigOverview> {
  try {
    const cluster = detectCluster(await rpc.getGenesisHash());
    const adapter = new SquadsV4Adapter(rpc);
    const multisig = await adapter.fetchMultisig(address);
    const entries = await adapter.listProposals(address, { limit });
    return { cluster, entries, health: await multisigHealth(multisig, cluster, clock), multisig };
  } catch (error) {
    if (error instanceof NotASquadsMultisigError) {
      throw new AnalysisError("NOT_A_MULTISIG", error.message);
    }
    if (error instanceof AnalysisError) {
      throw error;
    }
    throw new AnalysisError("RPC_FAILED", "the multisig could not be read from the RPC");
  }
}
