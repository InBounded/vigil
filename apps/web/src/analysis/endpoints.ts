import type { WebCluster } from "../lib/routes.js";
import type { Settings } from "../settings/settings.js";

/** The public devnet endpoint answers web pages (see docs/DECISIONS.md, Phase 7). */
export const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";

export type Endpoints =
  | { readonly ok: true; readonly url: string; readonly crossCheckUrl?: string }
  /**
   * Mainnet with no endpoint of the user's: the public mainnet endpoint refuses browser origins,
   * so there is no default (maintainer decision, docs/DECISIONS.md).
   */
  | { readonly ok: false; readonly missing: "mainnet-rpc" };

export function resolveEndpoints(settings: Settings, cluster: WebCluster): Endpoints {
  const own = settings.rpc[cluster];
  const url = own !== "" ? own : cluster === "devnet" ? PUBLIC_DEVNET_RPC : undefined;
  if (url === undefined) {
    return { missing: "mainnet-rpc", ok: false };
  }
  const cross = settings.crossCheckRpc[cluster];
  return cross === "" || sameEndpoint(cross, url)
    ? { ok: true, url }
    : { crossCheckUrl: cross, ok: true, url };
}

/** Two endpoint URLs that name the same thing (`…com` and `…com/`). */
export function sameEndpoint(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}
