import {
  type Address,
  isSolanaError,
  SOLANA_ERROR__PROGRAM_CLIENTS__FAILED_TO_IDENTIFY_INSTRUCTION,
  SOLANA_ERROR__PROGRAM_CLIENTS__UNRECOGNIZED_INSTRUCTION_TYPE,
} from "@solana/kit";
import { type IdlEntry, type IdlOptions, loadProgramIdls } from "../idl/fetch.js";
import { findRegistryProgram } from "../registry/index.js";
import type {
  AnalysisGap,
  AnalysisGapCode,
  DecodedAccount,
  DecodedInstruction,
} from "../report.js";
import type { RpcClient } from "../rpc/types.js";
import { sanitizeArgs } from "../sanitize/args.js";
import { toHex } from "./bytes.js";
import { DecodeError } from "./errors.js";
import { fetchLookupTables, type LookupTableEntry, type LookupTableInfo } from "./lookup-tables.js";
import {
  type CompiledMessage,
  parseSquadsTransactionMessage,
  staticAccountFlags,
} from "./message.js";
import { addressLookupTableDecoder } from "./native/address-lookup-table.js";
import { computeBudgetDecoder } from "./native/compute-budget.js";
import { loaderV3Decoder } from "./native/loader-v3.js";
import { memoDecoder } from "./native/memo.js";
import { stakeDecoder } from "./native/stake.js";
import { systemDecoder } from "./native/system.js";
import { associatedTokenDecoder, tokenDecoder } from "./native/token.js";
import { token2022Decoder } from "./native/token-2022.js";
import { squadsDecoder } from "./squads.js";
import type {
  InstructionAccountInput,
  InstructionInput,
  ProgramDecodeResult,
  ProgramDecoder,
} from "./types.js";

export const PROGRAM_DECODERS: readonly ProgramDecoder[] = [
  systemDecoder,
  computeBudgetDecoder,
  tokenDecoder,
  token2022Decoder,
  associatedTokenDecoder,
  addressLookupTableDecoder,
  stakeDecoder,
  loaderV3Decoder,
  memoDecoder,
  squadsDecoder,
];

const REGISTRY: ReadonlyMap<Address, ProgramDecoder> = new Map(
  PROGRAM_DECODERS.flatMap((decoder) =>
    decoder.programIds.map((programId) => [programId, decoder] as const),
  ),
);

/** How many levels of messages-inside-instructions are decoded (a Squads proposal nesting another). */
export const MAX_EMBEDDED_DEPTH = 3;

export interface DecodeContext {
  /** Lookup tables fetched so far. A table absent from this map has not been fetched yet. */
  readonly tables: ReadonlyMap<Address, LookupTableEntry>;
  /** Filled during decoding with tables that were needed but not yet fetched. */
  readonly missing: Set<Address>;
  /**
   * IDLs looked up so far, for programs without a built-in decoder; `undefined` = IDL lookup is
   * disabled. A program absent from the map has not been looked up yet.
   */
  readonly idls: ReadonlyMap<Address, IdlEntry> | undefined;
  /** Filled during decoding with programs whose IDL was needed but not yet looked up. */
  readonly missingIdls: Set<Address>;
  readonly gaps: AnalysisGap[];
}

export interface DecodeOptions {
  /** Look up third-party programs' IDLs on chain (default), or `false` to never do so. */
  readonly idl?: IdlOptions | false;
}

export interface MessageDecodeResult {
  readonly instructions: readonly DecodedInstruction[];
  readonly gaps: readonly AnalysisGap[];
  /** Every lookup table that resolved, in address order. */
  readonly lookupTables: readonly LookupTableInfo[];
  /** Slot of the lookup-table read, or `null` if no table had to be read. */
  readonly lookupTablesContextSlot: bigint | null;
}

export function createDecodeContext(
  tables: ReadonlyMap<Address, LookupTableEntry> = new Map(),
  idls?: ReadonlyMap<Address, IdlEntry>,
): DecodeContext {
  return { gaps: [], idls, missing: new Set(), missingIdls: new Set(), tables };
}

/**
 * Decodes every instruction of a message, fetching whatever lookup tables it (or any message
 * embedded in it) needs, and the IDLs of programs Vigil has no built-in decoder for. Decoding is
 * pure; each round only adds tables or IDLs discovered in the previous one, so the number of rounds
 * is bounded by the embedding depth.
 */
