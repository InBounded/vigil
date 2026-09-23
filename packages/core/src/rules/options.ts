import type { ResolvedRuleOptions, RuleOptions } from "./types.js";

export const DEFAULT_RULE_OPTIONS = {
  historyDepth: 0,
  largeTransferPercent: 10,
} as const;

/** Largest `historyDepth` accepted (`getSignaturesForAddress` returns at most 1,000 per call). */
export const MAX_HISTORY_DEPTH = 1000;

export class RuleOptionsError extends Error {
  readonly code = "INVALID_RULE_OPTIONS";
  constructor(message: string) {
    super(message);
    this.name = "RuleOptionsError";
  }
}

/** Validates options and fills in defaults. Throws `RuleOptionsError` on an invalid value. */
export function resolveRuleOptions(options: RuleOptions = {}): ResolvedRuleOptions {
  const percent = options.largeTransferPercent ?? DEFAULT_RULE_OPTIONS.largeTransferPercent;
  const basisPoints = Math.round(percent * 100);
  if (
    !Number.isFinite(percent) ||
    percent <= 0 ||
    percent > 100 ||
    Math.abs(percent * 100 - basisPoints) > 1e-6
  ) {
    throw new RuleOptionsError(
      "largeTransferPercent must be a number above 0 and at most 100, with at most two decimals",
    );
  }
  const historyDepth = options.historyDepth ?? DEFAULT_RULE_OPTIONS.historyDepth;
  if (!Number.isInteger(historyDepth) || historyDepth < 0 || historyDepth > MAX_HISTORY_DEPTH) {
    throw new RuleOptionsError(`historyDepth must be an integer from 0 to ${MAX_HISTORY_DEPTH}`);
  }
  const absolute = options.largeTransferAbsolute ?? new Map();
  for (const [asset, amount] of absolute) {
    if (amount <= 0n) {
      throw new RuleOptionsError(`largeTransferAbsolute for ${asset} must be above 0`);
    }
  }
  return {
    historyDepth,
    knownAddresses: options.knownAddresses ?? new Map(),
    largeTransferAbsolute: absolute,
    largeTransferBasisPoints: BigInt(basisPoints),
  };
}
