import type { Locale } from "@vigil-sol/core";
import { createContext, useContext } from "react";
import { type MessageKey, m } from "./messages.js";

export const LocaleContext = createContext<Locale>("en");

export interface Messages {
  readonly locale: Locale;
  readonly m: (key: MessageKey, params?: Readonly<Record<string, string>>) => string;
}

/** The web app's texts in the chosen language. */
export function useMessages(): Messages {
  const locale = useContext(LocaleContext);
  return { locale, m: (key, params) => m(locale, key, params) };
}
