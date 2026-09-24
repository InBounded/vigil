import { MAX_RAW_TRANSACTION_BASE64_LENGTH, REGISTRY_TOKENS } from "@vigil-sol/core";
import { describe, expect, it } from "vitest";
import { THRESHOLD_DECIMALS } from "../settings/thresholds.js";
import { rawBase64 } from "../test-support/fixtures.js";
import { parseDecimalAmount } from "./amounts.js";
import { detectInput } from "./detect.js";
import { explorerLinks } from "./explorer.js";
import { keyed } from "./keyed.js";
import { formatRoute, parseRoute, type Route } from "./routes.js";
import { MAX_BASE64_LENGTH, parseAddress, parseIndex, parseRpcUrl } from "./validate.js";

const MULTISIG = "DQnoxvJiAYUeB5Ahp5VbsaMGMmJUA5Jr5b1nnJ2ANeMG";

describe("routes", () => {
  const cases: [string, Route][] = [
    ["", { name: "home" }],
    ["#/", { name: "home" }],
    ["#/settings", { name: "settings" }],
    ["#/about", { name: "about" }],
    [`#/ms/${MULTISIG}`, { cluster: "mainnet", multisig: MULTISIG as never, name: "multisig" }],
    [
      `#/ms/${MULTISIG}/4?cluster=devnet`,
      { cluster: "devnet", index: 4n, multisig: MULTISIG as never, name: "proposal" },
    ],
  ];

  it.each(cases)("parses %s", (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it("round-trips every route through its link", () => {
    const base64 = rawBase64("raw-usdc-transfer");
    const routes: Route[] = [
      ...cases.map(([, route]) => route),
      { base64, cluster: "mainnet", name: "transaction" },
      { base64, cluster: "devnet", name: "transaction" },
    ];
    for (const route of routes) {
      expect(parseRoute(formatRoute(route))).toEqual(route);
    }
  });

  it.each([
    "#/ms/notAnAddress",
    `#/ms/${MULTISIG}/0`,
    `#/ms/${MULTISIG}/007`,
    `#/ms/${MULTISIG}/18446744073709551616`,
    `#/ms/${MULTISIG}/4/extra`,
    `#/ms/${MULTISIG}?cluster=testnet`,
    "#/tx?data=%%%",
    "#/tx",
    "#/unknown",
  ])("refuses %s", (hash) => {
    expect(parseRoute(hash)).toEqual({ name: "not-found" });
  });
});

describe("input detection on the start page", () => {
  it("recognises a multisig address and a base64 transaction", () => {
    expect(detectInput(`  ${MULTISIG}\n`, "mainnet")).toEqual({
      ok: true,
      route: { cluster: "mainnet", multisig: MULTISIG, name: "multisig" },
    });
    const base64 = rawBase64("raw-usdc-transfer");
    const wrapped = `${base64.slice(0, 60)}\n${base64.slice(60)}`;
    expect(detectInput(wrapped, "devnet")).toEqual({
      ok: true,
      route: { base64, cluster: "devnet", name: "transaction" },
    });
  });

  it("refuses empty, invalid and oversized input", () => {
    expect(detectInput("  ", "mainnet")).toEqual({ ok: false, reason: "empty" });
    expect(detectInput("hello world", "mainnet")).toEqual({ ok: false, reason: "invalid" });
    expect(detectInput("A".repeat(MAX_BASE64_LENGTH + 4), "mainnet")).toEqual({
      ok: false,
      reason: "too-long",
    });
  });

  it("uses core's transaction size limit", () => {
    expect(MAX_BASE64_LENGTH).toBe(MAX_RAW_TRANSACTION_BASE64_LENGTH);
  });
});

describe("validation", () => {
  it("addresses: base58 of 32 bytes only", () => {
    expect(parseAddress(MULTISIG)).toBe(MULTISIG);
    expect(parseAddress(`${MULTISIG}1`)).toBeUndefined();
    expect(parseAddress("0OIl")).toBeUndefined();
  });

  it("indices: positive decimal integers up to u64::MAX", () => {
    expect(parseIndex("1")).toBe(1n);
    expect(parseIndex("18446744073709551615")).toBe(18_446_744_073_709_551_615n);
    for (const bad of ["0", "-1", "1.5", "01", "1e3", "", "18446744073709551616"]) {
      expect(parseIndex(bad), bad).toBeUndefined();
    }
  });

  it("RPC endpoints: https only, no credentials, API keys in path or query allowed", () => {
    expect(parseRpcUrl(" https://rpc.example.test/?api-key=k ")).toBe(
      "https://rpc.example.test/?api-key=k",
    );
    expect(parseRpcUrl("https://rpc.example.test/v1/key")).toBe("https://rpc.example.test/v1/key");
    for (const bad of [
      "http://rpc.example.test",
      "https://user:pass@rpc.example.test",
      "wss://rpc.example.test",
      "javascript:alert(1)",
      "rpc.example.test",
    ]) {
      expect(parseRpcUrl(bad), bad).toBeUndefined();
    }
  });
});

describe("amounts typed by the user", () => {
  it("parses exact decimal amounts to base units", () => {
    expect(parseDecimalAmount("1", 9)).toBe(1_000_000_000n);
    expect(parseDecimalAmount("1,000.5", 6)).toBe(1_000_500_000n);
    expect(parseDecimalAmount("0.000001", 6)).toBe(1n);
    expect(parseDecimalAmount("123456789012345678.123456789", 9)).toBe(
      123_456_789_012_345_678_123_456_789n,
    );
  });

  it("refuses zero, negative, too many decimals and non-numbers", () => {
    for (const bad of ["0", "0.0", "-1", "1.0000001", "1e3", "abc", "", "."]) {
      expect(parseDecimalAmount(bad, 6), bad).toBeUndefined();
    }
  });

  it("USDC and USDT thresholds use the decimals of core's registry", () => {
    for (const symbol of ["USDC", "USDT"] as const) {
      const token = REGISTRY_TOKENS.find((t) => t.symbol === symbol && t.cluster === "mainnet");
      expect(token?.decimals).toBe(THRESHOLD_DECIMALS[symbol]);
    }
  });
});

describe("explorer links", () => {
  it("point to the analysed network, and nowhere for an unknown one", () => {
    expect(explorerLinks(MULTISIG as never, "mainnet")).toEqual({
      explorer: `https://explorer.solana.com/address/${MULTISIG}`,
      solscan: `https://solscan.io/account/${MULTISIG}`,
    });
    expect(explorerLinks(MULTISIG as never, "devnet")?.solscan).toBe(
      `https://solscan.io/account/${MULTISIG}?cluster=devnet`,
    );
    expect(explorerLinks(MULTISIG as never, "unknown")).toBeUndefined();
  });
});

describe("keyed", () => {
  it("keeps identities and numbers repeats", () => {
    expect(keyed(["a", "b", "a"], (x) => x).map((entry) => entry.key)).toEqual(["a", "b", "a#1"]);
  });
});
