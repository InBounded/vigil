import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeArgs } from "./args.js";
import { SANITIZE_LIMITS, type SanitizeKind, sanitizeOnchainString } from "./sanitize.js";

/** Every character `docs/reference.md` §11 says must be removed (newline is kept in memos only). */
const REMOVED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0x200e, 0x200f],
  [0x061c, 0x061c],
  [0x200b, 0x200d],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
];

function isRemoved(codePoint: number, kind: SanitizeKind): boolean {
  if (kind === "memo" && codePoint === 0x0a) {
    return false;
  }
  return REMOVED_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

describe("sanitizeOnchainString: bidi", () => {
  it("removes a right-to-left override hiding a file extension (the classic RLO spoof)", () => {
    // Displays as "USDC exe.gnp" reversed tail; the raw string ends in "gnp.exe".
    const result = sanitizeOnchainString("USDC\u202Egnp.exe", "name");
    expect(result).toEqual({ flags: ["bidi-removed"], modified: true, text: "USDCgnp.exe" });
  });

  it("removes every bidi control listed in the reference, including isolates and marks", () => {
    const input = "a\u202Ab\u202Bc\u202Cd\u202De\u2066f\u2067g\u2068h\u2069i\u200Ej\u200Fk\u061Cl";
    const result = sanitizeOnchainString(input, "text");
    expect(result.text).toBe("abcdefghijkl");
    expect(result.flags).toEqual(["bidi-removed"]);
  });
});

describe("sanitizeOnchainString: zero-width", () => {
  it("removes zero-width characters that make a look-alike of a known symbol", () => {
    const result = sanitizeOnchainString("US\u200BDC", "symbol");
    expect(result).toEqual({ flags: ["zero-width-removed"], modified: true, text: "USDC" });
  });

  it("removes ZWNJ, ZWJ, word joiner and BOM", () => {
    const result = sanitizeOnchainString("\uFEFFJ\u200CU\u200DP\u2060", "name");
    expect(result.text).toBe("JUP");
    expect(result.flags).toEqual(["zero-width-removed"]);
  });
});

describe("sanitizeOnchainString: homoglyphs", () => {
  it("flags a symbol spelled with Cyrillic look-alikes as non-ASCII, without changing it", () => {
    // "USDC" with Cyrillic \u0405 (U+0405) and \u0421 (U+0421): renders identically in most fonts.
    const input = "U\u0405D\u0421";
    const result = sanitizeOnchainString(input, "symbol");
    expect(result.text).toBe(input);
    expect(result.modified).toBe(false);
    expect(result.flags).toEqual(["non-ascii", "mixed-scripts"]);
  });

  it("flags a name mixing Latin with Greek (omicron in place of o)", () => {
    const result = sanitizeOnchainString("B\u03BFnk", "name");
    expect(result.flags).toEqual(["mixed-scripts"]);
    expect(result.modified).toBe(false);
  });

  it("does not flag a name entirely in one non-Latin script", () => {
    expect(sanitizeOnchainString("\u0420\u0443\u0431\u043B\u044C", "name").flags).toEqual([]);
    expect(sanitizeOnchainString("\u03A3\u03CC\u03BB\u03B1\u03BD\u03B1", "name").flags).toEqual([]);
  });

  it("flags non-ASCII in symbols only; a non-ASCII name is not suspicious by itself", () => {
    expect(sanitizeOnchainString("café", "symbol").flags).toEqual(["non-ascii"]);
    expect(sanitizeOnchainString("café", "name").flags).toEqual([]);
  });

  it("leaves plain ASCII untouched", () => {
    expect(sanitizeOnchainString("USD Coin", "name")).toEqual({
      flags: [],
      modified: false,
      text: "USD Coin",
    });
  });
});

describe("sanitizeOnchainString: control characters and memos", () => {
  it("removes C0 and C1 controls, including NUL, ESC (terminal escapes) and NEL", () => {
    const result = sanitizeOnchainString("a\u0000b\u001B[31mc\u0085d\u007F", "text");
    expect(result.text).toBe("ab[31mcd");
    expect(result.flags).toEqual(["control-chars-removed"]);
  });

  it("keeps newlines in memos but not carriage returns or tabs", () => {
    const result = sanitizeOnchainString("line 1\r\nline\t2", "memo");
    expect(result.text).toBe("line 1\nline2");
    expect(result.flags).toEqual(["control-chars-removed"]);
  });

  it("removes newlines outside memos", () => {
    expect(sanitizeOnchainString("a\nb", "name").text).toBe("ab");
  });

  it("does not flag mixed scripts in memos (free text), but still strips bidi there", () => {
    const result = sanitizeOnchainString("Pay \u0440\u0443\u0431 \u202Eok", "memo");
    expect(result.flags).toEqual(["bidi-removed"]);
  });
});

describe("sanitizeOnchainString: truncation", () => {
  it("truncates names and symbols to 64 and memos/text to 512 code points", () => {
    expect(SANITIZE_LIMITS).toEqual({ memo: 512, name: 64, symbol: 64, text: 512 });
    const name = sanitizeOnchainString("x".repeat(100), "name");
    expect(name.text).toHaveLength(64);
    expect(name.flags).toEqual(["truncated"]);
    expect(sanitizeOnchainString("m".repeat(600), "memo").text).toHaveLength(512);
  });

  it("counts code points, never splitting a surrogate pair", () => {
    const result = sanitizeOnchainString("\u{1F600}".repeat(70), "name");
    expect([...result.text]).toHaveLength(64);
    expect(result.text).toBe("\u{1F600}".repeat(64));
  });

  it("truncates after removing, so hidden characters cannot push visible ones out", () => {
    const result = sanitizeOnchainString(`${"\u200B".repeat(100)}USDC`, "symbol");
    expect(result.text).toBe("USDC");
    expect(result.flags).toEqual(["zero-width-removed"]);
  });
});

describe("sanitizeOnchainString: properties", () => {
  const kinds = fc.constantFrom<SanitizeKind>("name", "symbol", "memo", "text");
  const hostile = fc.string({
    unit: fc.oneof(
      fc.constantFrom("\u202E", "\u2066", "\u200B", "\uFEFF", "\u0000", "\n", "\u0085", "\u061C"),
      fc.string({ maxLength: 1, minLength: 1, unit: "grapheme" }),
    ),
  });

  it("never outputs a removed character, never exceeds the limit, and is idempotent", () => {
    fc.assert(
      fc.property(hostile, kinds, (input, kind) => {
        const result = sanitizeOnchainString(input, kind);
        const codePoints = [...result.text].map((c) => c.codePointAt(0) ?? 0);
        expect(codePoints.some((cp) => isRemoved(cp, kind))).toBe(false);
        expect(codePoints.length).toBeLessThanOrEqual(SANITIZE_LIMITS[kind]);
        expect(result.modified).toBe(result.text !== input);
        const again = sanitizeOnchainString(result.text, kind);
        expect(again.text).toBe(result.text);
        expect(again.modified).toBe(false);
      }),
    );
  });
});

describe("sanitizeArgs", () => {
  it("sanitizes nested strings, treats `memo` fields as memos, and reports each change", () => {
    const { args, notes } = sanitizeArgs({
      amount: 5n,
      args: { memo: "hi\nthere\u202E", seed: "st\u200Bake" },
      items: [{ name: "B\u03BFnk" }],
      memo: "a\nb",
    });
    expect(args).toEqual({
      amount: 5n,
      args: { memo: "hi\nthere", seed: "stake" },
      items: [{ name: "B\u03BFnk" }],
      memo: "a\nb",
    });
    expect(notes).toEqual([
      { flags: ["bidi-removed"], modified: true, path: "args.memo" },
      { flags: ["zero-width-removed"], modified: true, path: "args.seed" },
      { flags: ["mixed-scripts"], modified: false, path: "items[0].name" },
    ]);
  });

  it("leaves decoder-built hex whole, whatever its length", () => {
    const hex = "ab".repeat(1000);
    expect(sanitizeArgs({ data: hex })).toEqual({ args: { data: hex }, notes: [] });
  });
});
