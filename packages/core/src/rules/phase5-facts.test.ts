/**
 * Rules whose facts are gathered in Phase 5, run on real gathered facts (maintainer requirement,
 * docs/DECISIONS.md "Phase 4 follow-ups"): program accounts and ProgramData
 * (`programs-mainnet.json.gz`), a live upgrade buffer (`buffer-mainnet.json.gz`), and real
 * verification API answers (`http/verification-osec.json`). VGL-W006 / W007 / C012 on real simulations
 * and RPC snapshots are in `simulate/*.test.ts` and `crosscheck/crosscheck.test.ts`.
 */
import { type Address, address, type Signature } from "@solana/kit";
import { getUpgradeInstruction } from "@solana-program/loader-v3";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeRawTransaction } from "../decoders/transaction.js";
import { renderFinding } from "../i18n/render.js";
import { HttpError } from "../io/http.js";
import {
  gatherProgramFacts,
  invokedPrograms,
  upgradeBuffers,
  upgradedPrograms,
} from "../programs/gather.js";
import { addVerification, VerificationCache } from "../programs/verification.js";
import { findRegistryProgram } from "../registry/index.js";
import type { AnalysisGap, DecodedInstruction, Finding, ProgramInfo } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import type { FixtureData } from "../rpc/index.js";
import { getVaultPda } from "../squads/pda.js";
import { failingHttp, loadRecordedHttp } from "../test-support/http.js";
import {
  context,
  decodeBuilt,
  loadFixture,
  proposalFixtureContext,
  signer,
} from "../test-support/rules.js";
import { computeVerdict, runRules } from "./engine.js";
import type { RuleContext } from "./types.js";

