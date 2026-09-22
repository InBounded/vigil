import type { Address, ReadonlyUint8Array } from "@solana/kit";
import type { VaultTransactionMessage } from "../squads/generated/types/vaultTransactionMessage.js";
import { ByteReader } from "./bytes.js";
import { DecodeError } from "./errors.js";

export interface CompiledInstructionRef {
  readonly programIndex: number;
  readonly accountIndexes: readonly number[];
  readonly data: ReadonlyUint8Array;
}

export interface LookupRef {
  readonly tableAddress: Address;
  readonly writableIndexes: readonly number[];
  readonly readonlyIndexes: readonly number[];
}

/**
 * One account-index space shared by Solana wire messages (legacy / v0) and Squads transaction
 * messages. Both resolve an index the same way: static keys first, then every lookup's writable
 * entries (in lookup order), then every lookup's readonly entries — confirmed for Squads in
 * `utils/executable_transaction_message.rs` (`get_account_by_index`).
 */
export interface CompiledMessage {
  readonly staticAccounts: readonly Address[];
  readonly numSigners: number;
  readonly numWritableSigners: number;
  readonly numWritableNonSigners: number;
  readonly instructions: readonly CompiledInstructionRef[];
  readonly lookups: readonly LookupRef[];
}

export function fromVaultTransactionMessage(message: VaultTransactionMessage): CompiledMessage {
  return {
    instructions: message.instructions.map((instruction) => ({
      accountIndexes: Array.from(instruction.accountIndexes),
      data: instruction.data,
      programIndex: instruction.programIdIndex,
    })),
    lookups: message.addressTableLookups.map((lookup) => ({
      readonlyIndexes: Array.from(lookup.readonlyIndexes),
      tableAddress: lookup.accountKey,
      writableIndexes: Array.from(lookup.writableIndexes),
    })),
    numSigners: message.numSigners,
    numWritableNonSigners: message.numWritableNonSigners,
    numWritableSigners: message.numWritableSigners,
    staticAccounts: message.accountKeys,
  };
}

/**
 * Parses the compact `TransactionMessage` that Squads `vaultTransactionCreate` /
 * `batchAddTransaction` take as `transaction_message: Vec<u8>`. Layout from
 * `instructions/vault_transaction_create.rs` and `utils/small_vec.rs` (squads-protocol/v4 at the
 * commit recorded in `docs/DECISIONS.md`):
 *
 * - `num_signers: u8`, `num_writable_signers: u8`, `num_writable_non_signers: u8`
 * - `account_keys: SmallVec<u8, Pubkey>`
 * - `instructions: SmallVec<u8, { program_id_index: u8, account_indexes: SmallVec<u8, u8>, data: SmallVec<u16, u8> }>`
 * - `address_table_lookups: SmallVec<u8, { account_key: Pubkey, writable_indexes: SmallVec<u8, u8>, readonly_indexes: SmallVec<u8, u8> }>`
 *
 * Then applies the same validation as the program's `TryFrom<TransactionMessage>`; a message that
 * fails it could never be stored on-chain, so it is rejected rather than shown.
 */
export function parseSquadsTransactionMessage(bytes: ReadonlyUint8Array): CompiledMessage {
  const reader = new ByteReader(bytes);
  const numSigners = reader.u8();
  const numWritableSigners = reader.u8();
  const numWritableNonSigners = reader.u8();

  const staticAccounts: Address[] = [];
  const keyCount = reader.u8();
  for (let i = 0; i < keyCount; i++) {
    staticAccounts.push(reader.address());
  }

  const instructions: CompiledInstructionRef[] = [];
  const instructionCount = reader.u8();
  for (let i = 0; i < instructionCount; i++) {
    const programIndex = reader.u8();
    const accountIndexes = Array.from(reader.bytes(reader.u8()));
    const data = reader.bytes(reader.u16());
    instructions.push({ accountIndexes, data, programIndex });
  }

  const lookups: LookupRef[] = [];
  const lookupCount = reader.u8();
  for (let i = 0; i < lookupCount; i++) {
    const tableAddress = reader.address();
    const writableIndexes = Array.from(reader.bytes(reader.u8()));
    const readonlyIndexes = Array.from(reader.bytes(reader.u8()));
    lookups.push({ readonlyIndexes, tableAddress, writableIndexes });
  }

  const message: CompiledMessage = {
    instructions,
    lookups,
    numSigners,
    numWritableNonSigners,
    numWritableSigners,
    staticAccounts,
  };
  validateSquadsMessage(message);
  return message;
}

/** Mirrors `impl TryFrom<TransactionMessage> for VaultTransactionMessage` in the Squads program. */
function validateSquadsMessage(message: CompiledMessage): void {
  const keyCount = message.staticAccounts.length;
  if (message.numSigners > keyCount) {
    throw new DecodeError("INVALID_VALUE", "num_signers exceeds the number of account keys");
  }
  if (message.numWritableSigners > message.numSigners) {
    throw new DecodeError("INVALID_VALUE", "num_writable_signers exceeds num_signers");
  }
  if (message.numWritableNonSigners > keyCount - message.numSigners) {
    throw new DecodeError("INVALID_VALUE", "num_writable_non_signers exceeds the non-signer keys");
  }
  const total = totalAccountCount(message);
  for (const instruction of message.instructions) {
    if (instruction.programIndex >= total || instruction.accountIndexes.some((i) => i >= total)) {
      throw new DecodeError(
        "INVALID_VALUE",
        "instruction references an account index out of bounds",
      );
    }
  }
}

export function totalAccountCount(message: CompiledMessage): number {
  return message.lookups.reduce(
    (sum, lookup) => sum + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
    message.staticAccounts.length,
  );
}

/** Whether a static account index is a signer / writable, per the message header counts. */
export function staticAccountFlags(
  message: CompiledMessage,
  index: number,
): { readonly isSigner: boolean; readonly isWritable: boolean } {
  const isSigner = index < message.numSigners;
  const isWritable = isSigner
    ? index < message.numWritableSigners
    : index - message.numSigners < message.numWritableNonSigners;
  return { isSigner, isWritable };
}
