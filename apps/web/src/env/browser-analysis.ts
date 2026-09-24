import { FetchHttpClient, KitRpcClient, systemClock } from "@vigil-sol/core";
import { IndexedDbIdlCache } from "../idl-cache.js";
import type { AnalysisEnvironment } from "./environment.js";

/** Live endpoints and the IndexedDB IDL cache. A separate chunk, loaded by the first analysis. */
export function browserAnalysisEnvironment(): AnalysisEnvironment & {
  deleteCache(): Promise<boolean>;
} {
  const idlCache = new IndexedDbIdlCache();
  return {
    clock: systemClock,
    createHttp: () => new FetchHttpClient(),
    createRpc: (url) => new KitRpcClient(url),
    deleteCache: () => idlCache.deleteAll(),
    idlCache,
  };
}
