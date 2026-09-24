/**
 * The web app's Content Security Policy, in one place: `public/_headers` (Cloudflare Pages), the
 * GitHub Pages `<meta>` tag and the offline file's `<meta>` tag are all checked against it.
 */

export const OFFLINE_FILE_PREFIX = "vigil-offline-";

export type CspTarget =
  | { readonly kind: "header" }
  /** `frame-ancestors` is ignored in a `<meta>` CSP (CSP Level 3, §6.1), so it is left out. */
  | { readonly kind: "meta" }
  /** The single-file build: its inline script and style are allowed by their SHA-256 only. */
  | {
      readonly kind: "offline";
      readonly scriptHashes: readonly string[];
      readonly styleHashes: readonly string[];
    };

export function cspFor(target: CspTarget): string {
  const hashes = (list: readonly string[]) => list.map((hash) => `'sha256-${hash}'`).join(" ");
  const script = target.kind === "offline" ? hashes(target.scriptHashes) : "'self'";
  const style =
    target.kind === "offline"
      ? target.styleHashes.length === 0
        ? "'none'"
        : hashes(target.styleHashes)
      : "'self'";
  return [
    "default-src 'self'",
    `script-src ${script}`,
    `style-src ${style}`,
    "img-src 'self' data:",
    "connect-src 'self' https:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    ...(target.kind === "header" ? ["frame-ancestors 'none'"] : []),
  ].join("; ");
}

/** The exact text of every inline `<tag …>…</tag>` block (what a CSP hash covers). */
export function inlineBlocks(html: string, tag: "script" | "style"): string[] {
  const pattern = new RegExp(`<${tag}(?![^>]*\\ssrc=)[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  return [...html.matchAll(pattern)].map((match) => match[1] ?? "");
}

/** Inserts the CSP `<meta>` tag first in `<head>`, before anything it must govern. */
export function injectCspMeta(html: string, csp: string): string {
  if (!html.includes("<head>")) {
    throw new Error("index.html has no <head>");
  }
  return html.replace(
    "<head>",
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );
}
