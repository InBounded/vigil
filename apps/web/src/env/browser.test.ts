/**
 * The real browser environment (`browser.ts`, `browser-analysis.ts`) on jsdom: real
 * `localStorage`, IndexedDB (fake-indexeddb, the same engine the IDL cache tests use), and the
 * real `KitRpcClient` / `FetchHttpClient` with `fetch` stubbed, so each test sees exactly what
 * would go over the wire. Nothing reaches the network.
 */
import { address } from "@solana/kit";
import { HttpError } from "@vigil-sol/core";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../settings/settings.js";
import { browserEnvironment } from "./browser.js";
import { browserAnalysisEnvironment } from "./browser-analysis.js";

const RPC_URL = "https://rpc.example.test/?api-key=secret";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  crossCheckRpc: { devnet: "", mainnet: "https://second.example.test/" },
  rpc: { devnet: "", mainnet: RPC_URL },
};

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** Stubs `fetch`: records every request, answers with `answer(request body)`. */
function stubFetch(answer: (body: unknown) => unknown): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({ init, url });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify(answer(body)), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  });
  return sent;
}

function withIndexedDb(): IDBFactory {
  const factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  return factory;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("browserEnvironment: settings in localStorage", () => {
  it("hosted build: stores settings, RPC endpoints included, and a new page reads them back", () => {
    const environment = browserEnvironment("hosted");
    expect(environment.build).toBe("hosted");
    expect(environment.settingsStore.persistsRpc).toBe(true);
    expect(environment.settingsStore.save(SETTINGS)).toBe(true);
    expect(localStorage.getItem("vigil.settings")).toContain("rpc.example.test");
    expect(browserEnvironment("hosted").settingsStore.load()).toEqual(SETTINGS);
  });

  it("GitHub Pages build stores like the hosted one", () => {
    const environment = browserEnvironment("ghpages");
    expect(environment.settingsStore.persistsRpc).toBe(true);
    environment.settingsStore.save(SETTINGS);
    expect(browserEnvironment("ghpages").settingsStore.load()).toEqual(SETTINGS);
  });

  it("offline build: never writes an RPC endpoint to storage", () => {
    const environment = browserEnvironment("offline");
    expect(environment.settingsStore.persistsRpc).toBe(false);
    expect(environment.settingsStore.save(SETTINGS)).toBe(true);
    const stored = localStorage.getItem("vigil.settings") ?? "";
    expect(stored).not.toContain("example.test");
    expect(stored).not.toContain("secret");
    expect(browserEnvironment("offline").settingsStore.load()).toEqual({
      ...SETTINGS,
      crossCheckRpc: DEFAULT_SETTINGS.crossCheckRpc,
      rpc: DEFAULT_SETTINGS.rpc,
    });
  });

  it("only its own key: other data of the origin is left alone", () => {
    localStorage.setItem("someone-else", "keep");
    const environment = browserEnvironment("hosted");
    environment.settingsStore.save(SETTINGS);
    environment.settingsStore.clear();
    expect(localStorage.getItem("vigil.settings")).toBeNull();
    expect(localStorage.getItem("someone-else")).toBe("keep");
  });

  it("works when the browser blocks storage", () => {
    vi.stubGlobal("localStorage", undefined);
    const environment = browserEnvironment("hosted");
    expect(environment.settingsStore.load()).toEqual(DEFAULT_SETTINGS);
    expect(environment.settingsStore.save(SETTINGS)).toBe(false);
  });

  it("works when even reading localStorage throws (some privacy settings)", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    if (original === undefined) {
      throw new Error("expected jsdom's localStorage on the global object");
    }
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    try {
      const environment = browserEnvironment("hosted");
      expect(environment.settingsStore.load()).toEqual(DEFAULT_SETTINGS);
      expect(environment.settingsStore.save(SETTINGS)).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "localStorage", original);
    }
    expect(typeof localStorage.getItem).toBe("function");
  });
});

describe("browserEnvironment: clipboard and lazy analysis environment", () => {
  it("copies through navigator.clipboard, and reports a refusal", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const environment = browserEnvironment("hosted");
    await environment.writeClipboard("report text");
    expect(writeText).toHaveBeenCalledWith("report text");
    writeText.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await expect(environment.writeClipboard("again")).rejects.toThrow("denied");
  });

  it("loads the analysis environment once, on first use", async () => {
    const environment = browserEnvironment("hosted");
    const first = environment.analysis();
    expect(environment.analysis()).toBe(first);
    const analysis = await first;
    expect(analysis.idlCache).toBeDefined();
    expect(Math.abs(analysis.clock.now() - Date.now())).toBeLessThan(5_000);
  });
});

