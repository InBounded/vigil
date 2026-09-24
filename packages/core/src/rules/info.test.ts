/**
 * Info rules: positive and negative cases (real transactions in `fixtures.test.ts`).
 */
import type { Address } from "@solana/kit";
import * as computeBudgetProgram from "@solana-program/compute-budget";
import * as memoProgram from "@solana-program/memo";
import * as system from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { renderFinding } from "../i18n/render.js";
import type { Finding } from "../report.js";
import type { SquadsProposalInfo, SquadsProposalStatus } from "../squads/types.js";
import {
  account,
  addr,
  context,
  decodeBuilt,
  instruction,
  multisig,
  NOW,
  signer,
} from "../test-support/rules.js";
import {
  computeBudget,
  lookupTables,
  memo,
  priorityFeeLamports,
  proposalStatus,
  staleProposal,
} from "./catalog/info.js";
import { PROGRAMS } from "./helpers.js";

const A = addr(1);
const B = addr(2);

function only(findings: readonly Finding[]): Finding {
  expect(findings).toHaveLength(1);
  const [first] = findings;
  if (first === undefined) {
    throw new Error("no finding");
  }
  return first;
}

const limit = (units: number) =>
  decodeBuilt(computeBudgetProgram.getSetComputeUnitLimitInstruction({ units }));
const price = (microLamports: bigint) =>
  decodeBuilt(computeBudgetProgram.getSetComputeUnitPriceInstruction({ microLamports }));

describe("VGL-I001 compute budget and priority fee", () => {
  it("computes the maximum priority fee like Agave, capping the limit at 1,400,000", () => {
    expect(priorityFeeLamports(1n, 1n)).toBe(1n);
    expect(priorityFeeLamports(1_000_000n, 200_000n)).toBe(200_000n);
    expect(priorityFeeLamports(1n, 2_000_000n)).toBe(2n);
    expect(priorityFeeLamports(0n, 1_400_000n)).toBe(0n);
  });

  it("reports the fee from Compute Budget instructions", async () => {
    const ctx = await context({ instructions: [limit(300_000), price(5_000n)] });
    const found = only(computeBudget.evaluate(ctx));
    expect(found).toMatchObject({
      instructionIndex: 0,
      params: { fee: "1500", limit: "300000", price: "5000" },
      titleKey: "finding.VGL-I001.fee",
    });
    expect(renderFinding(found, "en").text).toBe(
      "Maximum priority fee 0.0000015 SOL (5,000 micro-lamports per unit × 300,000 compute units)",
    );
  });

  it("says when no priority fee is set, or the default limit applies", async () => {
    const heap = decodeBuilt(
      computeBudgetProgram.getRequestHeapFrameInstruction({ bytes: 64 * 1024 }),
    );
    expect(
      only(computeBudget.evaluate(await context({ instructions: [limit(1), heap] }))).titleKey,
    ).toBe("finding.VGL-I001.noPriorityFee");
    expect(
      only(computeBudget.evaluate(await context({ instructions: [price(0n)] }))).titleKey,
    ).toBe("finding.VGL-I001.noPriorityFee");
    expect(
      only(computeBudget.evaluate(await context({ instructions: [price(7n)] }))),
    ).toMatchObject({
      params: { price: "7" },
      titleKey: "finding.VGL-I001.defaultLimit",
    });
  });

  it("reports a v1 transaction's inline settings", async () => {
    const withFee = await context({
      transactionConfig: { computeUnitLimit: 10, priorityFeeLamports: 42n },
    });
    expect(only(computeBudget.evaluate(withFee))).toMatchObject({
      params: { fee: "42" },
      titleKey: "finding.VGL-I001.v1",
    });
    const noFee = await context({ transactionConfig: {} });
    const found = only(computeBudget.evaluate(noFee));
    expect(found.params).toEqual({ fee: "0" });
    expect(found.evidence).toContain("computeUnitLimit: default");
  });

  it("notes Compute Budget instructions inside a proposal have no effect", async () => {
    const nested = await context({
      instructions: [
        instruction({
          decoder: "squads",
          inner: [limit(1), price(1n)],
          programId: PROGRAMS.squads,
        }),
      ],
    });
    expect(only(computeBudget.evaluate(nested))).toMatchObject({
      evidence: ["instruction: 0.0", "instruction: 0.1"],
      titleKey: "finding.VGL-I001.inProposal",
    });
    const stored = await context({
      input: { kind: "squads-proposal", multisig: A, transactionIndex: 1n },
      instructions: [price(1n)],
    });
    expect(only(computeBudget.evaluate(stored)).titleKey).toBe("finding.VGL-I001.inProposal");
  });

  it("does not fire without compute budget settings, and ignores undecoded or malformed ones", async () => {
    expect(computeBudget.evaluate(await context())).toEqual([]);
    const odd = await context({
      instructions: [
        instruction({ decoder: "none", programId: PROGRAMS.computeBudget }),
        instruction({
          args: { units: "many" },
          name: "setComputeUnitLimit",
          programId: PROGRAMS.computeBudget,
        }),
      ],
    });
    expect(only(computeBudget.evaluate(odd)).titleKey).toBe("finding.VGL-I001.noPriorityFee");
  });
});

