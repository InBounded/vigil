import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useEnvironment } from "../env/context.js";
import { DEFAULT_SETTINGS, type Settings } from "./settings.js";

interface SettingsState {
  readonly settings: Settings;
  /** Applies new settings for this page and stores them; `false` if storing failed. */
  readonly update: (settings: Settings) => boolean;
  /** Back to defaults (after "Delete all local data"). */
  readonly reset: () => void;
}

const SettingsContext = createContext<SettingsState | undefined>(undefined);

export function SettingsProvider({ children }: { readonly children: ReactNode }) {
  const { settingsStore } = useEnvironment();
  const [settings, setSettings] = useState<Settings>(() => settingsStore.load());
  const update = useCallback(
    (next: Settings) => {
      setSettings(next);
      return settingsStore.save(next);
    },
    [settingsStore],
  );
  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);
  const value = useMemo(() => ({ reset, settings, update }), [reset, settings, update]);
  return <SettingsContext value={value}>{children}</SettingsContext>;
}

export function useSettings(): SettingsState {
  const state = useContext(SettingsContext);
  if (state === undefined) {
    throw new Error("useSettings outside SettingsProvider");
  }
  return state;
}
