import { SUPPORTED_MEMO_PROGRAM_ADDRESSES } from "@solana-program/memo";
import { DecodeError } from "../errors.js";
import type { InstructionInput, ProgramDecodeResult, ProgramDecoder } from "../types.js";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Memo: the instruction data *is* the memo, as UTF-8. Decoded strictly (the Memo program rejects
 * invalid UTF-8, so a lenient decode would show text that can never land). Every account is an
 * optional signer with no named role. The text is attacker-controlled: `decodeInstruction` runs it
 * through the sanitizer (as a memo) before it is placed in the report.
 */
export const memoDecoder: ProgramDecoder = {
  decode(instruction: InstructionInput): ProgramDecodeResult {
    let memo: string;
    try {
      memo = strictUtf8.decode(Uint8Array.from(instruction.data));
    } catch {
      throw new DecodeError("INVALID_UTF8", "memo data is not valid UTF-8");
    }
    return {
      accountRoles: instruction.accounts.map(() => "signer"),
      args: { memo },
      name: "addMemo",
    };
  },
  instructionNames: ["addMemo"],
  key: "memo",
  kind: "native",
  label: "Memo Program",
  programIds: SUPPORTED_MEMO_PROGRAM_ADDRESSES,
};
