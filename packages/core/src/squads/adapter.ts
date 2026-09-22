import { type Address, type ReadonlyUint8Array, unwrapOption } from "@solana/kit";
import type { RpcClient } from "../rpc/types.js";
import { decodePermissions, matchesDiscriminator, toEncodedAccount } from "./decode.js";
import { NotASquadsMultisigError } from "./errors.js";
import { BATCH_DISCRIMINATOR, decodeBatch } from "./generated/accounts/batch.js";
import { CONFIG_TRANSACTION_DISCRIMINATOR } from "./generated/accounts/configTransaction.js";
import {
  decodeMultisig,
  MULTISIG_DISCRIMINATOR,
  type Multisig,
} from "./generated/accounts/multisig.js";
import { decodeProposal, type Proposal } from "./generated/accounts/proposal.js";
import { VAULT_TRANSACTION_DISCRIMINATOR } from "./generated/accounts/vaultTransaction.js";
import { SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS } from "./generated/programs/squadsMultisigProgram.js";
import type { ProposalStatus } from "./generated/types/proposalStatus.js";
import { getBatchTransactionPda, getProposalPda, getTransactionPda } from "./pda.js";
import type {
  ListProposalsOptions,
  MultisigAdapter,
  SquadsBatchTransactionEntry,
  SquadsMultisigSummary,
  SquadsProposalBundle,
  SquadsProposalInfo,
  SquadsProposalListEntry,
  SquadsProposalStatus,
  SquadsTransactionKind,
} from "./types.js";

const DEFAULT_LIST_PROPOSALS_LIMIT = 20;

/** `Pubkey::default()` — the convention for "no config authority set" (an autonomous multisig). */
const DEFAULT_ADDRESS = "11111111111111111111111111111111" as Address;

export class SquadsV4Adapter implements MultisigAdapter {
  readonly #rpc: RpcClient;
  readonly #programAddress: Address;

  constructor(rpc: RpcClient, programAddress: Address = SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS) {
    this.#rpc = rpc;
    this.#programAddress = programAddress;
  }

  async fetchMultisig(address: Address): Promise<SquadsMultisigSummary> {
    const { value } = await this.#rpc.getAccountInfo(address);
    if (value === null || value.owner !== this.#programAddress) {
      throw new NotASquadsMultisigError(address);
    }
    const encoded = toEncodedAccount(address, value);
    if (!matchesDiscriminator(encoded.data, MULTISIG_DISCRIMINATOR)) {
      throw new NotASquadsMultisigError(address);
    }
    return summaryFromDecoded(address, decodeMultisig(encoded).data);
  }

  async listProposals(
    multisig: Address,
    options?: ListProposalsOptions,
  ): Promise<readonly SquadsProposalListEntry[]> {
    const summary = await this.fetchMultisig(multisig);
    const limit = options?.limit ?? DEFAULT_LIST_PROPOSALS_LIMIT;

    const indices: bigint[] = [];
    for (let i = 0n; i < BigInt(limit) && summary.transactionIndex - i > 0n; i++) {
      indices.push(summary.transactionIndex - i);
    }
    if (indices.length === 0) {
      return [];
    }

    const pdaEntries = await Promise.all(
      indices.map(async (transactionIndex) => {
        const [transactionPda] = await getTransactionPda({
          index: transactionIndex,
          multisigPda: multisig,
          programAddress: this.#programAddress,
        });
        const [proposalPda] = await getProposalPda({
          multisigPda: multisig,
          programAddress: this.#programAddress,
          transactionIndex,
        });
        return { proposalPda, transactionIndex, transactionPda };
      }),
    );

    const addresses = pdaEntries.flatMap((entry) => [entry.transactionPda, entry.proposalPda]);
    const { value: accounts } = await this.#rpc.getMultipleAccounts(addresses);

    return pdaEntries.map((entry, i) => {
      const transactionAccount = accounts[i * 2] ?? null;
      const proposalAccount = accounts[i * 2 + 1] ?? null;
      const transactionKind =
        transactionAccount === null
          ? null
          : classifyTransaction(toEncodedAccount(entry.transactionPda, transactionAccount).data);
      const proposal =
        proposalAccount === null
          ? null
          : proposalInfoFromDecoded(
              entry.proposalPda,
              decodeProposal(toEncodedAccount(entry.proposalPda, proposalAccount)).data,
            );
      return {
        isStale: entry.transactionIndex <= summary.staleTransactionIndex,
        proposal,
        transactionAddress: transactionAccount === null ? null : entry.transactionPda,
        transactionIndex: entry.transactionIndex,
        transactionKind,
      };
    });
  }

