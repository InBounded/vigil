import { type SanitizeFlag, sanitizeOnchainString } from "./sanitize.js";

/** A string inside an instruction's arguments that the sanitizer changed or flagged. */
export interface SanitizerNote {
  /** Where the string sits in `args`, e.g. `memo`, `args.seed`, `items[2].name`. */
  readonly path: string;
  readonly modified: boolean;
  readonly flags: readonly SanitizeFlag[];
}

export interface SanitizedArgs {
  readonly args: Readonly<Record<string, unknown>>;
  readonly notes: readonly SanitizerNote[];
}

/** Lower-case hex produced by the decoders from byte arrays: cannot carry anything to remove. */
const HEX = /^[0-9a-f]*$/;

/**
 * Sanitizes every string inside decoded instruction arguments, however deeply nested, so that no
 * on-chain string leaves the decoding layer raw. A field named `memo` is treated as a memo (keeps
 * line breaks, 512 code points); every other string as `text`. Hex strings the decoders built from
 * byte arrays are left whole: they only contain `[0-9a-f]` and truncating them would lose data
 * that `rawDataHex` also carries. Anything changed or flagged is reported as a note.
 */
export function sanitizeArgs(args: Readonly<Record<string, unknown>>): SanitizedArgs {
  const notes: SanitizerNote[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = sanitizeValue(value, key, key === "memo", notes);
  }
  return { args: out, notes };
}

function sanitizeValue(
  value: unknown,
  path: string,
  isMemo: boolean,
  notes: SanitizerNote[],
): unknown {
  if (typeof value === "string") {
    if (HEX.test(value)) {
      return value;
    }
    const result = sanitizeOnchainString(value, isMemo ? "memo" : "text");
    if (result.modified || result.flags.length > 0) {
      notes.push({ flags: result.flags, modified: result.modified, path });
    }
    return result.text;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => sanitizeValue(item, `${path}[${i}]`, false, notes));
  }
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = sanitizeValue(inner, `${path}.${key}`, key === "memo", notes);
    }
    return out;
  }
  return value;
}
