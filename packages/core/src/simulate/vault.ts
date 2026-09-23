import { type Address, getBase64Encoder } from "@solana/kit";
import { fetchLookupTables, type LookupTableEntry } from "../decoders/lookup-tables.js";
import { type CompiledMessage, fromVaultTransactionMessage } from "../decoders/message.js";
import { parseWireTransaction } from "../decoders/transaction.js";
import type {
  AnalysisGap,
  BatchSimulation,
  SimulationNote,
  SimulationOutcome,
  SimulationResult,
} from "../report.js";
import type { RpcClient } from "../rpc/types.js";
import { matchesDiscriminator, toEncodedAccount } from "../squads/decode.js";
import { BATCH_DISCRIMINATOR, decodeBatch } from "../squads/generated/accounts/batch.js";
import {
  decodeVaultBatchTransaction,
  VAULT_BATCH_TRANSACTION_DISCRIMINATOR,
} from "../squads/generated/accounts/vaultBatchTransaction.js";
import {
  decodeVaultTransaction,
  VAULT_TRANSACTION_DISCRIMINATOR,
} from "../squads/generated/accounts/vaultTransaction.js";
import { getEphemeralSignerPda, getVaultPda } from "../squads/pda.js";
import type { SquadsMultisigSummary, SquadsProposalBundle } from "../squads/types.js";
import { buildSimulationTransaction, instructionsFromMessage } from "./build.js";
import { resolveMessageKeys, writableKeys } from "./resolve.js";
import {
  LAMPORTS_PER_SIGNATURE,
  type PreState,
  readPreState,
  runSimulation,
  type SimulationContext,
  type SimulationGathered,
  snapshotNote,
  unavailable,
} from "./run.js";

const base64Bytes = getBase64Encoder();

/** One Squads message to simulate as if its vault executed it now. */
export interface VaultMessageTarget {
  readonly message: CompiledMessage;
  readonly vaultIndex: number;
  /**
   * Key the ephemeral signer PDAs are derived from: the `VaultTransaction` for a vault proposal,
   * the `Batch` (not the item) for a batch item — squads-protocol/v4 at af94153f,
   * `vault_transaction_execute.rs` and `batch_execute_transaction.rs` (`derive_ephemeral_signers`).
   */
  readonly ephemeralSignerBase: Address;
  readonly ephemeralSignerCount: number;
  /** 1-based batch item index. */
  readonly batchItem?: number;
}

export class SimulationTargetError extends Error {
  readonly code = "SIMULATION_TARGET_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SimulationTargetError";
  }
}

/**
 * Reads the message(s) a proposal would execute: the `VaultTransaction` of a vault proposal, or
 * every `VaultBatchTransaction` of a batch (with the batch's vault). Config proposals have none:
 * their actions are described directly, never simulated.
 */
export async function loadVaultTargets(
  rpc: RpcClient,
  bundle: SquadsProposalBundle,
): Promise<readonly VaultMessageTarget[]> {
  if (bundle.transactionKind === "config") {
    return [];
  }
  const items = bundle.batchTransactions ?? [];
  const addresses = [bundle.transactionAddress, ...items.map((item) => item.address)];
  const { value } = await rpc.getMultipleAccounts(addresses);
  const main = value[0] ?? null;
  if (main === null) {
    throw new SimulationTargetError(
      `transaction account ${bundle.transactionAddress} does not exist`,
    );
  }
  const encoded = toEncodedAccount(bundle.transactionAddress, main);
  if (bundle.transactionKind === "vault") {
    if (!matchesDiscriminator(encoded.data, VAULT_TRANSACTION_DISCRIMINATOR)) {
      throw new SimulationTargetError(`${bundle.transactionAddress} is not a VaultTransaction`);
    }
    const transaction = decodeVaultTransaction(encoded).data;
    return [
      {
        ephemeralSignerBase: bundle.transactionAddress,
        ephemeralSignerCount: transaction.ephemeralSignerBumps.length,
        message: fromVaultTransactionMessage(transaction.message),
        vaultIndex: transaction.vaultIndex,
      },
    ];
  }
  if (!matchesDiscriminator(encoded.data, BATCH_DISCRIMINATOR)) {
    throw new SimulationTargetError(`${bundle.transactionAddress} is not a Batch`);
  }
  const batch = decodeBatch(encoded).data;
  return items.map((item, i) => {
    const account = value[i + 1] ?? null;
    if (account === null) {
      throw new SimulationTargetError(`batch item ${item.index} (${item.address}) does not exist`);
    }
    const itemEncoded = toEncodedAccount(item.address, account);
    if (!matchesDiscriminator(itemEncoded.data, VAULT_BATCH_TRANSACTION_DISCRIMINATOR)) {
      throw new SimulationTargetError(`${item.address} is not a VaultBatchTransaction`);
    }
    const decoded = decodeVaultBatchTransaction(itemEncoded).data;
    return {
      batchItem: item.index,
      ephemeralSignerBase: bundle.transactionAddress,
      ephemeralSignerCount: decoded.ephemeralSignerBumps.length,
      message: fromVaultTransactionMessage(decoded.message),
      vaultIndex: batch.vaultIndex,
    };
  });
}

