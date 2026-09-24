import type { Address } from "@solana/kit";
import type { Locale } from "@vigil-sol/core";
import { WEB_CLUSTERS, type WebCluster } from "../lib/routes.js";
import { safeText } from "../lib/safe-text.js";
import { parseAddress, parseRpcUrl } from "../lib/validate.js";
import { parseAmountSetting, THRESHOLD_ASSETS, type ThresholdAsset } from "./thresholds.js";

export interface KnownAddress {
  readonly address: Address;
  readonly label: string;
}

export interface Settings {
  /** Network preselected on the start page. */
  readonly cluster: WebCluster;
  /** The user's RPC endpoint per network; `""` = none (devnet then uses the public endpoint). */
  readonly rpc: Readonly<Record<WebCluster, string>>;
  /** Optional second endpoint per network, for the cross-check (VGL-C012). */
  readonly crossCheckRpc: Readonly<Record<WebCluster, string>>;
  readonly locale: Locale;
  /** `historyDepth` of the rules (0–1,000). */
  readonly historyDepth: number;
  /** `largeTransferPercent` of the rules (0 < x ≤ 100, two decimals at most). */
  readonly largeTransferPercent: number;
  /** Absolute large-transfer thresholds, as typed (in SOL / token units); `""` = none. */
  readonly largeTransferAbsolute: Readonly<Record<ThresholdAsset, string>>;
  readonly knownAddresses: readonly KnownAddress[];
  /** Ask the program-verification API (verify.osec.io). */
  readonly verification: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  cluster: "mainnet",
  crossCheckRpc: { devnet: "", mainnet: "" },
  historyDepth: 0,
  knownAddresses: [],
  largeTransferAbsolute: { SOL: "", USDC: "", USDT: "" },
  largeTransferPercent: 10,
  locale: "en",
  rpc: { devnet: "", mainnet: "" },
  verification: true,
};

export const MAX_HISTORY_DEPTH = 1000;
export const MAX_KNOWN_ADDRESSES = 10_000;
export const MAX_LABEL_LENGTH = 100;

/** A percentage with at most two decimals, above 0 and at most 100 (as core requires). */
export function isValidPercent(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value > 0 &&
    value <= 100 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-6
  );
}

/**
 * Settings read back from storage, checked field by field: anything invalid falls back to its
 * default. Storage is shared with every page of the same origin, so it is not trusted either.
 */
export function validateSettings(value: unknown): Settings {
  const input = isRecord(value) ? value : {};
  const cluster = WEB_CLUSTERS.find((c) => c === input.cluster) ?? DEFAULT_SETTINGS.cluster;
  const urls = (field: unknown): Record<WebCluster, string> => {
    const record = isRecord(field) ? field : {};
    const url = (c: WebCluster) => {
      const raw = record[c];
      return typeof raw === "string" ? (parseRpcUrl(raw) ?? "") : "";
    };
    return { devnet: url("devnet"), mainnet: url("mainnet") };
  };
  const history = input.historyDepth;
  const percent = input.largeTransferPercent;
  const absoluteInput = isRecord(input.largeTransferAbsolute) ? input.largeTransferAbsolute : {};
  const absolute = { ...DEFAULT_SETTINGS.largeTransferAbsolute };
  for (const asset of THRESHOLD_ASSETS) {
    const raw = absoluteInput[asset];
    if (typeof raw === "string" && parseAmountSetting(asset, raw) !== undefined) {
      absolute[asset] = raw.trim();
    }
  }
  return {
    cluster,
    crossCheckRpc: urls(input.crossCheckRpc),
    historyDepth:
      typeof history === "number" &&
      Number.isInteger(history) &&
      history >= 0 &&
      history <= MAX_HISTORY_DEPTH
        ? history
        : DEFAULT_SETTINGS.historyDepth,
    knownAddresses: validateKnownAddresses(input.knownAddresses),
    largeTransferAbsolute: absolute,
    largeTransferPercent:
      typeof percent === "number" && isValidPercent(percent)
        ? percent
        : DEFAULT_SETTINGS.largeTransferPercent,
    locale: "en",
    rpc: urls(input.rpc),
    verification: typeof input.verification === "boolean" ? input.verification : true,
  };
}

function validateKnownAddresses(value: unknown): KnownAddress[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const out: KnownAddress[] = [];
  for (const entry of value.slice(0, MAX_KNOWN_ADDRESSES)) {
    if (!isRecord(entry) || typeof entry.address !== "string" || typeof entry.label !== "string") {
      continue;
    }
    const address = parseAddress(entry.address);
    const label = cleanLabel(entry.label);
    if (address === undefined || label === "" || seen.has(address)) {
      continue;
    }
    seen.add(address);
    out.push({ address, label });
  }
  return out;
}

/** A user label as stored and shown: invisible characters removed, trimmed, length-capped. */
export function cleanLabel(label: string): string {
  return safeText(label).replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
