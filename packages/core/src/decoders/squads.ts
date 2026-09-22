import type { ReadonlyUint8Array } from "@solana/kit";
import {
  parseSquadsMultisigProgramInstruction,
  SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS,
  SquadsMultisigProgramInstruction,
} from "../squads/generated/programs/squadsMultisigProgram.js";
import {
  enumName,
  instructionName,
  normalizeArgs,
  rolesFromParsedAccounts,
  toKitInstruction,
} from "./codama.js";
import type {
  EmbeddedMessageRef,
  InstructionInput,
  ProgramDecodeResult,
  ProgramDecoder,
} from "./types.js";

/**
 * Squads v4 instructions, via the Codama client generated from the pinned official IDL.
 * `vaultTransactionCreate` and `batchAddTransaction` carry a full serialized transaction message;
 * it is handed back as `embeddedMessage` so the pipeline can decode it recursively. The raw
 * message bytes are replaced by their length in `args` (they're already in `rawDataHex`), and the
 * IDL's single `args` struct of `vaultTransactionCreate` is flattened into the top level.
 */
export const squadsDecoder: ProgramDecoder = {
  decode(instruction: InstructionInput): ProgramDecodeResult {
    const kit = toKitInstruction(instruction);
    const parsed = parseSquadsMultisigProgramInstruction(kit);
    const name = instructionName(
      String(enumName(SquadsMultisigProgramInstruction, parsed.instructionType)),
    );
    const accountRoles = rolesFromParsedAccounts(kit.accounts, parsed.accounts);

    switch (parsed.instructionType) {
      case SquadsMultisigProgramInstruction.VaultTransactionCreate: {
        const { transactionMessage, ...rest } = parsed.data.args;
        return {
          accountRoles,
          args: { ...normalizeArgs(rest), transactionMessageLength: transactionMessage.length },
          embeddedMessage: embedded(transactionMessage),
          name,
        };
      }
      case SquadsMultisigProgramInstruction.BatchAddTransaction: {
        const { transactionMessage, ...rest } = parsed.data;
        return {
          accountRoles,
          args: { ...normalizeArgs(rest), transactionMessageLength: transactionMessage.length },
          embeddedMessage: embedded(transactionMessage),
          name,
        };
      }
      case SquadsMultisigProgramInstruction.TransactionBufferCreate:
      case SquadsMultisigProgramInstruction.TransactionBufferExtend:
      case SquadsMultisigProgramInstruction.VaultTransactionCreateFromBuffer:
        return {
          accountRoles,
          args: normalizeArgs(parsed.data),
          incompleteReason: {
            code: "EMBEDDED_MESSAGE_IN_BUFFER",
            message:
              "The transaction message is assembled in a Squads transaction buffer across " +
              "several transactions and cannot be decoded from this instruction alone.",
          },
          name,
        };
      default:
        return { accountRoles, args: normalizeArgs(parsed.data), name };
    }
  },
  key: "squads",
  kind: "squads",
  label: "Squads Multisig v4",
  programIds: [SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS],
};

function embedded(bytes: ReadonlyUint8Array): EmbeddedMessageRef {
  return { bytes, kind: "squads-transaction-message" };
}
