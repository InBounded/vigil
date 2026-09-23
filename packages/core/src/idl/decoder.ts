import { parseInstruction } from "@codama/dynamic-parsers";
import type { InstructionNode, RootNode } from "@codama/nodes";
import type { Address } from "@solana/kit";
import { normalizeValue, toKitInstruction } from "../decoders/codama.js";
import { DecodeError } from "../decoders/errors.js";
import type { InstructionInput, ProgramDecodeResult, ProgramDecoder } from "../decoders/types.js";

export type IdlSource = "program-metadata" | "anchor-idl-account";

/**
 * A `ProgramDecoder` driven by a program's own IDL, through Codama's dynamic parser: it identifies
 * the instruction by discriminator (restricted to this program's address) and decodes the data
 * and account names. Everything it yields is only what the program's author *declares*
 * (provenance `idl-declared`): an IDL does not prove what the program does.
 */
export function idlProgramDecoder(
  root: RootNode,
  program: Address,
  source: IdlSource,
): ProgramDecoder {
  const programName = root.program.name;
  return {
    decode(instruction: InstructionInput): ProgramDecodeResult {
      const kit = toKitInstruction(instruction);
      const parsed = parseInstruction(root, kit);
      if (parsed === undefined) {
        throw new DecodeError("INVALID_TAG", "the instruction is not in the program's IDL");
      }
      const node = parsed.path[parsed.path.length - 1] as InstructionNode;
      const accountRoles: (string | undefined)[] = instruction.accounts.map(
        (_account, i) => parsed.accounts[i]?.name,
      );
      const data = normalizeValue(mapsToEntries(parsed.data));
      const args: Record<string, unknown> = {};
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        for (const [key, value] of Object.entries(data)) {
          if (key !== "discriminator" && !key.endsWith("Discriminator")) {
            args[key] = value;
          }
        }
      }
      return {
        accountRoles,
        args,
        name: node.name,
        summary: {
          key: "ix.idl.call",
          params: { idlProgramName: programName, instruction: node.name },
        },
      };
    },
    instructionNames: [],
    key: "idl",
    kind: source === "program-metadata" ? "program-metadata-idl" : "anchor-idl",
    // Used in gap messages only. The IDL's own program name is author-declared, so it is never
    // shown as the program's label (a program could call itself "squadsMultisigProgram").
    label: `program ${program} (IDL)`,
    programIds: [program],
  };
}

/** Codama decodes `map` types to JS `Map`s, which plain-object handling would silently empty. */
function mapsToEntries(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()].map(([k, v]) => [mapsToEntries(k), mapsToEntries(v)]);
  }
  if (Array.isArray(value)) {
    return value.map(mapsToEntries);
  }
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = mapsToEntries(inner);
    }
    return out;
  }
  return value;
}
