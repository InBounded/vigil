import type { Address } from "@solana/kit";
import type { AccountLabel } from "../labels/labels.js";
import type { AnalysisGap, DecodedInstruction } from "../report.js";
import en from "./en.json" with { type: "json" };
import ptPT from "./pt-PT.json" with { type: "json" };

/**
 * Plain-language rendering of the i18n keys + params the engine produces (instruction summaries,
 * account labels, analysis gaps). The engine never produces sentences itself; interfaces call this.
 *
 * Template syntax: `{name}` inserts a param as text; `{name:type}` formats it:
 * - `address`: the account's label if it has one, otherwise a shortened address (`Gh3w\u2026Lq7m`);
 * - `sol`: lamports as SOL; `number`: an integer with digit grouping;
 * - `token`: a token amount using the `decimals`, `symbol` / `declaredName` and `mint` params;
 * - `authority`: an SPL Token / Token-2022 `AuthorityType` name; `stakeAuthorize`: a Stake
 *   `StakeAuthorize` value (0 = staker, 1 = withdrawer).
 * When a param a template needs is missing or `"none"`, and a `<key>.without.<param>` template
 * exists, that one is used instead (e.g. "makes the program immutable" when no new authority).
 *
 * Output is plain text. Every param already went through the sanitizer; interfaces must still
 * render the result as text, never as HTML.
 */

export type Locale = "en" | "pt-PT";
export const LOCALES: readonly Locale[] = ["en", "pt-PT"];

export const CATALOGS: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  en,
  "pt-PT": ptPT,
};

export interface Rendered {
  readonly text: string;
  /** Params a template referred to that were absent; always empty for a complete summary. */
  readonly missing: readonly string[];
}

const PLACEHOLDER = /\{([A-Za-z0-9_.]+)(?::([A-Za-z]+))?\}/g;

interface NumberFormat {
  readonly group: string;
  readonly decimal: string;
  /** Integers with fewer digits than this are not grouped (CLDR `minimumGroupingDigits` + 3). */
  readonly minDigitsToGroup: number;
}

const FORMAT: Readonly<Record<Locale, NumberFormat>> = {
  en: { decimal: ".", group: ",", minDigitsToGroup: 4 },
  // European Portuguese: decimal comma, (no-break) space between thousands, and no grouping below
  // five digits ("1000", "10 000"), as CLDR pt-PT (minimumGroupingDigits 2) and `Intl` do.
  "pt-PT": { decimal: ",", group: "\u00A0", minDigitsToGroup: 5 },
};

export function t(
  key: string,
  locale: Locale,
  params: Readonly<Record<string, string>> = {},
): string {
  const template = CATALOGS[locale][key] ?? CATALOGS.en[key] ?? key;
  return template.replace(PLACEHOLDER, (_match, name: string) => params[name] ?? "");
}

export function shortAddress(address: string): string {
  return address.length <= 11 ? address : `${address.slice(0, 4)}\u2026${address.slice(-4)}`;
}

/** Exact decimal formatting of a base-unit integer (never floating point). */
export function formatAmount(raw: string | bigint, decimals: number, locale: Locale): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const { decimal } = FORMAT[locale];
  const grouped = groupDigits(whole, locale);
  return `${negative ? "-" : ""}${grouped}${fraction === "" ? "" : `${decimal}${fraction}`}`;
}

function groupDigits(whole: string, locale: Locale): string {
  const { group, minDigitsToGroup } = FORMAT[locale];
  const digits = whole.startsWith("-") ? whole.length - 1 : whole.length;
  return digits < minDigitsToGroup ? whole : whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
}

/** Label text for an account. `short` is the inline form used inside sentences. */
export function renderLabel(
  label: AccountLabel,
  locale: Locale,
  short = false,
  address?: string,
): string {
  const key =
    short && CATALOGS.en[`${label.key}.short`] !== undefined ? `${label.key}.short` : label.key;
  const params =
    address === undefined ? label.params : { ...label.params, address: shortAddress(address) };
  return t(key, locale, params);
}

export function renderGap(gap: AnalysisGap, locale: Locale): string {
  return t(`gap.${gap.code}`, locale);
}

