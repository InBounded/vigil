import { type Address, isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";
import type { AccountLabel } from "../labels/labels.js";
import {
  type AnalysisGap,
  SIMULATION_SNAPSHOT_NOTE,
  type SimulationNote,
  type SimulationResult,
  type SimulationRun,
  type SimulationUnavailableCode,
} from "../report.js";
import type { AccountInfo, Cluster, RpcClient, SimulateResult } from "../rpc/types.js";
import { sanitizeOnchainString } from "../sanitize/sanitize.js";
import { computeBalanceChanges, mintsToRead, readTokenBalance } from "./balances.js";
import { sanitizeLogs } from "./logs.js";
import { type ResolvedKeys, writableKeys } from "./resolve.js";

/**
 * `lamports_per_signature` of the default `FeeStructure` (anza-xyz/solana-sdk
 * `fee-structure/src/lib.rs` at 43339f08). Only used to estimate a fee when the RPC does not report
 * one; the estimate is marked as such.
 */
export const LAMPORTS_PER_SIGNATURE = 5000n;

export interface SimulationContext {
  readonly cluster: Cluster;
  /** Labels for balance changes (see `buildLabels`). */
  readonly labels: ReadonlyMap<Address, AccountLabel>;
  /** Ask the RPC for inner instructions (CPI program ids). @defaultValue true */
  readonly innerInstructions?: boolean;
}

/** Accounts read with one `getMultipleAccounts` call, and the slot of that read. */
export interface PreState {
  readonly slot: bigint;
  readonly accounts: ReadonlyMap<Address, AccountInfo | null>;
}

export interface SimulationAttempt {
  readonly transactionBase64: string;
  /** Account keys of the transaction being simulated, in index order. */
  readonly resolved: ResolvedKeys;
  readonly feePayer: SimulationRun["feePayer"];
  readonly signatureCount: number;
  /** Notes after the snapshot note. */
  readonly notes: readonly SimulationNote[];
  readonly batchItem?: number;
}

export interface SimulationGathered {
  readonly result: SimulationResult;
  readonly gaps: readonly AnalysisGap[];
}

export function snapshotNote(): SimulationNote {
  return { key: SIMULATION_SNAPSHOT_NOTE, params: {} };
}

/** Reads accounts with one call; the returned slot is the floor for everything read after it. */
export async function readPreState(
  rpc: RpcClient,
  addresses: readonly Address[],
): Promise<PreState> {
  const unique = [...new Set(addresses)];
  const { contextSlot, value } = await rpc.getMultipleAccounts(unique);
  return {
    accounts: new Map(unique.map((address, i) => [address, value[i] ?? null])),
    slot: contextSlot,
  };
}

export function unavailable(
  code: SimulationUnavailableCode,
  reason: string,
  batchItem?: number,
): SimulationGathered {
  const clean = sanitizeOnchainString(reason, "text").text;
  return {
    gaps: [
      {
        code: "SIMULATION_UNAVAILABLE",
        message:
          batchItem === undefined
            ? `simulation could not be run: ${clean}`
            : `simulation of batch item ${batchItem} could not be run: ${clean}`,
      },
    ],
    result: {
      code,
      notes: [snapshotNote()],
      reason: clean,
      status: "unavailable",
      ...(batchItem === undefined ? {} : { batchItem }),
    },
  };
}

/**
 * Simulates one transaction (`sigVerify: false`, `replaceRecentBlockhash: true`) at or after the
 * pre-state slot, asking for the post-state of every writable account, and turns the answer into
 * a `SimulationResult`. RPC errors never throw: they become an `unavailable` result and a gap.
 */
export async function runSimulation(
  rpc: RpcClient,
  attempt: SimulationAttempt,
  pre: PreState,
  context: SimulationContext,
): Promise<SimulationGathered> {
  const writable = writableKeys(attempt.resolved);
  const innerInstructions = context.innerInstructions ?? true;
  let sim: SimulateResult;
  try {
    sim = await rpc.simulateTransaction(attempt.transactionBase64, {
      accounts: writable,
      innerInstructions,
      minContextSlot: pre.slot,
      replaceRecentBlockhash: true,
    });
  } catch (error) {
    const { code, reason } = describeRpcFailure(error);
    return unavailable(code, reason, attempt.batchItem);
  }

  const gaps: AnalysisGap[] = [];
  const logs = sanitizeLogs(sim.logs);
  const notes: SimulationNote[] = [snapshotNote(), ...attempt.notes];
  if (logs.truncated) {
    notes.push({
      key: "simulation.note.logsTruncated",
      params: { shown: String(logs.lines.length), total: String(logs.totalLines) },
    });
  }
  let innerPrograms: Address[] | undefined;
  if (innerInstructions) {
    if (sim.innerInstructionPrograms === null) {
      notes.push({ key: "simulation.note.innerInstructionsUnavailable", params: {} });
    } else {
      innerPrograms = [
        ...new Set(sim.innerInstructionPrograms.flatMap((group) => group.programs)),
      ].sort();
    }
  }
  const run: Omit<SimulationRun, "notes"> = {
    feePayer: attempt.feePayer,
    logs: logs.lines,
    logsTruncated: logs.truncated,
    slot: sim.contextSlot,
    ...(sim.unitsConsumed === null ? {} : { unitsConsumed: sim.unitsConsumed }),
    ...(sim.fee === null ? {} : { fee: sim.fee }),
    ...(innerPrograms === undefined ? {} : { innerPrograms }),
    ...(attempt.batchItem === undefined ? {} : { batchItem: attempt.batchItem }),
  };

  if (sim.err !== null) {
    return {
      gaps,
      result: { ...run, error: describeTransactionError(sim.err), notes, status: "failed" },
    };
  }

  if (sim.accounts === null || sim.accounts.length !== writable.length) {
    notes.push({ key: "simulation.note.balancesNotReported", params: {} });
    gaps.push({
      code: "SIMULATION_BALANCES_INCOMPLETE",
      message:
        "the RPC did not return the accounts' state after simulation, so balance changes are unknown",
    });
    return { gaps, result: { ...run, balanceChanges: [], notes, status: "success" } };
  }

  const post = new Map(writable.map((address, i) => [address, sim.accounts?.[i] ?? null]));
  const mintAddresses = mintsToRead({ addresses: writable, post, pre: pre.accounts });
  let mints = new Map<Address, AccountInfo | null>();
  if (mintAddresses.length > 0) {
    try {
      const read = await rpc.getMultipleAccounts(mintAddresses, { minContextSlot: pre.slot });
      mints = new Map(mintAddresses.map((mint, i) => [mint, read.value[i] ?? null]));
    } catch {
      // Decimals then come from the registry, or are reported unknown below.
    }
  }

  const estimated = sim.fee === null;
  const fee = sim.fee ?? LAMPORTS_PER_SIGNATURE * BigInt(attempt.signatureCount);
  notes.push({
    key: "simulation.note.feeExcluded",
    params: {
      estimated: String(estimated),
      fee: fee.toString(),
      feePayer: attempt.feePayer.address,
    },
  });
  const { changes, unknownDecimals } = computeBalanceChanges({
    addresses: writable,
    cluster: context.cluster,
    fee,
    feePayer: attempt.feePayer.address,
    labels: context.labels,
    mints,
    post,
    pre: pre.accounts,
  });
  for (const mint of unknownDecimals) {
    gaps.push({
      address: mint,
      code: "TOKEN_DECIMALS_UNKNOWN",
      message:
        "a simulated token balance change is shown in base units: its mint could not be read",
    });
  }
  gaps.push(...preStateMismatches(attempt.resolved, pre, sim));
  return { gaps, result: { ...run, balanceChanges: changes, notes, status: "success" } };
}

/**
 * Cross-check (maintainer decision): the pre-state read is the source of truth for balances, but
 * when the RPC also reports its own `preBalances` / `preTokenBalances` they must agree. Any
 * disagreement is a gap; neither value is silently preferred.
 */
function preStateMismatches(
  resolved: ResolvedKeys,
  pre: PreState,
  sim: SimulateResult,
): AnalysisGap[] {
  const mismatched = new Set<Address>();
  if (sim.preBalances !== null) {
    if (sim.preBalances.length !== resolved.keys.length) {
      return [
        {
          code: "SIMULATION_PRESTATE_MISMATCH",
          message: `the RPC reported ${sim.preBalances.length} pre-simulation balances for a transaction with ${resolved.keys.length} accounts`,
        },
      ];
    }
    resolved.keys.forEach((key, i) => {
      if (!pre.accounts.has(key)) {
        return;
      }
      const ours = pre.accounts.get(key)?.lamports ?? 0n;
      if (sim.preBalances?.[i] !== ours) {
        mismatched.add(key);
      }
    });
  }
  for (const entry of sim.preTokenBalances ?? []) {
    const key = resolved.keys[entry.accountIndex];
    if (key === undefined) {
      return [
        {
          code: "SIMULATION_PRESTATE_MISMATCH",
          message: `the RPC reported a token balance for account index ${entry.accountIndex}, which the transaction does not have`,
        },
      ];
    }
    if (!pre.accounts.has(key)) {
      continue;
    }
    const account = pre.accounts.get(key) ?? null;
    const ours = account === null ? null : readTokenBalance(account);
    if (ours === null || ours.amount !== entry.amount || ours.mint !== entry.mint) {
      mismatched.add(key);
    }
  }
  return [...mismatched].sort().map((address) => ({
    address,
    code: "SIMULATION_PRESTATE_MISMATCH" as const,
    message:
      "the balance read before simulation differs from the balance the RPC reports it simulated from; the state changed between the two reads, or the RPC is inconsistent",
  }));
}

/** A transaction error from the simulation, as sanitized text (`{"InstructionError":[0,…]}`). */
export function describeTransactionError(err: unknown): string {
  const text =
    typeof err === "string"
      ? err
      : JSON.stringify(err, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        );
  return sanitizeOnchainString(text ?? "unknown error", "text").text;
}

/**
 * Classifies a failed RPC call without ever echoing transport details: a transport error message
 * may contain the endpoint URL, which can hold an API key (`AGENTS.md`), so only the HTTP status
 * or the JSON-RPC server message is kept.
 */
export function describeRpcFailure(error: unknown): {
  readonly code: SimulationUnavailableCode;
  readonly reason: string;
} {
  if (isSolanaError(error)) {
    const context = error.context as {
      readonly __code?: unknown;
      readonly __serverMessage?: unknown;
    };
    const code = context.__code;
    if (typeof code === "number" && code <= -32000 && code >= -32768) {
      const message =
        typeof context.__serverMessage === "string" ? context.__serverMessage : "no message";
      return {
        code: "rpc-refused",
        reason: `the RPC refused the simulation (${code}): ${message}`,
      };
    }
    if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
      return {
        code: "rpc-error",
        reason: `the RPC endpoint answered HTTP ${error.context.statusCode}`,
      };
    }
  }
  return {
    code: "rpc-error",
    reason: "the RPC endpoint could not be reached or gave an invalid answer",
  };
}
