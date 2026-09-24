import { type Address, isAddress } from "@solana/kit";

/** Largest u64: Squads transaction indices are u64. */
const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * The encoding of 4,096 bytes (the v1 transaction limit), as `MAX_RAW_TRANSACTION_BASE64_LENGTH`
 * in core. Repeated here so the start page does not load the analysis engine; a test checks both
 * stay equal.
 */
export const MAX_BASE64_LENGTH = 4 * Math.ceil(4096 / 3);

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function parseAddress(text: string): Address | undefined {
  return BASE58.test(text) && isAddress(text) ? text : undefined;
}

/** A transaction index: a positive decimal integer (no sign, no leading zero) up to u64::MAX. */
export function parseIndex(text: string): bigint | undefined {
  if (!/^[1-9][0-9]{0,19}$/.test(text)) {
    return undefined;
  }
  const value = BigInt(text);
  return value <= U64_MAX ? value : undefined;
}

export type Base64Check =
  | { readonly ok: true; readonly base64: string }
  | { readonly ok: false; readonly reason: "invalid" | "too-long" };

/** Standard base64 with padding; whitespace (line breaks from copying) is ignored. */
export function parseBase64Transaction(text: string): Base64Check {
  const base64 = text.replace(/\s+/g, "");
  if (base64.length === 0 || !BASE64.test(base64)) {
    return { ok: false, reason: "invalid" };
  }
  if (base64.length > MAX_BASE64_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return { base64, ok: true };
}

/**
 * An RPC endpoint the user typed: `https:` only (the page's CSP allows nothing else) and no user
 * name or password. A path or query is allowed: providers put the API key there. Returns the
 * normalised URL, or `undefined`.
 */
export function parseRpcUrl(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.host === "") {
    return undefined;
  }
  return url.href;
}