describe("VGL-I002 memo", () => {
  it("shows the (already sanitized) memo text and what the sanitizer did", async () => {
    const built = decodeBuilt(memoProgram.getAddMemoInstruction({ memo: "invoice 42" }));
    const ctx = await context({
      instructions: [
        built,
        {
          ...built,
          index: 1,
          sanitizer: [{ flags: ["bidi-removed"], modified: true, path: "memo" }],
        },
      ],
    });
    const [plain, flagged] = memo.evaluate(ctx);
    expect(plain?.params).toEqual({ memo: "invoice 42" });
    expect(plain?.evidence).toEqual(["memo: invoice 42", "instruction: 0"]);
    expect(flagged?.evidence).toContain("sanitizer: bidi-removed");
    expect(renderFinding(plain as Finding, "en").text).toBe("Memo: “invoice 42”");
  });

  it("does not fire on other programs or an undecodable memo", async () => {
    const ctx = await context({
      instructions: [
        instruction({ args: { memo: "not a memo program" }, programId: PROGRAMS.system }),
        instruction({ decoder: "none", programId: memoProgram.MEMO_PROGRAM_ADDRESS }),
      ],
    });
    expect(memo.evaluate(ctx)).toEqual([]);
  });
});

describe("VGL-I003 address lookup tables used", () => {
  it("lists every table accounts were loaded from", async () => {
    const table = addr(90);
    const other = addr(91);
    const ctx = await context({
      instructions: [
        instruction({
          accounts: [
            { ...account(A), fromLookupTable: table },
            { ...account(B), fromLookupTable: table },
            account(addr(5)),
          ],
          inner: [
            instruction({
              accounts: [{ ...account(A), fromLookupTable: other }],
              programId: PROGRAMS.system,
            }),
          ],
          programId: PROGRAMS.squads,
        }),
      ],
    });
    const found = only(lookupTables.evaluate(ctx));
    expect(found.params).toEqual({ count: "2" });
    expect(found.evidence).toEqual([
      `lookupTable: ${table} (2 account uses)`,
      `lookupTable: ${other} (1 account uses)`,
    ]);
  });

  it("does not fire when no table is used", async () => {
    const ctx = await context({
      instructions: [
        decodeBuilt(
          system.getTransferSolInstruction({ amount: 1n, destination: B, source: signer(A) }),
        ),
      ],
    });
    expect(lookupTables.evaluate(ctx)).toEqual([]);
  });
});

const proposal = (
  status: SquadsProposalStatus,
  votes: Partial<SquadsProposalInfo["votes"]> = {},
): SquadsProposalInfo => ({
  address: addr(80),
  status,
  votes: { approved: [], cancelled: [], rejected: [], ...votes },
});

const members = multisig().members.map((m) => m.key) as [Address, Address];

