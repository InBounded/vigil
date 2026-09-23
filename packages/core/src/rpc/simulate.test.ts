/**
 * `KitRpcClient.simulateTransaction` against a local endpoint that answers with real mainnet
 * responses recorded verbatim (`fixtures/http/simulate-response-raw.json`).
 */
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { type Address, address } from "@solana/kit";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { describeRpcFailure } from "../simulate/run.js";
import { KitRpcClient } from "./kit-client.js";

interface Exchange {
  readonly source: string;
  readonly request: {
    readonly params: [string, { readonly accounts: { readonly addresses: Address[] } }];
  };
  readonly responseBody: string;
}

let exchanges: readonly Exchange[];
beforeAll(async () => {
  const path = fileURLToPath(
    new URL("../../../../fixtures/http/simulate-response-raw.json", import.meta.url),
  );
  exchanges = (JSON.parse(await readFile(path, "utf8")) as { exchanges: Exchange[] }).exchanges;
});

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** Serves `reply(requestBody)`; records every JSON-RPC request it receives. */
async function endpoint(reply: (request: { id: unknown }) => { status: number; body: string }) {
  const requests: { method: string; params: unknown[] }[] = [];
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const rpc = JSON.parse(body) as { id: unknown; method: string; params: unknown[] };
      requests.push({ method: rpc.method, params: rpc.params });
      const { status, body: answer } = reply(rpc);
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(answer.replace(/"id":\s*1\b/, `"id":${JSON.stringify(rpc.id)}`));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { requests, url: `http://127.0.0.1:${port}` };
}

function exchange(prefix: string): Exchange {
  const found = exchanges.find((e) => e.source.startsWith(prefix));
  if (found === undefined) {
    throw new Error(`no exchange ${prefix}`);
  }
  return found;
}

describe("KitRpcClient.simulateTransaction", () => {
  it("sends sigVerify false and the requested options, and parses a real answer", async () => {
    const real = exchange("simulation-opaque");
    const { requests, url } = await endpoint(() => ({ body: real.responseBody, status: 200 }));
    const [transaction, config] = real.request.params;
    const result = await new KitRpcClient(url).simulateTransaction(transaction, {
      accounts: config.accounts.addresses,
      innerInstructions: true,
      minContextSlot: 5n,
      replaceRecentBlockhash: true,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("simulateTransaction");
    expect(requests[0]?.params).toEqual([
      transaction,
      {
        accounts: { addresses: config.accounts.addresses, encoding: "base64" },
        commitment: "confirmed",
        encoding: "base64",
        innerInstructions: true,
        minContextSlot: 5,
        replaceRecentBlockhash: true,
        sigVerify: false,
      },
    ]);
    const body = JSON.parse(real.responseBody) as { result: { context: { slot: number } } };
    expect(result.contextSlot).toBe(BigInt(body.result.context.slot));
    expect(result.err).toBeNull();
    expect(result.fee).toBe(5000n);
    expect(result.innerInstructionPrograms).toEqual([
      { index: 0, programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] },
    ]);
    expect(result.accounts).toHaveLength(config.accounts.addresses.length);
    const vaultTokenAccount = result.postTokenBalances?.find(
      (b) => b.owner === address("7rzEKejyAXJXMkGfRhMV9Vg1k7tFznBBEFu3sfLNz8LC"),
    );
    expect(vaultTokenAccount).toMatchObject({
      decimals: 9,
      mint: "5Uzafw84V9rCTmYULqdJA115K6zHP16vR15zrcqa6r6C",
    });
    expect(typeof vaultTokenAccount?.amount).toBe("bigint");
    expect(result.preBalances?.every((b) => typeof b === "bigint")).toBe(true);
    expect(result.loadedAddresses).toEqual({ readonly: [], writable: [] });
  });

  it("reports an answer without inner instructions as an empty list, and none requested as null", async () => {
    const real = exchange("simulation-sol-usdc");
    const { url, requests } = await endpoint(() => ({ body: real.responseBody, status: 200 }));
    const [transaction] = real.request.params;
    const client = new KitRpcClient(url);
    expect(
      (
        await client.simulateTransaction(transaction, {
          innerInstructions: true,
          replaceRecentBlockhash: true,
        })
      ).innerInstructionPrograms,
    ).toEqual([]);
    const plain = await client.simulateTransaction(transaction);
    expect(plain.accounts).toBeNull();
    expect(requests[1]?.params[1]).toEqual({
      accounts: { addresses: [], encoding: "base64" },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: false,
      sigVerify: false,
    });
  });

  it("treats malformed optional fields from the RPC as absent rather than trusting them", async () => {
    const real = exchange("simulation-opaque");
    const tampered = JSON.parse(real.responseBody) as {
      result: { value: Record<string, unknown> };
    };
    const value = tampered.result.value;
    value.innerInstructions = [{ index: 0, instructions: [{ programIdIndex: 3 }] }];
    (value.preTokenBalances as { uiTokenAmount: { amount: string } }[])[0] = {
      ...(value.preTokenBalances as object[])[0],
      uiTokenAmount: { amount: "1e9", decimals: 9 },
    } as { uiTokenAmount: { amount: string } };
    value.fee = null;
    const { url } = await endpoint(() => ({ body: JSON.stringify(tampered), status: 200 }));
    const [transaction] = real.request.params;
    const result = await new KitRpcClient(url).simulateTransaction(transaction, {
      innerInstructions: true,
    });
    expect(result.innerInstructionPrograms).toBeNull();
    expect(result.preTokenBalances).toBeNull();
    expect(result.fee).toBeNull();
  });

  it("surfaces a JSON-RPC refusal and an HTTP failure without leaking the endpoint URL", async () => {
    const refusing = await endpoint(() => ({
      body: JSON.stringify({
        error: {
          code: -32602,
          message: "invalid transaction: Transaction failed to sanitize accounts offsets correctly",
        },
        id: 1,
        jsonrpc: "2.0",
      }),
      status: 200,
    }));
    const refused = await new KitRpcClient(refusing.url)
      .simulateTransaction("AA==")
      .catch((e: unknown) => e);
    expect(describeRpcFailure(refused)).toEqual({
      code: "rpc-refused",
      reason:
        "the RPC refused the simulation (-32602): invalid transaction: Transaction failed to sanitize accounts offsets correctly",
    });
    server?.close();
    const failing = await endpoint(() => ({ body: "oops", status: 503 }));
    const secretUrl = `${failing.url}/?api-key=SECRET`;
    const down = await new KitRpcClient(secretUrl, { maxRetryAttempts: 1 })
      .simulateTransaction("AA==")
      .catch((e: unknown) => e);
    const described = describeRpcFailure(down);
    expect(described).toEqual({ code: "rpc-error", reason: "the RPC endpoint answered HTTP 503" });
    expect(JSON.stringify(described)).not.toContain("SECRET");
    expect(describeRpcFailure(new Error(`fetch ${secretUrl} failed`))).toEqual({
      code: "rpc-error",
      reason: "the RPC endpoint could not be reached or gave an invalid answer",
    });
  });
});
