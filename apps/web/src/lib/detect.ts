import type { Route, WebCluster } from "./routes.js";
import { parseAddress, parseBase64Transaction } from "./validate.js";

export type Detected =
  | { readonly ok: true; readonly route: Route }
  | { readonly ok: false; readonly reason: "empty" | "invalid" | "too-long" };

/**
 * What the start page's single field holds: a multisig address (checked first: an address is
 * never a plausible transaction, which is at least ~100 base64 characters) or a base64 transaction.
 */
export function detectInput(text: string, cluster: WebCluster): Detected {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty" };
  }
  const multisig = parseAddress(trimmed);
  if (multisig !== undefined) {
    return { ok: true, route: { cluster, multisig, name: "multisig" } };
  }
  const check = parseBase64Transaction(trimmed);
  if (check.ok) {
    return { ok: true, route: { base64: check.base64, cluster, name: "transaction" } };
  }
  return { ok: false, reason: check.reason };
}
