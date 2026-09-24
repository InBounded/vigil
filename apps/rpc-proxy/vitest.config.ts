import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { STUB_UPSTREAM_URL, upstreamStub } from "./src/test-support/upstream-stub.js";

/**
 * Tests run inside workerd through Cloudflare's official Vitest plugin, which needs Vitest 4
 * (see docs/DECISIONS.md, Phase 9), so this package has its own Vitest and is not a project of the
 * root Vitest 5 run: `pnpm check` runs it as a separate step.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          ALLOWED_ORIGINS: "https://vigil.example, http://localhost:5173",
          // Made-up, never reachable: every outbound request goes to `upstreamStub`.
          UPSTREAM_RPC_URL: STUB_UPSTREAM_URL,
        },
        // Smaller than the deployed limit, so the tests can reach it quickly.
        ratelimits: {
          RATE_LIMITER: { namespace_id: "1001", simple: { limit: 5, period: 60 } },
        },
        outboundService: upstreamStub,
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  resolve: {
    // Core's source, as the web app's tests do: no build needed first.
    alias: [
      {
        find: /^@vigil-sol\/core\/rpc-allowlist$/,
        replacement: fileURLToPath(
          new URL("../../packages/core/src/rpc/allowlist.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    name: "@vigil/rpc-proxy",
  },
});
