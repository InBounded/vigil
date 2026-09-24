import type { Address } from "@solana/kit";
import {
  type AnalysisDependencies,
  type AnalysisOptions,
  type AnalysisStep,
  type AssetId,
  REGISTRY_TOKENS,
  rpcHostOf,
  type VerificationCache,
} from "@vigil-sol/core";
import type { AnalysisEnvironment } from "../env/environment.js";
import type { WebCluster } from "../lib/routes.js";
import type { Settings } from "../settings/settings.js";
import { parseAmountSetting, THRESHOLD_ASSETS } from "../settings/thresholds.js";

/** The analysis options a user's settings stand for, on one network. */
export function analysisOptions(
  settings: Settings,
  cluster: WebCluster,
  onProgress?: (step: AnalysisStep) => void,
): AnalysisOptions {
  const known = new Map<Address, string>(
    settings.knownAddresses.map((entry) => [entry.address, entry.label]),
  );
  const absolute = new Map<AssetId, bigint>();
  for (const asset of THRESHOLD_ASSETS) {
    const amount = parseAmountSetting(asset, settings.largeTransferAbsolute[asset]);
    if (amount === null || amount === undefined) {
      continue;
    }
    if (asset === "SOL") {
      absolute.set("SOL", amount);
      continue;
    }
    // USDC / USDT: the mint on this network, from core's registry (none listed on devnet).
    const token = REGISTRY_TOKENS.find((t) => t.symbol === asset && t.cluster === cluster);
    if (token !== undefined) {
      absolute.set(token.address, amount);
    }
  }
  return {
    ...(onProgress === undefined ? {} : { onProgress }),
    rules: {
      historyDepth: settings.historyDepth,
      knownAddresses: known,
      largeTransferAbsolute: absolute,
      largeTransferPercent: settings.largeTransferPercent,
    },
    simulate: true,
    userLabels: known,
    verification: settings.verification,
  };
}

/** Dependencies of one analysis (or one list of analyses sharing a verification cache). */
export function analysisDependencies(
  environment: AnalysisEnvironment,
  endpoints: { readonly url: string; readonly crossCheckUrl?: string },
  verificationCache?: VerificationCache,
): AnalysisDependencies {
  return {
    clock: environment.clock,
    http: environment.createHttp(),
    rpc: environment.createRpc(endpoints.url),
    rpcHost: rpcHostOf(endpoints.url),
    ...(endpoints.crossCheckUrl === undefined
      ? {}
      : { crossCheckRpc: environment.createRpc(endpoints.crossCheckUrl) }),
    ...(environment.idlCache === undefined ? {} : { idlCache: environment.idlCache }),
    ...(verificationCache === undefined ? {} : { verificationCache }),
  };
}
