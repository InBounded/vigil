import type { Address } from "@solana/kit";
import type { AccountLabel } from "../labels/labels.js";
import {
  type AnalysisGap,
  type ConfigAction,
  type DecodedInstruction,
  type Finding,
  SIMULATION_SNAPSHOT_NOTE,
  type SimulationNote,
  type SimulationOutcome,
} from "../report.js";
import type { TokenInfo } from "../tokens/enrich.js";
import en from "./en.json" with { type: "json" };

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
 * When a param a template needs is missing or null, and a `<key>.without.<param>` template exists,
 * that one is used instead (e.g. "makes the program immutable" when no new authority). A param is
 * null when it reads `"none"` *and* the summary lists it in `nullParams` (the argument was null);
 * any other value, including on-chain text reading "none", is shown exactly as written. Findings
 * are built by Vigil's own rules, so there `"none"` is always the "no value" marker (their
 * on-chain text uses `{x:text}`).
 *
 * Output is plain text. Every param already went through the sanitizer; interfaces must still
 * render the result as text, never as HTML.
 */

/**
 * Vigil ships in English only. Every text still goes through a keyed catalog, so another language
 * can be added later by adding its catalog here (and its number format below).
 */
export type Locale = "en";
export const LOCALES: readonly Locale[] = ["en"];

export const CATALOGS: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  en,
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
};

export function t(
  key: string,
  locale: Locale,
  params: Readonly<Record<string, string>> = {},
): string {
  const template = CATALOGS[locale][key] ?? CATALOGS.en[key] ?? key;
  return template.replace(PLACEHOLDER, (_match, name: string) => params[name] ?? "");
}

/**
 * How addresses appear inside rendered sentences. `short` (default): `CPMM…KP1C`, or the label
 * alone. `full`: every address in full, after its label when it has one (the CLI: a signer must be
 * able to compare every character).
 */
