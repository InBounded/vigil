import { StrictMode } from "react";
import { EnvironmentContext } from "../env/context.js";
import type { WebEnvironment } from "../env/environment.js";
import { LocaleContext } from "../i18n/locale.js";
import { SettingsProvider } from "../settings/context.js";
import { App } from "./App.js";

/** The app with its environment: the browser's in `main.tsx`, recorded fixtures in tests. */
export function Root({ environment }: { readonly environment: WebEnvironment }) {
  return (
    <StrictMode>
      <EnvironmentContext value={environment}>
        <SettingsProvider>
          <LocaleContext value="en">
            <App />
          </LocaleContext>
        </SettingsProvider>
      </EnvironmentContext>
    </StrictMode>
  );
}
