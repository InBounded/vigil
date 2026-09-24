/**
 * Last barrier before any report text reaches the page, after core's sanitizer (as the CLI's
 * `terminalSafe`): removes C0/C1 control characters (keeping line breaks and tabs), bidi
 * controls, zero-width and other invisible characters, line/paragraph separators and Unicode tag
 * characters. Core already sanitizes on-chain strings; this also covers text core passes through
 * as-is (simulation logs, error messages from the RPC). React renders it as text, never as HTML.
 */
export function safeText(text: string): string {
  let out = "";
  for (const char of text) {
    if (!isUnsafe(char.codePointAt(0) ?? 0)) {
      out += char;
    }
  }
  return out;
}

function isUnsafe(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}