/** The instruction's summary as a sentence, e.g. "Transfers 250,000 USDC from Vault #0 to Gh3w\u2026Lq7m". */
export function renderSummary(instruction: DecodedInstruction, locale: Locale): Rendered {
  const summary = instruction.summary;
  if (summary === undefined) {
    return { missing: [], text: t("ix.undecoded", locale) };
  }
  const labels = new Map<Address, AccountLabel>();
  collectLabels(instruction, labels);
  const catalog = CATALOGS[locale];
  let key = summary.key;
  let template = catalog[key];
  if (template === undefined) {
    return { missing: [key], text: t("ix.noSummary", locale, { name: instruction.name ?? "?" }) };
  }
  for (const [, name] of template.matchAll(PLACEHOLDER)) {
    const value = name === undefined ? undefined : summary.params[name];
    const alternative = catalog[`${key}.without.${name}`];
    if ((value === undefined || value === "none") && alternative !== undefined) {
      key = `${key}.without.${name}`;
      template = alternative;
      break;
    }
  }
  const missing: string[] = [];
  const text = template.replace(PLACEHOLDER, (_match, name: string, type: string | undefined) => {
    const value = summary.params[name];
    if (value === undefined && type !== "token") {
      missing.push(name);
      return t("common.unknown", locale);
    }
    return formatParam(value ?? "", type, summary.params, labels, locale, missing, name);
  });
  return { missing, text };
}

function formatParam(
  value: string,
  type: string | undefined,
  params: Readonly<Record<string, string>>,
  labels: ReadonlyMap<Address, AccountLabel>,
  locale: Locale,
  missing: string[],
  name: string,
): string {
  switch (type) {
    case "address": {
      if (value === "none") {
        return t("common.none", locale);
      }
      const label = labels.get(value as Address);
      return label === undefined ? shortAddress(value) : renderLabel(label, locale, true, value);
    }
    case "sol":
      return t("fmt.sol", locale, { amount: formatAmount(value, 9, locale) });
    case "number":
      return /^-?\d+$/.test(value) ? groupDigits(value, locale) : value;
    case "authority":
      return CATALOGS[locale][`authority.${value}`] ?? value;
    case "stakeAuthorize":
      return CATALOGS[locale][`stakeAuthorize.${value}`] ?? value;
    case "token":
      return formatToken(params, labels, locale, missing, name);
    default:
      return value === "none" ? t("common.none", locale) : value;
  }
}

function formatToken(
  params: Readonly<Record<string, string>>,
  labels: ReadonlyMap<Address, AccountLabel>,
  locale: Locale,
  missing: string[],
  name: string,
): string {
  const raw = params[name];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    missing.push(name);
    return t("common.unknown", locale);
  }
  const mint = params.mint;
  const decimals = params.decimals === undefined ? undefined : Number(params.decimals);
  if (decimals === undefined || !Number.isInteger(decimals)) {
    return mint === undefined
      ? t("fmt.token.rawNoMint", locale, { amount: groupDigits(raw, locale) })
      : t("fmt.token.raw", locale, {
          amount: groupDigits(raw, locale),
          mint: mintText(mint, labels, locale),
        });
  }
  const amount = formatAmount(raw, decimals, locale);
  if (params.symbol !== undefined) {
    return t("fmt.token.registry", locale, { amount, symbol: params.symbol });
  }
  const mintShown =
    mint === undefined ? t("common.unknown", locale) : mintText(mint, labels, locale);
  if (params.declaredName !== undefined) {
    return t("fmt.token.declared", locale, {
      amount,
      declaredName: params.declaredName,
      declaredSymbol: params.declaredSymbol ?? "",
      mint: mintShown,
    });
  }
  return t("fmt.token.unknown", locale, { amount, mint: mintShown });
}

function mintText(
  mint: string,
  labels: ReadonlyMap<Address, AccountLabel>,
  locale: Locale,
): string {
  const label = labels.get(mint as Address);
  return label === undefined ? shortAddress(mint) : renderLabel(label, locale, true, mint);
}

function collectLabels(instruction: DecodedInstruction, into: Map<Address, AccountLabel>): void {
  for (const account of instruction.accounts) {
    if (account.label !== undefined) {
      into.set(account.address, account.label);
    }
  }
}
