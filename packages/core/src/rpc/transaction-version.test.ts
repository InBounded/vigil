import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { signature } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixtureFile } from "./fixture-file.js";
import { KitRpcClient } from "./kit-client.js";

const FIXTURE = fileURLToPath(
  new URL("../../../../fixtures/native-instructions.json", import.meta.url),
);
// A real legacy transaction from the fixture, served by the fake endpoint.
const SIGNATURE = signature(
  "D78nFyzrJE9ZqX9WjsMW8ERUkDJVr8VESBYDa74RypbNzRHHxavFN8kLTRU71xUYfg1sHoWjX8E6d8Maqrqu93o",
);

type Behaviour = "rejects-v1" | "supports-v1" | "version-too-high";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A minimal JSON-RPC endpoint for `getTransaction`, recording the version each request asked for. */
async function fakeEndpoint(behaviour: Behaviour) {
  const data = await loadFixtureFile(FIXTURE);
  const tx = data.transactions.get(SIGNATURE);
  if (tx === undefined) {
    throw new Error("fixture is missing the transaction");
  }
  const requestedVersions: unknown[] = [];
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const rpc = JSON.parse(body) as { id: unknown; params: [string, Record<string, unknown>] };
      const version = rpc.params[1].maxSupportedTransactionVersion;
      requestedVersions.push(version);
      const reply = (payload: object) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", ...payload }));
      };
      if (behaviour === "rejects-v1" && version === 1) {
        reply({
          error: { code: -32602, message: "Invalid params: maxSupportedTransactionVersion" },
        });
      } else if (behaviour === "version-too-high") {
        reply({ error: { code: -32015, message: "Transaction version (2) is not supported" } });
      } else {
        reply({
          result: {
            blockTime: Number(tx.blockTime),
            meta: { err: null, loadedAddresses: { readonly: [], writable: [] } },
            slot: Number(tx.slot),
            transaction: [tx.transactionBase64, "base64"],
            version: "legacy",
          },
        });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    requestedVersions,
    transactionBase64: tx.transactionBase64,
    url: `http://127.0.0.1:${port}`,
  };
}

describe("KitRpcClient.getTransaction transaction-version negotiation", () => {
  it("asks for v1 and records no limitation when the endpoint supports it", async () => {
    const endpoint = await fakeEndpoint("supports-v1");
    const client = new KitRpcClient(endpoint.url, { maxRetryAttempts: 1 });
    const tx = await client.getTransaction(SIGNATURE);
    expect(tx?.transactionBase64).toBe(endpoint.transactionBase64);
    expect(endpoint.requestedVersions).toEqual([1]);
    expect(client.limitations()).toEqual([]);
  });

  it("falls back to 0 once, remembers it, and records a gap when the endpoint rejects v1", async () => {
    const endpoint = await fakeEndpoint("rejects-v1");
    const client = new KitRpcClient(endpoint.url, { maxRetryAttempts: 1 });
    const first = await client.getTransaction(SIGNATURE);
    const second = await client.getTransaction(SIGNATURE);
    expect(first?.transactionBase64).toBe(endpoint.transactionBase64);
    expect(second?.transactionBase64).toBe(endpoint.transactionBase64);
    expect(endpoint.requestedVersions).toEqual([1, 0, 0]);
    expect(client.limitations()).toEqual([
      expect.objectContaining({ code: "RPC_TRANSACTION_VERSION_UNSUPPORTED" }),
    ]);
  });

  it("does not swallow other errors (e.g. a transaction newer than v1)", async () => {
    const endpoint = await fakeEndpoint("version-too-high");
    const client = new KitRpcClient(endpoint.url, { maxRetryAttempts: 1 });
    await expect(client.getTransaction(SIGNATURE)).rejects.toThrow();
    expect(endpoint.requestedVersions).toEqual([1]);
    expect(client.limitations()).toEqual([]);
  });
});
