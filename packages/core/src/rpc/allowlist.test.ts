import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWED_RPC_METHODS, isAllowedRpcMethod } from "./allowlist.js";

describe("RPC allowlist", () => {
  it("kit-client.ts only calls allowlisted RPC methods on `this.#rpc`", async () => {
    const path = fileURLToPath(new URL("./kit-client.ts", import.meta.url));
    const source = await readFile(path, "utf8");

    const callSites = [...source.matchAll(/this\.#rpc\s*\.\s*([a-zA-Z]+)\s*\(/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);
    expect(callSites.length).toBeGreaterThan(0);

    const disallowed = callSites.filter((name) => !isAllowedRpcMethod(name));
    expect(disallowed).toEqual([]);

    // Every allowed method should actually be exercised somewhere in the file, so this test
    // fails loudly (rather than silently) if a method is removed without updating the allowlist.
    for (const method of ALLOWED_RPC_METHODS) {
      expect(callSites).toContain(method);
    }
  });
});

describe("allowlist module", () => {
  it("imports nothing, so the RPC proxy bundles only the list", async () => {
    const path = fileURLToPath(new URL("./allowlist.ts", import.meta.url));
    const source = await readFile(path, "utf8");
    expect(source).not.toMatch(/^\s*(import|export\s[^;]*\sfrom)\s/m);
  });

  it("is what the package's `rpc-allowlist` subpath exports", async () => {
    const path = fileURLToPath(new URL("../../package.json", import.meta.url));
    const manifest = JSON.parse(await readFile(path, "utf8")) as {
      exports: Record<string, { types: string; default: string }>;
    };
    expect(manifest.exports["./rpc-allowlist"]).toEqual({
      default: "./dist/rpc/allowlist.js",
      types: "./dist/rpc/allowlist.d.ts",
    });
  });
});
