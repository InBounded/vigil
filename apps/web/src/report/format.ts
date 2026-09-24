import {
  type AnalysisReport,
  type BalanceChange,
  CATALOGS,
  formatAmount,
  type Locale,
  type ProgramInfo,
  type RenderOptions,
  type TokenInfo,
  t,
} from "@vigil-sol/core";
import { m } from "../i18n/messages.js";

/** Addresses are always shown in full in the web app. */
export const FULL: RenderOptions = { addresses: "full" };

/** A core catalog text (verdicts, gaps, verification states...). */
export function core(
  locale: Locale,
  key: string,
  params: Readonly<Record<string, string>> = {},
): string {
  return CATALOGS[locale][key] === undefined && CATALOGS.en[key] === undefined
    ? key
    : t(key, locale, params);
}

/** A balance change as "+1,000 USDC" / "-0.5 SOL" (exact integer arithmetic). */
export function changeAmount(
  change: BalanceChange,
  tokens: readonly TokenInfo[],
  locale: Locale,
): string {
  const delta = change.post - change.pre;
  const sign = delta > 0n ? "+" : delta < 0n ? "-" : "±";
  return `${sign}${assetAmount(delta < 0n ? -delta : delta, change, tokens, locale)}`;
}

/** The notes after a balance change ("account created", "fee excluded"...). */
export function changeNotes(change: BalanceChange, locale: Locale): string[] {
  const notes: string[] = [];
  if (change.created === true) {
    notes.push(m(locale, "balance.created"));
  }
  if (change.closed === true) {
    notes.push(m(locale, "balance.closed"));
  }
  if (change.feeExcluded !== undefined) {
    notes.push(m(locale, "balance.feeExcluded"));
  }
  return notes;
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

/** Unix seconds as `2026-09-22 10:46 UTC`. */
export function unixTime(seconds: bigint): string {
  const date = new Date(Number(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? seconds.toString() : isoMinutes(date.toISOString());
}

/** An ISO 8601 time as `2026-09-22 10:46 UTC`. */
export function isoMinutes(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)
    ? `${iso.slice(0, 16).replace("T", " ")} UTC`
    : iso;
}

/** Suspected address poisoning (VGL-C008): each flagged address → the known address it imitates. */
export function poisonedAddresses(report: AnalysisReport): Map<string, string> {
  const map = new Map<string, string>();
  for (const finding of report.findings) {
    const { address, resembles } = finding.params;
    if (finding.ruleId === "VGL-C008" && address !== undefined && resembles !== undefined) {
      map.set(address, resembles);
    }
  }
  return map;
}

/** How a program can change, in words (without the authority's address). */
export function upgradeText(program: ProgramInfo, locale: Locale): string {
  switch (program.upgrade.kind) {
    case "immutable":
      return m(locale, "program.immutable");
    case "upgradeable":
      return program.authorityVaultIndex === undefined
        ? m(locale, "program.upgradeable")
        : m(locale, "program.authorityVault", { index: String(program.authorityVaultIndex) });
    case "unknown":
      return m(locale, "program.unknownUpgrade");
  }
}

export function verificationText(program: ProgramInfo, locale: Locale): string {
  if (program.loader === "native") {
    return m(locale, "program.native");
  }
  return m(locale, "program.verification", {
    status: core(locale, `verification.${program.verification}`),
  });
}
