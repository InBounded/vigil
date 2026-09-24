import { PROXY_URL } from "../analysis/endpoints.js";
import { browserSettingsStore, browserStorage } from "../settings/storage.js";
import type { AnalysisEnvironment, WebEnvironment } from "./environment.js";

/**
 * The real environment: localStorage, the clipboard, and (lazily) live RPC/HTTP and IndexedDB.
 * `build` and `proxyUrl` default to what this bundle was built with; tests pass them to cover
 * each build. The offline file never uses the proxy (its origin, `null`, is refused there).
 */
export function browserEnvironment(
  build: WebEnvironment["build"] = __VIGIL_BUILD__,
  proxyUrl: string = PROXY_URL,
): WebEnvironment {
  const settingsStore = browserSettingsStore(browserStorage(), { persistRpc: build !== "offline" });
  let analysis: Promise<AnalysisEnvironment & { deleteCache(): Promise<boolean> }> | undefined;
  const load = () => {
    analysis ??= import("./browser-analysis.js").then((module) =>
      module.browserAnalysisEnvironment(),
    );
    return analysis;
  };
  return {
    analysis: load,
    build,
    async deleteLocalData() {
      settingsStore.clear();
      return (await load()).deleteCache();
    },
    async writeClipboard(text) {
      await navigator.clipboard.writeText(text);
    },
    proxyUrl: build === "offline" ? "" : proxyUrl,
    settingsStore,
  };
}
