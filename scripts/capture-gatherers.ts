#!/usr/bin/env -S pnpm exec tsx
/**
 * Runs Vigil's own Phase 5 gatherers (simulation, program information) against a live RPC through
 * `RecordingRpcClient` and writes everything they read into a fixture, so tests replay exactly
 * what the gatherers saw. Only allowlisted RPC methods are called (`KitRpcClient`); simulation is
 * always `sigVerify: false`. The verification API is not called here (see `capture-verification`).
 *
 * Modes (combinable):
 *   --proposal <multisig>:<index>   simulate a live Squads proposal (vault or batch)
 *   --created-by <signature>        simulate the message of a past `vaultTransactionCreate`
 *                                   (read from that transaction) against *today's* state
 *   --raw-signature <signature>     simulate a past transaction's bytes as-is against today's state
 *   --programs <a,b,...>            gather program information (loader, authority, hashes)
 *   --buffers <a,b,...>             read upgrade buffers (authority, executable hash)
 *   --accounts <a,b,...>            also capture these accounts
 *   --gzip                          write `<name>.json.gz` (for fixtures holding program binaries)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { type Address, address, type Signature } from "@solana/kit";
import { decodeRawTransaction } from "../packages/core/src/decoders/transaction.js";
import { buildLabels } from "../packages/core/src/labels/labels.js";
import { KitRpcClient } from "../packages/core/src/rpc/kit-client.js";
import { simulateRawTransaction } from "../packages/core/src/simulate/raw.js";
import {
  loadVaultTargets,
  simulateProposal,
  simulateVaultMessage,
} from "../packages/core/src/simulate/vault.js";
import { SquadsV4Adapter } from "../packages/core/src/squads/adapter.js";
import { embeddedVaultMessages } from "./lib/embedded.js";
import { RecordingRpcClient, recordingToFixture } from "./lib/recording-rpc.js";

const RPC_URLS: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

function show(label: string, value: unknown): void {
  console.log(
    `${label}:`,
    JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      accounts: { type: "string" },
      buffers: { type: "string" },
      cluster: { default: "mainnet", type: "string" },
      "created-by": { type: "string" },
      description: { type: "string" },
      gzip: { type: "boolean" },
      name: { type: "string" },
      programs: { type: "string" },
      proposal: { type: "string" },
      "raw-signature": { type: "string" },
      "rpc-url": { type: "string" },
    },
  });
  if (!values.name || !values.description) {
    throw new Error("--name and --description are required");
  }
  const cluster = values.cluster === "devnet" ? "devnet" : "mainnet";
  const url = values["rpc-url"] ?? RPC_URLS[cluster];
  if (url === undefined) {
    throw new Error("no RPC URL");
  }
  const rpc = new RecordingRpcClient(new KitRpcClient(url));

  if (values.proposal !== undefined) {
    const [multisigText, indexText] = values.proposal.split(":");
    const multisig = address(multisigText ?? "");
    const adapter = new SquadsV4Adapter(rpc);
    const bundle = await adapter.fetchProposalBundle(multisig, BigInt(indexText ?? ""));
    const targets = await loadVaultTargets(rpc, bundle);
    const labels = await buildLabels({
      cluster,
      multisig: {
        address: multisig,
        members: bundle.multisig.members.map((m) => m.key),
        ...(targets[0] === undefined ? {} : { vaultIndex: targets[0].vaultIndex }),
      },
    });
    const simulation = await simulateProposal(
      rpc,
      bundle.multisig,
      targets,
      bundle.transactionKind,
      {
        cluster,
        labels,
      },
    );
    show("proposal simulation", simulation);
  }

  if (values["created-by"] !== undefined) {
    const signature = values["created-by"] as Signature;
    const tx = await rpc.getTransaction(signature);
    if (tx === null) {
      throw new Error(`transaction ${signature} not found`);
    }
    for (const embedded of await embeddedVaultMessages(tx)) {
      const adapter = new SquadsV4Adapter(rpc);
      const multisig = await adapter.fetchMultisig(embedded.multisig);
      const labels = await buildLabels({
        cluster,
        multisig: {
          address: embedded.multisig,
          members: multisig.members.map((m) => m.key),
          vaultIndex: embedded.target.vaultIndex,
        },
      });
      show(
        `simulation of the message created by ${signature}`,
        await simulateVaultMessage(rpc, multisig, embedded.target, { cluster, labels }),
      );
    }
  }

  if (values["raw-signature"] !== undefined) {
    const signature = values["raw-signature"] as Signature;
    const tx = await rpc.getTransaction(signature);
    if (tx === null) {
      throw new Error(`transaction ${signature} not found`);
    }
    await decodeRawTransaction(rpc, tx.transactionBase64, { idl: false });
    show(
      "raw simulation",
      await simulateRawTransaction(rpc, tx.transactionBase64, { cluster, labels: new Map() }),
    );
  }

  const extra = [values.programs, values.buffers, values.accounts]
    .flatMap((list) => (list ?? "").split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => address(item));
  if (values.programs !== undefined || values.buffers !== undefined) {
    const { gatherProgramFacts } = await import("../packages/core/src/programs/gather.js");
    const programs = (values.programs ?? "")
      .split(",")
      .filter(Boolean)
      .map((a) => address(a.trim()));
    const buffers = (values.buffers ?? "")
      .split(",")
      .filter(Boolean)
      .map((a) => address(a.trim()));
    show("program facts", await gatherProgramFacts(rpc, { buffers, programs, vaults: [] }));
  } else if (extra.length > 0) {
    await rpc.getMultipleAccounts(extra as Address[]);
  }

  const fixture = {
    capturedAt: new Date().toISOString(),
    cluster,
    contextSlot: rpc.contextSlot.toString(),
    description: values.description,
    ...recordingToFixture(rpc),
  };
  const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
  await mkdir(outDir, { recursive: true });
  const text = `${JSON.stringify(fixture, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`;
  const outPath = path.join(outDir, `${values.name}.json${values.gzip === true ? ".gz" : ""}`);
  await writeFile(outPath, values.gzip === true ? gzipSync(text, { level: 9 }) : text);
  console.log(`\nWrote ${outPath}`);
}

await main();
