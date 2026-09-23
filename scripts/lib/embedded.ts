/**
 * Finds `vaultTransactionCreate` instructions in a real transaction and turns their embedded
 * message into a simulation target, so a past proposal's message can be simulated against today's
 * state after its accounts were closed. Capture tooling only.
 */
import { type Address, getBase64Encoder } from "@solana/kit";
import { parseSquadsTransactionMessage } from "../../packages/core/src/decoders/message.js";
import { parseWireTransaction } from "../../packages/core/src/decoders/transaction.js";
import type { TransactionResult } from "../../packages/core/src/rpc/types.js";
import type { VaultMessageTarget } from "../../packages/core/src/simulate/vault.js";
import { matchesDiscriminator } from "../../packages/core/src/squads/decode.js";
import {
  getVaultTransactionCreateInstructionDataDecoder,
  VAULT_TRANSACTION_CREATE_DISCRIMINATOR,
} from "../../packages/core/src/squads/generated/instructions/vaultTransactionCreate.js";
import { SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS } from "../../packages/core/src/squads/generated/programs/squadsMultisigProgram.js";

export async function embeddedVaultMessages(
  tx: TransactionResult,
): Promise<{ readonly multisig: Address; readonly target: VaultMessageTarget }[]> {
  const parsed = parseWireTransaction(getBase64Encoder().encode(tx.transactionBase64));
  const keys = [
    ...parsed.message.compiled.staticAccounts,
    ...tx.loadedAddresses.writable,
    ...tx.loadedAddresses.readonly,
  ];
  const out: { multisig: Address; target: VaultMessageTarget }[] = [];
  for (const instruction of parsed.message.compiled.instructions) {
    if (keys[instruction.programIndex] !== SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS) {
      continue;
    }
    if (!matchesDiscriminator(instruction.data, VAULT_TRANSACTION_CREATE_DISCRIMINATOR)) {
      continue;
    }
    const { args } = getVaultTransactionCreateInstructionDataDecoder().decode(instruction.data);
    // Accounts per the IDL: multisig, transaction, creator, rentPayer, systemProgram.
    const multisig = keys[instruction.accountIndexes[0] ?? -1];
    const transaction = keys[instruction.accountIndexes[1] ?? -1];
    if (multisig === undefined || transaction === undefined) {
      throw new Error("vaultTransactionCreate without its accounts");
    }
    out.push({
      multisig,
      target: {
        ephemeralSignerBase: transaction,
        ephemeralSignerCount: args.ephemeralSigners,
        message: parseSquadsTransactionMessage(args.transactionMessage),
        vaultIndex: args.vaultIndex,
      },
    });
  }
  return out;
}
