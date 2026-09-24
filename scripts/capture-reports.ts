#!/usr/bin/env -S pnpm exec tsx
/**
 * Runs Vigil's full analysis (`analyzeProposal` / `analyzeRawTransaction`, the same calls the CLI
 * makes) against a live RPC through `RecordingRpcClient`, and the program-verification API through
 * a recording HTTP client, then writes everything read into two fixtures:
 *   fixtures/cli/<name>.json            RPC answers (replayed by `FixtureRpcClient`)
 *   fixtures/cli/<name>.http.json       verification API answers, verbatim
 * so the CLI tests replay exactly what a live run saw. Only allowlisted RPC methods are called
 * (`KitRpcClient`); simulation is always `sigVerify: false`.
 *
 * Operations (combinable, run in this order, all through the same recorders):
 *   --list <multisig>               list proposals (`--limit`, default 20) and analyse the active ones
 *   --proposal <multisig>:<index>   analyse a proposal (repeatable)
 *   --raw-signature <signature>     analyse a past transaction's bytes as-is against today's state
 *   --raw-base64-file <path>        analyse the base64 transaction in a file (e.g. an unsigned one
 *                                   built by scripts/build-hostile-memo-transaction.ts)
 *   --out <dir>                     fixtures subdirectory to write to (default `cli`)
 *   --verify <program>              program information and verification (repeatable)
 *   --history <n>                   `historyDepth` for proposal analyses
 *   --gzip                          write the RPC fixture as `<name>.json.gz` (program binaries)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { type Address, address, type Signature } from "@solana/kit";
import {
  analyzeProposal,
  analyzeRawTransaction,
  rpcHostOf,
} from "../packages/core/src/analyze/index.js";
import { systemClock } from "../packages/core/src/io/clock.js";
import {
  FetchHttpClient,
  type HttpClient,
  type HttpGetOptions,
  type HttpResponse,
} from "../packages/core/src/io/http.js";
import { gatherProgramFacts } from "../packages/core/src/programs/gather.js";
import {
  addVerification,
  VERIFICATION_API,
  VerificationCache,
} from "../packages/core/src/programs/verification.js";
import { KitRpcClient } from "../packages/core/src/rpc/kit-client.js";
import { SquadsV4Adapter } from "../packages/core/src/squads/adapter.js";
import { RecordingRpcClient, recordingToFixture } from "./lib/recording-rpc.js";

const RPC_URLS: Record<string, string> = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

class RecordingHttpClient implements HttpClient {
  readonly responses: Record<string, HttpResponse> = {};
  readonly #inner = new FetchHttpClient();

  async get(url: string, options: HttpGetOptions): Promise<HttpResponse> {
    const response = await this.#inner.get(url, options);
    if (url.startsWith(VERIFICATION_API)) {
      this.responses[url.slice(VERIFICATION_API.length)] = response;
    }
    return response;
  }
}

const ACTIVE = new Set(["Draft", "Active", "Approved", "Executing"]);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cluster: { default: "mainnet", type: "string" },
      description: { type: "string" },
      gzip: { type: "boolean" },
      history: { type: "string" },
      limit: { default: "20", type: "string" },
      list: { type: "string" },
      name: { type: "string" },
      proposal: { multiple: true, type: "string" },
      out: { default: "cli", type: "string" },
      "raw-base64-file": { type: "string" },
      "raw-signature": { type: "string" },
      verify: { multiple: true, type: "string" },
    },
  });
  if (!values.name || !values.description) {
    throw new Error("--name and --description are required");
  }
  const cluster = values.cluster;
  const url = RPC_URLS[cluster];
  if (url === undefined) {
    throw new Error(`unknown cluster ${cluster}`);
  }
  const rpc = new RecordingRpcClient(new KitRpcClient(url));
  const http = new RecordingHttpClient();
  const verificationCache = new VerificationCache(systemClock);
  const deps = { clock: systemClock, http, rpc, rpcHost: rpcHostOf(url), verificationCache };
  const history = values.history === undefined ? {} : { historyDepth: Number(values.history) };
  const options = { rules: history };

  const proposals: [Address, bigint][] = (values.proposal ?? []).map((spec) => {
    const [multisig, index] = spec.split(":");
    return [address(multisig ?? ""), BigInt(index ?? "")];
  });
  if (values.list !== undefined) {
    const multisig = address(values.list);
    const entries = await new SquadsV4Adapter(rpc).listProposals(multisig, {
      limit: Number(values.limit),
    });
    for (const entry of entries) {
      const status = entry.proposal?.status.kind ?? "none";
      console.log(`#${entry.transactionIndex} ${entry.transactionKind ?? "closed"} ${status}`);
      if (entry.transactionKind !== null && !entry.isStale && ACTIVE.has(status)) {
        proposals.push([multisig, entry.transactionIndex]);
      }
    }
  }
  for (const [multisig, transactionIndex] of proposals) {
    const report = await analyzeProposal(deps, { multisig, transactionIndex }, options);
    console.log(
      `${multisig}:${transactionIndex} → ${report.verdict}`,
      report.findings.map((f) => `${f.ruleId}`).join(" "),
      report.completeness.gaps.map((g) => g.code).join(" "),
    );
  }
  if (values["raw-signature"] !== undefined) {
    const tx = await rpc.getTransaction(values["raw-signature"] as Signature);
    if (tx === null) {
      throw new Error("transaction not found");
    }
    const report = await analyzeRawTransaction(deps, tx.transactionBase64, options);
    console.log(
      `raw ${values["raw-signature"]} → ${report.verdict}`,
      report.findings.map((f) => f.ruleId).join(" "),
      report.completeness.gaps.map((g) => g.code).join(" "),
    );
    console.log(`base64: ${tx.transactionBase64}`);
  }
  if (values["raw-base64-file"] !== undefined) {
    const base64 = (await readFile(values["raw-base64-file"], "utf8")).trim();
    const report = await analyzeRawTransaction(deps, base64, options);
    console.log(
      `raw ${values["raw-base64-file"]} → ${report.verdict}`,
      report.findings.map((f) => f.ruleId).join(" "),
      report.completeness.gaps.map((g) => g.code).join(" "),
    );
  }
  for (const program of values.verify ?? []) {
    const facts = await gatherProgramFacts(rpc, {
      buffers: [],
      programs: [address(program)],
      vaults: [],
    });
    const verified = await addVerification(facts.programs, {
      cache: verificationCache,
      enabled: true,
      http,
    });
    console.log(program, verified.programs[0]?.verification, verified.gaps);
  }

  if (!/^[a-z-]+$/.test(values.out)) {
    throw new Error("--out must be a fixtures subdirectory name");
  }
  const outDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    values.out,
  );
  await mkdir(outDir, { recursive: true });
  const capturedAt = new Date().toISOString();
  const fixture = {
    capturedAt,
    cluster,
    contextSlot: rpc.contextSlot.toString(),
    description: values.description,
    ...recordingToFixture(rpc),
  };
  const bigints = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
  const text = `${JSON.stringify(fixture, bigints, 2)}\n`;
  await writeFile(
    path.join(outDir, `${values.name}.json${values.gzip === true ? ".gz" : ""}`),
    values.gzip === true ? gzipSync(text, { level: 9 }) : text,
  );
  await writeFile(
    path.join(outDir, `${values.name}.http.json`),
    `${JSON.stringify(
      {
        capturedAt,
        description: `Verification API answers recorded with ${values.name}.json`,
        endpoint: VERIFICATION_API,
        responses: http.responses,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Wrote fixtures/${values.out}/${values.name}.json${values.gzip === true ? ".gz" : ""} and .http.json`,
  );
}

await main();
