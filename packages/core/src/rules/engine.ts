import type { AnalysisGap, Finding, Severity, Verdict } from "../report.js";
import { multisigConfigChange } from "./catalog/config.js";
import {
  accountOwnerChange,
  addressPoisoning,
  bufferExternalAuthority,
  closeToExternal,
  delegateApproval,
  programUpgrade,
  stakeAuthorityChange,
  tokenAuthorityChange,
  unresolvableMessage,
  upgradeAuthorityChange,
} from "./catalog/critical.js";
import {
  computeBudget,
  lookupTables,
  memo,
  proposalStatus,
  staleProposal,
} from "./catalog/info.js";
import {
  durableNonce,
  fragileMultisig,
  impersonatingToken,
  incompleteAnalysis,
  largeTransfer,
  newDestination,
  opaqueInstruction,
  simulationProblem,
  thirdPartyUpgradeable,
  unexpectedBalanceChanges,
  unverifiedProgram,
} from "./catalog/warning.js";
import type { Rule, RuleContext } from "./types.js";

/** Every rule, in id order. */
export const RULES: readonly Rule[] = [
  programUpgrade,
  upgradeAuthorityChange,
  tokenAuthorityChange,
  delegateApproval,
  accountOwnerChange,
  multisigConfigChange,
  stakeAuthorityChange,
  addressPoisoning,
  closeToExternal,
  unresolvableMessage,
  bufferExternalAuthority,
  opaqueInstruction,
  unverifiedProgram,
  thirdPartyUpgradeable,
  largeTransfer,
  newDestination,
  simulationProblem,
  unexpectedBalanceChanges,
  impersonatingToken,
  durableNonce,
  fragileMultisig,
  incompleteAnalysis,
  computeBudget,
  memo,
  lookupTables,
  proposalStatus,
  staleProposal,
];

/** Shown before everything else, so an incomplete analysis is never read as a clean one. */
export const ALWAYS_FIRST_RULE = incompleteAnalysis.id;

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { critical: 0, info: 2, warning: 1 };

function compareFindings(a: Finding, b: Finding): number {
  const first = Number(b.ruleId === ALWAYS_FIRST_RULE) - Number(a.ruleId === ALWAYS_FIRST_RULE);
  return (
    first ||
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    (a.instructionIndex ?? -1) - (b.instructionIndex ?? -1) ||
    (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)
  );
}

/**
 * Runs every rule over the context and returns the findings in a fixed order: VGL-W011 first,
 * then critical, warning, info; within a severity by instruction (report-level findings first),
 * then rule id, then the order the rule produced them in.
 */
export function runRules(context: RuleContext, rules: readonly Rule[] = RULES): Finding[] {
  return rules.flatMap((rule) => rule.evaluate(context)).sort(compareFindings);
}

/**
 * `critical` if any critical finding; else `incomplete` if the analysis has any gap; else
 * `attention` if any warning; else `no-findings`.
 */
export function computeVerdict(
  findings: readonly Finding[],
  gaps: readonly AnalysisGap[],
): Verdict {
  if (findings.some((f) => f.severity === "critical")) {
    return "critical";
  }
  if (gaps.length > 0) {
    return "incomplete";
  }
  return findings.some((f) => f.severity === "warning") ? "attention" : "no-findings";
}