describe("VGL-I004 proposal status", () => {
  const statusOf = async (p: SquadsProposalInfo | null, timeLockSeconds = 0) =>
    only(
      proposalStatus.evaluate(
        await context({
          input: { kind: "squads-proposal", multisig: multisig().address, transactionIndex: 5n },
          multisig: multisig({ timeLockSeconds }),
          proposal: p,
        }),
      ),
    );

  it("gives approvals against the threshold and what is still needed", async () => {
    const active = await statusOf(
      proposal(
        { kind: "Active", timestamp: NOW },
        { approved: [members[0]], rejected: [members[1]] },
      ),
    );
    expect(active.params).toMatchObject({
      approvals: "1",
      rejections: "1",
      remaining: "1",
      threshold: "2",
    });
    expect(renderFinding(active, "en").text).toBe(
      "Voting open: 1 of 2 approvals (1 more needed), 1 rejection(s)",
    );
    expect(active.evidence).toContain(`approvedBy: ${members[0]}`);
    expect(active.evidence).toContain(`rejectedBy: ${members[1]}`);
  });

  it("says how long until an approved proposal can run, or that it can run now", async () => {
    const waiting = await statusOf(
      proposal({ kind: "Approved", timestamp: NOW - 600n }, { approved: members }),
      3_600,
    );
    expect(waiting).toMatchObject({
      params: { secondsLeft: "3000" },
      titleKey: "finding.VGL-I004.approvedWaiting",
    });
    expect(renderFinding(waiting, "en").text).toBe(
      "Approved (2 of 2); can be executed in 50 min (time lock 1 h)",
    );
    const ready = await statusOf(
      proposal({ kind: "Approved", timestamp: NOW - 7_200n }, { approved: members }),
      3_600,
    );
    expect(ready).toMatchObject({
      params: { secondsLeft: "0" },
      titleKey: "finding.VGL-I004.approvedReady",
    });
    const noTimestamp = await statusOf(proposal({ kind: "Approved", timestamp: null }));
    expect(noTimestamp.titleKey).toBe("finding.VGL-I004.Approved");
  });

  it("covers every other status and a missing proposal", async () => {
    for (const kind of ["Draft", "Rejected", "Executed", "Cancelled"] as const) {
      expect((await statusOf(proposal({ kind, timestamp: NOW }))).titleKey).toBe(
        `finding.VGL-I004.${kind}`,
      );
    }
    const executing = await statusOf(
      proposal({ kind: "Executing", timestamp: null }, { cancelled: [members[0]] }),
    );
    expect(executing.titleKey).toBe("finding.VGL-I004.Executing");
    expect(executing.evidence).toContain("statusTimestamp: none");
    expect(executing.evidence).toContain(`cancelledBy: ${members[0]}`);
    const missing = await statusOf(null, 90_061);
    expect(missing.titleKey).toBe("finding.VGL-I004.missing");
    expect(renderFinding(missing, "en").text).toBe(
      "No proposal exists yet for this transaction, so it cannot be voted on (threshold 2, time lock 1 d 1 h 1 min 1 s)",
    );
  });

  it("does not fire in base64 mode", async () => {
    expect(proposalStatus.evaluate(await context({ multisig: multisig() }))).toEqual([]);
    expect(proposalStatus.evaluate(await context({ proposal: null }))).toEqual([]);
  });
});

describe("VGL-I005 stale proposal", () => {
  const stale = async (
    p: SquadsProposalInfo | null,
    transactionKind: "vault" | "config" | "batch",
    staleTransactionIndex = 5n,
  ) =>
    staleProposal.evaluate(
      await context({
        input: { kind: "squads-proposal", multisig: multisig().address, transactionIndex: 5n },
        multisig: multisig({ staleTransactionIndex }),
        proposal: p,
        transactionKind,
      }),
    );

  it("fires on rejected, cancelled and executed proposals", async () => {
    for (const kind of ["Rejected", "Cancelled", "Executed"] as const) {
      expect(
        (await stale(proposal({ kind, timestamp: NOW }), "vault", 0n)).map((f) => f.titleKey),
      ).toEqual([`finding.VGL-I005.${kind}`]);
    }
  });

  it("fires on a stale config proposal even if approved (Squads never executes it)", async () => {
    const [found] = await stale(proposal({ kind: "Approved", timestamp: NOW }), "config");
    expect(found?.titleKey).toBe("finding.VGL-I005.staleConfig");
    expect(renderFinding(found as Finding, "en").text).toContain("Proposal #5 is stale");
  });

  it("fires on a stale vault or batch proposal that was not approved in time", async () => {
    expect((await stale(proposal({ kind: "Active", timestamp: NOW }), "vault"))[0]?.titleKey).toBe(
      "finding.VGL-I005.staleNotApproved",
    );
    const [missing] = await stale(null, "batch");
    expect(missing?.titleKey).toBe("finding.VGL-I005.staleNotApproved");
    expect(missing?.evidence).toContain("status: no proposal");
  });

  it("does not fire on executable proposals, including stale vault proposals approved in time", async () => {
    expect(await stale(proposal({ kind: "Approved", timestamp: NOW }), "vault")).toEqual([]);
    expect(await stale(proposal({ kind: "Executing", timestamp: null }), "batch")).toEqual([]);
    expect(await stale(proposal({ kind: "Active", timestamp: NOW }), "config", 4n)).toEqual([]);
    expect(staleProposal.evaluate(await context({ multisig: multisig(), proposal: null }))).toEqual(
      [],
    );
    expect(
      staleProposal.evaluate(
        await context({
          input: { kind: "squads-proposal", multisig: A, transactionIndex: 1n },
          proposal: null,
        }),
      ),
    ).toEqual([]);
    const noKind = staleProposal.evaluate(
      await context({
        input: { kind: "squads-proposal", multisig: multisig().address, transactionIndex: 5n },
        multisig: multisig({ staleTransactionIndex: 9n }),
        proposal: proposal({ kind: "Cancelled", timestamp: NOW }),
      }),
    );
    expect(noKind[0]?.evidence).toContain("transactionKind: unknown");
  });
});
