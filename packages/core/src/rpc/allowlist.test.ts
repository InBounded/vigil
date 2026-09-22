import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every RPC method allowed anywhere in this project, per `docs/reference.md` §4. Sending methods
 * (e.g. `sendTransaction`) and expensive/unbounded methods (e.g. `getProgramAccounts`) are never
 * allowed, no matter how convenient.
 */
const ALLOWED_METHODS = [
  "getAccountInfo",
  "getMultipleAccounts",
  "getGenesisHash",
  "getSlot",
  "getSignaturesForAddress",
  "getTransaction",
  "simulateTransaction",
] as const;

describe("RPC allowlist", () => {
  it("kit-client.ts only calls allowlisted RPC methods on `this.#rpc`", async () => {
    const path = fileURLToPath(new URL("./kit-client.ts", import.meta.url));
    const source = await readFile(path, "utf8");

    const callSites = [...source.matchAll(/this\.#rpc\s*\.\s*([a-zA-Z]+)\s*\(/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);
    expect(callSites.length).toBeGreaterThan(0);

    const disallowed = callSites.filter(
      (name) => !(ALLOWED_METHODS as readonly string[]).includes(name),
    );
    expect(disallowed).toEqual([]);

    // Every allowed method should actually be exercised somewhere in the file, so this test
    // fails loudly (rather than silently) if a method is removed without updating the allowlist.
    for (const method of ALLOWED_METHODS) {
      expect(callSites).toContain(method);
    }
  });
});
