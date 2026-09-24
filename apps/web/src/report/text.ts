import {
  type AnalysisReport,
  type DecodedInstruction,
  groupBalanceChanges,
  type Locale,
  renderConfigAction,
  renderFinding,
  renderGap,
  renderLabel,
  renderSimulationNotes,
  renderSummary,
} from "@vigil-sol/core";
import { VERDICT_SYMBOL } from "../components/Severity.js";
import { m } from "../i18n/messages.js";
import { orderFindings } from "../lib/order.js";
import { safeText } from "../lib/safe-text.js";
import {
  changeAmount,
  changeNotes,
  core,
  FULL,
  isoMinutes,
  upgradeText,
  verificationText,
} from "./format.js";

/**
 * The report as plain text for a team chat: the same sections as the page (verdict, findings,
 * what is not checked, what it does, balance changes with the snapshot note, programs), full
 * addresses, no markup. Every line passes `safeText`.
 */
export function reportToText(report: AnalysisReport, locale: Locale): string {
  const out: string[] = [];
  const input = report.input;
  if (input.kind === "squads-proposal") {
    out.push(
      `Vigil · ${m(locale, "report.title.proposal", {
        index: input.transactionIndex.toString(),
        kind: m(locale, `kind.${report.transactionKind ?? "vault"}`),
      })}`,
      `${m(locale, "field.multisig")}: ${input.multisig}`,
    );
  } else {
    out.push(`Vigil · ${m(locale, "raw.title")}`, `${m(locale, "field.sha256")}: ${input.sha256}`);
  }
  out.push(
    `${m(locale, "field.network")}: ${report.cluster} (${report.rpcHost}) · ${m(locale, "report.analysedAt", { slot: report.contextSlot.toString(), time: isoMinutes(report.generatedAt) })}`,
    "",
    `${VERDICT_SYMBOL[report.verdict]} ${core(locale, `verdict.${report.verdict}`).toUpperCase()}`,
    core(locale, `verdict.${report.verdict}.detail`),
    m(locale, "notice.reanalyze"),
    "",
    m(locale, "report.findings", { count: String(report.findings.length) }),
  );
  if (report.findings.length === 0) {
    out.push(`  ${m(locale, "report.findings.none")}`);
  }
  for (const finding of orderFindings(report.findings)) {
    const text = renderFinding(finding, locale, report.instructions, FULL).text;
    out.push(`  [${m(locale, `severity.${finding.severity}`)}] ${finding.ruleId}: ${text}`);
  }
  const gaps = report.completeness.gaps;
  if (gaps.length > 0) {
    out.push("", m(locale, "report.gaps", { count: String(gaps.length) }));
    const seen = new Set<string>();
    for (const gap of gaps) {
      const line = `  ? ${renderGap(gap, locale)}${gap.address === undefined ? "" : ` (${gap.address})`}`;
      if (!seen.has(line)) {
        seen.add(line);
        out.push(line);
      }
    }
  }
  out.push("", m(locale, input.kind === "raw-transaction" ? "report.doesRaw" : "report.does"));
  if (report.configActions !== undefined) {
    report.configActions.forEach((action, i) => {
      const text = renderConfigAction(
        action,
        locale,
        { instructions: report.instructions, tokens: report.tokens },
        FULL,
      ).text;
      out.push(`  ${i + 1}. ${text}`);
    });
  } else {
    let batchItem: number | undefined;
    for (const instruction of report.instructions) {
      if (instruction.batchItem !== undefined && instruction.batchItem !== batchItem) {
        batchItem = instruction.batchItem;
        out.push(`  ${m(locale, "report.batchItem", { item: String(batchItem) })}`);
      }
      out.push(...instructionLines(instruction, `  ${instruction.index + 1}. `, locale));
    }
  }
  const outcome = report.simulation;
  if (outcome !== undefined) {
    const [snapshot, ...notes] = renderSimulationNotes(outcome, locale, report.instructions, FULL);
    out.push(
      "",
      m(locale, "report.balanceChanges"),
      `  ⚠ ${m(locale, "report.snapshot").toUpperCase()}: ${snapshot?.text ?? ""}`,
    );
    for (const result of outcome.status === "batch" ? outcome.items : [outcome]) {
      if (result.batchItem !== undefined) {
        out.push(`  ${m(locale, "report.batchItem", { item: String(result.batchItem) })}`);
      }
      if (result.status === "unavailable") {
        out.push(`  ${m(locale, "report.simulation.unavailable", { reason: result.reason })}`);
      } else if (result.status === "failed") {
        out.push(`  ${m(locale, "report.simulation.failed", { error: result.error })}`);
      } else if (result.balanceChanges.length === 0) {
        out.push(`  ${m(locale, "balance.none")}`);
      } else {
        for (const group of groupBalanceChanges(result.balanceChanges)) {
          const label = group.changes[0]?.holderLabel;
          out.push(
            `  ${label === undefined ? "" : `${renderLabel(label, locale, false)} `}${group.holder}`,
          );
          for (const change of group.changes) {
            const extra = changeNotes(change, locale);
            if (change.owner !== undefined) {
              extra.unshift(`${m(locale, "balance.tokenAccount")} ${change.account}`);
            }
            out.push(
              `    ${changeAmount(change, report.tokens, locale)}${extra.length === 0 ? "" : ` (${extra.join("; ")})`}`,
            );
          }
        }
      }
    }
    for (const note of notes) {
      out.push(`  • ${note.text}`);
    }
  }
  if (report.programs.length > 0) {
    out.push("", m(locale, "report.programs", { count: String(report.programs.length) }));
    for (const program of report.programs) {
      const authority =
        program.upgrade.kind === "upgradeable" ? ` (${program.upgrade.authority})` : "";
      out.push(
        `  ${program.address}: ${upgradeText(program, locale)}${authority} · ${verificationText(program, locale)}`,
      );
    }
  }
  out.push("", m(locale, "report.textFooter", { version: __VIGIL_VERSION__ }));
  return `${out.map((line) => safeText(line)).join("\n")}\n`;
}

function instructionLines(
  instruction: DecodedInstruction,
  prefix: string,
  locale: Locale,
): string[] {
  const lines = [`${prefix}${renderSummary(instruction, locale, FULL).text}`];
  const indent = " ".repeat(prefix.length);
  for (const inner of instruction.inner ?? []) {
    lines.push(...instructionLines(inner, `${indent}↳ `, locale));
  }
  return lines;
}
