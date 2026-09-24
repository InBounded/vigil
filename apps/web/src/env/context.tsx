import { createContext, useContext } from "react";
import type { WebEnvironment } from "./environment.js";

export const EnvironmentContext = createContext<WebEnvironment | undefined>(undefined);

export function useEnvironment(): WebEnvironment {
  const environment = useContext(EnvironmentContext);
  if (environment === undefined) {
    throw new Error("useEnvironment outside EnvironmentContext");
  }
  return environment;
}
