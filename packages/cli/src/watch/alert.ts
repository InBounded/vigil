import {
  type AnalysisReport,
  type Finding,
  formatDuration,
  type Locale,
  renderConfigAction,
  renderFinding,
  renderSummary,
  type Severity,
  type Verdict,
  type WatchEvent,
} from "@vigil-sol/core";
import { core, isMessageKey, m } from "../messages.js";
import { terminalSafe } from "../terminal.js";

export const MAX_ALERT_FINDINGS = 3;
export const MAX_ALERT_INSTRUCTIONS = 5;

/**
 * One alert, as queued in the state file and sent to every notifier. Every text in it was
 * rendered by core's catalogs from sanitized data and passed through `terminalSafe`; it never
 * holds an RPC URL (only the host).
 */
export interface Alert {
  readonly schemaVersion: 1;
  /** Stable identity: the same event always gets the same id. */
  readonly id: string;
  readonly event: "new-proposal" | "status-change";
  readonly multisig: string;
  readonly cluster: string;
  readonly rpcHost: string;
  readonly transactionIndex: string;
  readonly transactionKind: string | null;
  /** `from` only on a status change. Statuses: Squads names, `NoProposal` or `Closed`. */
  readonly status: { readonly from?: string; readonly to: string };
  /** A proposal that was already pending when watching started. */
  readonly initial: boolean;
  readonly isStale: boolean;
  /** From this cycle's analysis (`analysis`), the last analysis (`last-known`), or none. */
  readonly verdict: Verdict | null;
  readonly verdictSource: "analysis" | "last-known" | "none";
  /** Why the analysis failed, when it did. */
  readonly analysisError: string | null;
  /** Approved with a time lock: when execution becomes possible (ISO 8601). */
  readonly executableAfter: string | null;
  readonly timeLock: string | null;
  readonly findings: readonly {
    readonly ruleId: string;
    readonly severity: Severity;
    readonly title: string;
  }[];
  readonly findingsTotal: number;
  readonly instructions: readonly string[];
  readonly instructionsTotal: number;
  readonly contextSlot: string | null;
  readonly permalink: string | null;
  readonly detectedAt: string;
}

export interface AlertContext {
  readonly multisig: string;
  readonly cluster: string;
  readonly rpcHost: string;
  readonly timeLockSeconds: number;
  readonly webUrl: string | undefined;
  readonly detectedAt: string;
  readonly locale: Locale;
}

export type AlertAnalysis =
  | { readonly kind: "report"; readonly report: AnalysisReport }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "last-known"; readonly verdict: Verdict | undefined };

const FULL = { addresses: "full" } as const;
const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { critical: 0, info: 2, warning: 1 };

/** The event's identity: one alert per event, whatever happens to delivery. */
export function alertId(multisig: string, event: WatchEvent): string {
  const what = event.kind === "new-proposal" ? "new" : `${event.from}>${event.to}`;
  return `${multisig}:${event.transactionIndex}:${what}`;
}

export function buildAlert(event: WatchEvent, analysis: AlertAnalysis, ctx: AlertContext): Alert {
  const report = analysis.kind === "report" ? analysis.report : undefined;
  const findings = report === undefined ? [] : topFindings(report.findings);
  const instructions = report === undefined ? [] : instructionLines(report, ctx.locale);
  const approvedAt =
    event.kind === "status-change" && event.to === "Approved" ? event.timestamp : null;
  const lock = BigInt(ctx.timeLockSeconds);
  return {
    analysisError: analysis.kind === "failed" ? safe(analysis.message) : null,
    cluster: ctx.cluster,
    contextSlot: report === undefined ? null : report.contextSlot.toString(),
    detectedAt: ctx.detectedAt,
    event: event.kind,
    executableAfter:
      approvedAt !== null && lock > 0n
        ? new Date(Number((approvedAt + lock) * 1000n)).toISOString()
        : null,
    findings: findings.map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      title: safe(renderFinding(finding, ctx.locale, report?.instructions ?? [], FULL).text),
    })),
    findingsTotal: report?.findings.length ?? 0,
    id: alertId(ctx.multisig, event),
    initial: event.kind === "new-proposal" && event.initial,
    instructions: instructions.slice(0, MAX_ALERT_INSTRUCTIONS),
    instructionsTotal: instructions.length,
    isStale: event.kind === "new-proposal" && event.isStale,
    multisig: ctx.multisig,
    permalink: permalink(ctx.webUrl, ctx.cluster, ctx.multisig, event.transactionIndex),
    rpcHost: ctx.rpcHost,
    schemaVersion: 1,
    status:
      event.kind === "new-proposal" ? { to: event.status } : { from: event.from, to: event.to },
    timeLock: lock > 0n && approvedAt !== null ? formatDuration(lock, ctx.locale) : null,
    transactionIndex: event.transactionIndex.toString(),
    transactionKind: event.transactionKind,
    verdict:
      report !== undefined
        ? report.verdict
        : analysis.kind === "last-known"
          ? (analysis.verdict ?? null)
          : null,
    verdictSource:
      report !== undefined
        ? "analysis"
        : analysis.kind === "last-known" && analysis.verdict !== undefined
          ? "last-known"
          : "none",
  };
}

