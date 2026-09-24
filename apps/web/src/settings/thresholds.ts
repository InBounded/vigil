import { parseDecimalAmount } from "../lib/amounts.js";

/**
 * Assets the user can set an absolute large-transfer threshold for, typed in their own units.
 * USDC and USDT are resolved to their mint on the analysed network through core's token registry
 * (mainnet only: the registry lists no devnet mints), SOL to lamports.
 */
export const THRESHOLD_ASSETS = ["SOL", "USDC", "USDT"] as const;
export type ThresholdAsset = (typeof THRESHOLD_ASSETS)[number];

/** Decimals of each asset: SOL 9 (lamports); USDC and USDT 6 (checked against the registry by a test). */
export const THRESHOLD_DECIMALS: Readonly<Record<ThresholdAsset, number>> = {
  SOL: 9,
  USDC: 6,
  USDT: 6,
};

/** `""` → no threshold (`null`); a valid amount → base units; anything else → `undefined`. */
export function parseAmountSetting(asset: ThresholdAsset, text: string): bigint | null | undefined {
  if (text.trim() === "") {
    return null;
  }
  return parseDecimalAmount(text, THRESHOLD_DECIMALS[asset]);
}
