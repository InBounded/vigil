/**
 * Test-only: the web app's environment over real captured fixtures (`fixtures/cli/`,
 * `fixtures/web/`, see docs/DECISIONS.md). Every RPC endpoint replays the recorded mainnet
 * answers and the verification API replays its recorded answers; nothing reaches the network.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { address, isAddress } from "@solana/kit";
import {
  type AnalysisReport,
  analyzeProposal,
  analyzeRawTransaction,
  type Clock,
  FixtureRpcClient,
  type HttpClient,
  type HttpResponse,
} from "@vigil-sol/core";
import { loadFixtureFile } from "@vigil-sol/core/node";
import type { WebEnvironment } from "../env/environment.js";
import { DEFAULT_SETTINGS, type Settings } from "../settings/settings.js";
import type { SettingsStore } from "../settings/storage.js";

// `import.meta.dirname`, not `new URL(…, import.meta.url)`: under jsdom `URL` is jsdom's class,
// which Node's `fileURLToPath` refuses.
export const FIXTURES = `${resolve(import.meta.dirname, "../../../../fixtures")}/`;

/** The fixed clock of the CLI's tests: the fixtures were captured on this day. */
export const NOW = "2026-09-23T12:00:00.000Z";
export const clock: Clock = { now: () => Date.parse(NOW) };

export const UPGRADE_MULTISIG = "DQnoxvJiAYUeB5Ahp5VbsaMGMmJUA5Jr5b1nnJ2ANeMG";
export const OPAQUE_MULTISIG = "3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt";
export const BATCH_MULTISIG = "81S2mzdgrTGVjHHiJGiN2bCt8hjaiBvoNqVmYyRVzuJf";

export type FixtureName =
  | "upgrade-proposal"
  | "opaque-proposal"
  | "raw-usdc-transfer"
  | "hostile-memo"
  | "multisig-list";

const FILES: Readonly<Record<FixtureName, { readonly rpc: string; readonly http: string }>> = {
  "hostile-memo": { http: "web/hostile-memo.http.json", rpc: "web/hostile-memo.json" },
  "multisig-list": { http: "web/multisig-list.http.json", rpc: "web/multisig-list.json" },
  "opaque-proposal": { http: "cli/opaque-proposal.http.json", rpc: "cli/opaque-proposal.json.gz" },
  "raw-usdc-transfer": {
    http: "cli/raw-usdc-transfer.http.json",
    rpc: "cli/raw-usdc-transfer.json",
  },
  "upgrade-proposal": {
    http: "cli/upgrade-proposal.http.json",
    rpc: "cli/upgrade-proposal.json.gz",
  },
};

/** Settings for the fixtures (mainnet): an endpoint is set, only its host ever shows. */
export const FIXTURE_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  rpc: { devnet: "", mainnet: "https://rpc.example.test/" },
};

interface RecordedHttp {
  readonly endpoint: string;
  readonly responses: Readonly<Record<string, HttpResponse>>;
}

/** Replays the verification API answers recorded with a fixture (as the CLI's tests do). */
export class ReplayHttpClient implements HttpClient {
  readonly #recorded: RecordedHttp;

  constructor(recorded: RecordedHttp) {
    this.#recorded = recorded;
  }

  get(url: string): Promise<HttpResponse> {
    const { endpoint, responses } = this.#recorded;
    const response = url.startsWith(endpoint) ? responses[url.slice(endpoint.length)] : undefined;
    return response === undefined
      ? Promise.reject(new Error("no recorded answer"))
      : Promise.resolve(response);
  }
}

function recordedHttp(name: FixtureName): RecordedHttp {
  return JSON.parse(readFileSync(`${FIXTURES}${FILES[name].http}`, "utf8")) as RecordedHttp;
}

export function memorySettingsStore(initial: Settings = FIXTURE_SETTINGS): SettingsStore & {
  saved: Settings[];
} {
  let current = initial;
  const saved: Settings[] = [];
  return {
    clear() {
      current = DEFAULT_SETTINGS;
    },
    load: () => current,
    persistsRpc: true,
    save(settings) {
      current = settings;
      saved.push(settings);
      return true;
    },
    saved,
  };
}

export interface TestEnvironment {
  readonly environment: WebEnvironment;
  readonly clipboard: string[];
  readonly store: ReturnType<typeof memorySettingsStore>;
  /** Endpoints the app asked for, to check which URL an analysis used. */
  readonly endpoints: string[];
}

export async function fixtureEnvironment(
  name: FixtureName,
  settings: Settings = FIXTURE_SETTINGS,
  proxyUrl = "",
): Promise<TestEnvironment> {
  const data = await loadFixtureFile(`${FIXTURES}${FILES[name].rpc}`);
  const http = recordedHttp(name);
  const clipboard: string[] = [];
  const endpoints: string[] = [];
  const store = memorySettingsStore(settings);
  return {
    clipboard,
    endpoints,
    environment: {
      analysis: async () => ({
        clock,
        createHttp: () => new ReplayHttpClient(http),
        createRpc: (url) => {
          endpoints.push(url);
          return new FixtureRpcClient(data);
        },
      }),
      build: "hosted",
      proxyUrl,
      deleteLocalData: async () => {
        store.clear();
        return true;
      },
      settingsStore: store,
      writeClipboard: async (text) => {
        clipboard.push(text);
      },
    },
    store,
  };
}

/** The base64 transaction of a raw-mode fixture. */
export function rawBase64(name: "raw-usdc-transfer" | "hostile-memo"): string {
  if (name === "hostile-memo") {
    return readFileSync(`${FIXTURES}web/hostile-memo.base64`, "utf8").trim();
  }
  const fixture = JSON.parse(readFileSync(`${FIXTURES}cli/raw-usdc-transfer.json`, "utf8")) as {
    transactions: Record<string, { transactionBase64: string }>;
  };
  const [tx] = Object.values(fixture.transactions);
  if (tx === undefined) {
    throw new Error("fixture incomplete");
  }
  return tx.transactionBase64;
}

/** The real report of each verdict fixture, analysed exactly as the web app does. */
export async function fixtureReport(
  name: "upgrade-proposal" | "opaque-proposal" | "raw-usdc-transfer" | "hostile-memo",
): Promise<AnalysisReport> {
  const { environment } = await fixtureEnvironment(name);
  const analysis = await environment.analysis();
  const deps = {
    clock,
    http: analysis.createHttp(),
    rpc: analysis.createRpc("https://rpc.example.test/"),
    rpcHost: "rpc.example.test",
  };
  switch (name) {
    case "upgrade-proposal":
      return analyzeProposal(deps, { multisig: address(UPGRADE_MULTISIG), transactionIndex: 4n });
    case "opaque-proposal":
      return analyzeProposal(deps, { multisig: address(OPAQUE_MULTISIG), transactionIndex: 352n });
    case "raw-usdc-transfer":
    case "hostile-memo":
      return analyzeRawTransaction(deps, rawBase64(name));
  }
}

/**
 * An address with the same first and last four characters as `address` but different in the
 * middle (as core's tests build them): what an address-poisoning attacker grinds for.
 */
export function lookalikeOf(address: string): string {
  const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  for (let position = 5; position < address.length - 5; position++) {
    for (const char of base58) {
      const candidate = `${address.slice(0, position)}${char}${address.slice(position + 1)}`;
      if (candidate !== address && isAddress(candidate)) {
        return candidate;
      }
    }
  }
  throw new Error(`no look-alike found for ${address}`);
}
