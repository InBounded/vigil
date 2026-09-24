import { DEFAULT_SETTINGS, type Settings, validateSettings } from "./settings.js";

const SETTINGS_KEY = "vigil.settings";

export interface SettingsStore {
  load(): Settings;
  /** `false` when the browser refused to store (private mode, quota, blocked storage). */
  save(settings: Settings): boolean;
  /** Removes everything this store wrote. */
  clear(): void;
  /** Whether RPC endpoints are written to storage (not in the offline file; see below). */
  readonly persistsRpc: boolean;
}

/**
 * Settings in `localStorage`, only ever under Vigil's own key (never `localStorage.clear()`: on a
 * shared origin such as a GitHub Pages user site it would wipe other pages' data). Every access is
 * guarded: a browser that blocks storage gets defaults and in-memory settings.
 *
 * With `persistRpc: false` (the offline file) RPC endpoints are never written: a page opened from
 * disk shares its storage with every other local file opened in the same browser, and an endpoint
 * may contain an API key.
 */
export function browserSettingsStore(
  storage: Storage | undefined,
  options: { readonly persistRpc: boolean },
): SettingsStore {
  return {
    clear() {
      try {
        storage?.removeItem(SETTINGS_KEY);
      } catch {
        // Nothing stored, or storage blocked: nothing to remove.
      }
    },
    load() {
      try {
        const text = storage?.getItem(SETTINGS_KEY);
        return text === null || text === undefined
          ? DEFAULT_SETTINGS
          : validateSettings(JSON.parse(text));
      } catch {
        return DEFAULT_SETTINGS;
      }
    },
    persistsRpc: options.persistRpc,
    save(settings) {
      const stored = options.persistRpc
        ? settings
        : {
            ...settings,
            crossCheckRpc: DEFAULT_SETTINGS.crossCheckRpc,
            rpc: DEFAULT_SETTINGS.rpc,
          };
      try {
        if (storage === undefined) {
          return false;
        }
        storage.setItem(SETTINGS_KEY, JSON.stringify(stored));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The browser's `localStorage`, or `undefined` where even reading the property throws. */
export function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
