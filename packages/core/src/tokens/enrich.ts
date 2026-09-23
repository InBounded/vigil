import { type Address, getBase64Encoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "../decoders/native/token-2022.js";
import { findRegistryToken } from "../registry/index.js";
import type { AnalysisGap, DecodedInstruction } from "../report.js";
import type { Cluster, RpcClient } from "../rpc/types.js";
import { type SanitizedString, sanitizeOnchainString } from "../sanitize/sanitize.js";
import {
  findMetaplexMetadataAddress,
  type MintInfo,
  parseMetaplexMetadata,
  parseMintAccount,
  parseTokenAccount,
  type RawAccount,
  type RawDeclaredMetadata,
} from "./accounts.js";

/** What Vigil knows about a mint used by the analysed instructions. */
export interface TokenInfo {
  readonly mint: Address;
  readonly tokenProgram: Address;
  /** From the mint account (`onchain`). */
  readonly decimals: number;
  /** From Vigil's curated registry; the only authoritative name. */
  readonly registry?: { readonly symbol: string; readonly name: string };
  /**
   * Name and symbol the mint's creator declared on chain (anyone can declare anything). Only read
   * for mints not in the registry, and always shown with the mint address.
   */
  readonly declared?: {
    readonly name: SanitizedString;
    readonly symbol: SanitizedString;
    readonly source: "token-2022-metadata" | "metaplex";
  };
}

export interface TokenEnrichment {
  readonly instructions: DecodedInstruction[];
  /** Sorted by mint address. */
  readonly tokens: TokenInfo[];
  readonly gaps: AnalysisGap[];
}

/**
 * Instructions whose `amount` is in the mint's base units. For the unchecked ones the decimals are
 * not in the instruction, so they (and, for transfer/approve, the mint itself) must be read from
 * chain: the mint through the source token account's `mint` field. Both are immutable once set.
 */
const AMOUNT_INSTRUCTIONS: Readonly<Record<string, "mint" | "source">> = {
  approve: "source",
  approveChecked: "mint",
  burn: "mint",
  burnChecked: "mint",
  mintTo: "mint",
  mintToChecked: "mint",
  transfer: "source",
  transferChecked: "mint",
};

const TOKEN_PROGRAMS: ReadonlySet<Address> = new Set([
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
]);

const base64Bytes = getBase64Encoder();

interface Pending {
  readonly instruction: DecodedInstruction;
  readonly topIndex: number;
  readonly via: "mint" | "source";
  readonly address: Address;
}

/**
 * Adds `mint`, `decimals` and the token's name to the summary params of every token instruction
 * that moves an amount, so it can be shown as "250,000 USDC" rather than base units. Needs at most
 * two `getMultipleAccounts` calls (token accounts, then mints + Metaplex metadata). When the mint
 * or its decimals cannot be established the amount stays in base units and a
 * `TOKEN_DECIMALS_UNKNOWN` gap says so.
 */
export async function enrichTokenAmounts(
  rpc: RpcClient,
  instructions: readonly DecodedInstruction[],
  cluster: Cluster,
): Promise<TokenEnrichment> {
  const pending: Pending[] = [];
  collect(instructions, undefined, pending);
  const gaps: AnalysisGap[] = [];
  if (pending.length === 0) {
    return { gaps, instructions: [...instructions], tokens: [] };
  }

  let failure: string | null = null;
  const sourceMints = new Map<Address, Address | null>();
  const sources = unique(pending.filter((p) => p.via === "source").map((p) => p.address));
  if (sources.length > 0) {
    try {
      const accounts = await readAccounts(rpc, sources);
      for (const source of sources) {
        const raw = accounts.get(source);
        sourceMints.set(source, raw === undefined ? null : (parseTokenAccount(raw)?.mint ?? null));
      }
    } catch (error) {
      failure = describe(error);
    }
  }

  const mintOf = (p: Pending): Address | null =>
    p.via === "mint" ? p.address : (sourceMints.get(p.address) ?? null);
  const mints = unique(pending.map(mintOf).filter((m): m is Address => m !== null));
  const mintInfos = new Map<Address, MintInfo>();
  const metaplex = new Map<Address, RawDeclaredMetadata>();
  if (failure === null && mints.length > 0) {
    try {
      const unregistered = mints.filter((m) => findRegistryToken(m, cluster) === undefined);
      const metadataAddresses = await Promise.all(unregistered.map(findMetaplexMetadataAddress));
      const accounts = await readAccounts(rpc, [...mints, ...metadataAddresses]);
      for (const mint of mints) {
        const raw = accounts.get(mint);
        const info = raw === undefined ? null : parseMintAccount(raw);
        if (info !== null) {
          mintInfos.set(mint, info);
        }
      }
      unregistered.forEach((mint, i) => {
        const address = metadataAddresses[i];
        const raw = address === undefined ? undefined : accounts.get(address);
        const declared = raw === undefined ? null : parseMetaplexMetadata(raw, mint);
        if (declared !== null) {
          metaplex.set(mint, declared);
        }
      });
    } catch (error) {
      failure = describe(error);
    }
  }

  const tokens = new Map<Address, TokenInfo>();
  for (const [mint, info] of mintInfos) {
    tokens.set(mint, tokenInfo(mint, info, metaplex.get(mint) ?? null, cluster));
  }

  const params = new Map<DecodedInstruction, Record<string, string>>();
  for (const p of pending) {
    const mint = mintOf(p);
    const token = mint === null ? undefined : tokens.get(mint);
    const declaredDecimals = p.instruction.args?.decimals;
    const decimals = typeof declaredDecimals === "number" ? declaredDecimals : token?.decimals;
    if (mint === null || decimals === undefined) {
      gaps.push({
        address: p.address,
        code: "TOKEN_DECIMALS_UNKNOWN",
        instructionIndex: p.topIndex,
        message:
          failure !== null
            ? `token accounts could not be read (${failure}); the amount is shown in base units`
            : mint === null
              ? "the source token account could not be read, so its token and decimals are unknown; the amount is shown in base units"
              : "the mint account could not be read, so its decimals are unknown; the amount is shown in base units",
      });
    }
    params.set(p.instruction, tokenParams(mint, decimals, token));
  }

  return {
    gaps,
    instructions: rewrite(instructions, params),
    tokens: [...tokens.values()].sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0)),
  };
}

