import { type Address, isAddress } from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { LOADER_V3_PROGRAM_ADDRESS } from "@solana-program/loader-v3";
import { STAKE_PROGRAM_ADDRESS } from "@solana-program/stake";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { memoDecoder } from "../decoders/native/memo.js";
import { TOKEN_2022_PROGRAM_ADDRESS } from "../decoders/native/token-2022.js";
import type { DecodedInstruction, Finding, Provenance } from "../report.js";
import { SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS } from "../squads/generated/programs/squadsMultisigProgram.js";
import type { Rule, RuleContext } from "./types.js";
import type { WalkedInstruction } from "./walk.js";

export const PROGRAMS = {
  computeBudget: COMPUTE_BUDGET_PROGRAM_ADDRESS,
  loader: LOADER_V3_PROGRAM_ADDRESS,
  squads: SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS,
  stake: STAKE_PROGRAM_ADDRESS,
  system: SYSTEM_PROGRAM_ADDRESS,
  token: TOKEN_PROGRAM_ADDRESS,
  token2022: TOKEN_2022_PROGRAM_ADDRESS,
} as const;

export const MEMO_PROGRAMS: readonly Address[] = memoDecoder.programIds;

export function isTokenProgram(programId: Address): boolean {
  return programId === PROGRAMS.token || programId === PROGRAMS.token2022;
}

/** `true` for an instruction of `programId` named `name` that a decoder actually decoded. */
export function isInstruction(
  instruction: DecodedInstruction,
  programId: Address,
  ...names: readonly string[]
): boolean {
  return (
    instruction.programId === programId &&
    instruction.decoder !== "none" &&
    instruction.name !== undefined &&
    names.includes(instruction.name)
  );
}

export function accountByRole(instruction: DecodedInstruction, role: string): Address | undefined {
  return instruction.accounts.find((account) => account.role === role)?.address;
}

/** The address in `role`, or `"unknown"` for display when the instruction has no such account. */
export function roleText(instruction: DecodedInstruction, role: string): string {
  return accountByRole(instruction, role) ?? "unknown";
}

export function accountAt(instruction: DecodedInstruction, position: number): Address | undefined {
  return instruction.accounts[position]?.address;
}

export function argOf(instruction: DecodedInstruction, name: string): unknown {
  return instruction.args?.[name];
}

/** An argument that holds an address (`null` when an optional one is absent). */
export function addressArg(instruction: DecodedInstruction, name: string): Address | null {
  const value = argOf(instruction, name);
  return typeof value === "string" && isAddress(value) ? value : null;
}

export function bigintArg(instruction: DecodedInstruction, name: string): bigint | undefined {
  const value = argOf(instruction, name);
  return typeof value === "bigint" ? value : undefined;
}

/** A `field: value` evidence line. */
export function ev(field: string, value: string | number | bigint): string {
  return `${field}: ${String(value)}`;
}

export interface FindingSpec {
  readonly variant?: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly evidence: readonly string[];
  readonly provenance: Provenance;
  readonly at?: WalkedInstruction;
  readonly instructionIndex?: number;
}

/**
 * Builds a finding of `rule`. For an instruction inside a proposal the transaction only creates,
 * the `proposed` param is set and the evidence says where the instruction sits.
 */
export function finding(rule: Rule, spec: FindingSpec): Finding {
  const params: Record<string, string> = { ...spec.params };
  const evidence = [...spec.evidence];
  if (spec.at !== undefined) {
    evidence.push(ev("instruction", spec.at.path));
    if (spec.at.proposed) {
      params.proposed = "true";
    }
  }
  const instructionIndex = spec.at?.topIndex ?? spec.instructionIndex;
  return {
    evidence,
    params,
    provenance: spec.provenance,
    ruleId: rule.id,
    severity: rule.defaultSeverity,
    titleKey:
      spec.variant === undefined || spec.variant === ""
        ? rule.titleKey
        : `${rule.titleKey}.${spec.variant}`,
    ...(instructionIndex === undefined ? {} : { instructionIndex }),
  };
}

/** A vault of this multisig, or an address the user said they know (maintainer decision). */
export function isOwnAddress(context: RuleContext, address: Address): boolean {
  return context.vaults.has(address) || context.options.knownAddresses.has(address);
}

/** How an address is described in evidence: `vault #0`, `user label "…"`, `member`, `unknown`. */
export function describeAddress(context: RuleContext, address: Address): string {
  const vault = context.vaults.get(address);
  if (vault !== undefined) {
    return `vault #${vault}`;
  }
  const user = context.options.knownAddresses.get(address);
  if (user !== undefined) {
    return `user label "${user}"`;
  }
  const kinds = context.known.get(address);
  return kinds === undefined ? "unknown" : kinds.join(", ");
}
