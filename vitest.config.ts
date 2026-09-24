import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // apps/rpc-proxy runs its own Vitest 4 under Cloudflare's plugin (`pnpm test:proxy`); see
    // docs/DECISIONS.md, Phase 9.
    projects: ["packages/*", "apps/web"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**", "apps/*/src/**"],
      // Shared builders for tests only; not shipped (excluded from the build too).
      exclude: ["packages/*/src/test-support/**", "apps/rpc-proxy/**"],
      thresholds: {
        // Acceptance criterion of Phase 4: every branch of the rules engine is tested.
        "packages/core/src/rules/**": { 100: true, perFile: true },
      },
    },
  },
});
