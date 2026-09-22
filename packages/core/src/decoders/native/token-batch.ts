import { ByteReader } from "../bytes.js";
import { DecodeError } from "../errors.js";
import type { InstructionInput } from "../types.js";

/** Instruction tag of `Batch` in both SPL Token and Token-2022. */
export const TOKEN_BATCH_TAG = 255;

/**
 * Splits a Token / Token-2022 `Batch` (tag 255) into its items, each resolved against its own
 * slice of the outer instruction's accounts. Layout per item, from Token-2022's
 * `Processor::process_batch` (and identical in `@solana-program/token`'s batch codec):
 * `u8` number of accounts, `u8` data length, then that many data bytes. Nested batches are
 * rejected by the program, so they are rejected here too.
 */
export function splitTokenBatch(instruction: InstructionInput): InstructionInput[] {
  const reader = new ByteReader(instruction.data, 1);
  const items: InstructionInput[] = [];
  let accountCursor = 0;
  if (reader.remaining === 0) {
    throw new DecodeError("TRUNCATED", "empty Batch");
  }
  while (reader.remaining > 0) {
    const accountCount = reader.u8();
    const dataLength = reader.u8();
    const data = reader.bytes(dataLength);
    if (data[0] === TOKEN_BATCH_TAG) {
      throw new DecodeError("INVALID_VALUE", "nested Batch is not allowed");
    }
    const accounts = instruction.accounts.slice(accountCursor, accountCursor + accountCount);
    if (accounts.length !== accountCount) {
      throw new DecodeError(
        "TRUNCATED",
        `Batch item ${items.length} expects ${accountCount} account(s), only ${accounts.length} left`,
      );
    }
    accountCursor += accountCount;
    items.push({ accounts, data, programId: instruction.programId });
  }
  return items;
}
