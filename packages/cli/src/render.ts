import {
  type AnalysisGap,
  type AnalysisReport,
  type BalanceChange,
  type DecodedAccount,
  type DecodedInstruction,
  type Finding,
  findRegistryProgram,
  formatAmount,
  groupBalanceChanges,
  type Locale,
  type ProgramInfo,
  type RenderOptions,
  renderConfigAction,
  renderFinding,
  renderGap,
  renderLabel,
  renderSimulationNotes,
  renderSummary,
  type Severity,
  type SimulationResult,
  type TokenInfo,
  t,
  type Verdict,
} from "@vigil-sol/core";
import { core, type MessageKey, m } from "./messages.js";
import { type Color, type Style, wrap } from "./terminal.js";

/** Addresses are always shown in full in the CLI. */
const FULL: RenderOptions = { addresses: "full" };

export interface RenderContext {
  readonly locale: Locale;
  readonly style: Style;
  readonly width: number;
  readonly verbose: boolean;
  readonly version: string;
}

/** Words and symbols carry the meaning; colour only reinforces it (readable with `NO_COLOR`). */
const SEVERITY: Readonly<Record<Severity, { symbol: string; color: Color; key: MessageKey }>> = {
  critical: { color: "red", key: "severity.critical", symbol: "✖" },
  info: { color: "cyan", key: "severity.info", symbol: "ℹ" },
  warning: { color: "yellow", key: "severity.warning", symbol: "⚠" },
};

const VERDICT: Readonly<Record<Verdict, { symbol: string; color: Color }>> = {
  attention: { color: "yellow", symbol: "⚠" },
  critical: { color: "red", symbol: "✖" },
  incomplete: { color: "yellow", symbol: "?" },
  // Deliberately not a check mark: "no findings" is not "safe".
  "no-findings": { color: "cyan", symbol: "○" },
};

/** A report as text for a terminal: verdict first, then findings, gaps, effects, programs. */
export function renderReport(report: AnalysisReport, ctx: RenderContext): string {
  const out: string[] = [];
  out.push(...header(report, ctx), "");
  out.push(...verdictBlock(report.verdict, ctx));
  out.push(...findingsSection(report, ctx));
  out.push(...gapsSection(report.completeness.gaps, ctx));
  out.push(...effectsSection(report, ctx));
  out.push(...simulationSection(report, ctx));
  out.push(...programsSection(report.programs, ctx));
  out.push(
    "",
    ...wrap(
      m(ctx.locale, "footer.readOnly", { time: report.generatedAt, version: ctx.version }),
      ctx.width,
    ).map((line) => ctx.style.dim(line)),
  );
  return `${out.join("\n")}\n`;
}

function header(report: AnalysisReport, ctx: RenderContext): string[] {
  const { locale, style } = ctx;
  const fields: [string, string][] = [];
  let title: string;
  if (report.input.kind === "squads-proposal") {
    const kind = report.transactionKind ?? "vault";
    title = m(locale, "title.proposal", {
      index: report.input.transactionIndex.toString(),
      kind: m(locale, `kind.${kind}`),
    });
    fields.push([m(locale, "field.multisig"), report.input.multisig]);
    const proposal = report.proposal;
    if (proposal !== undefined) {
      const status =
        proposal.status === null
          ? m(locale, "status.none")
          : proposal.status.timestamp === null
            ? m(locale, `proposalStatus.${proposal.status.kind}`)
            : m(locale, "status.value", {
                status: m(locale, `proposalStatus.${proposal.status.kind}`),
                time: unixTime(proposal.status.timestamp),
              });
      fields.push([
        m(locale, "field.status"),
        proposal.isStale ? `${status} · ${m(locale, "stale")}` : status,
      ]);
      if (report.multisig !== undefined) {
        fields.push([
          m(locale, "field.approvals"),
          m(locale, "votes.value", {
            approved: String(proposal.votes?.approved.length ?? 0),
            rejected: String(proposal.votes?.rejected.length ?? 0),
            members: String(report.multisig.members.length),
            threshold: String(report.multisig.threshold),
          }),
        ]);
      }
    }
  } else {
    title = m(locale, "raw.title");
    fields.push([m(locale, "field.sha256"), report.input.sha256]);
    if (report.rawTransaction !== undefined) {
      fields.push([m(locale, "field.feePayer"), report.rawTransaction.feePayer]);
      fields.push([m(locale, "field.version"), String(report.rawTransaction.version)]);
    }
  }
  fields.push([
    m(locale, "field.network"),
    m(locale, "network.value", {
      cluster: report.cluster,
      host: report.rpcHost,
      slot: report.contextSlot.toString(),
    }),
  ]);
  return [style.bold(`Vigil · ${title}`), ...fieldLines(fields, ctx)];
}

