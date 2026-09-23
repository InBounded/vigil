/**
 * Program information (Phase 5.2) on real mainnet accounts: `programs-mainnet.json.gz` and
 * `buffer-mainnet.json.gz`, captured with `gatherProgramFacts` itself (see each fixture's
 * description).
 */
import { type Address, address, getBase64Encoder } from "@solana/kit";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import type { FixtureData } from "../rpc/index.js";
import { getVaultPda } from "../squads/pda.js";
import { loadFixture } from "../test-support/rules.js";
import { gatherProgramFacts, invokedPrograms, upgradeBuffers } from "./gather.js";
import { executableHash } from "./hash.js";
import { parseBufferAccount, parseProgramAccount, parseProgramDataAccount } from "./loader.js";

/**
 * The executable hashes printed by `solana-verify` 0.5.2, built from
 * solana-foundation/solana-verifiable-build at fef5951281092948c7c465bf63fa28ab59ff5485 with
 * `cargo install --git … --rev fef59512 --locked solana-verify`, run on 2026-09-23 as
 * `solana-verify get-program-hash -u https://api.mainnet-beta.solana.com <program>` and
 * `solana-verify get-buffer-hash -u … <buffer>` against the same deployments as the fixtures (the
 * fixtures' ProgramData deploy slots are asserted below). The buffer was still being written, so
 * its hash was taken immediately before and after the capture, and only accepted when both runs
 * agreed (the first bracketed attempt did not). This local run is the authoritative
 * reference; OtterSec's `on_chain_hash` (verification-osec.json) agrees for the programs it has.
 */
const SOLANA_VERIFY = {
  buffer6W37: "0f7beab6d6d001eb020143a87152e8352c2cc056797c41bb6b78774a7ca63bab",
  cpmm: "bdaff73e7ed9fc75f091d732987d36476d7378d32c47495fe9eef0a930dbf8cc",
  j24j: "a83b811dd1659a91d5861ad8e329417caca09e2dc6bd7e0916d8a4655387dcf5",
  sett1ere: "93e877fd2dd6164848ff400e326718d33f02ae78181b6d73aa2619b8800bb721",
  squadsV3: "72da599d9ee14b2a03a23ccfa6f06d53eea4a00825ad2191929cbd78fb69205c",
} as const;

