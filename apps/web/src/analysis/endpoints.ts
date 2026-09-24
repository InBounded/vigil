import type { WebCluster } from "../lib/routes.js";
import type { Settings } from "../settings/settings.js";

/** The public devnet endpoint answers web pages (see docs/DECISIONS.md, Phase 7). */
export const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";

/**
 * The Vigil RPC proxy (`apps/rpc-proxy`, mainnet only) this build was made for, from
 * `VIGIL_PROXY_URL` at build time; `""` = none. Always `""` in the offline file: a page opened from
 * disk has the origin `null`, which the proxy refuses.
 */
export const PROXY_URL: string = __VIGIL_PROXY_URL__;

/** Where the RPC endpoint in use comes from, shown on the page. */
export type RpcSource = "own" | "proxy" | "public";

export interface ChosenRpc {
  readonly url: string;
  readonly source: RpcSource;
}

/**
 * The endpoint for one network, in order: the user's own → the Vigil proxy (mainnet only) → the
 * network's public endpoint (devnet only: the public mainnet endpoint refuses web pages).
 */
export function chooseRpc(
  settings: Settings,
  cluster: WebCluster,
  proxyUrl: string = PROXY_URL,
): ChosenRpc | undefined {
  const own = settings.rpc[cluster];
  if (own !== "") {
    return { source: "own", url: own };
  }
  if (cluster === "mainnet") {
    return proxyUrl === "" ? undefined : { source: "proxy", url: proxyUrl };
  }
  return { source: "public", url: PUBLIC_DEVNET_RPC };
}

export type Endpoints =
  | { readonly ok: true; readonly url: string; readonly crossCheckUrl?: string }
  /**
   * Mainnet with no endpoint of the user's and no proxy in this build: the public mainnet endpoint
   * refuses browser origins, so there is no default (maintainer decision, docs/DECISIONS.md).
   */
  | { readonly ok: false; readonly missing: "mainnet-rpc" };

export function resolveEndpoints(
  settings: Settings,
  cluster: WebCluster,
  proxyUrl: string = PROXY_URL,
): Endpoints {
  const chosen = chooseRpc(settings, cluster, proxyUrl);
  if (chosen === undefined) {
    return { missing: "mainnet-rpc", ok: false };
  }
  const url = chosen.url;
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