  async fetchProposalBundle(
    multisig: Address,
    transactionIndex: bigint,
  ): Promise<SquadsProposalBundle> {
    const summary = await this.fetchMultisig(multisig);
    const [transactionPda] = await getTransactionPda({
      index: transactionIndex,
      multisigPda: multisig,
      programAddress: this.#programAddress,
    });
    const [proposalPda] = await getProposalPda({
      multisigPda: multisig,
      programAddress: this.#programAddress,
      transactionIndex,
    });

    const result = await this.#rpc.getMultipleAccounts([transactionPda, proposalPda]);
    const transactionAccount = result.value[0] ?? null;
    const proposalAccount = result.value[1] ?? null;
    if (transactionAccount === null) {
      throw new Error(
        `No transaction found at index ${transactionIndex} for multisig ${multisig}.`,
      );
    }

    const encodedTransaction = toEncodedAccount(transactionPda, transactionAccount);
    const transactionKind = classifyTransaction(encodedTransaction.data);
    if (transactionKind === null) {
      throw new Error(
        `Account ${transactionPda} does not match any known transaction discriminator.`,
      );
    }
    const proposal =
      proposalAccount === null
        ? null
        : proposalInfoFromDecoded(
            proposalPda,
            decodeProposal(toEncodedAccount(proposalPda, proposalAccount)).data,
          );

    const batchTransactions =
      transactionKind === "batch"
        ? await this.#fetchBatchTransactions(
            multisig,
            transactionIndex,
            decodeBatch(encodedTransaction).data.size,
          )
        : undefined;

    return {
      ...(batchTransactions === undefined ? {} : { batchTransactions }),
      multisig: summary,
      proposal,
      transactionAddress: transactionPda,
      transactionIndex,
      transactionKind,
    };
  }

  async #fetchBatchTransactions(
    multisig: Address,
    batchIndex: bigint,
    size: number,
  ): Promise<readonly SquadsBatchTransactionEntry[]> {
    const subIndices = Array.from({ length: size }, (_, i) => i + 1);
    if (subIndices.length === 0) {
      return [];
    }
    const entries = await Promise.all(
      subIndices.map(async (index) => {
        const [address] = await getBatchTransactionPda({
          batchIndex,
          multisigPda: multisig,
          programAddress: this.#programAddress,
          transactionIndex: index,
        });
        return { address, index };
      }),
    );
    const { value: accounts } = await this.#rpc.getMultipleAccounts(
      entries.map((entry) => entry.address),
    );
    return entries.filter((_entry, i) => accounts[i] != null);
  }
}

function classifyTransaction(data: ReadonlyUint8Array): SquadsTransactionKind | null {
  if (matchesDiscriminator(data, VAULT_TRANSACTION_DISCRIMINATOR)) {
    return "vault";
  }
  if (matchesDiscriminator(data, CONFIG_TRANSACTION_DISCRIMINATOR)) {
    return "config";
  }
  if (matchesDiscriminator(data, BATCH_DISCRIMINATOR)) {
    return "batch";
  }
  return null;
}

function summaryFromDecoded(address: Address, decoded: Multisig): SquadsMultisigSummary {
  return {
    address,
    configAuthority: decoded.configAuthority,
    createKey: decoded.createKey,
    isControlled: decoded.configAuthority !== DEFAULT_ADDRESS,
    members: decoded.members.map((member) => ({
      key: member.key,
      permissions: decodePermissions(member.permissions.mask),
    })),
    rentCollector: unwrapOption(decoded.rentCollector),
    staleTransactionIndex: decoded.staleTransactionIndex,
    threshold: decoded.threshold,
    timeLockSeconds: decoded.timeLock,
    transactionIndex: decoded.transactionIndex,
  };
}

function proposalInfoFromDecoded(address: Address, decoded: Proposal): SquadsProposalInfo {
  return {
    address,
    status: proposalStatusFromDecoded(decoded.status),
    votes: { approved: decoded.approved, cancelled: decoded.cancelled, rejected: decoded.rejected },
  };
}

function proposalStatusFromDecoded(status: ProposalStatus): SquadsProposalStatus {
  return {
    kind: status.__kind,
    timestamp: status.__kind === "Executing" ? null : status.timestamp,
  };
}
