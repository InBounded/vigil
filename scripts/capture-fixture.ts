#!/usr/bin/env -S pnpm exec tsx
/**
 * Captures real on-chain data into a fixture file under `fixtures/`, for offline decoder tests.
 * Every read goes through `KitRpcClient`, i.e. only allowlisted RPC methods are ever called.
 *
 * Two capture modes, combinable in one run:
 *   --addresses  fetches each address's current account state via getMultipleAccounts. An
 *                address with no live account (e.g. closed, rent-reclaimed) is skipped with a
 *                warning — there's nothing to capture for it.
 *   --signatures fetches each transaction's full historical record via getTransaction. Unlike an
 *                account snapshot, this is permanent: it works even for a transaction whose
 *                resulting accounts have since been closed.
 *
 * Usage:
 *   pnpm exec tsx scripts/capture-fixture.ts \
 *     --name my-fixture \
 *     --description "what this is and why it was picked" \
 *     --addresses Addr1,Addr2 \
 *     --signatures Sig1,Sig2
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Address, Signature } from "@solana/kit";
import { KitRpcClient } from "../packages/core/src/rpc/kit-client.js";

const CLUSTER_RPC_URLS: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

/** Delay between sequential `getTransaction` calls, to stay well under the public RPC's rate limit. */
const SIGNATURE_FETCH_DELAY_MS = 1_500;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      addresses: { type: "string" },
      cluster: { default: "mainnet", type: "string" },
      description: { type: "string" },
      name: { type: "string" },
      "out-dir": { type: "string" },
      "rpc-url": { type: "string" },
      signatures: { type: "string" },
    },
  });

  if (!values.name) {
    throw new Error("--name is required");
  }
  const addresses = splitList(values.addresses);
  const signatures = splitList(values.signatures);
  if (addresses.length === 0 && signatures.length === 0) {
    throw new Error("at least one of --addresses or --signatures is required");
  }

  const rpcUrl = values["rpc-url"] ?? CLUSTER_RPC_URLS[values.cluster];
  if (rpcUrl === undefined) {
    throw new Error(`unknown --cluster "${values.cluster}" and no --rpc-url given`);
  }

  const rpc = new KitRpcClient(rpcUrl);
  const accounts: Record<string, unknown> = {};
  const transactions: Record<string, unknown> = {};
  let contextSlot = 0n;

  if (addresses.length > 0) {
    console.log(`Fetching ${addresses.length} account(s) via getMultipleAccounts...`);
    const result = await rpc.getMultipleAccounts(addresses as Address[]);
    if (result.contextSlot > contextSlot) {
      contextSlot = result.contextSlot;
    }
    result.value.forEach((account, index) => {
      const address = addresses[index];
      if (account === null) {
        console.warn(`  ! ${address}: no live account (closed, or never existed) — skipped`);
        return;
      }
      accounts[address as string] = {
        dataBase64: account.dataBase64,
        executable: account.executable,
        lamports: account.lamports.toString(),
        owner: account.owner,
        space: account.space.toString(),
      };
      console.log(`  + ${address}: captured (${account.dataBase64.length} base64 chars)`);
    });
  }

  for (const [index, signature] of signatures.entries()) {
    if (index > 0) {
      await sleep(SIGNATURE_FETCH_DELAY_MS);
    }
    console.log(`Fetching transaction ${signature}...`);
    const tx = await rpc.getTransaction(signature as Signature);
    if (tx === null) {
      console.warn(`  ! ${signature}: not found — skipped`);
      continue;
    }
    if (tx.slot > contextSlot) {
      contextSlot = tx.slot;
    }
    transactions[signature] = {
      blockTime: tx.blockTime === null ? null : tx.blockTime.toString(),
      err: tx.err,
      loadedAddresses: tx.loadedAddresses,
      slot: tx.slot.toString(),
      transactionBase64: tx.transactionBase64,
    };
    console.log(`  + ${signature}: captured (slot ${tx.slot})`);
  }

  const fixture = {
    capturedAt: new Date().toISOString(),
    cluster: values.cluster,
    contextSlot: contextSlot.toString(),
    ...(values.description === undefined ? {} : { description: values.description }),
    ...(Object.keys(accounts).length > 0 ? { accounts } : {}),
    ...(Object.keys(transactions).length > 0 ? { transactions } : {}),
  };

  const outDir = values["out-dir"] ?? defaultFixturesDir();
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${values.name}.json`);
  await writeFile(outPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${outPath}`);
}

function splitList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultFixturesDir(): string {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(scriptsDir, "..", "fixtures");
}

await main();
