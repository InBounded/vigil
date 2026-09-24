import { isAddress } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { PUBLIC_DEVNET_RPC, resolveEndpoints } from "../analysis/endpoints.js";
import { analysisOptions } from "../analysis/options.js";
import { DEFAULT_SETTINGS, type Settings, validateSettings } from "./settings.js";
import { browserSettingsStore } from "./storage.js";

const MEMBER = "7Ky8kVEfjm66ZLvZ9VcP9rJ5yN2XSyiXLr7F3vqS2QKB";

class MemoryStorage implements Storage {
  readonly map = new Map<string, string>();
  fail = false;
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.fail) {
      throw new Error("QuotaExceededError");
    }
    this.map.set(key, value);
  }
}

const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  crossCheckRpc: { devnet: "", mainnet: "https://second.example.test/" },
  historyDepth: 150,
  knownAddresses: [{ address: MEMBER as never, label: "Treasury" }],
  largeTransferAbsolute: { SOL: "10", USDC: "250,000", USDT: "" },
  largeTransferPercent: 5.5,
  rpc: { devnet: "", mainnet: "https://rpc.example.test/?api-key=secret" },
  verification: false,
};

describe("settings storage", () => {
  it("round-trips every field", () => {
    const storage = new MemoryStorage();
    const store = browserSettingsStore(storage, { persistRpc: true });
    expect(store.save(SETTINGS)).toBe(true);
    expect(store.load()).toEqual(SETTINGS);
  });

  it("the offline file never writes RPC endpoints", () => {
    const storage = new MemoryStorage();
    const store = browserSettingsStore(storage, { persistRpc: false });
    store.save(SETTINGS);
    const stored = storage.getItem("vigil.settings") ?? "";
    expect(stored).not.toContain("example.test");
    expect(store.load()).toEqual({
      ...SETTINGS,
      crossCheckRpc: DEFAULT_SETTINGS.crossCheckRpc,
      rpc: DEFAULT_SETTINGS.rpc,
    });
  });

  it("only ever removes its own key", () => {
    const storage = new MemoryStorage();
    storage.setItem("other-app", "keep");
    const store = browserSettingsStore(storage, { persistRpc: true });
    store.save(SETTINGS);
    store.clear();
    expect([...storage.map.keys()]).toEqual(["other-app"]);
  });

  it("survives blocked or failing storage", () => {
    const storage = new MemoryStorage();
    storage.fail = true;
    expect(browserSettingsStore(storage, { persistRpc: true }).save(SETTINGS)).toBe(false);
    const store = browserSettingsStore(undefined, { persistRpc: true });
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
    expect(store.save(SETTINGS)).toBe(false);
  });

  it("treats stored data as untrusted: bad JSON or bad fields fall back to defaults", () => {
    const storage = new MemoryStorage();
    storage.setItem("vigil.settings", "{not json");
    expect(browserSettingsStore(storage, { persistRpc: true }).load()).toEqual(DEFAULT_SETTINGS);
    const tampered = validateSettings({
      cluster: "testnet",
      crossCheckRpc: { mainnet: "javascript:alert(1)" },
      historyDepth: 5000,
      knownAddresses: [
        { address: "notAnAddress", label: "x" },
        { address: MEMBER, label: `  Tre\u200Basury ${"x".repeat(200)} ` },
        { address: MEMBER, label: "duplicate" },
        { address: MEMBER },
      ],
      largeTransferAbsolute: { SOL: "-1", USDC: "1.1234567" },
      largeTransferPercent: 0,
      locale: "fr",
      rpc: { mainnet: "http://insecure.example.test" },
      verification: "yes",
    });
    expect(tampered.cluster).toBe("mainnet");
    expect(tampered.rpc).toEqual(DEFAULT_SETTINGS.rpc);
    expect(tampered.crossCheckRpc).toEqual(DEFAULT_SETTINGS.crossCheckRpc);
    expect(tampered.historyDepth).toBe(0);
    expect(tampered.largeTransferPercent).toBe(10);
    expect(tampered.largeTransferAbsolute).toEqual(DEFAULT_SETTINGS.largeTransferAbsolute);
    expect(tampered.locale).toBe("en");
    expect(tampered.verification).toBe(true);
    expect(tampered.knownAddresses).toHaveLength(1);
    const [entry] = tampered.knownAddresses;
    expect(isAddress(entry?.address ?? "")).toBe(true);
    expect(entry?.label.startsWith("Treasury x")).toBe(true);
    expect(entry?.label.length).toBe(100);
  });
});

describe("endpoints", () => {
  it("mainnet has no default endpoint: the public one refuses web pages", () => {
    expect(resolveEndpoints(DEFAULT_SETTINGS, "mainnet")).toEqual({
      missing: "mainnet-rpc",
      ok: false,
    });
  });

  it("devnet defaults to the public endpoint; the user's own endpoint wins", () => {
    expect(resolveEndpoints(DEFAULT_SETTINGS, "devnet")).toEqual({
      ok: true,
      url: PUBLIC_DEVNET_RPC,
    });
    const own = { ...DEFAULT_SETTINGS, rpc: { devnet: "https://own.example.test/", mainnet: "" } };
    expect(resolveEndpoints(own, "devnet")).toEqual({ ok: true, url: "https://own.example.test/" });
  });

  it("adds the cross-check endpoint unless it is the same endpoint", () => {
    expect(resolveEndpoints(SETTINGS, "mainnet")).toEqual({
      crossCheckUrl: "https://second.example.test/",
      ok: true,
      url: "https://rpc.example.test/?api-key=secret",
    });
    const same = {
      ...SETTINGS,
      crossCheckRpc: { devnet: "https://api.devnet.solana.com", mainnet: "" },
    };
    expect(resolveEndpoints(same, "devnet")).toEqual({ ok: true, url: PUBLIC_DEVNET_RPC });
  });
});

describe("analysis options from settings", () => {
  it("maps every setting to core's options", () => {
    const options = analysisOptions(SETTINGS, "mainnet");
    expect(options.verification).toBe(false);
    expect(options.simulate).toBe(true);
    expect(options.rules?.historyDepth).toBe(150);
    expect(options.rules?.largeTransferPercent).toBe(5.5);
    expect(options.userLabels).toEqual(new Map([[MEMBER, "Treasury"]]));
    expect(options.rules?.knownAddresses).toEqual(new Map([[MEMBER, "Treasury"]]));
    expect(options.rules?.largeTransferAbsolute).toEqual(
      new Map<string, bigint>([
        ["SOL", 10_000_000_000n],
        // USDC's mainnet mint, from core's registry.
        ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 250_000_000_000n],
      ]),
    );
  });

  it("drops token thresholds on a network where the registry has no such mint", () => {
    const options = analysisOptions(SETTINGS, "devnet");
    expect(options.rules?.largeTransferAbsolute).toEqual(new Map([["SOL", 10_000_000_000n]]));
  });
});
