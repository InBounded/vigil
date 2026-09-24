import type { Finding, Severity } from "@vigil-sol/core";

const RANK: Readonly<Record<Severity, number>> = { critical: 0, info: 2, warning: 1 };

/**
 * Critical findings first, then warnings (VGL-W011, "incomplete analysis", first among them, as
 * core orders it), then info; otherwise core's order.
 */
export function orderFindings(findings: readonly Finding[]): Finding[] {
  return findings
    .map((finding, i) => ({ finding, i }))
    .sort(
      (a, b) =>
        RANK[a.finding.severity] - RANK[b.finding.severity] ||
        Number(b.finding.ruleId === "VGL-W011") - Number(a.finding.ruleId === "VGL-W011") ||
        a.i - b.i,
    )
    .map(({ finding }) => finding);
}
