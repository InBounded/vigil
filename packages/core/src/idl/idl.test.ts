import { fileURLToPath } from "node:url";
import { deflateSync, gzipSync } from "node:zlib";
import {
  type Address,
  address,
  getBase64Decoder,
  getBase64Encoder,
  type Signature,
} from "@solana/kit";
import { findMetadataPda } from "@solana-program/program-metadata";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDecodeContext, decodeInstruction } from "../decoders/decode.js";
import { squadsDecoder } from "../decoders/squads.js";
import { decodeRawTransaction } from "../decoders/transaction.js";
import type { InstructionInput } from "../decoders/types.js";
import type { DecodedInstruction } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { loadFixtureFile } from "../rpc/fixture-file.js";
import type { AccountInfo, FixtureData, RpcClient } from "../rpc/index.js";
import { parseAnchorIdlAccount, parseProgramMetadataAccount } from "./accounts.js";
import {
  findAnchorIdlAddress,
  findProgramMetadataIdlAddress,
  PROGRAM_METADATA_PROGRAM_ADDRESS,
} from "./addresses.js";
import { type IdlCache, type IdlEntry, loadProgramIdls } from "./fetch.js";
import { InflateLimitError, inflateBounded, MAX_IDL_DECOMPRESSED_BYTES } from "./inflate.js";
import { IdlLoadError, loadIdl } from "./load.js";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/${name}.json`, import.meta.url));
}

const base64Bytes = getBase64Encoder();
const base64String = getBase64Decoder();

const PUMP = address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const MARINADE = address("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const RAYDIUM_CPMM = address("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const WHIRLPOOL = address("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const SQUADS = address("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

const PUMP_TX =
  "pY43LgyUgXQUjuFBzSZbGSiheeouictTc27t5anDk3uXr3EMNmjHZF8dWc1khqaHDLaMGJoRK9eXF5M6VzkgHXE";
const MARINADE_TX =
  "34AKWVAwZrqRWXhMgreuZwH2wEna5rV6nq8rRYUupJhcpsu8rrj5bemau6zKshvYP6pcQib1oGhbty5GjvYivbyY";
const CPMM_TX =
  "x2L9pQd7Ue4YmUf7Y4Tgz8nQaWd2vHyGmtaSW2KJYCTWAaX7GGspow43UbTs7Tex8d9z1r9fiC2c15rnfmVAyxD";

let idls: FixtureData;
beforeAll(async () => {
  idls = await loadFixtureFile(fixturePath("idl-programs"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function decodeTx(data: FixtureData, signature: string) {
  const tx = data.transactions.get(signature as Signature);
  if (tx === undefined) {
    throw new Error(`fixture has no transaction ${signature}`);
  }
  return decodeRawTransaction(new FixtureRpcClient(data), tx.transactionBase64);
}

function account(data: FixtureData, at: Address): AccountInfo {
  const info = data.accounts.get(at);
  if (info === undefined) {
    throw new Error(`fixture has no account ${at}`);
  }
  return info;
}

function withAccount(data: FixtureData, at: Address, info: AccountInfo | null): FixtureData {
  const accounts = new Map(data.accounts);
  if (info === null) {
    accounts.delete(at);
  } else {
    accounts.set(at, info);
  }
  return { ...data, accounts };
}

function patched(info: AccountInfo, patch: (bytes: Uint8Array) => void): AccountInfo {
  const bytes = Uint8Array.from(base64Bytes.encode(info.dataBase64));
  patch(bytes);
  return { ...info, dataBase64: base64String.decode(bytes) };
}

async function entryFor(data: FixtureData, program: Address, cache?: IdlCache): Promise<IdlEntry> {
  const entries = await loadProgramIdls(
    new FixtureRpcClient(data),
    [program],
    cache === undefined ? {} : { cache },
  );
  const entry = entries.get(program);
  if (entry === undefined) {
    throw new Error("no entry");
  }
  return entry;
}

describe("IDL account addresses", () => {
  it("derive the canonical Program Metadata `idl` account exactly like @solana-program/program-metadata", async () => {
    for (const program of [PUMP, RAYDIUM_CPMM, WHIRLPOOL]) {
      const [expected] = await findMetadataPda({ authority: null, program, seed: "idl" });
      expect(await findProgramMetadataIdlAddress(program)).toBe(expected);
    }
  });

  it("derive the Anchor IDL accounts that exist on mainnet, owned by each program", async () => {
    for (const program of [PUMP, MARINADE, SQUADS, WHIRLPOOL]) {
      expect(account(idls, await findAnchorIdlAddress(program)).owner).toBe(program);
    }
    expect(account(idls, await findProgramMetadataIdlAddress(RAYDIUM_CPMM)).owner).toBe(
      PROGRAM_METADATA_PROGRAM_ADDRESS,
    );
  });
});

describe("real Anchor program with a new-format (0.30+) on-chain IDL: pump.fun", () => {
  it("decodes distributeFeeToHolders with names, arguments and accounts, as idl-declared", async () => {
    const result = await decodeTx(idls, PUMP_TX);
    expect(result.gaps).toEqual([]);
    const ix = result.instructions[2];
    expect(ix).toMatchObject({
      decoder: "anchor-idl",
      name: "distributeFeeToHolders",
      programId: PUMP,
      provenance: "idl-declared",
      summary: {
        key: "ix.idl.call",
        params: { idlProgramName: "pump", instruction: "distributeFeeToHolders" },
      },
    });
    expect(ix?.args).toEqual({
      amounts: [319n, 1242n, 16968n, 5684n, 926n, 517n, 293n, 430n, 287n],
    });
    expect(ix?.accounts.slice(0, 11).map((a) => a.role)).toEqual([
      "global",
      "holderRewardClaimAuthority",
      "mint",
      "holderRewards",
      "holderRewardsTokenAccount",
      "quoteMint",
      "quoteTokenProgram",
      "associatedTokenProgram",
      "systemProgram",
      "eventAuthority",
      "program",
    ]);
    // Remaining accounts (the holders) are not named by the IDL, and must not be guessed.
    expect(ix?.accounts.slice(11).every((a) => a.role === undefined)).toBe(true);
    // The IDL's own program name is never used as the program's label.
    expect(ix?.programLabel).toBeUndefined();
  });
});

describe("real Anchor program with a legacy (pre-0.30) on-chain IDL: Marinade", () => {
  it("decodes deposit", async () => {
    const result = await decodeTx(idls, MARINADE_TX);
    expect(result.gaps).toEqual([]);
    const [ix] = result.instructions;
    expect(ix).toMatchObject({
      args: { lamports: 5706000n },
      decoder: "anchor-idl",
      name: "deposit",
      provenance: "idl-declared",
    });
    expect(ix?.accounts.map((a) => a.role)).toEqual([
      "state",
      "msolMint",
      "liqPoolSolLegPda",
      "liqPoolMsolLeg",
      "liqPoolMsolLegAuthority",
      "reservePda",
      "transferFrom",
      "mintTo",
      "msolMintAuthority",
      "systemProgram",
      "tokenProgram",
    ]);
  });

  it("agrees with the generated Squads client when Squads' own legacy on-chain IDL is used", async () => {
    const data = await loadFixtureFile(fixturePath("squads-create-with-lookup-table"));
    const [tx] = [...data.transactions.values()];
    if (tx === undefined) {
      throw new Error("fixture has no transaction");
    }
    const native = await decodeRawTransaction(new FixtureRpcClient(data), tx.transactionBase64, {
      idl: false,
    });
    const entry = await entryFor(idls, SQUADS);
    if (entry.status !== "ok") {
      throw new Error(`Squads IDL did not load: ${JSON.stringify(entry)}`);
    }
    expect(entry.format).toBe("anchor-legacy");
    const squadsInstructions = native.instructions.filter((ix) => ix.programId === SQUADS);
    expect(squadsInstructions).toHaveLength(6);
    for (const ix of squadsInstructions) {
      const input = toInput(ix);
      const fromIdl = entry.decoder.decode(input);
      const fromClient = squadsDecoder.decode(input);
      expect(fromIdl.name).toBe(fromClient.name);
      expect(fromIdl.accountRoles).toEqual(fromClient.accountRoles);
    }
  });
});

describe("real program publishing its IDL through Program Metadata: Raydium CPMM", () => {
  it("decodes swapBaseInput from the canonical Program Metadata account", async () => {
    const result = await decodeTx(idls, CPMM_TX);
    expect(result.gaps).toEqual([]);
    const ix = result.instructions[1];
    expect(ix).toMatchObject({
      args: { amountIn: 129647618259n, minimumAmountOut: 2504037n },
      decoder: "program-metadata-idl",
      name: "swapBaseInput",
      provenance: "idl-declared",
    });
    expect(ix?.accounts.map((a) => a.role)).toEqual([
      "payer",
      "authority",
      "ammConfig",
      "poolState",
      "inputTokenAccount",
      "outputTokenAccount",
      "inputVault",
      "outputVault",
      "inputTokenProgram",
      "outputTokenProgram",
      "inputTokenMint",
      "outputTokenMint",
      "observationState",
    ]);
  });

  it("prefers Program Metadata over the Anchor account when a program has both (Whirlpool)", async () => {
    const entry = await entryFor(idls, WHIRLPOOL);
    expect(entry).toMatchObject({ format: "anchor", source: "program-metadata", status: "ok" });
  });

  it("falls back to the Anchor account when the Program Metadata account is unusable", async () => {
    const metadata = await findProgramMetadataIdlAddress(WHIRLPOOL);
    const broken = patched(account(idls, metadata), (bytes) => {
      bytes[0] = 1; // a Buffer, not a Metadata account
    });
    const entry = await entryFor(withAccount(idls, metadata, broken), WHIRLPOOL);
    expect(entry).toMatchObject({ source: "anchor-idl-account", status: "ok" });
  });
});

describe("IDL sources Vigil does not follow", () => {
  const DATA_SOURCE_OFFSET = 86;

  async function cpmmWith(patch: (bytes: Uint8Array) => void) {
    const metadata = await findProgramMetadataIdlAddress(RAYDIUM_CPMM);
    const data = withAccount(idls, metadata, patched(account(idls, metadata), patch));
    return decodeTx(data, CPMM_TX);
  }

  it("reports an IDL published at a URL as a visible gap, without fetching it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await cpmmWith((bytes) => {
      bytes[DATA_SOURCE_OFFSET] = 1;
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.instructions[1]?.decoder).toBe("none");
    expect(result.gaps).toEqual([
      expect.objectContaining({ address: RAYDIUM_CPMM, code: "IDL_AT_URL", instructionIndex: 1 }),
    ]);
  });

  it("reports an IDL stored in another account as unsupported (possible later addition)", async () => {
    const result = await cpmmWith((bytes) => {
      bytes[DATA_SOURCE_OFFSET] = 2;
    });
    expect(result.gaps).toEqual([expect.objectContaining({ code: "IDL_UNSUPPORTED" })]);
  });

  it("refuses YAML/TOML, non-UTF-8 encodings and non-canonical accounts", async () => {
    const yaml = await cpmmWith((bytes) => {
      bytes[85] = 2;
    });
    expect(yaml.gaps).toEqual([expect.objectContaining({ code: "IDL_UNSUPPORTED" })]);
    const base58 = await cpmmWith((bytes) => {
      bytes[83] = 2;
    });
    expect(base58.gaps).toEqual([expect.objectContaining({ code: "IDL_UNSUPPORTED" })]);
    const nonCanonical = await cpmmWith((bytes) => {
      bytes[66] = 0;
    });
    expect(nonCanonical.gaps).toEqual([expect.objectContaining({ code: "IDL_INVALID" })]);
  });

  it("reports a program with no IDL as unknown, saying it publishes none", async () => {
    const metadata = await findProgramMetadataIdlAddress(RAYDIUM_CPMM);
    const result = await decodeTx(withAccount(idls, metadata, null), CPMM_TX);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        code: "UNKNOWN_PROGRAM",
        message: "no decoder for this program, and it publishes no IDL on chain",
      }),
    ]);
  });
});

describe("IDL account parsing is strict", () => {
  it("rejects an Anchor IDL account not owned by the program, or with the wrong discriminator", async () => {
    const at = await findAnchorIdlAddress(MARINADE);
    const info = account(idls, at);
    const bytes = base64Bytes.encode(info.dataBase64);
    const discriminator = bytes.subarray(0, 8);
    expect(parseAnchorIdlAccount(PUMP, bytes, MARINADE, discriminator).ok).toBe(false);
    expect(parseAnchorIdlAccount(MARINADE, bytes, MARINADE, new Uint8Array(8)).ok).toBe(false);
    expect(parseAnchorIdlAccount(MARINADE, bytes.subarray(0, 30), MARINADE, discriminator)).toEqual(
      {
        ok: false,
        problem: { kind: "invalid", reason: "the Anchor IDL account is truncated" },
      },
    );
  });

  it("rejects a compressed IDL above 1 MB before reading it", async () => {
    const at = await findAnchorIdlAddress(MARINADE);
    const huge = patched(account(idls, at), (bytes) => {
      new DataView(bytes.buffer).setUint32(40, 1_000_001, true);
    });
    const entry = await entryFor(withAccount(idls, at, huge), MARINADE);
    expect(entry).toMatchObject({ code: "IDL_INVALID", status: "error" });
    expect(entry.status === "error" && entry.message).toContain("1000000-byte limit");
  });

  it("rejects a Program Metadata account that describes another program", async () => {
    const metadata = await findProgramMetadataIdlAddress(RAYDIUM_CPMM);
    const info = account(idls, metadata);
    expect(
      parseProgramMetadataAccount(info.owner, base64Bytes.encode(info.dataBase64), PUMP),
    ).toEqual({
      ok: false,
      problem: {
        kind: "invalid",
        reason: "the Program Metadata account describes a different program",
      },
    });
  });
});

describe("decompression limits", () => {
  it("stops a decompression bomb at 5 MB instead of inflating it", () => {
    const bomb = deflateSync(new Uint8Array(MAX_IDL_DECOMPRESSED_BYTES + 1));
    expect(bomb.length).toBeLessThan(10_000);
    expect(() => inflateBounded(bomb, "zlib")).toThrow(InflateLimitError);
    expect(() =>
      inflateBounded(gzipSync(new Uint8Array(MAX_IDL_DECOMPRESSED_BYTES + 1)), "gzip"),
    ).toThrow(InflateLimitError);
  });

  it("inflates zlib and gzip exactly, and rejects truncated input", () => {
    const text = new TextEncoder().encode(JSON.stringify({ hello: "x".repeat(50_000) }));
    expect(inflateBounded(deflateSync(text), "zlib")).toEqual(text);
    expect(inflateBounded(gzipSync(text), "gzip")).toEqual(text);
    const truncated = deflateSync(text).subarray(0, 40);
    expect(() => inflateBounded(truncated, "zlib")).toThrow();
  });
});

describe("Codama conversion warnings", () => {
  it("are captured on the loaded IDL and never printed", async () => {
    const warn = vi.spyOn(console, "warn");
    const at = await findAnchorIdlAddress(PUMP);
    const bytes = base64Bytes.encode(account(idls, at).dataBase64);
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(40, true);
    const json = new TextDecoder().decode(inflateBounded(bytes.subarray(44, 44 + length), "zlib"));
    const { warnings } = loadIdl(json, PUMP);
    expect(warnings.some((w) => w.startsWith("PDA name collision"))).toBe(true);
    await decodeTx(idls, PUMP_TX);
    expect(warn).not.toHaveBeenCalled();
    expect(console.warn).not.toBe(undefined);
  });
});

describe("IDL content validation", () => {
  const legacy = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      instructions: [
        {
          accounts: [{ isMut: true, isSigner: true, name: "payer" }],
          args: [{ name: "note", type: "string" }],
          name: "sayHello",
        },
      ],
      name: "hello",
      types: [],
      version: "0.1.0",
      ...overrides,
    });

  it("accepts a minimal legacy IDL and pins it to the program it was read for", () => {
    const { root, format } = loadIdl(legacy(), PUMP);
    expect(format).toBe("anchor-legacy");
    expect(root.program.publicKey).toBe(PUMP);
    expect(root.additionalPrograms).toEqual([]);
  });

  it("rejects non-JSON, non-objects and IDLs without instructions", () => {
    expect(() => loadIdl("{", PUMP)).toThrow(IdlLoadError);
    expect(() => loadIdl("[]", PUMP)).toThrow(IdlLoadError);
    expect(() => loadIdl(JSON.stringify({ name: "x" }), PUMP)).toThrow(IdlLoadError);
  });

  it("rejects an IDL that declares a different program address", () => {
    expect(() => loadIdl(legacy({ metadata: { address: MARINADE } }), PUMP)).toThrow(
      /declares program/,
    );
  });

  it("rejects names that are not plain ASCII identifiers (homoglyph, bidi)", () => {
    const spoofed = legacy({
      instructions: [{ accounts: [], args: [], name: "tr\u0430nsfer" }],
    });
    expect(() => loadIdl(spoofed, PUMP)).toThrow(/not a plain ASCII identifier/);
    const bidi = legacy({ instructions: [{ accounts: [], args: [], name: "a\u202Eb" }] });
    expect(() => loadIdl(bidi, PUMP)).toThrow(IdlLoadError);
  });

  it("rejects a vector of zero-sized items, which would make decoding hang", () => {
    const hang = legacy({
      instructions: [
        {
          accounts: [],
          args: [{ name: "items", type: { vec: { defined: "Empty" } } }],
          name: "spin",
        },
      ],
      types: [{ name: "Empty", type: { fields: [], kind: "struct" } }],
    });
    expect(() => loadIdl(hang, PUMP)).toThrow(/take no bytes/);
  });

  it("sanitizes strings decoded from instruction data like any on-chain string", async () => {
    const at = await findAnchorIdlAddress(PUMP);
    const idl = legacy();
    const compressed = deflateSync(new TextEncoder().encode(idl));
    const data = new Uint8Array(44 + compressed.length);
    data.set(base64Bytes.encode(account(idls, at).dataBase64).subarray(0, 40));
    new DataView(data.buffer).setUint32(40, compressed.length, true);
    data.set(compressed, 44);
    const fixture = withAccount(
      withAccount(idls, await findProgramMetadataIdlAddress(PUMP), null),
      at,
      { ...account(idls, at), dataBase64: base64String.decode(data) },
    );
    const entry = await entryFor(fixture, PUMP);
    if (entry.status !== "ok") {
      throw new Error(JSON.stringify(entry));
    }
    // Legacy discriminator: sha256("global:say_hello")[..8], then a Borsh string.
    const discriminator = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("global:say_hello")),
    ).subarray(0, 8);
    const note = new TextEncoder().encode("hi\u202Ethere");
    const ixData = new Uint8Array([...discriminator, note.length, 0, 0, 0, ...note]);
    const input: InstructionInput = {
      accounts: [{ address: MARINADE, isSigner: true, isWritable: true }],
      data: ixData,
      programId: PUMP,
    };
    // The IDL decoder itself returns the raw string...
    expect(entry.decoder.decode(input).args).toEqual({ note: "hi\u202Ethere" });
    // ...and the pipeline sanitizes it before it reaches the report.
    const context = createDecodeContext(new Map(), new Map([[PUMP, entry]]));
    const decoded = decodeInstruction(input, 0, context, 0, 0);
    expect(decoded).toMatchObject({
      args: { note: "hithere" },
      decoder: "anchor-idl",
      name: "sayHello",
      provenance: "idl-declared",
      sanitizer: [{ flags: ["bidi-removed"], modified: true, path: "note" }],
    });
    expect(context.gaps).toEqual([]);
  });
});

describe("timeouts, failures and the cache", () => {
  it("reports IDL_FETCH_FAILED when the IDL read times out", async () => {
    class Slow extends FixtureRpcClient {
      override getMultipleAccounts(): ReturnType<RpcClient["getMultipleAccounts"]> {
        return new Promise(() => undefined);
      }
    }
    const entries = await loadProgramIdls(new Slow(idls), [MARINADE], { timeoutMs: 20 });
    expect(entries.get(MARINADE)).toMatchObject({ code: "IDL_FETCH_FAILED", status: "error" });
  });

  it("caches validated JSON under program + account hash, and re-validates what it reads back", async () => {
    const store = new Map<string, string>();
    const cache: IdlCache = {
      get: (key) => Promise.resolve(store.get(key)),
      set: (key, json) => {
        store.set(key, json);
        return Promise.resolve();
      },
    };
    const first = await entryFor(idls, MARINADE, cache);
    expect(first.status).toBe("ok");
    const [key] = [...store.keys()];
    expect(key).toMatch(/^MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD:[0-9a-f]{64}$/);
    expect(first.status === "ok" && key?.endsWith(first.accountHash)).toBe(true);

    // A tampered cache entry is treated as hostile input, not trusted.
    store.set(key ?? "", "{ not json");
    expect(await entryFor(idls, MARINADE, cache)).toMatchObject({ code: "IDL_INVALID" });
  });

  it("never lets a failing cache break decoding", async () => {
    const cache: IdlCache = {
      get: () => Promise.reject(new Error("disk full")),
      set: () => Promise.reject(new Error("disk full")),
    };
    expect(await entryFor(idls, MARINADE, cache)).toMatchObject({ status: "ok" });
  });
});

function toInput(ix: DecodedInstruction): InstructionInput {
  const hex = ix.rawDataHex;
  const data = new Uint8Array(hex.length / 2);
  for (let i = 0; i < data.length; i++) {
    data[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return {
    accounts: ix.accounts.map((a) => ({
      address: a.address,
      isSigner: a.isSigner,
      isWritable: a.isWritable,
      ...(a.fromLookupTable === undefined ? {} : { fromLookupTable: a.fromLookupTable }),
    })),
    data,
    programId: ix.programId,
  };
}