/** Critical first, then warnings (VGL-W011, "analysis incomplete", first among them), then info. */
function topFindings(findings: readonly Finding[]): Finding[] {
  return [...findings]
    .map((finding, position) => ({ finding, position }))
    .sort((a, b) => {
      const severity = SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity];
      if (severity !== 0) {
        return severity;
      }
      const w011 =
        Number(b.finding.ruleId === "VGL-W011") - Number(a.finding.ruleId === "VGL-W011");
      return w011 !== 0 ? w011 : a.position - b.position;
    })
    .slice(0, MAX_ALERT_FINDINGS)
    .map(({ finding }) => finding);
}

function instructionLines(report: AnalysisReport, locale: Locale): string[] {
  if (report.configActions !== undefined && report.configActions.length > 0) {
    return report.configActions.map((action) =>
      safe(
        renderConfigAction(
          action,
          locale,
          { instructions: report.instructions, tokens: report.tokens },
          FULL,
        ).text,
      ),
    );
  }
  return report.instructions.map((instruction) =>
    safe(renderSummary(instruction, locale, FULL).text),
  );
}

/** One line of text, with every invisible or control character removed (second barrier). */
function safe(text: string): string {
  return terminalSafe(text.replace(/\s+/g, " ")).trim();
}

/**
 * `VIGIL_WEB_URL` + the web app's proposal route (`#/ms/<multisig>/<index>[?cluster=devnet]`,
 * `apps/web/src/lib/routes.ts`). The web app knows mainnet and devnet only.
 */
