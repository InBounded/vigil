import { sanitizeOnchainString } from "../sanitize/sanitize.js";

/** Maintainer decision (Phase 5): at most 200 log lines of at most 512 characters. */
export const MAX_LOG_LINES = 200;

export interface SanitizedLogs {
  readonly lines: readonly string[];
  /** Lines were dropped, or a line was cut to 512 characters. */
  readonly truncated: boolean;
  readonly totalLines: number;
}

/**
 * Program logs are written by the programs being simulated, i.e. by whoever wrote the proposal's
 * programs: hostile text. Every line goes through the sanitizer (which also cuts it to 512 code
 * points) and only the first 200 are kept.
 */
export function sanitizeLogs(logs: readonly string[] | null): SanitizedLogs {
  const all = logs ?? [];
  let truncated = all.length > MAX_LOG_LINES;
  const lines = all.slice(0, MAX_LOG_LINES).map((line) => {
    const clean = sanitizeOnchainString(typeof line === "string" ? line : String(line), "text");
    if (clean.flags.includes("truncated")) {
      truncated = true;
    }
    return clean.text;
  });
  return { lines, totalLines: all.length, truncated };
}