export interface ProposalSimulation {
  /** Absent for config proposals (nothing to simulate). */
  readonly outcome?: SimulationOutcome;
  readonly gaps: readonly AnalysisGap[];
}

/**
 * Simulates what a vault or batch proposal would do if executed now. Batch items are simulated one
 * by one; the effects of earlier items are not carried into later ones (noted on the result).
 */
export async function simulateProposal(
  rpc: RpcClient,
  multisig: SquadsMultisigSummary,
  targets: readonly VaultMessageTarget[],
  kind: SquadsProposalBundle["transactionKind"],
  context: SimulationContext,
): Promise<ProposalSimulation> {
  if (kind === "config") {
    return { gaps: [] };
  }
  if (kind === "vault") {
    const target = targets[0];
    if (target === undefined) {
      const gathered = unavailable(
        "build-failed",
        "the proposal's transaction message was not found",
      );
      return { gaps: gathered.gaps, outcome: gathered.result };
    }
    const gathered = await simulateVaultMessage(rpc, multisig, target, context);
    return { gaps: gathered.gaps, outcome: gathered.result };
  }
  const items: SimulationResult[] = [];
  const gaps: AnalysisGap[] = [];
  for (const target of targets) {
    const gathered = await simulateVaultMessage(rpc, multisig, target, context);
    items.push(gathered.result);
    gaps.push(...gathered.gaps);
  }
  const notes: SimulationNote[] = [
    snapshotNote(),
    { key: "simulation.note.batchIsolated", params: { count: String(items.length) } },
  ];
  const outcome: BatchSimulation = { items, notes, status: "batch" };
  return { gaps, outcome };
}

/**
 * Builds and simulates one Squads message as a v0 transaction signed (with zero signatures) by the
 * vault and the ephemeral signer PDAs. The fee payer is the vault if it can pay the estimated fee,
 * otherwise the member with Execute permission holding the most SOL. If the vault-paid simulation
 * fails and such a member exists, it is simulated again with the member paying — as in a real
 * execution, where the executing member pays — and that result is reported, with a note.
 */