export function permalink(
  webUrl: string | undefined,
  cluster: string,
  multisig: string,
  index: bigint,
): string | null {
  if (webUrl === undefined || (cluster !== "mainnet" && cluster !== "devnet")) {
    return null;
  }
  const base = webUrl.replace(/\/+$/, "");
  return `${base}/#/ms/${multisig}/${index}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

/** What happened, in a few words: "New proposal #12", "Proposal #12: Approved, ready to execute". */
export function headline(alert: Alert, locale: Locale): string {
  const index = alert.transactionIndex;
  if (alert.event === "new-proposal") {
    if (alert.status.to === "Closed") {
      return m(locale, "alert.newClosed", { index });
    }
    return m(locale, alert.initial ? "alert.pending" : "alert.new", {
      index,
      status: statusText(alert.status.to, locale),
    });
  }
  if (alert.status.to === "Approved") {
    return m(locale, "alert.approved", { index });
  }
  if (alert.status.to === "Closed") {
    return m(locale, "alert.closed", { index });
  }
  return m(locale, "alert.changed", {
    from: statusText(alert.status.from ?? "", locale),
    index,
    to: statusText(alert.status.to, locale),
  });
}

function statusText(status: string, locale: Locale): string {
  if (status === "NoProposal") {
    return m(locale, "alert.status.noProposal");
  }
  if (status === "Closed") {
    return m(locale, "alert.status.closed");
  }
  const key = `proposalStatus.${status}`;
  return isMessageKey(key) ? m(locale, key) : status;
}

function verdictText(alert: Alert, locale: Locale): string {
  if (alert.verdict === null) {
    return alert.analysisError !== null
      ? m(locale, "alert.analysisFailed", { error: alert.analysisError })
      : m(locale, "alert.notAnalysed");
  }
  const words = core(locale, `verdict.${alert.verdict}`).toUpperCase();
  return alert.verdictSource === "last-known"
    ? m(locale, "alert.lastVerdict", { verdict: words })
    : words;
}

/**
 * The alert as plain-text lines, most important first. `body` never contains the permalink (the
 * Discord format places it outside its code block).
 */
export function alertLines(alert: Alert, locale: Locale): { title: string; body: string[] } {
  const body: string[] = [
    m(locale, "alert.field.multisig", { cluster: alert.cluster, multisig: alert.multisig }),
    m(locale, "alert.field.verdict", { verdict: verdictText(alert, locale) }),
  ];
  if (alert.executableAfter !== null && alert.timeLock !== null) {
    body.push(
      m(locale, "alert.timeLock", { duration: alert.timeLock, time: alert.executableAfter }),
    );
  }
  if (alert.isStale) {
    body.push(m(locale, "stale"));
  }
  if (alert.findings.length > 0) {
    body.push(
      m(locale, "alert.findings", {
        shown: String(alert.findings.length),
        total: String(alert.findingsTotal),
      }),
    );
    for (const finding of alert.findings) {
      body.push(
        `- ${m(locale, `severity.${finding.severity}`)} ${finding.ruleId}: ${finding.title}`,
      );
    }
  } else if (alert.verdictSource === "analysis") {
    body.push(m(locale, "alert.noFindings"));
  }
  if (alert.instructions.length > 0) {
    body.push(m(locale, "alert.does"));
    alert.instructions.forEach((line, i) => {
      body.push(`${i + 1}. ${line}`);
    });
    if (alert.instructionsTotal > alert.instructions.length) {
      body.push(
        m(locale, "alert.more", {
          count: String(alert.instructionsTotal - alert.instructions.length),
        }),
      );
    }
  }
  body.push(
    m(locale, "alert.footer", {
      host: alert.rpcHost,
      slot: alert.contextSlot ?? "?",
      time: alert.detectedAt,
    }),
  );
  return { body, title: `Vigil · ${headline(alert, locale)}` };
}

/** Plain text for Telegram and similar: title, body, link. Cut to `limit` UTF-16 code units. */
export function alertPlainText(alert: Alert, locale: Locale, limit: number): string {
  const { title, body } = alertLines(alert, locale);
  const link = alert.permalink === null ? [] : [m(locale, "alert.link", { url: alert.permalink })];
  return fit([title], body, link, limit, locale);
}

/**
 * Keeps the head and tail, drops body lines from the end until the text fits, and says so. A
 * single line longer than the limit is cut.
 */
export function fit(
  head: readonly string[],
  body: readonly string[],
  tail: readonly string[],
  limit: number,
  locale: Locale,
  join: (lines: readonly string[]) => string = (lines) => lines.join("\n"),
): string {
  const whole = join([...head, ...body, ...tail]);
  if (whole.length <= limit) {
    return whole;
  }
  const marker = m(locale, "alert.truncated");
  for (let keep = body.length - 1; keep >= 0; keep--) {
    const text = join([...head, ...body.slice(0, keep), marker, ...tail]);
    if (text.length <= limit) {
      return text;
    }
  }
  return cutToLength(join([...head, marker, ...tail]), limit);
}

/** Cuts at a code point boundary, never in the middle of a surrogate pair. */
export function cutToLength(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  let out = "";
  for (const char of text) {
    if (out.length + char.length > limit - 1) {
      break;
    }
    out += char;
  }
  return `${out}…`;
}

/** One readable line for standard output. */
export function alertLine(alert: Alert, locale: Locale): string {
  const parts = [
    alert.detectedAt,
    headline(alert, locale),
    `${alert.multisig} (${alert.cluster})`,
    verdictText(alert, locale),
  ];
  if (alert.findings.length > 0) {
    parts.push(alert.findings.map((finding) => finding.ruleId).join(", "));
  }
  if (alert.permalink !== null) {
    parts.push(alert.permalink);
  }
  return parts.join(" · ");
}
