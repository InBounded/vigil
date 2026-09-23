import { type AccountMeta, AccountRole, type Address, type ReadonlyUint8Array } from "@solana/kit";
import { toHex } from "./bytes.js";
import type { InstructionInput } from "./types.js";

/** Shape of a Codama-generated kit instruction, as the official `parse*Instruction` functions accept it. */
export interface KitInstruction {
  readonly programAddress: Address;
  readonly accounts: readonly AccountMeta[];
  readonly data: ReadonlyUint8Array;
}

export function toKitInstruction(instruction: InstructionInput): KitInstruction {
  return {
    accounts: instruction.accounts.map((account) => ({
      address: account.address,
      role: accountRole(account.isSigner, account.isWritable),
    })),
    data: instruction.data,
    programAddress: instruction.programId,
  };
}

function accountRole(isSigner: boolean, isWritable: boolean): AccountRole {
  if (isSigner) {
    return isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
  }
  return isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
}

/**
 * Maps each account position to the role name a Codama `parse*Instruction` assigned it.
 * Generated parsers hand back the *same* `AccountMeta` objects they were given, so identity
 * comparison is exact even when optional accounts are omitted or addresses repeat.
 */
export function rolesFromParsedAccounts(
  metas: readonly AccountMeta[],
  parsedAccounts: object | undefined,
): (string | undefined)[] {
  const roles: (string | undefined)[] = metas.map(() => undefined);
  if (parsedAccounts === undefined) {
    return roles;
  }
  for (const [role, meta] of Object.entries(parsedAccounts)) {
    const position = metas.indexOf(meta as AccountMeta);
    if (position !== -1) {
      roles[position] = role;
    }
  }
  return roles;
}

/**
 * Converts Codama-decoded instruction data into plain report values: drops discriminator fields,
 * unwraps kit `Option`s to value-or-null, turns byte arrays into hex strings. `bigint` stays
 * `bigint` (serialized to string only at the report boundary).
 */
export function normalizeArgs(data: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "discriminator" || key.endsWith("Discriminator")) {
      continue;
    }
    out[key] = normalizeValue(value);
  }
  return out;
}

export function normalizeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return toHex(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value !== null && typeof value === "object") {
    if ("__option" in value) {
      return value.__option === "Some" && "value" in value ? normalizeValue(value.value) : null;
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = normalizeValue(inner);
    }
    return out;
  }
  return value;
}

/** Enum member name for a numeric TypeScript enum value (e.g. `AuthorityType[3]`), else the number. */
export function enumName(enumObject: Readonly<Record<number, string>>, value: unknown): unknown {
  if (typeof value === "number") {
    return enumObject[value] ?? value;
  }
  return value;
}

/** Every member name of a numeric TypeScript enum, as lower-camel instruction names. */
export function enumInstructionNames(enumObject: Readonly<Record<number, string>>): string[] {
  return Object.values(enumObject)
    .filter((value): value is string => typeof value === "string")
    .map(instructionName);
}

/** Lower-camel instruction name from an enum member name (`TransferSol` → `transferSol`). */
export function instructionName(enumMemberName: string): string {
  return enumMemberName.charAt(0).toLowerCase() + enumMemberName.slice(1);
}
