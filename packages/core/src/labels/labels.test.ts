import { type Address, address } from "@solana/kit";
import * as sysvars from "@solana/sysvars";
import { describe, expect, it } from "vitest";
import { PROGRAM_DECODERS } from "../decoders/decode.js";
import { REGISTRY_PROGRAMS } from "../registry/index.js";
import { getVaultPda } from "../squads/pda.js";
import { applyLabels, buildLabels, LABELLED_VAULT_INDICES, labelFor } from "./labels.js";
import { SYSVARS } from "./sysvars.js";
import {
  MAX_USER_LABELS_BYTES,
  parseUserLabels,
  serializeUserLabels,
  UserLabelsError,
} from "./user-labels.js";

const MULTISIG = address("HpGrGa8tE1wxgxaNEasb71SYmgXUdwU5U7ZzpbLWgAs");
const MEMBER = address("HqgTVEqKuYfji4WtUKyJDqXGna5C2sa67SSkMry8zCJb");
const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

describe("sysvar labels", () => {
  it("match every SYSVAR_*_ADDRESS exported by @solana/sysvars", () => {
    const official = Object.entries(sysvars)
      .filter(([name]) => /^SYSVAR_[A-Z_]+_ADDRESS$/.test(name))
      .map(([, value]) => value)
      .sort();
    expect([...SYSVARS.keys()].sort()).toEqual(official);
  });
});

describe("program registry", () => {
  it("names every program Vigil decodes, with the same name the decoder uses", () => {
    const byAddress = new Map(REGISTRY_PROGRAMS.map((p) => [p.address, p.name]));
    for (const decoder of PROGRAM_DECODERS) {
      for (const programId of decoder.programIds) {
        expect(byAddress.get(programId), programId).toBe(decoder.label);
      }
    }
  });

  it("has no duplicate addresses", () => {
    const addresses = REGISTRY_PROGRAMS.map((p) => p.address);
    expect(new Set(addresses).size).toBe(addresses.length);
  });
});

describe("buildLabels / labelFor", () => {
  it("labels vaults 0–15 and the proposal's own vault even above 15, but not other high vaults", async () => {
    const labels = await buildLabels({
      cluster: "mainnet",
      multisig: { address: MULTISIG, members: [MEMBER], vaultIndex: 200 },
    });
    const [vault15] = await getVaultPda({
      index: LABELLED_VAULT_INDICES - 1,
      multisigPda: MULTISIG,
    });
    const [vault16] = await getVaultPda({ index: 16, multisigPda: MULTISIG });
    const [vault200] = await getVaultPda({ index: 200, multisigPda: MULTISIG });
    expect(labels.get(vault15)?.params).toEqual({ index: "15" });
    expect(labels.get(vault16)).toBeUndefined();
    expect(labels.get(vault200)).toEqual({
      key: "label.vault",
      params: { index: "200" },
      source: "multisig",
    });
  });

  it("never lets a user label override a vault, the multisig, a member, a program or a registry mint", async () => {
    const [vault0] = await getVaultPda({ index: 0, multisigPda: MULTISIG });
    const system = address("11111111111111111111111111111111");
    const userLabels = new Map([
      [vault0, "Attacker says: exchange deposit"],
      [MULTISIG, "x"],
      [MEMBER, "x"],
      [system, "x"],
      [USDC, "x"],
    ]);
    const labels = await buildLabels({
      cluster: "mainnet",
      multisig: { address: MULTISIG, members: [MEMBER] },
      userLabels,
    });
    expect(labelFor(vault0, labels, "mainnet")?.key).toBe("label.vault");
    expect(labelFor(MULTISIG, labels, "mainnet")?.key).toBe("label.multisig");
    expect(labelFor(MEMBER, labels, "mainnet")?.key).toBe("label.member");
    expect(labelFor(system, labels, "mainnet")).toEqual({
      key: "label.program",
      params: { name: "System Program" },
      source: "registry",
    });
    expect(labelFor(USDC, labels, "mainnet")).toEqual({
      key: "label.tokenMint",
      params: { symbol: "USDC" },
      source: "registry",
    });
  });

  it("uses user labels for addresses Vigil knows nothing about", async () => {
    const mine = address("Cv7e4t2LM1chzziHZA8aRvfT24nvbdcjHvoTMXPNLCu7");
    const labels = await buildLabels({ cluster: "mainnet", userLabels: new Map([[mine, "Ops"]]) });
    expect(labelFor(mine, labels, "mainnet")).toEqual({
      key: "label.user",
      params: { text: "Ops" },
      source: "user",
    });
  });

  it("only names registry mints on their own cluster", async () => {
    const labels = await buildLabels({ cluster: "devnet" });
    expect(labelFor(USDC, labels, "devnet")).toBeUndefined();
  });

  it("labels nested instructions and fills a missing program label from the registry", async () => {
    const labels = await buildLabels({ cluster: "mainnet" });
    const [ix] = applyLabels(
      [
        {
          accounts: [],
          decoder: "none",
          index: 0,
          inner: [
            {
              accounts: [
                {
                  address: address("SysvarRent111111111111111111111111111111111"),
                  isSigner: false,
                  isWritable: false,
                },
              ],
              decoder: "none",
              index: 0,
              programId: address("Vote111111111111111111111111111111111111111"),
              provenance: "onchain",
              rawDataHex: "",
            },
          ],
          programId: address("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"),
          provenance: "onchain",
          rawDataHex: "",
        },
      ],
      labels,
      "mainnet",
    );
    expect(ix?.programLabel).toBe("Squads Multisig v4");
    expect(ix?.inner?.[0]?.programLabel).toBe("Vote Program");
    expect(ix?.inner?.[0]?.accounts[0]?.label).toEqual({
      key: "label.sysvar",
      params: { name: "Rent" },
      source: "sysvar",
    });
  });
});

