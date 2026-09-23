import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

// In-process tests use core's source, so they never run against a stale `dist/` (the build
// order is only enforced by `pnpm build`). The spawn test runs the built binary instead.
export default defineProject({
  resolve: {
    alias: {
      "@vigil-sol/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: { name: "@vigil-sol/cli" },
});
