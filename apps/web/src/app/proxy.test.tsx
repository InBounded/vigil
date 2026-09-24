/**
 * The Vigil RPC proxy in the web app (Phase 9): endpoint order (own → proxy → public), which
 * endpoint is in use on the page, the history cap through the proxy and the hint on RPC failures.
 * Analyses run on real captured mainnet fixtures; the proxy URL is a made-up test host.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { proxyUrlFromEnv } from "../../scripts/proxy-url.js";
import { chooseRpc, PUBLIC_DEVNET_RPC, resolveEndpoints } from "../analysis/endpoints.js";
import { analysisOptions, PROXY_MAX_HISTORY_DEPTH } from "../analysis/options.js";
import { ErrorPanel } from "../components/ErrorPanel.js";
import { browserEnvironment } from "../env/browser.js";
import { DEFAULT_SETTINGS, type Settings } from "../settings/settings.js";
import { fixtureEnvironment, UPGRADE_MULTISIG } from "../test-support/fixtures.js";
import { renderWith } from "../test-support/render.js";
import { Root } from "./Root.js";

const PROXY = "https://proxy.example.test/";
const OWN = "https://own.example.test/?api-key=secret";
const SLOW = { timeout: 30_000 };

const withOwn = (mainnet: string, devnet = ""): Settings => ({
  ...DEFAULT_SETTINGS,
  rpc: { devnet, mainnet },
});

afterEach(() => {
  globalThis.location.hash = "";
});

describe("endpoint order: own → proxy → public", () => {
  it("mainnet: the user's own endpoint first, then the proxy, else none", () => {
    expect(chooseRpc(withOwn(OWN), "mainnet", PROXY)).toEqual({ source: "own", url: OWN });
    expect(chooseRpc(DEFAULT_SETTINGS, "mainnet", PROXY)).toEqual({ source: "proxy", url: PROXY });
    expect(chooseRpc(DEFAULT_SETTINGS, "mainnet", "")).toBeUndefined();
    expect(resolveEndpoints(DEFAULT_SETTINGS, "mainnet", PROXY)).toEqual({ ok: true, url: PROXY });
    expect(resolveEndpoints(DEFAULT_SETTINGS, "mainnet", "")).toEqual({
      missing: "mainnet-rpc",
      ok: false,
    });
  });

  it("devnet never uses the proxy (mainnet only): own, else the public devnet endpoint", () => {
    expect(chooseRpc(DEFAULT_SETTINGS, "devnet", PROXY)).toEqual({
      source: "public",
      url: PUBLIC_DEVNET_RPC,
    });
    expect(chooseRpc(withOwn("", OWN), "devnet", PROXY)).toEqual({ source: "own", url: OWN });
  });

  it("keeps the cross-check endpoint next to the proxy", () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      crossCheckRpc: { devnet: "", mainnet: "https://second.example.test/" },
    };
    expect(resolveEndpoints(settings, "mainnet", PROXY)).toEqual({
      crossCheckUrl: "https://second.example.test/",
      ok: true,
      url: PROXY,
    });
  });
});

describe("history depth through the proxy", () => {
  it(`is capped at ${PROXY_MAX_HISTORY_DEPTH} through the proxy only`, () => {
    const deep: Settings = { ...DEFAULT_SETTINGS, historyDepth: 1000 };
    expect(analysisOptions(deep, "mainnet", undefined, "proxy").rules?.historyDepth).toBe(100);
    expect(analysisOptions(deep, "mainnet", undefined, "own").rules?.historyDepth).toBe(1000);
    expect(analysisOptions(deep, "mainnet").rules?.historyDepth).toBe(1000);
    const shallow: Settings = { ...DEFAULT_SETTINGS, historyDepth: 30 };
    expect(analysisOptions(shallow, "mainnet", undefined, "proxy").rules?.historyDepth).toBe(30);
  });

  it("matches the proxy's getSignaturesForAddress limit", () => {
    const policy = readFileSync(
      resolve(import.meta.dirname, "../../../rpc-proxy/src/policy.ts"),
      "utf8",
    );
    expect(policy).toContain(`export const MAX_SIGNATURES_LIMIT = ${PROXY_MAX_HISTORY_DEPTH};`);
  });
});

describe("the proxy URL of a build", () => {
  it("is empty when VIGIL_PROXY_URL is unset or blank", () => {
    expect(proxyUrlFromEnv(undefined)).toBe("");
    expect(proxyUrlFromEnv("  ")).toBe("");
  });

  it("accepts a plain https URL", () => {
    expect(proxyUrlFromEnv("https://vigil-rpc-proxy.example.workers.dev")).toBe(
      "https://vigil-rpc-proxy.example.workers.dev/",
    );
  });

  it.each([
    "http://proxy.example.test/",
    "https://user:pass@proxy.example.test/",
    "https://proxy.example.test/?api-key=secret",
    "https://proxy.example.test/#x",
    "proxy.example.test",
  ])("stops the build on %s", (raw) => {
    expect(() => proxyUrlFromEnv(raw)).toThrow(/VIGIL_PROXY_URL/);
  });

  it("is never used by the offline file (its origin, null, is refused by the proxy)", () => {
    expect(browserEnvironment("offline", PROXY).proxyUrl).toBe("");
    expect(browserEnvironment("hosted", PROXY).proxyUrl).toBe(PROXY);
    expect(browserEnvironment("ghpages", PROXY).proxyUrl).toBe(PROXY);
  });
});

describe("which endpoint is in use, on the page", () => {
  async function open(settings: Settings, proxyUrl: string) {
    globalThis.location.hash = `#/ms/${UPGRADE_MULTISIG}/4`;
    const env = await fixtureEnvironment("upgrade-proposal", settings, proxyUrl);
    render(<Root environment={env.environment} />);
    return env;
  }

  it("mainnet with no endpoint of the user's goes through the proxy and says so", async () => {
    const { endpoints } = await open(DEFAULT_SETTINGS, PROXY);
    expect(
      await screen.findByText(/RPC endpoint: the shared Vigil proxy \(proxy\.example\.test\)\./),
    ).toBeTruthy();
    await screen.findByRole("region", { name: /Critical findings/ }, SLOW);
    const note = screen.getByText(/the shared Vigil proxy/);
    expect(note.textContent).toContain("It limits how many requests each visitor can make.");
    expect(within(note).getByRole("link", { name: "Set your own RPC in settings." })).toBeTruthy();
    expect(new Set(endpoints)).toEqual(new Set([PROXY]));
  }, 60_000);

  it("the user's own endpoint wins over the proxy, shown by host only", async () => {
    const { endpoints } = await open(withOwn(OWN), PROXY);
    const note = await screen.findByText(/RPC endpoint: your own \(own\.example\.test\)\./);
    expect(note.textContent).not.toContain("secret");
    await screen.findByRole("region", { name: /Critical findings/ }, SLOW);
    expect(new Set(endpoints)).toEqual(new Set([OWN]));
  }, 60_000);

  it("says when the proxy caps the history depth setting", async () => {
    await open({ ...DEFAULT_SETTINGS, historyDepth: 500 }, PROXY);
    expect(
      await screen.findByText(
        /history checks read at most 100 past transactions \(your setting: 500\)/,
      ),
    ).toBeTruthy();
    await screen.findByRole("region", { name: /Critical findings/ }, SLOW);
  }, 60_000);

  it("without a proxy in the build, mainnet still asks for the user's endpoint", async () => {
    const { endpoints } = await open(DEFAULT_SETTINGS, "");
    expect(await screen.findByRole("heading", { name: "Add your RPC endpoint" })).toBeTruthy();
    expect(endpoints).toEqual([]);
  });
});

describe("RPC failures through the proxy", () => {
  it("point to setting one's own RPC", async () => {
    const { environment } = await fixtureEnvironment("upgrade-proposal");
    const error = {
      key: "error.RPC_FAILED" as const,
      params: { detail: "Reading the multisig: the endpoint answered HTTP 429" },
    };
    const { container } = renderWith(
      <ErrorPanel error={error} onRetry={() => undefined} viaProxy />,
      environment,
    );
    expect(container.textContent).toContain(
      "You are using the shared Vigil proxy, which limits how many requests each visitor can make.",
    );
    expect(
      within(container).getByRole("link", { name: "Set your own RPC in settings." }),
    ).toBeTruthy();
  });

  it("say nothing about the proxy when it is not in use", async () => {
    const { environment } = await fixtureEnvironment("upgrade-proposal");
    const { container } = renderWith(
      <ErrorPanel
        error={{ key: "error.RPC_FAILED", params: { detail: "x" } }}
        onRetry={() => undefined}
      />,
      environment,
    );
    expect(container.textContent).not.toContain("proxy");
  });
});
