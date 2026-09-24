import { AnalysisError } from "@vigil-sol/core";
import type { MessageKey } from "../i18n/messages.js";
import { safeText } from "../lib/safe-text.js";

export interface ShownError {
  readonly key: MessageKey;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Why an analysis produced no report, for the page. Only `AnalysisError` messages are shown (core
 * guarantees they hold no endpoint URL); anything else is a generic message, since an unknown
 * error's text could contain the URL and its API key.
 */
export function describeError(error: unknown): ShownError {
  if (error instanceof AnalysisError) {
    switch (error.code) {
      case "RPC_FAILED":
        return { key: "error.RPC_FAILED", params: { detail: safeText(error.message) } };
      case "NOT_A_MULTISIG":
      case "TRANSACTION_NOT_FOUND":
      case "TRANSACTION_INVALID":
      case "INVALID_TRANSACTION":
        return { key: `error.${error.code}`, params: {} };
    }
  }
  return { key: "error.UNEXPECTED", params: {} };
}