export async function decodeMessageWithLookups(
  rpc: RpcClient,
  message: CompiledMessage,
  options: DecodeOptions = {},
): Promise<MessageDecodeResult> {
  const tables = new Map<Address, LookupTableEntry>();
  const idls = options.idl === false ? undefined : new Map<Address, IdlEntry>();
  let contextSlot: bigint | null = null;
  for (let round = 0; round <= 2 * (MAX_EMBEDDED_DEPTH + 2); round++) {
    const context = createDecodeContext(tables, idls);
    const instructions = decodeCompiledMessage(message, context, 0, undefined);
    if (context.missing.size === 0 && context.missingIdls.size === 0) {
      return {
        gaps: dedupeGaps(context.gaps),
        instructions,
        lookupTables: [...tables.values()]
          .flatMap((entry) => (entry.status === "ok" ? [entry.table] : []))
          .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)),
        lookupTablesContextSlot: contextSlot,
      };
    }
    if (context.missing.size > 0) {
      const fetched = await fetchLookupTables(rpc, [...context.missing].sort());
      for (const [address, entry] of fetched.entries) {
        tables.set(address, entry);
      }
      if (contextSlot === null || fetched.contextSlot > contextSlot) {
        contextSlot = fetched.contextSlot;
      }
    } else if (idls !== undefined) {
      // IDLs are looked up once every lookup table is resolved, so all program ids are known.
      const loaded = await loadProgramIdls(
        rpc,
        [...context.missingIdls].sort(),
        options.idl === false ? {} : options.idl,
      );
      for (const [program, entry] of loaded) {
        idls.set(program, entry);
      }
    }
  }
  // Unreachable in practice: every round either finishes or fetches new tables/IDLs, and new ones
  // can only come from a deeper embedding level, which is capped.
  throw new DecodeError("INVALID_VALUE", "lookup table resolution did not converge");
}

/**
 * Resolves and decodes one compiled message against already-fetched lookup tables.
 * `topIndex` is the top-level instruction this message is embedded in (for gap attribution).
 */
export function decodeCompiledMessage(
  message: CompiledMessage,
  context: DecodeContext,
  depth: number,
  topIndex: number | undefined,
): DecodedInstruction[] {
  const keys = resolveAccountKeys(message, context, topIndex);
  const decoded: DecodedInstruction[] = [];
  message.instructions.forEach((compiled, index) => {
    const gapIndex = topIndex ?? index;
    const program = keys[compiled.programIndex];
    if (program === undefined) {
      addGap(
        context,
        "ACCOUNT_INDEX_OUT_OF_RANGE",
        `program index ${compiled.programIndex} is out of range`,
        gapIndex,
      );
      return;
    }
    if (program === null) {
      addGap(
        context,
        "ACCOUNT_UNRESOLVED",
        "the program address comes from a lookup table that could not be read",
        gapIndex,
      );
      return;
    }
    const accounts = compiled.accountIndexes.map((accountIndex) => keys[accountIndex]);
    if (accounts.some((account) => account === undefined)) {
      addGap(
        context,
        "ACCOUNT_INDEX_OUT_OF_RANGE",
        "an account index is out of range",
        gapIndex,
        program.address,
      );
      decoded.push(undecoded(index, program.address, [], compiled.data));
      return;
    }
    if (accounts.some((account) => account === null)) {
      addGap(
        context,
        "ACCOUNT_UNRESOLVED",
        "an account comes from a lookup table that could not be read",
        gapIndex,
        program.address,
      );
      decoded.push(undecoded(index, program.address, [], compiled.data));
      return;
    }
    const resolved = accounts.filter(
      (account): account is InstructionAccountInput => account != null,
    );
    decoded.push(
      decodeInstruction(
        { accounts: resolved, data: compiled.data, programId: program.address },
        index,
        context,
        depth,
        gapIndex,
      ),
    );
  });
  return decoded;
}

