import type { Address } from "@solana/kit";

export interface ExplorerLinks {
  readonly explorer: string;
  readonly solscan: string;
}

/**
 * Links to public explorers for the network the data came from (links only: the app never calls
 * their APIs; the page opens them with `rel="noopener noreferrer"`). None for an unknown network:
 * a link to the wrong network would show a different account.
 */
export function explorerLinks(address: Address, cluster: string): ExplorerLinks | undefined {
  const query =
    cluster === "mainnet"
      ? ""
      : cluster === "devnet" || cluster === "testnet"
        ? `?cluster=${cluster}`
        : undefined;
  if (query === undefined) {
    return undefined;
  }
  return {
    explorer: `https://explorer.solana.com/address/${address}${query}`,
    solscan: `https://solscan.io/account/${address}${query}`,
  };
}
