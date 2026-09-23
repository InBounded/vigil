import type { Address, ReadonlyUint8Array } from "@solana/kit";
import {
  enumInstructionNames,
  enumName,
  instructionName,
  type KitInstruction,
  normalizeArgs,
  rolesFromParsedAccounts,
  toKitInstruction,
} from "../codama.js";
import type { InstructionInput, ProgramDecodeResult, ProgramDecoder } from "../types.js";

/** The common shape of every official Codama client's program-level `parse*Instruction` result. */
export interface ParsedCodamaInstruction {
  readonly instructionType: number;
  readonly accounts?: object;
  readonly data?: object;
}

export interface CodamaProgramOptions {
  readonly key: string;
  readonly label: string;
  readonly programIds: readonly Address[];
  readonly instructionEnum: Readonly<Record<number, string>>;
  readonly parse: (
    instruction: KitInstruction & { readonly data: ReadonlyUint8Array },
  ) => ParsedCodamaInstruction;
  /** Optional per-program post-processing of normalized args (e.g. enum values → names). */
  readonly refineArgs?: (name: string, args: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * A `ProgramDecoder` backed by an official `@solana-program/*` client. The client's own
 * `parse*Instruction` identifies the instruction and decodes accounts and data; it throws on
 * unknown discriminators, too few accounts, or truncated data.
 */
export function codamaProgramDecoder(options: CodamaProgramOptions): ProgramDecoder {
  return {
    decode(instruction: InstructionInput): ProgramDecodeResult {
      const kit = toKitInstruction(instruction);
      const parsed = options.parse(kit);
      const member = enumName(options.instructionEnum, parsed.instructionType);
      const name = instructionName(String(member));
      const normalized = parsed.data === undefined ? {} : normalizeArgs(parsed.data);
      const args =
        options.refineArgs === undefined ? normalized : options.refineArgs(name, normalized);
      return {
        accountRoles: rolesFromParsedAccounts(kit.accounts, parsed.accounts),
        args,
        name,
      };
    },
    instructionNames: enumInstructionNames(options.instructionEnum),
    key: options.key,
    kind: "native",
    label: options.label,
    programIds: options.programIds,
  };
}
