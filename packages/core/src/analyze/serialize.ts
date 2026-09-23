import type { AnalysisReport } from "../report.js";

/**
 * The report as JSON, deterministically: object keys sorted, `bigint` as decimal strings,
 * `undefined` fields left out, byte arrays as lower-case hex. The same report always gives the same
 * text, so reports can be compared and snapshotted. Shape: `docs/report.schema.json`.
 */
export function serializeReport(report: AnalysisReport, indent = 2): string {
  return JSON.stringify(toJsonValue(report), null, indent);
}

/** The report as plain JSON data (what `serializeReport` writes). */
export function reportToJson(report: AnalysisReport): unknown {
  return toJsonValue(report);
}

/** Any value as JSON with the same rules as `serializeReport` (sorted keys, bigint as strings). */
export function toStableJson(value: unknown, indent = 2): string {
  return JSON.stringify(toJsonValue(value), null, indent);
}

function toJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : toJsonValue(item)));
  }
  if (value instanceof Map) {
    return toJsonValue(Object.fromEntries(value));
  }
  if (value instanceof Set) {
    return toJsonValue([...value]);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined && typeof inner !== "function") {
        out[key] = toJsonValue(inner);
      }
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  return value;
}