const SQUADS_V3 = address("SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu");
const SETT1ERE = address("Sett1ereLzRw7neSzoUSwp6vvstBkEgAgQeP6wFcw5F");
const CPMM = address("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const J24J = address("J24jWEosQc5jgkdPm3YzNgzQ54CqNKkhzKy56XXJsLo2");
const SYSTEM = address("11111111111111111111111111111111");
const BUFFER = address("6W37H2XfGJmq3LXCjUt6Zzv5mpSDcLVeyCPsvjDaSfZX");
const DQNOX = address("DQnoxvJiAYUeB5Ahp5VbsaMGMmJUA5Jr5b1nnJ2ANeMG");
const THREE_GJE = address("3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt");

let programs: FixtureData;
let buffers: FixtureData;
beforeAll(async () => {
  programs = await loadFixture("programs-mainnet.json.gz");
  buffers = await loadFixture("buffer-mainnet.json.gz");
});

async function vault(multisig: Address, index: number) {
  return { address: (await getVaultPda({ index, multisigPda: multisig }))[0], index };
}

describe("executable hash (solana-verify compatible)", () => {
  it("equals solana-verify's own output for real programs and a real buffer", async () => {
    const facts = await gatherProgramFacts(new FixtureRpcClient(programs), {
      buffers: [],
      programs: [SQUADS_V3, SETT1ERE, CPMM, J24J],
      vaults: [],
    });
    const hash = (program: Address) =>
      facts.programs.find((p) => p.address === program)?.executableHash;
    expect(hash(SQUADS_V3)).toBe(SOLANA_VERIFY.squadsV3);
    expect(hash(SETT1ERE)).toBe(SOLANA_VERIFY.sett1ere);
    expect(hash(CPMM)).toBe(SOLANA_VERIFY.cpmm);
    expect(hash(J24J)).toBe(SOLANA_VERIFY.j24j);
    // Same deployments solana-verify hashed (last deploy slot of each ProgramData).
    const slot = (program: Address) =>
      facts.programs.find((p) => p.address === program)?.lastDeploySlot;
    expect([slot(SQUADS_V3), slot(SETT1ERE), slot(CPMM), slot(J24J)]).toEqual([
      178977035n,
      449484640n,
      445763504n,
      449059290n,
    ]);

    const buffer = await gatherProgramFacts(new FixtureRpcClient(buffers), {
      buffers: [BUFFER],
      programs: [],
      vaults: [],
    });
    expect(buffer.buffers.get(BUFFER)?.executableHash).toBe(SOLANA_VERIFY.buffer6W37);
  });

  it("strips trailing zero bytes only (solana-verify `get_binary_hash`)", async () => {
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(await executableHash(new Uint8Array([0, 0, 0]))).toBe(empty);
    expect(await executableHash(new Uint8Array([1, 0, 2, 0, 0]))).toBe(
      await executableHash(new Uint8Array([1, 0, 2])),
    );
    expect(await executableHash(new Uint8Array([0, 1]))).not.toBe(
      await executableHash(new Uint8Array([1])),
    );
  });
});

describe("gatherProgramFacts", () => {
  it("reads loader, upgrade authority, deploy slot and whether the authority is this multisig's vault", async () => {
    const vaults = [await vault(DQNOX, 0), await vault(THREE_GJE, 0)];
    const facts = await gatherProgramFacts(new FixtureRpcClient(programs), {
      buffers: [],
      programs: [SETT1ERE, SQUADS_V3, CPMM, J24J, SYSTEM],
      vaults,
    });
    expect(facts.gaps).toEqual([]);
    const byAddress = new Map(facts.programs.map((p) => [p.address, p]));
    expect(facts.programs.map((p) => p.address)).toEqual([...byAddress.keys()].sort());
    expect(byAddress.get(SQUADS_V3)).toMatchObject({
      loader: "upgradeable",
      programData: "Q1xCTDDfdfB4jk2Wicw1HdutFVdRik5LMKYMcZdT2rU",
      upgrade: { kind: "immutable" },
      verification: "unknown",
    });
    expect(byAddress.get(SETT1ERE)).toMatchObject({
      authorityVaultIndex: 0,
      upgrade: { authority: "ER4DX3atK5EV6p4i8k11gGvR5imAQC72TWkXMk4DDpus", kind: "upgradeable" },
    });
    expect(byAddress.get(J24J)).toMatchObject({
      authorityVaultIndex: 0,
      upgrade: { authority: "7rzEKejyAXJXMkGfRhMV9Vg1k7tFznBBEFu3sfLNz8LC", kind: "upgradeable" },
    });
    expect(byAddress.get(CPMM)?.upgrade).toEqual({
      authority: "FytDrVzDybM1TwFQPGb8qaxZR7dBCzNeqT3vtQsceZQK",
      kind: "upgradeable",
    });
    expect(byAddress.get(CPMM)?.authorityVaultIndex).toBeUndefined();
    expect(byAddress.get(SYSTEM)).toEqual({
      address: SYSTEM,
      loader: "native",
      upgrade: { kind: "immutable" },
      verification: "unknown",
    });
  });

  it("reads a real buffer's authority", async () => {
    const facts = await gatherProgramFacts(new FixtureRpcClient(buffers), {
      buffers: [BUFFER],
      programs: [],
      vaults: [],
    });
    expect(facts.buffers.get(BUFFER)).toEqual({
      address: BUFFER,
      authority: BUFFER,
      executableHash: SOLANA_VERIFY.buffer6W37,
    });
  });

  it("reports what cannot be read as unknown with a gap, never a guess", async () => {
    // Accounts absent from the fixture read as non-existent, like a closed account on chain.
    const missingProgram = address("11111111111111111111111111111112");
    const facts = await gatherProgramFacts(new FixtureRpcClient(programs), {
      buffers: [BUFFER, address("Q1xCTDDfdfB4jk2Wicw1HdutFVdRik5LMKYMcZdT2rU"), SQUADS_V3],
      programs: [missingProgram, address("Q1xCTDDfdfB4jk2Wicw1HdutFVdRik5LMKYMcZdT2rU")],
      vaults: [],
    });
    expect(facts.programs).toEqual([
      {
        address: missingProgram,
        loader: "not-a-program",
        upgrade: { kind: "unknown" },
        verification: "unknown",
      },
      {
        address: "Q1xCTDDfdfB4jk2Wicw1HdutFVdRik5LMKYMcZdT2rU",
        loader: "upgradeable",
        upgrade: { kind: "unknown" },
        verification: "unknown",
      },
    ]);
    expect(facts.buffers.size).toBe(0);
    expect(facts.gaps.map((g) => [g.code, g.address, g.message])).toEqual([
      ["PROGRAM_INFO_UNKNOWN", missingProgram, "the program account does not exist"],
      [
        "PROGRAM_INFO_UNKNOWN",
        "Q1xCTDDfdfB4jk2Wicw1HdutFVdRik5LMKYMcZdT2rU",
        "program account has loader state 3, expected 2",
      ],
      [
        "PROGRAM_INFO_UNKNOWN",
        BUFFER,
        "the upgrade buffer does not exist (already used or closed)",
      ],
      [
        "PROGRAM_INFO_UNKNOWN",
        "Q1xCTDDfdfB4jk2Wicw1HdutFVdRik5LMKYMcZdT2rU",
        "account has loader state 3, not a buffer (1)",
      ],
      ["PROGRAM_INFO_UNKNOWN", SQUADS_V3, "buffer account is only 36 bytes"],
    ]);
  });

  it("does not throw when the RPC fails", async () => {
    const failing = new FixtureRpcClient(programs);
    failing.getMultipleAccounts = () => Promise.reject(new Error("down"));
    const facts = await gatherProgramFacts(failing, {
      buffers: [BUFFER],
      programs: [CPMM],
      vaults: [],
    });
    expect(facts.programs).toEqual([
      { address: CPMM, upgrade: { kind: "unknown" }, verification: "unknown" },
    ]);
    expect(facts.gaps.map((g) => g.address)).toEqual([CPMM, BUFFER]);
  });
});

describe("loader account parsers", () => {
  it("parse the real accounts and reject everything else without throwing", () => {
    const bytes = (a: Address) =>
      getBase64Encoder().encode(programs.accounts.get(a)?.dataBase64 ?? "");
    const program = parseProgramAccount(bytes(SETT1ERE));
    expect(program).toEqual({
      ok: true,
      programData: "CJWAUZ2mmbuht1hij9zxN9odX1X5rnjArGMejFK1fmCv",
    });
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 120 }), (data) => {
        parseProgramAccount(data);
        parseProgramDataAccount(data);
        parseBufferAccount(data);
      }),
    );
    const badOption = new Uint8Array(45);
    badOption[0] = 3;
    badOption[12] = 2;
    expect(parseProgramDataAccount(badOption)).toEqual({
      ok: false,
      reason: "ProgramData authority option tag is not 0 or 1",
    });
  });
});

describe("invokedPrograms / upgradeBuffers", () => {
  it("collect nested programs, CPI programs and upgrade buffers", () => {
    const loader = address("BPFLoaderUpgradeab1e11111111111111111111111");
    const upgrade = {
      accounts: [{ address: BUFFER, isSigner: false, isWritable: true, role: "bufferAccount" }],
      decoder: "native" as const,
      index: 0,
      name: "upgrade",
      programId: loader,
      provenance: "onchain" as const,
      rawDataHex: "03000000",
    };
    const outer = {
      ...upgrade,
      accounts: [],
      inner: [upgrade],
      name: "vaultTransactionCreate",
      programId: J24J,
    };
    expect(invokedPrograms([outer], [CPMM])).toEqual([loader, CPMM, J24J].sort());
    expect(upgradeBuffers([outer])).toEqual([BUFFER]);
  });
});
