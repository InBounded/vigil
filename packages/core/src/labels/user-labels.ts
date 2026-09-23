import { type Address, isAddress } from "@solana/kit";
import { type SanitizeFlag, sanitizeOnchainString } from "../sanitize/sanitize.js";

/**
 * User-defined address labels, importable and exportable as JSON:
 *
 * ```json
 * { "format": "vigil-labels", "version": 1,
 *   "labels": [{ "address": "<base58>", "label": "Treasury cold wallet" }] }
 * ```
 *
 * A label file may come from anyone, so it is treated like on-chain data: size-capped, parsed with
 * `JSON.parse` only, every label sanitized as a name. Invalid entries are skipped and reported, never
 * silently dropped.
 */
export const USER_LABELS_FORMAT = "vigil-labels";
export const USER_LABELS_VERSION = 1;
export const MAX_USER_LABELS_BYTES = 1_000_000;
export const MAX_USER_LABELS = 10_000;

export type UserLabelsErrorCode = "TOO_LARGE" | "INVALID_JSON" | "INVALID_FORMAT";

export class UserLabelsError extends Error {
  readonly code: UserLabelsErrorCode;
  constructor(code: UserLabelsErrorCode, message: string) {
    super(message);
    this.name = "UserLabelsError";
    this.code = code;
  }
}

export interface UserLabelIssue {
  /** Position in the `labels` array. */
  readonly index: number;
  readonly reason:
    | "invalid-entry"
    | "invalid-address"
    | "empty-label"
    | "duplicate-address"
    | "sanitized"
    | "too-many";
  readonly flags?: readonly SanitizeFlag[];
}

export interface ParsedUserLabels {
  readonly labels: ReadonlyMap<Address, string>;
  /** Entries skipped, or kept but changed/flagged by the sanitizer. */
  readonly issues: readonly UserLabelIssue[];
}

export function parseUserLabels(json: string): ParsedUserLabels {
  if (new TextEncoder().encode(json).length > MAX_USER_LABELS_BYTES) {
    throw new UserLabelsError(
      "TOO_LARGE",
      `label files are limited to ${MAX_USER_LABELS_BYTES} bytes`,
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    throw new UserLabelsError("INVALID_JSON", "the label file is not valid JSON");
  }
  if (
    typeof document !== "object" ||
    document === null ||
    !("format" in document) ||
    document.format !== USER_LABELS_FORMAT ||
    !("version" in document) ||
    document.version !== USER_LABELS_VERSION ||
    !("labels" in document) ||
    !Array.isArray(document.labels)
  ) {
    throw new UserLabelsError(
      "INVALID_FORMAT",
      `expected { "format": "${USER_LABELS_FORMAT}", "version": ${USER_LABELS_VERSION}, "labels": [...] }`,
    );
  }

  const entries: unknown[] = document.labels;
  const labels = new Map<Address, string>();
  const issues: UserLabelIssue[] = [];
  entries.forEach((entry, index) => {
    if (index >= MAX_USER_LABELS) {
      issues.push({ index, reason: "too-many" });
      return;
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("address" in entry) ||
      !("label" in entry) ||
      typeof entry.address !== "string" ||
      typeof entry.label !== "string"
    ) {
      issues.push({ index, reason: "invalid-entry" });
      return;
    }
    if (!isAddress(entry.address)) {
      issues.push({ index, reason: "invalid-address" });
      return;
    }
    if (labels.has(entry.address)) {
      issues.push({ index, reason: "duplicate-address" });
      return;
    }
    const label = sanitizeOnchainString(entry.label, "name");
    if (label.text.trim() === "") {
      issues.push({ index, reason: "empty-label" });
      return;
    }
    if (label.modified || label.flags.length > 0) {
      issues.push({ flags: label.flags, index, reason: "sanitized" });
    }
    labels.set(entry.address, label.text);
  });
  return { issues, labels };
}

/** Deterministic export: sorted by address, stable key order, trailing newline. */
export function serializeUserLabels(labels: ReadonlyMap<Address, string>): string {
  const sorted = [...labels.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const document = {
    format: USER_LABELS_FORMAT,
    labels: sorted.map(([address, label]) => ({ address, label })),
    version: USER_LABELS_VERSION,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
