import { type Address, isAddress } from "@solana/kit";
import type { Cluster } from "../rpc/types.js";
import programsJson from "./programs.json" with { type: "json" };
import tokensJson from "./tokens.json" with { type: "json" };

/**
 * Curated, hand-confirmed registry (see `source` on every entry and `docs/DECISIONS.md`). It is the
 * only thing that may name a token or program authoritatively; on-chain metadata is only ever shown
 * as a "declared name" next to the mint address.
 */

export interface RegistryProgram {
  readonly address: Address;
  readonly name: string;
  readonly source: string;
}

export interface RegistryToken {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly tokenProgram: Address;
  readonly cluster: Exclude<Cluster, "unknown">;
  readonly source: string;
}

export class RegistryError extends Error {
  readonly code = "INVALID_REGISTRY";
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

function asAddress(value: unknown, where: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new RegistryError(`${where}: not a valid address`);
  }
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") {
    throw new RegistryError(`${where}: expected a non-empty string`);
  }
  return value;
}

function loadPrograms(): readonly RegistryProgram[] {
  return programsJson.programs.map((entry, i) => ({
    address: asAddress(entry.address, `programs.json #${i}`),
    name: asString(entry.name, `programs.json #${i} name`),
    source: asString(entry.source, `programs.json #${i} source`),
  }));
}

function loadTokens(): readonly RegistryToken[] {
  return tokensJson.tokens.map((entry, i) => {
    const where = `tokens.json #${i}`;
    if (!Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 255) {
      throw new RegistryError(`${where}: decimals must be a u8`);
    }
    if (entry.cluster !== "mainnet" && entry.cluster !== "devnet" && entry.cluster !== "testnet") {
      throw new RegistryError(`${where}: unknown cluster`);
    }
    return {
      address: asAddress(entry.address, where),
      cluster: entry.cluster,
      decimals: entry.decimals,
      name: asString(entry.name, `${where} name`),
      source: asString(entry.source, `${where} source`),
      symbol: asString(entry.symbol, `${where} symbol`),
      tokenProgram: asAddress(entry.tokenProgram, `${where} tokenProgram`),
    };
  });
}

export const REGISTRY_PROGRAMS: readonly RegistryProgram[] = loadPrograms();
export const REGISTRY_TOKENS: readonly RegistryToken[] = loadTokens();

const programsByAddress = new Map(REGISTRY_PROGRAMS.map((p) => [p.address, p] as const));

export function findRegistryProgram(address: Address): RegistryProgram | undefined {
  return programsByAddress.get(address);
}

/** Tokens are cluster-specific: the same mint address means nothing on another cluster. */
export function findRegistryToken(address: Address, cluster: Cluster): RegistryToken | undefined {
  return REGISTRY_TOKENS.find((token) => token.address === address && token.cluster === cluster);
}
