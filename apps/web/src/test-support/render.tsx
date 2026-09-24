import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { EnvironmentContext } from "../env/context.js";
import type { WebEnvironment } from "../env/environment.js";
import { SettingsProvider } from "../settings/context.js";

/** Renders `ui` with the app's providers around it. */
export function renderWith(ui: ReactNode, environment: WebEnvironment) {
  return render(
    <EnvironmentContext value={environment}>
      <SettingsProvider>{ui}</SettingsProvider>
    </EnvironmentContext>,
  );
}
