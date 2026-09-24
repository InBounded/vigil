import { browserSettingsStore, browserStorage } from "../settings/storage.js";
import type { AnalysisEnvironment, WebEnvironment } from "./environment.js";

/**
 * The real environment: localStorage, the clipboard, and (lazily) live RPC/HTTP and IndexedDB.
 * `build` defaults to the one this bundle was built as; tests pass it to cover each build.
 */
export function browserEnvironment(
  build: WebEnvironment["build"] = __VIGIL_BUILD__,
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
    settingsStore,
  };
}
