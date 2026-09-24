import type { Clock, HttpClient, IdlCache, RpcClient } from "@vigil-sol/core";
import type { SettingsStore } from "../settings/storage.js";

/** What analyses read through. The browser's is loaded on first use (`WebEnvironment.analysis`). */
export interface AnalysisEnvironment {
  readonly createRpc: (url: string) => RpcClient;
  readonly createHttp: () => HttpClient;
  readonly clock: Clock;
  readonly idlCache?: IdlCache;
}

/**
 * Everything outside the page the app touches, injected so every screen runs in tests against
 * real captured fixtures. Nothing else performs I/O.
 */
export interface WebEnvironment {
  readonly settingsStore: SettingsStore;
  readonly writeClipboard: (text: string) => Promise<void>;
  /** Deletes settings and cached program interfaces. Resolves `false` if something remained. */
  readonly deleteLocalData: () => Promise<boolean>;
  /** Loaded on first use, so the start page never downloads the analysis engine. */
  readonly analysis: () => Promise<AnalysisEnvironment>;
  readonly build: "hosted" | "ghpages" | "offline";
}
