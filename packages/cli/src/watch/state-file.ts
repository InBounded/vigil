import { join } from "node:path";
import {
  parseWatchState,
  type Verdict,
  WatchError,
  type WatchState,
  watchStateToJson,
} from "@vigil-sol/core";
import type { Alert } from "./alert.js";
import type { NotifierId } from "./notifiers.js";

/** Reads and writes the watcher's state file. Injected so tests can use a temporary directory. */
export interface StateFiles {
  /** The file's text, or `undefined` when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Writes atomically (temporary file + rename), creating the directory (0700) and file (0600). */
  write(path: string, text: string): Promise<void>;
}

/** An alert not yet delivered to every notifier. */
export interface OutboxItem {
  readonly alert: Alert;
  /** Notifiers still to deliver to. */
  readonly pending: readonly NotifierId[];
  /** When the alert was first queued (ISO 8601); it is dropped 24 hours later. */
  readonly queuedAt: string;
}

export interface WatchFile {
  readonly watch: WatchState | undefined;
  /** Last analysis verdict per tracked transaction index, for later status-change alerts. */
  readonly verdicts: Readonly<Record<string, Verdict>>;
  readonly outbox: readonly OutboxItem[];
}

export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const FORMAT = "vigil-watch-state";
const NOTIFIERS: readonly NotifierId[] = ["discord", "telegram", "stdout"];
const VERDICTS: readonly Verdict[] = ["critical", "incomplete", "attention", "no-findings"];

/**
 * `$XDG_STATE_HOME/vigil/<multisig>.json`, else `~/.local/state/vigil/<multisig>.json` (the XDG
 * Base Directory default for `XDG_STATE_HOME`). A relative `XDG_STATE_HOME` is invalid per the
 * specification and ignored.
 */
export function defaultStatePath(
  env: Readonly<Record<string, string | undefined>>,
  home: string | undefined,
  multisig: string,
): string | undefined {
  const xdg = env.XDG_STATE_HOME;
  if (xdg?.startsWith("/")) {
    return join(xdg, "vigil", `${multisig}.json`);
  }
  return home === undefined || home === ""
    ? undefined
    : join(home, ".local", "state", "vigil", `${multisig}.json`);
}

export function serializeWatchFile(file: WatchFile): string {
  return `${JSON.stringify(
    {
      format: FORMAT,
      outbox: file.outbox,
      verdicts: file.verdicts,
      version: 1,
      watch: file.watch === undefined ? null : watchStateToJson(file.watch),
    },
    null,
    2,
  )}\n`;
}

/** Reads a state file back, refusing anything malformed (`WatchError` `STATE_INVALID`). */
export function parseWatchFile(text: string): WatchFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid("not JSON");
  }
  const record = asRecord(value);
  if (record === undefined || record.format !== FORMAT || record.version !== 1) {
    throw invalid("not a Vigil watch state file of a supported version");
  }
  const watch = record.watch === null ? undefined : parseWatchState(record.watch);
  const verdictsRecord = asRecord(record.verdicts);
  if (verdictsRecord === undefined) {
    throw invalid("verdicts is not an object");
  }
  const verdicts: Record<string, Verdict> = {};
  for (const [index, verdict] of Object.entries(verdictsRecord)) {
    if (!/^[1-9][0-9]*$/.test(index) || !(VERDICTS as readonly unknown[]).includes(verdict)) {
      throw invalid("a verdict entry is malformed");
    }
    verdicts[index] = verdict as Verdict;
  }
  if (!Array.isArray(record.outbox)) {
    throw invalid("outbox is not a list");
  }
  const outbox = record.outbox.map((item: unknown) => parseOutboxItem(item));
  return { outbox, verdicts, watch };
}

function parseOutboxItem(value: unknown): OutboxItem {
  const record = asRecord(value);
  const alert = asRecord(record?.alert);
  if (record === undefined || alert === undefined) {
    throw invalid("an outbox entry is malformed");
  }
  const pending = record.pending;
  if (
    !Array.isArray(pending) ||
    !pending.every((id) => (NOTIFIERS as readonly unknown[]).includes(id)) ||
    typeof record.queuedAt !== "string" ||
    Number.isNaN(Date.parse(record.queuedAt))
  ) {
    throw invalid("an outbox entry is malformed");
  }
  return {
    alert: parseAlert(alert),
    pending: pending as NotifierId[],
    queuedAt: record.queuedAt,
  };
}

const SEVERITIES: readonly unknown[] = ["critical", "warning", "info"];

/** A queued alert, field by field: it is formatted and sent again on a later cycle. */
function parseAlert(alert: Record<string, unknown>): Alert {
  const str = (value: unknown): value is string => typeof value === "string";
  const strOrNull = (value: unknown): value is string | null => value === null || str(value);
  const status = asRecord(alert.status);
  const findings = Array.isArray(alert.findings) ? alert.findings.map(asRecord) : undefined;
  const ok =
    alert.schemaVersion === 1 &&
    str(alert.id) &&
    (alert.event === "new-proposal" || alert.event === "status-change") &&
    str(alert.multisig) &&
    str(alert.cluster) &&
    str(alert.rpcHost) &&
    str(alert.transactionIndex) &&
    strOrNull(alert.transactionKind) &&
    status !== undefined &&
    str(status.to) &&
    (status.from === undefined || str(status.from)) &&
    typeof alert.initial === "boolean" &&
    typeof alert.isStale === "boolean" &&
    (alert.verdict === null || (VERDICTS as readonly unknown[]).includes(alert.verdict)) &&
    (alert.verdictSource === "analysis" ||
      alert.verdictSource === "last-known" ||
      alert.verdictSource === "none") &&
    strOrNull(alert.analysisError) &&
    strOrNull(alert.executableAfter) &&
    strOrNull(alert.timeLock) &&
    findings?.every(
      (f) => f !== undefined && str(f.ruleId) && str(f.title) && SEVERITIES.includes(f.severity),
    ) &&
    Number.isSafeInteger(alert.findingsTotal) &&
    Array.isArray(alert.instructions) &&
    alert.instructions.every(str) &&
    Number.isSafeInteger(alert.instructionsTotal) &&
    strOrNull(alert.contextSlot) &&
    strOrNull(alert.permalink) &&
    str(alert.detectedAt);
  if (!ok) {
    throw invalid("a queued alert is malformed");
  }
  // Every field was checked above.
  return alert as unknown as Alert;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function invalid(detail: string): WatchError {
  return new WatchError("STATE_INVALID", `the watch state file is not valid: ${detail}`);
}
