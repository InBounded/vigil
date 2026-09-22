import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  AssociatedTokenInstruction,
  AuthorityType,
  parseAssociatedTokenInstruction,
  parseTokenInstruction,
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
} from "@solana-program/token";
import { enumName } from "../codama.js";
import type { InstructionInput, ProgramDecodeResult, ProgramDecoder } from "../types.js";
import { codamaProgramDecoder } from "./codama-program.js";
import { splitTokenBatch, TOKEN_BATCH_TAG } from "./token-batch.js";

const baseTokenDecoder = codamaProgramDecoder({
  instructionEnum: TokenInstruction,
  key: "token",
  label: "SPL Token",
  parse: parseTokenInstruction,
  programIds: [TOKEN_PROGRAM_ADDRESS],
  refineArgs: (name, args) =>
    name === "setAuthority"
      ? { ...args, authorityType: enumName(AuthorityType, args.authorityType) }
      : args,
});

export const tokenDecoder: ProgramDecoder = {
  ...baseTokenDecoder,
  decode(instruction: InstructionInput): ProgramDecodeResult {
    if (instruction.data[0] === TOKEN_BATCH_TAG) {
      return { args: {}, innerInstructions: splitTokenBatch(instruction), name: "batch" };
    }
    return baseTokenDecoder.decode(instruction);
  },
};

export const associatedTokenDecoder = codamaProgramDecoder({
  instructionEnum: AssociatedTokenInstruction,
  key: "associatedToken",
  label: "Associated Token Account Program",
  parse: parseAssociatedTokenInstruction,
  programIds: [ASSOCIATED_TOKEN_PROGRAM_ADDRESS],
});
