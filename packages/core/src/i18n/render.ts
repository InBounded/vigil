import type { Address } from "@solana/kit";
import type { AccountLabel } from "../labels/labels.js";
import type { AnalysisGap, DecodedInstruction, Finding } from "../report.js";
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
 * - `text`: the value verbatim (on-chain text: never translated, even if it reads "none");
 * - `duration`: seconds as "1 d 2 h"; `permissions`: Squads permission names, translated;
 * - any other type: the catalog's `<type>.<value>` text if there is one, else the value;
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
  if (CATALOGS[locale][summary.key] === undefined) {
    return {
      missing: [summary.key],
      text: t("ix.noSummary", locale, { name: instruction.name ?? "?" }),
    };
  }
  return renderTemplate(summary.key, summary.params, labels, locale);
}

/**
 * A finding as a sentence. Addresses are shown with the labels found on `instructions` (pass the
 * report's instructions). A finding about an instruction inside a Squads proposal the transaction
 * only creates ends with a sentence saying so.
 */
export function renderFinding(
  finding: Finding,
  locale: Locale,
  instructions: readonly DecodedInstruction[] = [],
): Rendered {
  const labels = new Map<Address, AccountLabel>();
  const visit = (list: readonly DecodedInstruction[]): void => {
    for (const instruction of list) {
      collectLabels(instruction, labels);
      visit(instruction.inner ?? []);
    }
  };
  visit(instructions);
  if (CATALOGS[locale][finding.titleKey] === undefined) {
    return { missing: [finding.titleKey], text: finding.titleKey };
  }
  const rendered = renderTemplate(finding.titleKey, finding.params, labels, locale);
  return finding.params.proposed === "true"
    ? { missing: rendered.missing, text: `${rendered.text} ${t("finding.proposed", locale)}` }
    : rendered;
}

/** Fills in a catalog template (which must exist), choosing a `.without.<param>` form if needed. */
function renderTemplate(
  baseKey: string,
  params: Readonly<Record<string, string>>,
  labels: ReadonlyMap<Address, AccountLabel>,
  locale: Locale,
): Rendered {
  const catalog = CATALOGS[locale];
  let key = baseKey;
  let template = catalog[key] ?? key;
  for (const [, name] of template.matchAll(PLACEHOLDER)) {
    const value = name === undefined ? undefined : params[name];
    const alternative = catalog[`${key}.without.${name}`];
    if ((value === undefined || value === "none") && alternative !== undefined) {
      key = `${key}.without.${name}`;
      template = alternative;
      break;
    }
  }
  const missing: string[] = [];
  const text = template.replace(PLACEHOLDER, (_match, name: string, type: string | undefined) => {
    const value = params[name];
    if (value === undefined && type !== "token") {
      missing.push(name);
      return t("common.unknown", locale);
    }
    return formatParam(value ?? "", type, params, labels, locale, missing, name);
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
      if (value === "none" || value === "unknown") {
        return t(`common.${value}`, locale);
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
    case "text":
      // On-chain text (memos, declared names, error details): verbatim, never translated.
      return value;
    case "duration":
      return /^\d+$/.test(value) ? formatDuration(BigInt(value), locale) : value;
    case "permissions":
      return value === "none"
        ? t("common.none", locale)
        : value
            .split(",")
            .map((permission) => CATALOGS[locale][`permission.${permission}`] ?? permission)
            .join(", ");
    default:
      if (value === "none") {
        return t("common.none", locale);
      }
      // Any other `{name:type}`: the catalog's `<type>.<value>` text if there is one (e.g.
      // `verification.unverified`, `period.Day`, `gap.LOOKUP_TABLE_NOT_FOUND`), else the value.
      return type === undefined ? value : (CATALOGS[locale][`${type}.${value}`] ?? value);
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

/** Seconds as "2 d 3 h 5 min" (largest units first, zero units left out; "0 s" for zero). */
export function formatDuration(seconds: bigint, locale: Locale): string {
  const units: readonly (readonly [string, bigint])[] = [
    ["fmt.duration.d", 86_400n],
    ["fmt.duration.h", 3_600n],
    ["fmt.duration.min", 60n],
    ["fmt.duration.s", 1n],
  ];
  const parts: string[] = [];
  let rest = seconds;
  for (const [key, size] of units) {
    const count = rest / size;
    rest %= size;
    if (count > 0n) {
      parts.push(t(key, locale, { n: groupDigits(count.toString(), locale) }));
    }
  }
  return parts.length === 0 ? t("fmt.duration.s", locale, { n: "0" }) : parts.join(" ");
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