describe("browserAnalysisEnvironment: RPC", () => {
  it("sends allowlisted JSON-RPC calls to exactly the configured endpoint", async () => {
    const sent = stubFetch((body) => {
      const request = body as { id: unknown; method: string };
      return { id: request.id, jsonrpc: "2.0", result: DEVNET_GENESIS };
    });
    const rpc = browserAnalysisEnvironment().createRpc(RPC_URL);
    expect(await rpc.getGenesisHash()).toBe(DEVNET_GENESIS);
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe(RPC_URL);
    expect(request?.init?.method).toBe("POST");
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({
      jsonrpc: "2.0",
      method: "getGenesisHash",
    });
  });

  it("reads accounts through the same endpoint", async () => {
    const sent = stubFetch((body) => {
      const request = body as { id: unknown };
      return { id: request.id, jsonrpc: "2.0", result: { context: { slot: 42 }, value: null } };
    });
    const rpc = browserAnalysisEnvironment().createRpc(RPC_URL);
    const result = await rpc.getAccountInfo(address(SQUADS));
    expect(result).toEqual({ contextSlot: 42n, value: null });
    expect(sent.map((request) => request.url)).toEqual([RPC_URL]);
    const body = JSON.parse(String(sent[0]?.init?.body)) as { method: string; params: unknown[] };
    expect(body.method).toBe("getAccountInfo");
    expect(body.params[0]).toBe(SQUADS);
  });

  it("a failing endpoint surfaces as an error, never as data", async () => {
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    const rpc = browserAnalysisEnvironment().createRpc(RPC_URL);
    await expect(rpc.getGenesisHash()).rejects.toThrow();
  }, 30_000);
});

describe("browserAnalysisEnvironment: HTTP", () => {
  it("fetches the verification API with no credentials, no referrer, no redirects", async () => {
    const sent = stubFetch(() => ({ is_verified: false }));
    const http = browserAnalysisEnvironment().createHttp();
    const response = await http.get(`https://verify.osec.io/status/${SQUADS}`, {
      maxBytes: 100_000,
      timeoutMs: 5_000,
    });
    expect(response).toEqual({ status: 200, text: '{"is_verified":false}' });
    expect(sent[0]?.url).toBe(`https://verify.osec.io/status/${SQUADS}`);
    expect(sent[0]?.init).toMatchObject({
      credentials: "omit",
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  });

  it("refuses any other host before sending anything", async () => {
    const sent = stubFetch(() => ({}));
    const http = browserAnalysisEnvironment().createHttp();
    const attempt = http.get("https://tracker.example.test/pixel", { maxBytes: 10, timeoutMs: 10 });
    await expect(attempt).rejects.toBeInstanceOf(HttpError);
    await expect(attempt).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
    expect(sent).toEqual([]);
  });
});

describe("IDL cache and deleting local data", () => {
  it("caches IDLs in IndexedDB", async () => {
    withIndexedDb();
    const { idlCache } = browserAnalysisEnvironment();
    await idlCache?.set("program:hash", '{"instructions":[]}');
    expect(await browserAnalysisEnvironment().idlCache?.get("program:hash")).toBe(
      '{"instructions":[]}',
    );
  });

  it("deletes the settings and the whole IDL cache", async () => {
    withIndexedDb();
    const environment = browserEnvironment("hosted");
    environment.settingsStore.save(SETTINGS);
    const analysis = await environment.analysis();
    await analysis.idlCache?.set("program:hash", "{}");
    expect(await environment.deleteLocalData()).toBe(true);
    expect(localStorage.getItem("vigil.settings")).toBeNull();
    expect(await browserAnalysisEnvironment().idlCache?.get("program:hash")).toBeUndefined();
  });

  it("deletes the settings even where IndexedDB does not exist", async () => {
    // jsdom has no IndexedDB of its own.
    expect(globalThis.indexedDB).toBeUndefined();
    const environment = browserEnvironment("hosted");
    environment.settingsStore.save(SETTINGS);
    expect(await environment.deleteLocalData()).toBe(true);
    expect(localStorage.getItem("vigil.settings")).toBeNull();
    expect(await (await environment.analysis()).idlCache?.get("anything")).toBeUndefined();
  });
});
