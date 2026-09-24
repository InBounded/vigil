import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { cspFor, injectCspMeta, inlineBlocks, OFFLINE_FILE_PREFIX } from "./scripts/csp.js";

/**
 * Three builds from one source (see docs/DECISIONS.md, Phase 7):
 * - default (`dist/`): Cloudflare Pages; the CSP and security headers come from `public/_headers`.
 * - `ghpages` (`dist-ghpages/`): GitHub Pages mirror; no custom headers there, so the CSP is a
 *   `<meta>` tag (where `frame-ancestors` has no effect).
 * - `offline` (`dist-offline/`): one self-contained HTML file with its SHA-256. Its script and
 *   style are inline, so its `<meta>` CSP allows exactly those by hash instead of `'self'`.
 */
export default defineConfig(({ mode }) => {
  const version = (
    JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;
  const offline = mode === "offline";
  const ghpages = mode === "ghpages";
  return {
    base: "./",
    build: {
      outDir: offline ? "dist-offline" : ghpages ? "dist-ghpages" : "dist",
      emptyOutDir: true,
      // No source maps in production: they would ship the whole source a second time.
      sourcemap: false,
      target: "es2023",
    },
    define: {
      __VIGIL_VERSION__: JSON.stringify(version),
      __VIGIL_COMMIT__: JSON.stringify(gitCommit()),
      __VIGIL_BUILD__: JSON.stringify(offline ? "offline" : ghpages ? "ghpages" : "hosted"),
    },
    plugins: [
      react(),
      ...(offline ? [viteSingleFile({ removeViteModuleLoader: true }), offlineCsp(version)] : []),
      ...(ghpages ? [metaCsp()] : []),
    ],
    // `_headers` is for Cloudflare Pages only.
    publicDir: offline || ghpages ? false : "public",
    resolve: {
      // Core's source, as in the CLI's tests: never a stale `dist/`, and no build order needed.
      alias: [
        {
          find: /^@vigil-sol\/core$/,
          replacement: fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
        },
      ],
    },
  };
});

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** GitHub Pages: the same policy as `_headers`, as a `<meta>` tag at the top of `<head>`. */
function metaCsp(): Plugin {
  return {
    name: "vigil-meta-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html) => injectCspMeta(html, cspFor({ kind: "meta" })),
    },
  };
}

/**
 * Offline file: after vite-plugin-singlefile inlined everything, hash the inline script and
 * style, allow exactly those in the `<meta>` CSP, rename the file with the version and write its
 * SHA-256 next to it in `sha256sum` format.
 */
function offlineCsp(version: string): Plugin {
  return {
    name: "vigil-offline-csp",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = bundle["index.html"];
      if (html === undefined || html.type !== "asset" || typeof html.source !== "string") {
        this.error("offline build: index.html missing from the bundle");
      }
      const scripts = inlineBlocks(html.source, "script");
      const styles = inlineBlocks(html.source, "style");
      if (scripts.length === 0) {
        this.error("offline build: no inline script found");
      }
      const csp = cspFor({
        kind: "offline",
        scriptHashes: scripts.map(sha256Base64),
        styleHashes: styles.map(sha256Base64),
      });
      const source = injectCspMeta(html.source, csp);
      const fileName = `${OFFLINE_FILE_PREFIX}${version}.html`;
      delete bundle["index.html"];
      this.emitFile({ fileName, source, type: "asset" });
      const digest = createHash("sha256").update(source, "utf8").digest("hex");
      this.emitFile({
        fileName: `${fileName}.sha256`,
        source: `${digest}  ${fileName}\n`,
        type: "asset",
      });
    },
  };
}

function sha256Base64(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("base64");
}