/** Decodes one resolved instruction (and anything nested in it). Never throws on bad input. */
export function decodeInstruction(
  instruction: InstructionInput,
  index: number,
  context: DecodeContext,
  depth: number,
  topIndex: number,
): DecodedInstruction {
  const decoder = REGISTRY.get(instruction.programId) ?? idlDecoder(instruction, context, topIndex);
  if (decoder === undefined) {
    return undecoded(index, instruction.programId, instruction.accounts, instruction.data);
  }
  const fromIdl = decoder.kind === "anchor-idl" || decoder.kind === "program-metadata-idl";
  const programLabel = fromIdl ? findRegistryProgram(instruction.programId)?.name : decoder.label;

  let result: ProgramDecodeResult;
  try {
    result = decoder.decode(instruction);
  } catch (error) {
    const unknown = isUnknownInstructionError(error);
    addGap(
      context,
      unknown ? "UNKNOWN_INSTRUCTION" : "MALFORMED_INSTRUCTION",
      `${decoder.label}: ${describeError(error)}`,
      topIndex,
      instruction.programId,
    );
    return {
      ...undecoded(index, instruction.programId, instruction.accounts, instruction.data),
      ...(programLabel === undefined ? {} : { programLabel }),
    };
  }

  if (result.argsNotDecoded === true) {
    addGap(
      context,
      "INSTRUCTION_ARGS_NOT_DECODED",
      `${decoder.label}: ${result.name} was identified but its arguments were not decoded`,
      topIndex,
      instruction.programId,
    );
  }
  if (result.incompleteReason !== undefined) {
    addGap(
      context,
      result.incompleteReason.code,
      result.incompleteReason.message,
      topIndex,
      instruction.programId,
    );
  }

  const inner = decodeNested(result, instruction, context, depth, topIndex);
  const accounts = instruction.accounts.map((account, i) =>
    decodedAccount(account, result.accountRoles?.[i]),
  );
  const { args, notes } = sanitizeArgs(result.args ?? {});
  return {
    accounts,
    ...(result.argsNotDecoded === true ? {} : { args }),
    decoder: decoder.kind,
    index,
    ...(inner === undefined ? {} : { inner }),
    name: result.name,
    programId: instruction.programId,
    ...(programLabel === undefined ? {} : { programLabel }),
    provenance: fromIdl ? "idl-declared" : "onchain",
    rawDataHex: toHex(instruction.data),
    ...(notes.length === 0 ? {} : { sanitizer: notes }),
    summary: result.summary ?? buildSummary(decoder.key, result.name, args, accounts),
  };
}

/**
 * The IDL-driven decoder for a program Vigil has no built-in decoder for, or `undefined` after
 * recording why the instruction cannot be decoded (no IDL, IDL unusable, IDL not looked up yet).
 */
function idlDecoder(
  instruction: InstructionInput,
  context: DecodeContext,
  topIndex: number,
): ProgramDecoder | undefined {
  const entry = context.idls?.get(instruction.programId);
  if (entry?.status === "ok") {
    return entry.decoder;
  }
  if (entry?.status === "error") {
    addGap(context, entry.code, entry.message, topIndex, instruction.programId);
    return undefined;
  }
  if (entry === undefined && context.idls !== undefined) {
    context.missingIdls.add(instruction.programId);
  }
  addGap(
    context,
    "UNKNOWN_PROGRAM",
    entry === undefined
      ? "no decoder for this program"
      : "no decoder for this program, and it publishes no IDL on chain",
    topIndex,
    instruction.programId,
  );
  return undefined;
}

function decodeNested(
  result: ProgramDecodeResult,
  instruction: InstructionInput,
  context: DecodeContext,
  depth: number,
  topIndex: number,
): DecodedInstruction[] | undefined {
  if (result.innerInstructions !== undefined) {
    return result.innerInstructions.map((inner, i) =>
      decodeInstruction(inner, i, context, depth + 1, topIndex),
    );
  }
  if (result.embeddedMessage === undefined) {
    return undefined;
  }
  if (depth + 1 > MAX_EMBEDDED_DEPTH) {
    addGap(
      context,
      "EMBEDDED_MESSAGE_INVALID",
      `messages nested deeper than ${MAX_EMBEDDED_DEPTH} levels are not decoded`,
      topIndex,
      instruction.programId,
    );
    return undefined;
  }
  let embedded: CompiledMessage;
  try {
    embedded = parseSquadsTransactionMessage(result.embeddedMessage.bytes);
  } catch (error) {
    addGap(
      context,
      "EMBEDDED_MESSAGE_INVALID",
      `embedded transaction message: ${describeError(error)}`,
      topIndex,
      instruction.programId,
    );
    return undefined;
  }
  return decodeCompiledMessage(embedded, context, depth + 1, topIndex);
}

/**
 * Maps every account index of a message to an address and its signer/writable flags.
 * `null` = comes from a lookup table that could not be read (gap recorded); an index past the end
 * of the array = out of range.
 */
