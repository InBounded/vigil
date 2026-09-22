import type { Cluster } from "./types.js";

/** Genesis hashes per `docs/reference.md` §2. */
const GENESIS_HASHES: Readonly<Record<string, Cluster>> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

/**
 * Maps a genesis hash to a known cluster. An unrecognized hash resolves to `"unknown"` rather
 * than throwing — per `AGENTS.md`, an unknown cluster must not block analysis, only be reported.
 */
export function detectCluster(genesisHash: string): Cluster {
  return GENESIS_HASHES[genesisHash] ?? "unknown";
}
