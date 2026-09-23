import { RULES, type Rule, toStableJson } from "@vigil-sol/core";
import type { ParsedArgs } from "../args.js";
import { CliError, EXIT } from "../errors.js";
import type { Runtime } from "../runtime.js";
import { wrap } from "../terminal.js";

const SYMBOL = { critical: "✖", info: "ℹ", warning: "⚠" } as const;
const COLOR = { critical: "red", info: "cyan", warning: "yellow" } as const;

function ruleJson(rule: Rule) {
  return {
    docs: rule.docs,
    id: rule.id,
    name: rule.name,
    severity: rule.defaultSeverity,
    titleKey: rule.titleKey,
  };
}

export function rulesCommand(args: ParsedArgs, runtime: Runtime): number {
  if (args.positionals.length > 0) {
    throw new CliError(
      "vigil rules takes no arguments.",
      "To see one rule: vigil explain <ruleId>",
    );
  }
  if (runtime.options.json) {
    runtime.out(`${toStableJson(RULES.map(ruleJson))}\n`);
    return EXIT.ok;
  }
  const { style, width } = runtime.renderContext();
  const out = [style.bold(`Vigil · ${RULES.length} rules`), ""];
  for (const rule of RULES) {
    const severity = rule.defaultSeverity;
    out.push(
      `${style.color(COLOR[severity], `${SYMBOL[severity]} ${rule.id}`, true)}  ${style.dim(severity)}`,
      ...wrap(rule.name, width, "  "),
    );
  }
  out.push("", style.dim("Details: vigil explain <ruleId>, e.g. vigil explain VGL-C001"));
  runtime.out(`${out.join("\n")}\n`);
  return EXIT.ok;
}

export function explainCommand(args: ParsedArgs, runtime: Runtime): number {
  const [id, ...extra] = args.positionals;
  if (id === undefined || extra.length > 0) {
    throw new CliError(
      id === undefined ? "Missing the rule id." : "vigil explain takes one rule id.",
      "Usage: vigil explain <ruleId>, e.g. vigil explain VGL-C001. vigil rules lists them.",
    );
  }
  const rule = RULES.find((candidate) => candidate.id === id.toUpperCase());
  if (rule === undefined) {
    throw new CliError(
      `There is no rule "${id.replace(/[^\x20-\x7e]/g, "?").slice(0, 20)}".`,
      "Rule ids look like VGL-C001, VGL-W004 or VGL-I002; vigil rules lists them all.",
    );
  }
  if (runtime.options.json) {
    runtime.out(`${toStableJson(ruleJson(rule))}\n`);
    return EXIT.ok;
  }
  const { style, width } = runtime.renderContext();
  const severity = rule.defaultSeverity;
  const section = (title: string, text: string) => [
    "",
    style.bold(title),
    ...wrap(text.replace(/`/g, ""), width, "  "),
  ];
  runtime.out(
    `${[
      style.color(COLOR[severity], `${SYMBOL[severity]} ${rule.id} · ${rule.name}`, true),
      style.dim(`  severity: ${severity}`),
      ...section("What it checks", rule.docs.what),
      ...section("Why it matters", rule.docs.why),
      ...section("False positives and limits", rule.docs.falsePositives),
    ].join("\n")}\n`,
  );
  return EXIT.ok;
}

/** Phase 8. Registered now so scripts and `--help` already know the name. */
export function watchCommand(runtime: Runtime): number {
  runtime.err(
    "vigil watch arrives in a later version of Vigil.\n  → For now, run vigil list <multisig> on a schedule (it exits 2 on a critical finding).\n",
  );
  return EXIT.error;
}
