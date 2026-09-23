import { styleText } from "node:util";

/**
 * Code point ranges that must never reach a terminal from data: C0 controls except line feed,
 * DEL and C1 controls (an ESC in on-chain text could rewrite the screen), the Arabic letter mark,
 * zero-width and bidi controls, line/paragraph separators, word joiners and isolates, the BOM, and
 * Unicode tag characters. Core already sanitizes on-chain strings; this is a second,
 * terminal-specific barrier applied to every line of data the CLI prints.
 */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x09],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x61c, 0x61c],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

export function terminalSafe(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (!UNSAFE_RANGES.some(([from, to]) => code >= from && code <= to)) {
      out += char;
    }
  }
  return out;
}

export type Color = "red" | "yellow" | "cyan" | "green" | "gray";

/** Text styles; plain text when colour is off (`NO_COLOR`, not a terminal, `TERM=dumb`). */
export interface Style {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  color(color: Color, text: string, bold?: boolean): string;
}

/**
 * Colour follows the https://no-color.org convention (`NO_COLOR` set to anything non-empty turns
 * it off) and `FORCE_COLOR` (non-empty, not `0`, turns it on); otherwise it is on only for a
 * terminal whose `TERM` is not `dumb`. Colour is never the only signal: every severity also has
 * a symbol and a word.
 */
export function createStyle(
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean,
): Style {
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0";
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const enabled = !noColor && (forced || (isTTY && env.TERM !== "dumb"));
  const apply = (format: Parameters<typeof styleText>[0], text: string) =>
    enabled ? styleText(format, text, { validateStream: false }) : text;
  return {
    bold: (text) => apply("bold", text),
    color: (color, text, bold = false) => apply(bold ? [color, "bold"] : color, text),
    dim: (text) => apply("dim", text),
    enabled,
  };
}

/** Width to lay text out in: the terminal's, kept between 40 and 100; 80 when not a terminal. */
export function layoutWidth(isTTY: boolean, columns: number | undefined): number {
  if (!isTTY || columns === undefined || !Number.isFinite(columns)) {
    return 80;
  }
  return Math.max(40, Math.min(100, Math.floor(columns)));
}

/**
 * Word-wraps `text` to `width` columns: the first line starts with `first`, the others with
 * `rest`. Words are never split, so an address longer than the line stays whole (and copyable).
 */
export function wrap(text: string, width: number, first = "", rest = first): string[] {
  const lines: string[] = [];
  for (const paragraph of terminalSafe(text).split("\n")) {
    let line = lines.length === 0 ? first : rest;
    let prefixOnly = true;
    for (const word of paragraph.split(" ")) {
      if (word === "") {
        continue;
      }
      const candidate = prefixOnly ? `${line}${word}` : `${line} ${word}`;
      if (!prefixOnly && [...candidate].length > width) {
        lines.push(line);
        line = `${rest}${word}`;
      } else {
        line = candidate;
      }
      prefixOnly = false;
    }
    lines.push(line);
  }
  return lines;
}
