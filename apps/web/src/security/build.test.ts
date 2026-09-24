/**
 * The Content Security Policy and the built output of the three builds (`pnpm check` builds
 * before it tests; see docs/DECISIONS.md, Phase 7): headers for Cloudflare Pages, the `<meta>`
 * CSP of the GitHub Pages mirror, and the offline single file with its hashes and SHA-256.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cspFor, inlineBlocks, OFFLINE_FILE_PREFIX } from "../../scripts/csp.js";

const ROOT = resolve(import.meta.dirname, "../..");
const HOSTED = join(ROOT, "dist");
const GHPAGES = join(ROOT, "dist-ghpages");
const OFFLINE = join(ROOT, "dist-offline");

/** The policy exactly as the phase specification states it. */
const SPECIFIED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function headers(file: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      map.set(match[1], match[2].trim());
    }
  }
  return map;
}

function metaCsp(html: string): string | undefined {
  return /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
}

/** `src`/`href` values of the page's own resources (not `<a>` links, which are only links). */
function resourceUrls(html: string): string[] {
  return [
    ...html.matchAll(
      /<(?:script|link|img|iframe|source|embed|object)\b[^>]*?\b(?:src|href)="([^"]*)"/g,
    ),
  ].map((match) => match[1] ?? "");
}

function builtFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out;
}

describe("Content Security Policy", () => {
  it("is exactly the specified policy for the hosted build", () => {
    expect(cspFor({ kind: "header" })).toBe(SPECIFIED_CSP);
  });

  it("public/_headers sends it with the other security headers", () => {
    const sent = headers(join(ROOT, "public", "_headers"));
    expect(sent.get("Content-Security-Policy")).toBe(SPECIFIED_CSP);
    expect(sent.get("X-Frame-Options")).toBe("DENY");
    expect(sent.get("Referrer-Policy")).toBe("no-referrer");
    expect(sent.get("X-Content-Type-Options")).toBe("nosniff");
    const permissions = sent.get("Permissions-Policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      expect(permissions).toContain(`${feature}=()`);
    }
    // The copy buttons need clipboard writing, which the page's own origin keeps by default.
    expect(permissions).not.toContain("clipboard-write");
  });

  it("the <meta> variant only leaves out frame-ancestors, which browsers ignore in <meta>", () => {
    expect(cspFor({ kind: "meta" })).toBe(SPECIFIED_CSP.replace("; frame-ancestors 'none'", ""));
  });

  it("the offline variant allows exactly the given hashes, never 'self' or 'unsafe-inline'", () => {
    const csp = cspFor({ kind: "offline", scriptHashes: ["abc="], styleHashes: ["def="] });
    expect(csp).toContain("script-src 'sha256-abc='");
    expect(csp).toContain("style-src 'sha256-def='");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).not.toContain("script-src 'self'");
  });
});

describe("built output", () => {
  beforeAll(() => {
    for (const dir of [HOSTED, GHPAGES, OFFLINE]) {
      if (!existsSync(dir)) {
        throw new Error(`${dir} does not exist: run pnpm build first (pnpm check does)`);
      }
    }
  });

  it("hosted: the headers file ships, scripts and styles are the page's own files", () => {
    expect(readFileSync(join(HOSTED, "_headers"), "utf8")).toBe(
      readFileSync(join(ROOT, "public", "_headers"), "utf8"),
    );
    const html = readFileSync(join(HOSTED, "index.html"), "utf8");
    expect(metaCsp(html)).toBeUndefined();
    const urls = resourceUrls(html);
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) {
      expect(url).toMatch(/^(\.\/assets\/|data:image\/svg\+xml,)/);
    }
    // Code splitting: the start page's script does not contain the analysis engine.
    const entry = /<script type="module"[^>]*src="\.\/assets\/([^"]+)"/.exec(html)?.[1] ?? "";
    const entryCode = readFileSync(join(HOSTED, "assets", entry), "utf8");
    expect(entryCode).not.toContain("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
  });

  it("GitHub Pages: the CSP is the first thing in <head>, and no headers file", () => {
    const html = readFileSync(join(GHPAGES, "index.html"), "utf8");
    expect(html).toMatch(/<head>\s*<meta http-equiv="Content-Security-Policy"/);
    expect(metaCsp(html)).toBe(cspFor({ kind: "meta" }));
    expect(existsSync(join(GHPAGES, "_headers"))).toBe(false);
  });

  it("offline: one self-contained file whose CSP hashes match its inline script and style", () => {
    const files = readdirSync(OFFLINE).sort();
    expect(files).toHaveLength(2);
    const [htmlName, shaName] = files;
    expect(htmlName).toMatch(new RegExp(`^${OFFLINE_FILE_PREFIX}\\d+\\.\\d+\\.\\d+.*\\.html$`));
    expect(shaName).toBe(`${htmlName}.sha256`);
    const html = readFileSync(join(OFFLINE, htmlName ?? ""), "utf8");
    expect(html).toMatch(/<head>\s*<meta http-equiv="Content-Security-Policy"/);
    const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("base64");
    const scripts = inlineBlocks(html, "script");
    const styles = inlineBlocks(html, "style");
    expect(scripts).toHaveLength(1);
    expect(styles).toHaveLength(1);
    expect(metaCsp(html)).toBe(
      cspFor({ kind: "offline", scriptHashes: scripts.map(hash), styleHashes: styles.map(hash) }),
    );
    // Nothing is loaded from anywhere: no src/href resource other than the inline favicon.
    for (const url of resourceUrls(html)) {
      expect(url).toMatch(/^data:image\/svg\+xml,/);
    }
  });

  it("offline: the .sha256 file is the file's real SHA-256, in sha256sum format", () => {
    const [htmlName] = readdirSync(OFFLINE).filter((name) => name.endsWith(".html"));
    const bytes = readFileSync(join(OFFLINE, htmlName ?? ""));
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(readFileSync(join(OFFLINE, `${htmlName}.sha256`), "utf8")).toBe(
      `${digest}  ${htmlName}\n`,
    );
  });

  it("no build loads fonts or anything else from a third party", () => {
    for (const dir of [HOSTED, GHPAGES, OFFLINE]) {
      for (const file of builtFiles(dir).filter((f) => /\.(css|html)$/.test(f))) {
        const text = readFileSync(file, "utf8");
        expect(text, file).not.toMatch(/@font-face|@import|url\(\s*["']?https?:/);
        expect(text, file).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\./);
      }
    }
  });
});
