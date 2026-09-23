import { type Address, getBase64Encoder } from "@solana/kit";
import { createDecodeContext, decodeInstruction } from "../decoders/decode.js";
import { staticAccountFlags } from "../decoders/message.js";
import { parseWireTransaction } from "../decoders/transaction.js";
import type { InstructionAccountInput } from "../decoders/types.js";
import type { AnalysisGap, DecodedInstruction } from "../report.js";
import type { RpcClient, TransactionResult } from "../rpc/types.js";
import { listTransfers } from "../rules/catalog/warning.js";
import { accountByRole } from "../rules/helpers.js";
import { SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS } from "../squads/generated/programs/squadsMultisigProgram.js";

const base64Bytes = getBase64Encoder();

/** Squads instructions that move funds out of a vault, and where their destinations are. */
const EXECUTES = new Set(["vaultTransactionExecute", "batchExecuteTransaction"]);
const SPENDING_LIMIT_DESTINATIONS = ["destination", "destinationTokenAccount"];

export interface RecentDestinationsInput {
  readonly multisig: Address;
  /** The vault whose history is read (the proposal's own vault). */
  readonly vault: Address;
  /** How many of the vault's most recent transactions to read (1–1,000). */
  readonly depth: number;
  /** The analysed instructions: owners of token accounts found in the history are added. */
  readonly instructions: readonly DecodedInstruction[];
}

export interface RecentDestinations {
  /** `undefined` when the history could not be read (a gap says so; VGL-W005 then does not run). */
  readonly destinations?: ReadonlySet<Address>;
  readonly gaps: readonly AnalysisGap[];
}

/**
 * The addresses this multisig's vault paid in its last `depth` transactions, for VGL-W005. Only
 * successful transactions that **this multisig** executed are counted: the writable, non-signer
 * accounts a `vaultTransactionExecute` / `batchExecuteTransaction` passes to the vault's
 * instructions, and the destination of a `spendingLimitUse`. Anyone can send a transaction that
 * merely mentions the vault (address poisoning sends dust to it on purpose), so every other
 * transaction is ignored: its addresses must not make a destination look familiar.
 *
 * A transfer in the analysed instructions whose destination *token account* was paid before is
 * treated as a known destination too (VGL-W005 compares the token account's owner).
 */
export async function gatherRecentDestinations(
  rpc: RpcClient,
  input: RecentDestinationsInput,
): Promise<RecentDestinations> {
  const destinations = new Set<Address>();
  try {
    const signatures = await rpc.getSignaturesForAddress(input.vault, { limit: input.depth });
    for (const entry of signatures) {
      if (entry.err !== null) {
        continue;
      }
      const transaction = await rpc.getTransaction(entry.signature);
      if (transaction !== null && transaction.err === null) {
        for (const address of paidBy(transaction, input.multisig)) {
          destinations.add(address);
        }
      }
    }
  } catch {
    return {
      gaps: [
        {
          address: input.vault,
          code: "HISTORY_UNAVAILABLE",
          message: "the vault's recent transactions could not be read from the RPC",
        },
      ],
    };
  }
  for (const transfer of listTransfers(input.instructions)) {
    const tokenAccount =
      transfer.asset === "SOL" ? undefined : accountByRole(transfer.at.instruction, "destination");
    if (tokenAccount !== undefined && destinations.has(tokenAccount)) {
      destinations.add(transfer.to);
    }
  }
  return { destinations, gaps: [] };
}

/** Destinations of the fund-moving Squads instructions of `multisig` in one transaction. */
function paidBy(transaction: TransactionResult, multisig: Address): Address[] {
  let parsed: ReturnType<typeof parseWireTransaction>;
  try {
    parsed = parseWireTransaction(base64Bytes.encode(transaction.transactionBase64));
  } catch {
    return [];
  }
  const { compiled } = parsed.message;
  const keys: InstructionAccountInput[] = [
    ...compiled.staticAccounts.map((address, i) => ({
      address,
      ...staticAccountFlags(compiled, i),
    })),
    ...transaction.loadedAddresses.writable.map((address) => ({
      address,
      isSigner: false,
      isWritable: true,
    })),
    ...transaction.loadedAddresses.readonly.map((address) => ({
      address,
      isSigner: false,
      isWritable: false,
    })),
  ];
  const out: Address[] = [];
  compiled.instructions.forEach((ref, index) => {
    const programId = keys[ref.programIndex]?.address;
    if (programId !== SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS) {
      return;
    }
    const accounts = ref.accountIndexes.map((i) => keys[i]);
    if (accounts.some((account) => account === undefined)) {
      return;
    }
    const decoded = decodeInstruction(
      { accounts: accounts as InstructionAccountInput[], data: ref.data, programId },
      index,
      createDecodeContext(),
      0,
      index,
    );
    if (decoded.decoder !== "squads" || accountByRole(decoded, "multisig") !== multisig) {
      return;
    }
    if (EXECUTES.has(decoded.name ?? "")) {
      for (const account of decoded.accounts) {
        if (account.role === undefined && account.isWritable && !account.isSigner) {
          out.push(account.address);
        }
      }
    } else if (decoded.name === "spendingLimitUse") {
      for (const role of SPENDING_LIMIT_DESTINATIONS) {
        const address = accountByRole(decoded, role);
        if (address !== undefined) {
          out.push(address);
        }
      }
    }
  });
  return out;
}