describe("user label files", () => {
  const file = (labels: unknown) => JSON.stringify({ format: "vigil-labels", labels, version: 1 });

  it("round-trips: export is sorted and re-imports to the same map", () => {
    const labels = new Map<Address, string>([
      [MULTISIG, "Treasury"],
      [MEMBER, "Alice's hardware wallet"],
    ]);
    const json = serializeUserLabels(labels);
    expect(JSON.parse(json).labels.map((l: { address: string }) => l.address)).toEqual(
      [MEMBER, MULTISIG].sort(),
    );
    expect(parseUserLabels(json)).toEqual({ issues: [], labels: new Map([...labels].sort()) });
  });

  it("sanitizes labels like on-chain names and reports what it changed", () => {
    const result = parseUserLabels(file([{ address: MEMBER, label: "Bin\u200Bance \u202Ehot" }]));
    expect(result.labels.get(MEMBER)).toBe("Binance hot");
    expect(result.issues).toEqual([
      { flags: ["bidi-removed", "zero-width-removed"], index: 0, reason: "sanitized" },
    ]);
  });

  it("skips and reports bad entries instead of dropping them silently", () => {
    const result = parseUserLabels(
      file([
        { address: "not-an-address", label: "x" },
        { address: MEMBER },
        { address: MEMBER, label: "\u200B" },
        { address: MULTISIG, label: "first" },
        { address: MULTISIG, label: "second" },
        42,
      ]),
    );
    expect(result.labels).toEqual(new Map([[MULTISIG, "first"]]));
    expect(result.issues.map((i) => i.reason)).toEqual([
      "invalid-address",
      "invalid-entry",
      "empty-label",
      "duplicate-address",
      "invalid-entry",
    ]);
  });

  it("rejects files that are not JSON, have the wrong shape, or are too large", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof UserLabelsError ? error.code : "other";
      }
      return "none";
    };
    expect(code(() => parseUserLabels("{"))).toBe("INVALID_JSON");
    expect(code(() => parseUserLabels(JSON.stringify({ labels: [] })))).toBe("INVALID_FORMAT");
    expect(
      code(() =>
        parseUserLabels(JSON.stringify({ format: "vigil-labels", labels: [], version: 2 })),
      ),
    ).toBe("INVALID_FORMAT");
    expect(code(() => parseUserLabels(" ".repeat(MAX_USER_LABELS_BYTES + 1)))).toBe("TOO_LARGE");
  });
});
