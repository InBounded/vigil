import type { Address } from "@solana/kit";
import { detectCluster } from "../rpc/cluster.js";
import type { RpcClient } from "../rpc/types.js";
import { SquadsV4Adapter } from "../squads/adapter.js";
import type { WatchSnapshot, WatchState } from "./detect.js";

export interface WatchSnapshotOptions {
  /** First run: how many of the newest indices to look at. @defaultValue 20 */
  readonly initialWindow?: number;
  /** At most this many new indices are read per cycle; older ones are reported as skipped. @defaultValue 100 */
  readonly maxNewPerCycle?: number;
}

export const DEFAULT_WATCH_INITIAL_WINDOW = 20;
export const DEFAULT_WATCH_MAX_NEW_PER_CYCLE = 100;

/**
 * Reads what `detectChanges` needs: the cluster (`getGenesisHash`), the multisig
 * (`getAccountInfo`), then the transaction and proposal accounts of every new index and every
 * tracked one (`getMultipleAccounts`). Allowlisted methods only.
 */
export async function readWatchSnapshot(
  rpc: RpcClient,
  multisig: Address,
  previous: WatchState | undefined,
  options: WatchSnapshotOptions = {},
): Promise<WatchSnapshot> {
  const initialWindow = BigInt(options.initialWindow ?? DEFAULT_WATCH_INITIAL_WINDOW);
  const maxNew = BigInt(options.maxNewPerCycle ?? DEFAULT_WATCH_MAX_NEW_PER_CYCLE);
  const cluster = detectCluster(await rpc.getGenesisHash());
  const adapter = new SquadsV4Adapter(rpc);
  const summary = await adapter.fetchMultisig(multisig);
  const tip = summary.transactionIndex;

  let from = previous === undefined ? tip - initialWindow + 1n : previous.lastTransactionIndex + 1n;
  if (from < 1n) {
    from = 1n;
  }
  let skipped: WatchSnapshot["skipped"] = null;
  if (tip - from + 1n > maxNew) {
    skipped = { from, to: tip - maxNew };
    from = tip - maxNew + 1n;
  }

  const indices = new Set<bigint>();
  for (const proposal of previous?.tracked ?? []) {
    indices.add(proposal.transactionIndex);
  }
  for (let index = from; index <= tip; index++) {
    indices.add(index);
  }
  const entries = await adapter.readProposals(
    summary,
    [...indices].sort((a, b) => (a < b ? -1 : 1)),
  );
  return { cluster, entries, multisig: summary, skipped };
}
