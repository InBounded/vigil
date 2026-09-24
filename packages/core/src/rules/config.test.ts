/**
 * VGL-C006 and the Squads config-action conversion. Squads instructions are encoded with the
 * generated client (from the official Squads v4 IDL) and decoded by Vigil's decoder; the real
 * config proposals are covered in `fixtures.test.ts`.
 */
import { type Address, address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { renderFinding } from "../i18n/render.js";
import type { ConfigAction, Finding } from "../report.js";
import { configActionsFromInstruction, toConfigAction } from "../squads/config-actions.js";
import * as squads from "../squads/generated/index.js";
import {
  account,
  addr,
  context,
  decodeBuilt,
  instruction,
  multisig,
  signer,
} from "../test-support/rules.js";
import { multisigConfigChange } from "./catalog/config.js";
import { PROGRAMS } from "./helpers.js";

const A = addr(1);
const B = addr(2);
const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MS = multisig({ threshold: 3, timeLockSeconds: 3600 });

const base = { configAuthority: signer(A), memo: null, multisig: MS.address, rentPayer: signer(A) };

function titles(findings: readonly Finding[]): string[] {
  return findings.map((f) => f.titleKey.replace("finding.VGL-C006.", ""));
}

describe("config actions from the generated Squads client", () => {
  it("converts every ConfigAction variant", () => {
    const actions: squads.ConfigAction[] = [
      { __kind: "AddMember", newMember: { key: A, permissions: { mask: 7 } } },
      { __kind: "RemoveMember", oldMember: A },
      { __kind: "ChangeThreshold", newThreshold: 2 },
      { __kind: "SetTimeLock", newTimeLock: 60 },
      {
        __kind: "AddSpendingLimit",
        amount: 5n,
        createKey: A,
        destinations: [B],
        members: [A],
        mint: USDC,
        period: squads.Period.Week,
        vaultIndex: 1,
      },
      { __kind: "RemoveSpendingLimit", spendingLimit: B },
      { __kind: "SetRentCollector", newRentCollector: { __option: "None" } },
    ];
    expect(actions.map(toConfigAction)).toEqual([
      { kind: "addMember", member: A, permissions: ["Initiate", "Vote", "Execute"] },
      { kind: "removeMember", member: A },
      { kind: "changeThreshold", newThreshold: 2 },
      { kind: "setTimeLock", newTimeLockSeconds: 60 },
      {
        amount: 5n,
        createKey: A,
        destinations: [B],
        kind: "addSpendingLimit",
        members: [A],
        mint: USDC,
        period: "Week",
        vaultIndex: 1,
      },
      { kind: "removeSpendingLimit", spendingLimit: B },
      { kind: "setRentCollector", newRentCollector: null },
    ]);
  });

  it("reads config changes from direct config-authority instructions, and nothing from others", () => {
    const direct = [
      squads.getMultisigAddMemberInstruction({
        ...base,
        newMember: { key: B, permissions: { mask: 2 } },
      }),
      squads.getMultisigRemoveMemberInstruction({ ...base, oldMember: B }),
      squads.getMultisigChangeThresholdInstruction({ ...base, newThreshold: 1 }),
      squads.getMultisigSetTimeLockInstruction({ ...base, timeLock: 0 }),
      squads.getMultisigAddSpendingLimitInstruction({
        ...base,
        amount: 1n,
        createKey: B,
        destinations: [],
        members: [B],
        mint: USDC,
        period: squads.Period.OneTime,
        spendingLimit: addr(9),
        vaultIndex: 0,
      }),
      squads.getMultisigRemoveSpendingLimitInstruction({
        configAuthority: signer(A),
        memo: null,
        multisig: MS.address,
        rentCollector: A,
        spendingLimit: addr(9),
      }),
      squads.getMultisigSetRentCollectorInstruction({ ...base, rentCollector: B }),
    ].map((built) => configActionsFromInstruction(decodeBuilt(built)));
    expect(direct).toEqual([
      [{ kind: "addMember", member: B, permissions: ["Vote"] }],
      [{ kind: "removeMember", member: B }],
      [{ kind: "changeThreshold", newThreshold: 1 }],
      [{ kind: "setTimeLock", newTimeLockSeconds: 0 }],
      [
        {
          amount: 1n,
          createKey: B,
          destinations: [],
          kind: "addSpendingLimit",
          members: [B],
          mint: USDC,
          period: "OneTime",
          vaultIndex: 0,
        },
      ],
      [{ kind: "removeSpendingLimit", spendingLimit: addr(9) }],
      [{ kind: "setRentCollector", newRentCollector: B }],
    ]);

    // `multisigSetConfigAuthority` has an argument with the same name as its signer account; the
    // generated builder cannot express that, so its data is encoded with the generated encoder.
    const setAuthority = instruction({
      decoder: "squads",
      name: "multisigSetConfigAuthority",
      programId: PROGRAMS.squads,
      rawDataHex: Buffer.from(
        squads
          .getMultisigSetConfigAuthorityInstructionDataEncoder()
          .encode({ configAuthority: B, memo: null }),
      ).toString("hex"),
    });
    expect(configActionsFromInstruction(setAuthority)).toEqual([
      { kind: "setConfigAuthority", newConfigAuthority: B },
    ]);

    expect(
      configActionsFromInstruction(
        decodeBuilt(
          squads.getProposalApproveInstruction({
            args: { memo: null },
            member: signer(A),
            multisig: MS.address,
            proposal: B,
          }),
        ),
      ),
    ).toBeUndefined();
    expect(
      configActionsFromInstruction(instruction({ programId: PROGRAMS.token })),
    ).toBeUndefined();
    expect(
      configActionsFromInstruction(instruction({ decoder: "none", programId: PROGRAMS.squads })),
    ).toBeUndefined();
    expect(
      configActionsFromInstruction(
        instruction({
          decoder: "squads",
          name: "multisigRemoveSpendingLimit",
          programId: PROGRAMS.squads,
        }),
      ),
    ).toEqual([]);
  });
});

describe("VGL-C006 multisig configuration change", () => {
  const all: ConfigAction[] = [
    { kind: "addMember", member: A, permissions: [] },
    { kind: "removeMember", member: A },
    { kind: "changeThreshold", newThreshold: 1 },
    { kind: "changeThreshold", newThreshold: 4 },
    { kind: "setTimeLock", newTimeLockSeconds: 0 },
    { kind: "setTimeLock", newTimeLockSeconds: 86_400 },
    { kind: "setRentCollector", newRentCollector: null },
    { kind: "setRentCollector", newRentCollector: B },
    {
      amount: 1_000_000_000n,
      createKey: A,
      destinations: [],
      kind: "addSpendingLimit",
      members: [A, B],
      mint: USDC,
      period: "Month",
      vaultIndex: 0,
    },
    { kind: "removeSpendingLimit", spendingLimit: B },
    { kind: "setConfigAuthority", newConfigAuthority: B },
  ];

  it("describes every change of a config proposal, with the stronger wording when lowering", async () => {
    const ctx = await context({
      configActions: all,
      input: { kind: "squads-proposal", multisig: MS.address, transactionIndex: 1n },
      multisig: MS,
      transactionKind: "config",
    });
    const found = multisigConfigChange.evaluate(ctx);
    expect(titles(found)).toEqual([
      "addMember",
      "removeMember",
      "thresholdLowered",
      "threshold",
      "timeLockLowered",
      "timeLock",
      "rentCollector",
      "rentCollector",
      "spendingLimitAdded",
      "spendingLimitRemoved",
      "configAuthority",
    ]);
    expect(found.every((f) => f.params.proposed === undefined && f.provenance === "onchain")).toBe(
      true,
    );
    const text = found.map((f) => renderFinding(f, "en").text);
    expect(text[0]).toContain("with permissions: none");
    expect(text[2]).toBe(
      "LOWERS the approval threshold from 3 to 1: fewer members will be needed to approve transactions",
    );
    expect(text[4]).toBe(
      "LOWERS the time lock from 1 h to 0 s: approved transactions can be executed sooner, leaving less time to react",
    );
    expect(text[5]).toBe("Changes the time lock from 1 h to 1 d");
    expect(text[6]).toBe("Removes the rent collector");
    expect(text[8]).toBe(
      "Adds a spending limit on vault #0: 2 member(s) can spend up to 1,000 USDC per month without a vote, to any address",
    );
  });

  it("marks a config proposal being created as proposed, and a direct config-authority change as not", async () => {
    const create = decodeBuilt(
      squads.getConfigTransactionCreateInstruction({
        actions: [{ __kind: "ChangeThreshold", newThreshold: 1 }],
        creator: signer(A),
        memo: null,
        multisig: MS.address,
        rentPayer: signer(A),
        transaction: addr(50),
      }),
    );
    const direct = decodeBuilt(
      squads.getMultisigAddMemberInstruction({
        ...base,
        newMember: { key: B, permissions: { mask: 7 } },
      }),
      1,
    );
    const ctx = await context({ instructions: [create, direct], multisig: MS });
    const [proposed, now] = multisigConfigChange.evaluate(ctx);
    expect(proposed).toMatchObject({
      instructionIndex: 0,
      params: { newThreshold: "1", oldThreshold: "3", proposed: "true" },
      titleKey: "finding.VGL-C006.thresholdLowered",
    });
    expect(renderFinding(proposed as Finding, "en").text).toContain("Proposed only:");
    expect(now).toMatchObject({ instructionIndex: 1, titleKey: "finding.VGL-C006.addMember" });
    expect(now?.params.proposed).toBeUndefined();
  });

  it("does not compare with the current settings of a different multisig, or when none is known", async () => {
    const other = decodeBuilt(
      squads.getMultisigChangeThresholdInstruction({
        ...base,
        multisig: addr(77),
        newThreshold: 1,
      }),
    );
    const withOther = await context({ instructions: [other], multisig: MS });
    const [changed] = multisigConfigChange.evaluate(withOther);
    expect(changed?.titleKey).toBe("finding.VGL-C006.threshold");
    expect(renderFinding(changed as Finding, "en").text).toBe("Sets the approval threshold to 1");

    const noMultisig = await context({
      configActions: [{ kind: "setTimeLock", newTimeLockSeconds: 30 }],
    });
    const [timeLock] = multisigConfigChange.evaluate(noMultisig);
    expect(timeLock?.evidence).toContain("multisig: unknown");
    expect(renderFinding(timeLock as Finding, "en").text).toBe("Sets the time lock to 30 s");

    const orphan = await context({
      instructions: [
        instruction({
          accounts: [account(B, "spendingLimit")],
          decoder: "squads",
          name: "multisigRemoveSpendingLimit",
          programId: PROGRAMS.squads,
        }),
      ],
    });
    expect(multisigConfigChange.evaluate(orphan)[0]?.evidence[0]).toBe("multisig: unknown");
  });

  it("shows spending limit amounts in SOL, with known decimals, or in base units", async () => {
    const limit = (mint: Address): ConfigAction => ({
      amount: 2_500_000_000n,
      createKey: A,
      destinations: [B],
      kind: "addSpendingLimit",
      members: [A],
      mint,
      period: "OneTime",
      vaultIndex: 3,
    });
    const unknownMint = addr(88);
    const declaredMint = addr(89);
    const ctx = await context({
      configActions: [limit(PROGRAMS.system), limit(unknownMint), limit(declaredMint)],
      tokens: [{ decimals: 9, mint: declaredMint, tokenProgram: PROGRAMS.token }],
    });
    const text = multisigConfigChange.evaluate(ctx).map((f) => renderFinding(f, "en").text);
    expect(text[0]).toBe(
      "Adds a spending limit on vault #3: 1 member(s) can spend up to 2.5 SOL in total (once) without a vote, to 1 allowed destination(s)",
    );
    expect(text[1]).toContain("up to 2,500,000,000 base units of token");
    expect(text[2]).toContain("up to 2.5 of token");
  });
});
