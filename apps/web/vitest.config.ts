import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

export default defineProject({
  define: {
    __VIGIL_BUILD__: JSON.stringify("hosted"),
    __VIGIL_COMMIT__: JSON.stringify("test"),
    // Tests pass the proxy URL explicitly where it matters.
    __VIGIL_PROXY_URL__: JSON.stringify(""),
    __VIGIL_VERSION__: JSON.stringify("0.0.0-test"),
  },
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@vigil-sol\/core$/,
        replacement: fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      },
      {
        find: /^@vigil-sol\/core\/node$/,
        replacement: fileURLToPath(new URL("../../packages/core/src/node.ts", import.meta.url)),
      },
    ],
  },
  test: {
    name: "@vigil/web",
    environment: "jsdom",
    setupFiles: ["./src/test-support/setup.ts"],
  },
});
