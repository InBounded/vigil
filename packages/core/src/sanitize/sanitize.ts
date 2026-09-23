/**
 * Sanitizer for strings that come from the chain (memos, token names and symbols, IDL string
 * values, seeds, ...). They are attacker-controlled: see `AGENTS.md` → "On-chain data is hostile
 * input" and `docs/reference.md` §11. No on-chain string may reach an interface without passing
 * through here, and interfaces must still render the result as text, never as HTML.
 */

/**
 * What a string is used for, which decides its length limit and which checks apply:
 * - `name` / `symbol`: token names and symbols, labels (64 code points);
 * - `memo`: free text where line breaks are meaningful (512 code points, `\n` kept);
 * - `text`: any other on-chain string, e.g. an instruction argument (512 code points).
 */
export type SanitizeKind = "name" | "symbol" | "memo" | "text";

export type SanitizeFlag =
  /** C0/C1 control characters were removed. */
  | "control-chars-removed"
  /** Bidirectional formatting characters were removed (they can reorder what is displayed). */
  | "bidi-removed"
  /** Zero-width characters were removed (they can hide inside an otherwise familiar string). */
  | "zero-width-removed"
  /**
   * Other invisible characters were removed: Unicode tag characters (U+E0000–U+E007F, which can
   * smuggle hidden text) and the line/paragraph separators U+2028/U+2029.
   */
  | "invisible-removed"
  | "truncated"
  /** A token symbol contains characters outside printable ASCII (possible look-alike). */
  | "non-ascii"
  /** Latin letters mixed with Cyrillic or Greek letters (possible homoglyph spoof). */
  | "mixed-scripts";

export interface SanitizedString {
  readonly text: string;
  /** `true` when `text` differs from the input (characters removed or truncated). */
  readonly modified: boolean;
  /** Every reason the string was changed or should be treated with suspicion, in a fixed order. */
  readonly flags: readonly SanitizeFlag[];
}

export const SANITIZE_LIMITS: Readonly<Record<SanitizeKind, number>> = {
  memo: 512,
  name: 64,
  symbol: 64,
  text: 512,
};

const FLAG_ORDER: readonly SanitizeFlag[] = [
  "control-chars-removed",
  "bidi-removed",
  "zero-width-removed",
  "invisible-removed",
  "truncated",
  "non-ascii",
  "mixed-scripts",
];

type RemovalFlag =
  | "control-chars-removed"
  | "bidi-removed"
  | "zero-width-removed"
  | "invisible-removed";

/** Character classes from `docs/reference.md` §11 (tags and U+2028/U+2029 added in Phase 3B). */
function removalReason(codePoint: number, kind: SanitizeKind): RemovalFlag | null {
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return kind === "memo" && codePoint === 0x0a ? null : "control-chars-removed";
  }
  if (
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x061c
  ) {
    return "bidi-removed";
  }
  if (
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    codePoint === 0x2060 ||
    codePoint === 0xfeff
  ) {
    return "zero-width-removed";
  }
  if (
    (codePoint >= 0xe0000 && codePoint <= 0xe007f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  ) {
    return "invisible-removed";
  }
  return null;
}

const LATIN = /\p{Script=Latin}/u;
const CONFUSABLE_SCRIPTS = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
const NOT_PRINTABLE_ASCII = /[^\x20-\x7e]/;

/**
 * Removes control, bidi and zero-width characters, truncates to the kind's limit (by code point,
 * so a surrogate pair is never split) and flags look-alike risks. Never normalizes (NFC/NFKC):
 * normalization would silently change what the chain says. Pure and deterministic.
 */
export function sanitizeOnchainString(input: string, kind: SanitizeKind = "text"): SanitizedString {
  const flags = new Set<SanitizeFlag>();
  const kept: string[] = [];
  for (const char of input) {
    const reason = removalReason(char.codePointAt(0) ?? 0, kind);
    if (reason === null) {
      kept.push(char);
    } else {
      flags.add(reason);
    }
  }
  const limit = SANITIZE_LIMITS[kind];
  if (kept.length > limit) {
    kept.length = limit;
    flags.add("truncated");
  }
  const text = kept.join("");
  if (kind === "symbol" && NOT_PRINTABLE_ASCII.test(text)) {
    flags.add("non-ascii");
  }
  if (kind !== "memo" && LATIN.test(text) && CONFUSABLE_SCRIPTS.test(text)) {
    flags.add("mixed-scripts");
  }
  return {
    flags: FLAG_ORDER.filter((flag) => flags.has(flag)),
    modified: text !== input,
    text,
  };
}