const CPMM = address("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const J24J = address("J24jWEosQc5jgkdPm3YzNgzQ54CqNKkhzKy56XXJsLo2");
const SETT1ERE = address("Sett1ereLzRw7neSzoUSwp6vvstBkEgAgQeP6wFcw5F");
const THREE_GJE = address("3gjeSqMDqip2uLALaeFoGN3PmNx1tuY1y6S9qVxLyVJt");
const DQNOX = address("DQnoxvJiAYUeB5Ahp5VbsaMGMmJUA5Jr5b1nnJ2ANeMG");
const BUFFER = address("6W37H2XfGJmq3LXCjUt6Zzv5mpSDcLVeyCPsvjDaSfZX");

let programs: FixtureData;
let buffers: FixtureData;
beforeAll(async () => {
  programs = await loadFixture("programs-mainnet.json.gz");
  buffers = await loadFixture("buffer-mainnet.json.gz");
});

const byRule = (findings: readonly Finding[], id: string) =>
  findings.filter((f) => f.ruleId === id);

/** Program facts and verification exactly as the gatherers produce them, for non-registry programs. */
async function gather(
  instructions: readonly DecodedInstruction[],
  vaults: readonly { address: Address; index: number }[],
  verification: "recorded" | "unreachable",
  extraBuffers: FixtureData | undefined = undefined,
) {
  const merged: FixtureData = {
    ...programs,
    accounts: new Map([...programs.accounts, ...(extraBuffers?.accounts ?? [])]),
  };
  const wanted = [...invokedPrograms(instructions), ...upgradedPrograms(instructions)].filter(
    (p) => findRegistryProgram(p) === undefined,
  );
  const facts = await gatherProgramFacts(new FixtureRpcClient(merged), {
    buffers: upgradeBuffers(instructions),
    programs: wanted,
    vaults,
  });
  const http =
    verification === "recorded"
      ? await loadRecordedHttp("http/verification-osec")
      : failingHttp(() =>
          Promise.reject(new HttpError("TIMEOUT", "no answer from verify.osec.io within 8000 ms")),
        );
  const verified = await addVerification(facts.programs, {
    cache: new VerificationCache({ now: () => 0 }),
    enabled: true,
    http,
  });
  const gaps: AnalysisGap[] = [...facts.gaps, ...verified.gaps];
  return { buffers: facts.buffers, gaps, programs: verified.programs };
}

async function vault(multisig: Address, index: number) {
  return { address: (await getVaultPda({ index, multisigPda: multisig }))[0], index };
}

describe("raw Raydium CPMM swap (idl-programs.json, 2a6Uy... in x2L9pQd7)", () => {
  let instructions: readonly DecodedInstruction[];
  beforeAll(async () => {
    const data = await loadFixture("idl-programs");
    const signature = [...data.transactions.keys()].find((s) =>
      s.startsWith("x2L9pQd7"),
    ) as Signature;
    const tx = data.transactions.get(signature);
    if (tx === undefined) {
      throw new Error("fixture incomplete");
    }
    instructions = (await decodeRawTransaction(new FixtureRpcClient(data), tx.transactionBase64))
      .instructions;
    expect(instructions.some((ix) => ix.programId === CPMM)).toBe(true);
  });

  async function evaluate(
    verification: "recorded" | "unreachable",
  ): Promise<{ findings: Finding[]; ctx: RuleContext }> {
    const facts = await gather(instructions, [], verification);
    const ctx = await context({
      facts: { buffers: facts.buffers },
      gaps: facts.gaps,
      instructions,
      programs: facts.programs,
    });
    return { ctx, findings: runRules(ctx) };
  }

  it("VGL-W002: the real API says CPMM is not a verified build", async () => {
    const { findings } = await evaluate("recorded");
    const [w002] = byRule(findings, "VGL-W002");
    expect(w002).toMatchObject({
      params: { program: CPMM },
      provenance: "external-api",
      titleKey: "finding.VGL-W002.unverified",
    });
    expect(w002?.evidence).toEqual([
      `program: ${CPMM}`,
      "verification: unverified",
      "instruction: 1",
    ]);
  });

  it("VGL-W003: CPMM can be upgraded by a third party (its real ProgramData authority)", async () => {
    const { findings } = await evaluate("recorded");
    const [w003] = byRule(findings, "VGL-W003");
    expect(w003).toMatchObject({
      params: { authority: "FytDrVzDybM1TwFQPGb8qaxZR7dBCzNeqT3vtQsceZQK", program: CPMM },
      provenance: "onchain",
    });
    expect(renderFinding(w003 as Finding, "en", instructions).text).toBe(
      "Program CPMM\u2026KP1C can be upgraded by FytD\u2026eZQK, outside this multisig: its behaviour could change between the vote and execution",
    );
  });

  it("VGL-W002 unknown, with a gap and an incomplete verdict, when the API cannot be reached", async () => {
    const { findings, ctx } = await evaluate("unreachable");
    expect(byRule(findings, "VGL-W002")[0]?.titleKey).toBe("finding.VGL-W002.unknown");
    expect(ctx.gaps).toContainEqual({
      address: CPMM,
      code: "PROGRAM_VERIFICATION_UNKNOWN",
      message:
        "verify.osec.io could not say whether this program is verified: no answer from verify.osec.io within 8000 ms",
    });
    expect(byRule(findings, "VGL-W003")).toHaveLength(1);
    expect(
      computeVerdict(
        findings.filter((f) => f.severity !== "critical"),
        ctx.gaps,
      ),
    ).toBe("incomplete");
  });
});

describe("real proposal calling J24jWEos... (vault-transaction.json, #352)", () => {
  it("raises neither VGL-W002 (verified build, hash matches) nor VGL-W003 (authority is this multisig's vault 0)", async () => {
    const { context: base } = await proposalFixtureContext("vault-transaction", THREE_GJE, 352n);
    const facts = await gather(base.instructions, [await vault(THREE_GJE, 0)], "recorded");
    const j24j = facts.programs.find((p) => p.address === J24J) as ProgramInfo;
    expect(j24j).toMatchObject({ authorityVaultIndex: 0, verification: "verified" });
    const { context: ctx } = await proposalFixtureContext("vault-transaction", THREE_GJE, 352n, {
      gaps: [...base.gaps, ...facts.gaps],
      programs: facts.programs,
    });
    const findings = runRules(ctx);
    expect(byRule(findings, "VGL-W002")).toEqual([]);
    expect(byRule(findings, "VGL-W003")).toEqual([]);
    // Still reported: the instruction itself is opaque (VGL-W001).
    expect(byRule(findings, "VGL-W001")).toHaveLength(1);
  });
});

describe("real upgrade proposal (squads-program-upgrade.json, DQnoxvJi... #4)", () => {
  it("VGL-C001 shows the program's real verification status; the executed buffer is gone (unknown + gap)", async () => {
    const { context: base } = await proposalFixtureContext("squads-program-upgrade", DQNOX, 4n);
    const buffer = upgradeBuffers(base.instructions)[0];
    expect(buffer).toBeDefined();
    const facts = await gather(base.instructions, [await vault(DQNOX, 0)], "recorded");
    expect(facts.gaps).toContainEqual({
      address: buffer,
      code: "PROGRAM_INFO_UNKNOWN",
      message: "the upgrade buffer does not exist (already used or closed)",
    });
    const sett1ere = facts.programs.find((p) => p.address === SETT1ERE);
    expect(sett1ere).toMatchObject({ authorityVaultIndex: 0, verification: "unverified" });
    const { context: ctx } = await proposalFixtureContext("squads-program-upgrade", DQNOX, 4n, {
      facts: { buffers: facts.buffers },
      gaps: [...base.gaps, ...facts.gaps],
      programs: facts.programs,
    });
    const findings = runRules(ctx);
    const [c001] = byRule(findings, "VGL-C001");
    expect(c001?.params).toMatchObject({
      bufferHash: "unknown",
      program: SETT1ERE,
      verification: "unverified",
    });
    expect(byRule(findings, "VGL-C011")).toEqual([]);
    expect(byRule(findings, "VGL-W003")).toEqual([]);
  });
});

describe("an upgrade using the real live buffer 6W37H2Xf... (external authority)", () => {
  // The instruction is encoded with the official @solana-program/loader-v3 builder (no real pending
  // upgrade with a live buffer was found on mainnet); every fact the rules read — the buffer's
  // authority and hash, the program's ProgramData, the verification answer — is real.
  it("VGL-C011 fires and VGL-C001 shows the buffer's solana-verify hash", async () => {
    const { context: base, bundle } = await proposalFixtureContext(
      "squads-program-upgrade",
      DQNOX,
      4n,
    );
    const dqnoxVault = await vault(DQNOX, 0);
    const upgrade = decodeBuilt(
      getUpgradeInstruction({
        authority: signer(dqnoxVault.address),
        bufferAccount: BUFFER,
        programAccount: SETT1ERE,
        programDataAccount: address("CJWAUZ2mmbuht1hij9zxN9odX1X5rnjArGMejFK1fmCv"),
        spillAccount: dqnoxVault.address,
      }),
    );
    const facts = await gather([upgrade], [dqnoxVault], "recorded", buffers);
    expect(facts.buffers.get(BUFFER)?.authority).toBe(BUFFER);
    const ctx = await context({
      facts: { buffers: facts.buffers },
      gaps: facts.gaps,
      input: base.input,
      instructions: [upgrade],
      multisig: bundle.multisig,
      programs: facts.programs,
      vaultIndex: 0,
    });
    const findings = runRules(ctx);
    const [c011] = byRule(findings, "VGL-C011");
    expect(c011).toMatchObject({
      params: { buffer: BUFFER, bufferAuthority: BUFFER },
      provenance: "onchain",
    });
    expect(c011?.evidence).toEqual([
      `buffer: ${BUFFER}`,
      `bufferAuthority: ${BUFFER}`,
      expect.stringMatching(/^bufferAuthorityIs: /),
      `upgradeAuthority: ${dqnoxVault.address}`,
      "instruction: 0",
    ]);
    const [c001] = byRule(findings, "VGL-C001");
    expect(c001?.params).toMatchObject({
      buffer: BUFFER,
      bufferHash: "0f7beab6d6d001eb020143a87152e8352c2cc056797c41bb6b78774a7ca63bab",
      verification: "unverified",
    });
    expect(computeVerdict(findings, ctx.gaps)).toBe("critical");
  });
});