/** `label  value` lines; stacked (value under the label) on a narrow terminal. */
function fieldLines(fields: readonly [string, string][], ctx: RenderContext): string[] {
  const labelWidth = Math.max(...fields.map(([label]) => label.length)) + 2;
  const stacked = ctx.width < 64;
  return fields.flatMap(([label, value]) =>
    stacked
      ? [`  ${ctx.style.dim(label)}`, ...wrap(value, ctx.width, "    ")]
      : wrap(value, ctx.width, `  ${" ".repeat(labelWidth)}`, `  ${" ".repeat(labelWidth)}`).map(
          (line, i) =>
            i === 0 ? `  ${ctx.style.dim(label.padEnd(labelWidth))}${line.trimStart()}` : line,
        ),
  );
}

function verdictBlock(verdict: Verdict, ctx: RenderContext): string[] {
  const { symbol, color } = VERDICT[verdict];
  const title = `${symbol} ${core(ctx.locale, `verdict.${verdict}`).toUpperCase()}`;
  return [
    ctx.style.color(color, title, true),
    ...wrap(core(ctx.locale, `verdict.${verdict}.detail`), ctx.width, "  "),
  ];
}

function findingsSection(report: AnalysisReport, ctx: RenderContext): string[] {
  const { locale, style } = ctx;
  if (report.findings.length === 0) {
    return [
      "",
      style.bold(m(locale, "heading.noFindings")),
      ...wrap(m(locale, "noFindings.checked"), ctx.width, "  "),
    ];
  }
  const out = [
    "",
    style.bold(m(locale, "heading.findings", { count: String(report.findings.length) })),
  ];
  for (const finding of orderBySeverity(report.findings)) {
    out.push(...findingLines(finding, report.instructions, ctx));
  }
  return out;
}

/** Critical first, then warnings, then info; VGL-W011 (incomplete analysis) stays first. */
function orderBySeverity(findings: readonly Finding[]): Finding[] {
  const rank: Readonly<Record<Severity, number>> = { critical: 0, info: 2, warning: 1 };
  return findings
    .map((finding, i) => ({ finding, i }))
    .sort(
      (a, b) =>
        Number(b.finding.ruleId === "VGL-W011") - Number(a.finding.ruleId === "VGL-W011") ||
        rank[a.finding.severity] - rank[b.finding.severity] ||
        a.i - b.i,
    )
    .map(({ finding }) => finding);
}

function findingLines(
  finding: Finding,
  instructions: readonly DecodedInstruction[],
  ctx: RenderContext,
): string[] {
  const { symbol, color, key } = SEVERITY[finding.severity];
  const text = renderFinding(finding, ctx.locale, instructions, FULL).text;
  const lines = [
    `  ${ctx.style.color(color, `${symbol} ${m(ctx.locale, key)}`, true)}  ${ctx.style.dim(finding.ruleId)}`,
    ...wrap(text, ctx.width, "    "),
  ];
  if (ctx.verbose) {
    for (const evidence of finding.evidence) {
      lines.push(...wrap(evidence, ctx.width, "      ").map((line) => ctx.style.dim(line)));
    }
  }
  return lines;
}