function resolveAccountKeys(
  message: CompiledMessage,
  context: DecodeContext,
  topIndex: number | undefined,
): (InstructionAccountInput | null)[] {
  const keys: (InstructionAccountInput | null)[] = message.staticAccounts.map((address, i) => ({
    address,
    ...staticAccountFlags(message, i),
  }));
  const writable: (InstructionAccountInput | null)[] = [];
  const readonly: (InstructionAccountInput | null)[] = [];
  for (const lookup of message.lookups) {
    const entry = context.tables.get(lookup.tableAddress);
    const resolve = (tableIndex: number, isWritable: boolean): InstructionAccountInput | null => {
      if (entry === undefined) {
        context.missing.add(lookup.tableAddress);
        return null;
      }
      if (entry.status !== "ok") {
        addGap(
          context,
          entry.status === "not-found" ? "LOOKUP_TABLE_NOT_FOUND" : "LOOKUP_TABLE_INVALID",
          entry.status === "not-found"
            ? "address lookup table account does not exist"
            : `address lookup table is invalid: ${entry.reason}`,
          topIndex,
          lookup.tableAddress,
        );
        return null;
      }
      const address = entry.table.addresses[tableIndex];
      if (address === undefined) {
        addGap(
          context,
          "LOOKUP_TABLE_INDEX_OUT_OF_RANGE",
          `index ${tableIndex} is past the end of the table (${entry.table.addresses.length} entries)`,
          topIndex,
          lookup.tableAddress,
        );
        return null;
      }
      return { address, fromLookupTable: lookup.tableAddress, isSigner: false, isWritable };
    };
    writable.push(...lookup.writableIndexes.map((i) => resolve(i, true)));
    readonly.push(...lookup.readonlyIndexes.map((i) => resolve(i, false)));
  }
  return [...keys, ...writable, ...readonly];
}

function decodedAccount(
  account: InstructionAccountInput,
  role: string | undefined,
): DecodedAccount {
  return {
    address: account.address,
    ...(account.fromLookupTable === undefined ? {} : { fromLookupTable: account.fromLookupTable }),
    isSigner: account.isSigner,
    isWritable: account.isWritable,
    ...(role === undefined ? {} : { role }),
  };
}

function undecoded(
  index: number,
  programId: Address,
  accounts: readonly InstructionAccountInput[],
  data: InstructionInput["data"],
): DecodedInstruction {
  return {
    accounts: accounts.map((account) => decodedAccount(account, undefined)),
    decoder: "none",
    index,
    programId,
    provenance: "onchain",
    rawDataHex: toHex(data),
  };
}

/**
 * Generic i18n summary: key `ix.<program>.<instruction>`, params = every scalar argument plus
 * every named account role. The UI template picks which params to show. `null` becomes `"none"`
 * (e.g. an authority being removed) so absence is always explicit.
 */
function buildSummary(
  programKey: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
  accounts: readonly DecodedAccount[],
): { key: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  for (const account of accounts) {
    if (account.role !== undefined && !(account.role in params)) {
      params[account.role] = account.address;
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === null) {
      params[key] = "none";
    } else if (
      typeof value === "bigint" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      params[key] = value.toString();
    } else if (typeof value === "string") {
      params[key] = value;
    }
  }
  return { key: `ix.${programKey}.${name}`, params };
}

function addGap(
  context: DecodeContext,
  code: AnalysisGapCode,
  message: string,
  instructionIndex: number | undefined,
  address?: Address,
): void {
  context.gaps.push({
    code,
    message,
    ...(instructionIndex === undefined ? {} : { instructionIndex }),
    ...(address === undefined ? {} : { address }),
  });
}

function dedupeGaps(gaps: readonly AnalysisGap[]): AnalysisGap[] {
  const seen = new Set<string>();
  return gaps.filter((gap) => {
    const key = `${gap.code}|${gap.instructionIndex ?? ""}|${gap.address ?? ""}|${gap.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isUnknownInstructionError(error: unknown): boolean {
  if (error instanceof DecodeError) {
    return error.code === "INVALID_TAG";
  }
  return (
    isSolanaError(error, SOLANA_ERROR__PROGRAM_CLIENTS__FAILED_TO_IDENTIFY_INSTRUCTION) ||
    isSolanaError(error, SOLANA_ERROR__PROGRAM_CLIENTS__UNRECOGNIZED_INSTRUCTION_TYPE)
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