function collect(
  instructions: readonly DecodedInstruction[],
  topIndex: number | undefined,
  out: Pending[],
): void {
  for (const instruction of instructions) {
    const top = topIndex ?? instruction.index;
    const via = instruction.name === undefined ? undefined : AMOUNT_INSTRUCTIONS[instruction.name];
    if (via !== undefined && TOKEN_PROGRAMS.has(instruction.programId)) {
      const account = instruction.accounts.find((a) => a.role === via);
      if (account !== undefined) {
        out.push({ address: account.address, instruction, topIndex: top, via });
      }
    }
    if (instruction.inner !== undefined) {
      collect(instruction.inner, top, out);
    }
  }
}

async function readAccounts(
  rpc: RpcClient,
  addresses: readonly Address[],
): Promise<Map<Address, RawAccount>> {
  const { value } = await rpc.getMultipleAccounts(addresses);
  const out = new Map<Address, RawAccount>();
  addresses.forEach((address, i) => {
    const account = value[i];
    if (account != null) {
      out.set(address, { data: base64Bytes.encode(account.dataBase64), owner: account.owner });
    }
  });
  return out;
}

function tokenInfo(
  mint: Address,
  info: MintInfo,
  metaplex: RawDeclaredMetadata | null,
  cluster: Cluster,
): TokenInfo {
  const registry = findRegistryToken(mint, cluster);
  if (registry !== undefined) {
    return {
      decimals: info.decimals,
      mint,
      registry: { name: registry.name, symbol: registry.symbol },
      tokenProgram: info.tokenProgram,
    };
  }
  const declared = info.extensionMetadata ?? metaplex;
  return {
    decimals: info.decimals,
    mint,
    tokenProgram: info.tokenProgram,
    ...(declared === null
      ? {}
      : {
          declared: {
            name: sanitizeOnchainString(declared.name, "name"),
            source: info.extensionMetadata === null ? "metaplex" : "token-2022-metadata",
            symbol: sanitizeOnchainString(declared.symbol, "symbol"),
          },
        }),
  };
}

function tokenParams(
  mint: Address | null,
  decimals: number | undefined,
  token: TokenInfo | undefined,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (mint !== null) {
    params.mint = mint;
  }
  if (decimals !== undefined) {
    params.decimals = String(decimals);
  }
  if (token?.registry !== undefined) {
    params.symbol = token.registry.symbol;
  } else if (token?.declared !== undefined) {
    params.declaredName = token.declared.name.text;
    params.declaredSymbol = token.declared.symbol.text;
  }
  return params;
}

function rewrite(
  instructions: readonly DecodedInstruction[],
  params: ReadonlyMap<DecodedInstruction, Record<string, string>>,
): DecodedInstruction[] {
  return instructions.map((instruction) => {
    const extra = params.get(instruction);
    const inner = instruction.inner === undefined ? undefined : rewrite(instruction.inner, params);
    const summary =
      extra === undefined || instruction.summary === undefined
        ? instruction.summary
        : { key: instruction.summary.key, params: { ...instruction.summary.params, ...extra } };
    return {
      ...instruction,
      ...(inner === undefined ? {} : { inner }),
      ...(summary === undefined ? {} : { summary }),
    };
  });
}

function unique(addresses: readonly Address[]): Address[] {
  return [...new Set(addresses)].sort();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