export interface RenderOptions {
  readonly addresses?: "short" | "full";
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

/**
 * Label text for an account. `short` is the inline form used inside sentences. With
 * `options.addresses` `"full"` and an `address`, the full address is always part of the text.
 */
export function renderLabel(
  label: AccountLabel,
  locale: Locale,
  short = false,
  address?: string,
  options: RenderOptions = {},
): string {
  const full = options.addresses === "full";
  // `.full`: the inline form to use next to the account's own full address, where the `.short`
  // form would name another account (a vault's token account is "Vault #0" in short sentences).
  const key =
    short && full && CATALOGS.en[`${label.key}.full`] !== undefined
      ? `${label.key}.full`
      : short && CATALOGS.en[`${label.key}.short`] !== undefined
        ? `${label.key}.short`
        : label.key;
  const params =
    address === undefined
      ? label.params
      : { ...label.params, address: full ? address : shortAddress(address) };
  const text = t(key, locale, params);
  const template = CATALOGS[locale][key] ?? CATALOGS.en[key] ?? key;
  return full && address !== undefined && !template.includes("{address")
    ? `${text} (${address})`
    : text;
}

/** An address inside a sentence: its label if it has one, and the address in the chosen form. */
function addressText(
  value: string,
  labels: ReadonlyMap<Address, AccountLabel>,
  locale: Locale,
  options: RenderOptions,
): string {
  const label = labels.get(value as Address);
  if (label === undefined) {
    return options.addresses === "full" ? value : shortAddress(value);
  }
  return renderLabel(label, locale, true, value, options);
}

export function renderGap(gap: AnalysisGap, locale: Locale): string {
  return t(`gap.${gap.code}`, locale);
}

/** The instruction's summary as a sentence, e.g. "Transfers 250,000 USDC from Vault #0 to Gh3w\u2026Lq7m". */
export function renderSummary(
  instruction: DecodedInstruction,
  locale: Locale,
  options: RenderOptions = {},
): Rendered {
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
  const nulls = new Set(summary.nullParams ?? []);
  return renderTemplate(
    summary.key,
    summary.params,
    labels,
    locale,
    (name, value) => value === "none" && nulls.has(name),
    options,
  );
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
  options: RenderOptions = {},
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
  const rendered = renderTemplate(
    finding.titleKey,
    finding.params,
    labels,
    locale,
    (_name, value) => value === "none",
    options,
  );
  return finding.params.proposed === "true"
    ? { missing: rendered.missing, text: `${rendered.text} ${t("finding.proposed", locale)}` }
    : rendered;
}

/**
 * The notes of a simulation result, as sentences. The snapshot note ("Network state can change
 * before execution…") always comes first — even if the result object somehow lacks it — so no
 * interface can show simulated balances without it (maintainer requirement). Notes repeated across
 * batch items are rendered once.
 */
export function renderSimulationNotes(
  outcome: SimulationOutcome,
  locale: Locale,
  instructions: readonly DecodedInstruction[] = [],
  options: RenderOptions = {},
): Rendered[] {
  const labels = new Map<Address, AccountLabel>();
  const visit = (list: readonly DecodedInstruction[]): void => {
    for (const instruction of list) {
      collectLabels(instruction, labels);
      visit(instruction.inner ?? []);
    }
  };
  visit(instructions);
  const results = outcome.status === "batch" ? outcome.items : [outcome];
  for (const result of results) {
    if (result.status === "success") {
      for (const change of result.balanceChanges) {
        if (change.label !== undefined) {
          labels.set(change.account, change.label);
        }
        if (change.holderLabel !== undefined) {
          labels.set(change.owner ?? change.account, change.holderLabel);
        }
      }
    }
  }
  const notes: SimulationNote[] = [
    { key: SIMULATION_SNAPSHOT_NOTE, params: {} },
    ...outcome.notes,
    ...(outcome.status === "batch" ? outcome.items.flatMap((item) => item.notes) : []),
  ];
  const seen = new Set<string>();
  const out: Rendered[] = [];
  for (const note of notes) {
    const id = `${note.key}${JSON.stringify(Object.entries(note.params).sort())}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(
      CATALOGS[locale][note.key] === undefined
        ? { missing: [note.key], text: note.key }
        : renderTemplate(note.key, note.params, labels, locale, () => false, options),
    );
  }
  return out;
}

/** `Pubkey::default()`: a Squads spending limit on this mint is a limit on SOL. */
const SOL_MINT_SENTINEL = "11111111111111111111111111111111";

/**
 * A settings change of a Squads config proposal as a sentence. Addresses are labelled with the
 * labels found on `instructions`; token amounts use `tokens` (from the report) for decimals and
 * registry symbols, else they are shown in base units.
 */
export function renderConfigAction(
  action: ConfigAction,
  locale: Locale,
  context: {
    readonly instructions?: readonly DecodedInstruction[];
    readonly tokens?: readonly TokenInfo[];
  } = {},
  options: RenderOptions = {},
): Rendered {
  const labels = new Map<Address, AccountLabel>();
  const visit = (list: readonly DecodedInstruction[]): void => {
    for (const instruction of list) {
      collectLabels(instruction, labels);
      visit(instruction.inner ?? []);
    }
  };
  visit(context.instructions ?? []);
  let key = `configAction.${action.kind}`;
  let params: Record<string, string>;
  switch (action.kind) {
    case "addMember":
      params = {
        member: action.member,
        permissions: action.permissions.length === 0 ? "none" : action.permissions.join(","),
      };
      break;
    case "removeMember":
      params = { member: action.member };
      break;
    case "changeThreshold":
      params = { newThreshold: String(action.newThreshold) };
      break;
    case "setTimeLock":
      params = { newTimeLockSeconds: String(action.newTimeLockSeconds) };
      break;
    case "addSpendingLimit": {
      const token = context.tokens?.find((info) => info.mint === action.mint);
      if (action.mint === SOL_MINT_SENTINEL) {
        key = "configAction.addSpendingLimitSol";
      }
      params = {
        amount: String(action.amount),
        destinations: action.destinations.join(","),
        members: action.members.join(","),
        mint: action.mint,
        period: action.period,
        vaultIndex: String(action.vaultIndex),
        ...(token === undefined ? {} : { decimals: String(token.decimals) }),
        ...(token?.registry === undefined ? {} : { symbol: token.registry.symbol }),
      };
      break;
    }
    case "removeSpendingLimit":
      params = { spendingLimit: action.spendingLimit };
      break;
    case "setRentCollector":
      params =
        action.newRentCollector === null ? {} : { newRentCollector: action.newRentCollector };
      break;
    case "setConfigAuthority":
      params = { newConfigAuthority: action.newConfigAuthority };
      break;
  }
  return renderTemplate(
    key,
    params,
    labels,
    locale,
    (name, value) => (name === "permissions" && value === "none") || value === "",
    options,
  );
}

/** `true` when a param's value means "no value" (see the module comment). */
type IsNull = (name: string, value: string) => boolean;

/** Fills in a catalog template (which must exist), choosing a `.without.<param>` form if needed. */
function renderTemplate(
  baseKey: string,
  params: Readonly<Record<string, string>>,
  labels: ReadonlyMap<Address, AccountLabel>,
  locale: Locale,
  isNull: IsNull,
  options: RenderOptions,
): Rendered {
  const catalog = CATALOGS[locale];
  let key = baseKey;
  let template = catalog[key] ?? key;
  for (const [, name] of template.matchAll(PLACEHOLDER)) {
    const value = name === undefined ? undefined : params[name];
    const alternative = catalog[`${key}.without.${name}`];
    if (
      name !== undefined &&
      (value === undefined || isNull(name, value)) &&
      alternative !== undefined
    ) {
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
    const isNone = value !== undefined && isNull(name, value);
    return formatParam(value ?? "", type, params, labels, locale, missing, name, isNone, options);
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
  isNone: boolean,
  options: RenderOptions,
): string {
  switch (type) {
    case "address": {
      if (isNone) {
        return t("common.none", locale);
      }
      // Rules write "unknown" for an account an instruction does not have; a real address never
      // reads "unknown".
      if (value === "unknown") {
        return t("common.unknown", locale);
      }
      return addressText(value, labels, locale, options);
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
      return formatToken(params, labels, locale, missing, name, options);
    case "text":
      // On-chain text (memos, declared names, error details): verbatim, never translated.
      return value;
    case "duration":
      return /^\d+$/.test(value) ? formatDuration(BigInt(value), locale) : value;
    case "addresses":
      return value
        .split(",")
        .filter((item) => item !== "")
        .map((item) => addressText(item, labels, locale, options))
        .join(", ");
    case "permissions":
      return isNone
        ? t("common.none", locale)
        : value
            .split(",")
            .map((permission) => CATALOGS[locale][`permission.${permission}`] ?? permission)
            .join(", ");
    default:
      if (isNone) {
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
  options: RenderOptions,
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
          mint: mintText(mint, labels, locale, options),
        });
  }
  const amount = formatAmount(raw, decimals, locale);
  if (params.symbol !== undefined) {
    return t("fmt.token.registry", locale, { amount, symbol: params.symbol });
  }
  const mintShown =
    mint === undefined ? t("common.unknown", locale) : mintText(mint, labels, locale, options);
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
  options: RenderOptions,
): string {
  return addressText(mint, labels, locale, options);
}

function collectLabels(instruction: DecodedInstruction, into: Map<Address, AccountLabel>): void {
  for (const account of instruction.accounts) {
    if (account.label !== undefined) {
      into.set(account.address, account.label);
    }
  }
}