function gapsSection(gaps: readonly AnalysisGap[], ctx: RenderContext): string[] {
  if (gaps.length === 0) {
    return [];
  }
  const out = ["", ctx.style.bold(m(ctx.locale, "heading.gaps", { count: String(gaps.length) }))];
  const seen = new Set<string>();
  for (const gap of gaps) {
    const id = `${gap.code}|${gap.address ?? ""}|${ctx.verbose ? gap.message : ""}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(
      ...wrap(
        renderGap(gap, ctx.locale),
        ctx.width,
        `  ${ctx.style.color("yellow", "?")} `,
        "    ",
      ),
    );
    if (gap.address !== undefined) {
      out.push(...wrap(gap.address, ctx.width, "    ").map((line) => ctx.style.dim(line)));
    }
    if (ctx.verbose) {
      out.push(...wrap(gap.message, ctx.width, "    ").map((line) => ctx.style.dim(line)));
    }
  }
  return out;
}

function effectsSection(report: AnalysisReport, ctx: RenderContext): string[] {
  const { locale, style } = ctx;
  const heading = report.input.kind === "raw-transaction" ? "heading.doesRaw" : "heading.does";
  const out = ["", style.bold(m(locale, heading))];
  if (report.configActions !== undefined) {
    out.push(`  ${style.dim(m(locale, "heading.configActions"))}`);
    for (const action of report.configActions) {
      const text = renderConfigAction(
        action,
        locale,
        { instructions: report.instructions, tokens: report.tokens },
        FULL,
      ).text;
      out.push(...wrap(text, ctx.width, "  • ", "    "));
    }
    return out;
  }
  if (report.instructions.length === 0) {
    out.push(`  ${m(locale, "ix.none")}`);
    return out;
  }
  let batchItem: number | undefined;
  for (const instruction of report.instructions) {
    if (instruction.batchItem !== undefined && instruction.batchItem !== batchItem) {
      batchItem = instruction.batchItem;
      out.push(`  ${style.dim(m(locale, "heading.batchItem", { item: String(batchItem) }))}`);
    }
    const indent = batchItem === undefined ? "  " : "    ";
    out.push(...instructionLines(instruction, `${indent}${instruction.index + 1}. `, ctx));
  }
  return out;
}

function instructionLines(
  instruction: DecodedInstruction,
  prefix: string,
  ctx: RenderContext,
): string[] {
  const rest = " ".repeat(prefix.length);
  const lines = wrap(renderSummary(instruction, ctx.locale, FULL).text, ctx.width, prefix, rest);
  if (ctx.verbose) {
    lines.push(
      ...wrap(
        `${instruction.programLabel ?? ""} ${instruction.programId}`.trim(),
        ctx.width,
        rest,
      ).map((l) => ctx.style.dim(l)),
    );
    lines.push(ctx.style.dim(`${rest}${m(ctx.locale, "ix.accounts")}`));
    for (const account of instruction.accounts) {
      lines.push(
        ...wrap(accountText(account, ctx.locale), ctx.width, `${rest}  `, `${rest}    `).map((l) =>
          ctx.style.dim(l),
        ),
      );
    }
  }
  for (const inner of instruction.inner ?? []) {
    lines.push(...instructionLines(inner, `${rest}↳ `, ctx));
  }
  return lines;
}

function accountText(account: DecodedAccount, locale: Locale): string {
  const flags = [account.isSigner ? "signer" : "", account.isWritable ? "writable" : ""]
    .filter((flag) => flag !== "")
    .join(", ");
  const label =
    account.label === undefined ? "" : ` (${renderLabel(account.label, locale, false)})`;
  const table =
    account.fromLookupTable === undefined ? "" : ` [lookup table ${account.fromLookupTable}]`;
  return `${account.role ?? "?"}: ${account.address}${label}${flags === "" ? "" : ` [${flags}]`}${table}`;
}

function simulationSection(report: AnalysisReport, ctx: RenderContext): string[] {
  const outcome = report.simulation;
  if (outcome === undefined) {
    return [];
  }
  const { locale, style } = ctx;
  const notes = renderSimulationNotes(outcome, locale, report.instructions, FULL).map(
    (n) => n.text,
  );
  const [snapshot, ...otherNotes] = notes;
  const out = ["", style.bold(m(locale, "heading.balanceChanges"))];
  out.push(...snapshotBox(snapshot ?? "", ctx));
  const results = outcome.status === "batch" ? outcome.items : [outcome];
  for (const result of results) {
    const indent = result.batchItem === undefined ? "  " : "    ";
    if (result.batchItem !== undefined) {
      out.push(
        `  ${style.dim(m(locale, "heading.batchItem", { item: String(result.batchItem) }))}`,
      );
    }
    out.push(...resultLines(result, report.tokens, indent, ctx));
  }
  if (otherNotes.length > 0) {
    out.push(`  ${style.dim(m(locale, "simulation.notes"))}`);
    for (const note of otherNotes) {
      out.push(...wrap(note, ctx.width, "  • ", "    "));
    }
  }
  return out;
}

/**
 * The snapshot note, framed, before any balance: simulated balances are one moment of the
 * network, never a promise of what execution will do (maintainer requirement).
 */
function snapshotBox(text: string, ctx: RenderContext): string[] {
  const inner = Math.max(20, ctx.width - 4);
  const title = ` ⚠ ${m(ctx.locale, "snapshot.title")} `;
  const top = `  ┌${title}${"─".repeat(Math.max(2, inner - [...title].length))}`;
  const body = wrap(text, inner, "  │ ");
  const bottom = `  └${"─".repeat(Math.max(2, inner))}`;
  return [
    ctx.style.color("yellow", top, true),
    ...body.map((line) => ctx.style.color("yellow", line)),
    ctx.style.color("yellow", bottom, true),
  ];
}

function resultLines(
  result: SimulationResult,
  tokens: readonly TokenInfo[],
  indent: string,
  ctx: RenderContext,
): string[] {
  const { locale, style } = ctx;
  if (result.status === "unavailable") {
    return wrap(m(locale, "simulation.unavailable", { reason: result.reason }), ctx.width, indent);
  }
  const out: string[] = [];
  if (result.status === "failed") {
    out.push(
      ...wrap(m(locale, "simulation.failed", { error: result.error }), ctx.width, indent).map(
        (line) => style.color("red", line),
      ),
    );
  } else if (result.balanceChanges.length === 0) {
    out.push(...wrap(m(locale, "balance.none"), ctx.width, indent));
  } else {
    for (const group of groupBalanceChanges(result.balanceChanges)) {
      const first = group.changes[0];
      const holderLabel = first?.holderLabel;
      const holder =
        holderLabel === undefined
          ? group.holder
          : `${renderLabel(holderLabel, locale, false)} (${group.holder})`;
      out.push(...wrap(holder, ctx.width, indent));
      for (const change of group.changes) {
        out.push(
          ...wrap(changeText(change, tokens, locale), ctx.width, `${indent}  `, `${indent}    `),
        );
      }
    }
  }
  if (ctx.verbose && result.logs.length > 0) {
    out.push(style.dim(`${indent}${m(locale, "simulation.logs")}`));
    for (const log of result.logs) {
      out.push(
        ...wrap(log, ctx.width, `${indent}  `, `${indent}    `).map((line) => style.dim(line)),
      );
    }
  }
  return out;
}

function changeText(change: BalanceChange, tokens: readonly TokenInfo[], locale: Locale): string {
  const delta = change.post - change.pre;
  const sign = delta > 0n ? "+" : delta < 0n ? "-" : "±";
  const amount = assetAmount(delta < 0n ? -delta : delta, change, tokens, locale);
  const notes: string[] = [];
  if (change.owner !== undefined) {
    notes.push(m(locale, "balance.tokenAccount", { address: change.account }));
  }
  if (change.created === true) {
    notes.push(m(locale, "balance.created"));
  }
  if (change.closed === true) {
    notes.push(m(locale, "balance.closed"));
  }
  if (change.feeExcluded !== undefined) {
    notes.push(m(locale, "balance.feeExcluded"));
  }
  return `${sign}${amount}${notes.length === 0 ? "" : ` (${notes.join("; ")})`}`;
}

function assetAmount(
  raw: bigint,
  change: BalanceChange,
  tokens: readonly TokenInfo[],
  locale: Locale,
): string {
  if (change.asset === "SOL") {
    return t("fmt.sol", locale, { amount: formatAmount(raw, 9, locale) });
  }
  const token = tokens.find((info) => info.mint === change.asset);
  const decimals = change.decimals ?? token?.decimals;
  if (decimals === undefined) {
    return t("fmt.token.raw", locale, { amount: raw.toString(), mint: change.asset });
  }
  const amount = formatAmount(raw, decimals, locale);
  if (token?.registry !== undefined) {
    return t("fmt.token.registry", locale, { amount, symbol: token.registry.symbol });
  }
  if (token?.declared !== undefined) {
    return t("fmt.token.declared", locale, {
      amount,
      declaredName: token.declared.name.text,
      declaredSymbol: token.declared.symbol.text,
      mint: change.asset,
    });
  }
  return t("fmt.token.unknown", locale, { amount, mint: change.asset });
}

function programsSection(programs: readonly ProgramInfo[], ctx: RenderContext): string[] {
  if (programs.length === 0) {
    return [];
  }
  const out = [
    "",
    ctx.style.bold(m(ctx.locale, "heading.programs", { count: String(programs.length) })),
  ];
  for (const program of programs) {
    out.push(...programLines(program, ctx));
  }
  return out;
}

export function programLines(program: ProgramInfo, ctx: RenderContext): string[] {
  const { locale, style } = ctx;
  const name = findRegistryProgram(program.address)?.name;
  const facts = [name, upgradeText(program, locale), verificationText(program, locale)].filter(
    (part): part is string => part !== undefined,
  );
  const out = [
    ...wrap(program.address, ctx.width, "  "),
    ...wrap(facts.join(" · "), ctx.width, "    "),
  ];
  const details: string[] = [];
  if (program.lastDeploySlot !== undefined) {
    details.push(m(locale, "program.lastDeploy", { slot: program.lastDeploySlot.toString() }));
  }
  if (program.verificationDetails?.hashMismatch === true) {
    details.push(m(locale, "program.hashMismatch"));
  }
  if (ctx.verbose) {
    if (program.loader !== undefined) {
      details.push(m(locale, "program.loader", { loader: program.loader }));
    }
    if (program.executableHash !== undefined) {
      details.push(m(locale, "program.hash", { hash: program.executableHash }));
    }
    const verification = program.verificationDetails;
    if (verification?.repoUrl !== undefined) {
      details.push(m(locale, "program.repo", { repo: verification.repoUrl }));
    }
    if (verification?.commit !== undefined) {
      details.push(m(locale, "program.commit", { commit: verification.commit }));
    }
    if (verification?.lastVerifiedAt !== undefined) {
      details.push(m(locale, "program.verifiedAt", { time: verification.lastVerifiedAt }));
    }
  }
  for (const detail of details) {
    out.push(...wrap(detail, ctx.width, "    ").map((line) => style.dim(line)));
  }
  return out;
}

function upgradeText(program: ProgramInfo, locale: Locale): string {
  switch (program.upgrade.kind) {
    case "immutable":
      return m(locale, "program.immutable");
    case "upgradeable":
      return program.authorityVaultIndex === undefined
        ? m(locale, "program.upgradeable", { authority: program.upgrade.authority })
        : m(locale, "program.authorityVault", {
            authority: program.upgrade.authority,
            index: String(program.authorityVaultIndex),
          });
    case "unknown":
      return m(locale, "program.unknownUpgrade");
  }
}

function verificationText(program: ProgramInfo, locale: Locale): string {
  if (program.loader === "native") {
    return m(locale, "program.native");
  }
  return m(locale, "program.verification", {
    status: core(locale, `verification.${program.verification}`),
  });
}

/** Unix seconds as `2026-09-22 10:46 UTC`. */
export function unixTime(seconds: bigint): string {
  const date = new Date(Number(seconds) * 1000);
  return Number.isNaN(date.getTime())
    ? seconds.toString()
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