export async function simulateVaultMessage(
  rpc: RpcClient,
  multisig: SquadsMultisigSummary,
  target: VaultMessageTarget,
  context: SimulationContext,
): Promise<SimulationGathered> {
  const { batchItem } = target;
  const tableAddresses = [...new Set(target.message.lookups.map((lookup) => lookup.tableAddress))];
  let tables = new Map<Address, LookupTableEntry>();
  if (tableAddresses.length > 0) {
    try {
      tables = (await fetchLookupTables(rpc, tableAddresses)).entries;
    } catch {
      return unavailable(
        "rpc-error",
        "the proposal's address lookup tables could not be read",
        batchItem,
      );
    }
  }
  const messageKeys = resolveMessageKeys(target.message, tables);
  if (!messageKeys.ok) {
    return unavailable(
      "accounts-unresolved",
      `${messageKeys.reason} (${messageKeys.table ?? "?"})`,
      batchItem,
    );
  }
  const [vault] = await getVaultPda({ index: target.vaultIndex, multisigPda: multisig.address });
  const ephemeralSigners: Address[] = [];
  for (let i = 0; i < target.ephemeralSignerCount; i++) {
    const [pda] = await getEphemeralSignerPda({
      ephemeralSignerIndex: i,
      transactionPda: target.ephemeralSignerBase,
    });
    ephemeralSigners.push(pda);
  }
  const instructions = instructionsFromMessage(target.message, messageKeys.resolved);
  const lookupTables: Record<Address, readonly Address[]> = {};
  for (const [address, entry] of tables) {
    if (entry.status === "ok") {
      lookupTables[address] = entry.table.addresses;
    }
  }

  const members = multisig.members
    .filter((member) => member.permissions.includes("Execute"))
    .map((member) => member.key);
  let pre: PreState;
  try {
    pre = await readPreState(rpc, [...writableKeys(messageKeys.resolved), vault, ...members]);
  } catch {
    return unavailable("rpc-error", "the accounts' current state could not be read", batchItem);
  }
  const signers = new Set<Address>(
    messageKeys.resolved.keys.filter((_key, i) => messageKeys.resolved.signer[i] === true),
  );
  const feeEstimate = (payer: Address) =>
    LAMPORTS_PER_SIGNATURE * BigInt(new Set([...signers, payer]).size);
  const lamports = (address: Address) => pre.accounts.get(address)?.lamports ?? 0n;
  const member = members
    .filter((key) => lamports(key) >= feeEstimate(key))
    .sort((a, b) =>
      lamports(b) > lamports(a) ? 1 : lamports(b) < lamports(a) ? -1 : a < b ? -1 : 1,
    )[0];
  // Squads signs for the vault and the ephemeral PDAs itself; any other signer in the message must
  // really sign the execute transaction (`executable_transaction_message.rs`, `new_validated`).
  const baseNotes: SimulationNote[] = [...signers]
    .filter((signer) => signer !== vault && !ephemeralSigners.includes(signer))
    .sort()
    .map((signer) => ({ key: "simulation.note.extraSigner", params: { signer } }));

  const attempt = async (
    payer: Address,
    source: "vault" | "member",
    notes: readonly SimulationNote[],
  ): Promise<SimulationGathered> => {
    const built = buildSimulationTransaction({ feePayer: payer, instructions, lookupTables });
    if (!built.ok) {
      return unavailable(built.code, built.reason, batchItem);
    }
    const parsed = parseWireTransaction(base64Bytes.encode(built.transaction.base64));
    const keys = resolveMessageKeys(parsed.message.compiled, tables);
    if (!keys.ok) {
      return unavailable("build-failed", keys.reason, batchItem);
    }
    let state = pre;
    const missing = writableKeys(keys.resolved).filter((key) => !pre.accounts.has(key));
    if (missing.length > 0) {
      // Only possible if kit reorders something unexpectedly; read what is missing, never guess.
      try {
        state = await readPreState(rpc, [...pre.accounts.keys(), ...missing]);
      } catch {
        return unavailable("rpc-error", "the accounts' current state could not be read", batchItem);
      }
    }
    return runSimulation(
      rpc,
      {
        feePayer: { address: payer, source },
        notes,
        resolved: keys.resolved,
        signatureCount: parsed.signatureCount,
        transactionBase64: built.transaction.base64,
        ...(batchItem === undefined ? {} : { batchItem }),
      },
      state,
      context,
    );
  };

  if (lamports(vault) >= feeEstimate(vault)) {
    const vaultPaid = await attempt(vault, "vault", baseNotes);
    if (vaultPaid.result.status !== "failed" || member === undefined) {
      return vaultPaid;
    }
    return attempt(member, "member", [
      ...baseNotes,
      { key: "simulation.note.feePayerMember", params: { member, reason: "vaultFailed", vault } },
    ]);
  }
  if (member === undefined) {
    return unavailable(
      "no-fee-payer",
      "neither the vault nor any member with Execute permission has enough SOL to pay the simulation fee",
      batchItem,
    );
  }
  return attempt(member, "member", [
    ...baseNotes,
    { key: "simulation.note.feePayerMember", params: { member, reason: "vaultBalance", vault } },
  ]);
}
