/**
 * Every RPC method allowed anywhere in this project, per `docs/reference.md` §4. Sending methods
 * (e.g. `sendTransaction`) and expensive/unbounded methods (e.g. `getProgramAccounts`) are never
 * allowed, no matter how convenient. `simulateTransaction` is only ever called with
 * `sigVerify: false`.
 *
 * This module has no imports on purpose: the RPC proxy (`apps/rpc-proxy`) imports it through the
 * `@vigil-sol/core/rpc-allowlist` subpath, so its bundle holds this list and nothing else.
 */
export const ALLOWED_RPC_METHODS = [
  "getAccountInfo",
  "getMultipleAccounts",
  "getGenesisHash",
  "getSlot",
  "getSignaturesForAddress",
  "getTransaction",
  "simulateTransaction",
] as const;

export type AllowedRpcMethod = (typeof ALLOWED_RPC_METHODS)[number];

export function isAllowedRpcMethod(method: string): method is AllowedRpcMethod {
  return (ALLOWED_RPC_METHODS as readonly string[]).includes(method);
}
