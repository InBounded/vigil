/**
 * Critical rules: positive and negative cases. Instructions are encoded by the official client
 * builders and decoded by Vigil's decoders; hand-built instructions only cover shapes a real
 * decoder cannot produce (missing accounts), so every branch is exercised.
 */
import { type Address, address } from "@solana/kit";
import * as loader from "@solana-program/loader-v3";
import * as stake from "@solana-program/stake";
import * as system from "@solana-program/system";
import * as token from "@solana-program/token";
import * as token2022 from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { renderFinding } from "../i18n/render.js";
import type { AnalysisGap, Finding } from "../report.js";
import {
  account,
  addr,
  context,
  decodeBuilt,
  instruction,
  lookalikeOf,
  multisig,
  signer,
} from "../test-support/rules.js";
import {
  accountOwnerChange,
  addressPoisoning,
  bufferExternalAuthority,
  closeToExternal,
  delegateApproval,
  looksLike,
  programUpgrade,
  stakeAuthorityChange,
  tokenAuthorityChange,
  unresolvableMessage,
  upgradeAuthorityChange,
} from "./catalog/critical.js";
import { PROGRAMS } from "./helpers.js";

const A = addr(1);
const B = addr(2);
const C = addr(3);
const D = addr(4);

function only(findings: readonly Finding[]): Finding {
  expect(findings).toHaveLength(1);
  const [first] = findings;
  if (first === undefined) {
    throw new Error("no finding");
  }
  return first;
}

function upgradeIx(buffer: Address = B, authority: Address = C) {
  return decodeBuilt(
    loader.getUpgradeInstruction({
      authority: signer(authority),
      bufferAccount: buffer,
      programAccount: A,
      programDataAccount: D,
      spillAccount: authority,
    }),
  );
}

describe("VGL-C001 program upgrade", () => {
  it("fires on a loader Upgrade with the program, buffer, hash and verification status", async () => {
    const ctx = await context({
      facts: { buffers: new Map([[B, { address: B, authority: C, executableHash: "ff" }]]) },
      instructions: [upgradeIx()],
      programs: [
        { address: A, upgrade: { authority: C, kind: "upgradeable" }, verification: "verified" },
      ],
    });
    const found = only(programUpgrade.evaluate(ctx));
    expect(found).toMatchObject({
      instructionIndex: 0,
      params: { buffer: B, bufferHash: "ff", program: A, verification: "verified" },
      provenance: "onchain",
      severity: "critical",
      titleKey: "finding.VGL-C001",
    });
    expect(found.evidence).toEqual([
      `program: ${A}`,
      `programData: ${D}`,
      `buffer: ${B}`,
      "bufferExecutableHash: ff",
      "currentVerification: verified",
      `upgradeAuthority: ${C}`,
      `spill: ${C}`,
      "instruction: 0",
    ]);
  });

  it("does not fire on other loader instructions or an undecoded loader instruction", async () => {
    const ctx = await context({
      instructions: [
        decodeBuilt(
          loader.getSetAuthorityCheckedInstruction({
            bufferOrProgramDataAccount: D,
            currentAuthority: signer(C),
            newAuthority: signer(B),
          }),
        ),
        instruction({ decoder: "none", name: "upgrade", programId: PROGRAMS.loader }),
      ],
    });
    expect(programUpgrade.evaluate(ctx)).toEqual([]);
  });
});

describe("VGL-C002 upgrade authority change", () => {
  const setAuthority = (next?: Address) =>
    decodeBuilt(
      loader.getSetAuthorityInstruction({
        bufferOrProgramDataAccount: D,
        currentAuthority: signer(C),
        ...(next === undefined ? {} : { newAuthority: next }),
      }),
    );

  it("says the program becomes immutable when no new authority is given", async () => {
    const ctx = await context({
      instructions: [setAuthority()],
      programs: [
        {
          address: A,
          programData: D,
          upgrade: { authority: C, kind: "upgradeable" },
          verification: "unknown",
        },
      ],
    });
    const found = only(upgradeAuthorityChange.evaluate(ctx));
    expect(found).toMatchObject({
      params: { account: D, newAuthority: "none", oldAuthority: C, program: A },
      titleKey: "finding.VGL-C002.immutable",
    });
    expect(found.evidence).toContain("accountKind: programData");
    expect(renderFinding(found, "en").text).toBe(
      `Removes the upgrade authority of program ${A.slice(0, 4)}…${A.slice(-4)}: it can never be changed again. This cannot be undone.`,
    );
  });

  it("uses the stronger wording when the new authority is outside the multisig", async () => {
    const ctx = await context({
      facts: { buffers: new Map([[D, { address: D, authority: C }]]) },
      instructions: [setAuthority(B)],
      multisig: multisig(),
    });
    const found = only(upgradeAuthorityChange.evaluate(ctx));
    expect(found.titleKey).toBe("finding.VGL-C002.external");
    expect(found.evidence).toContain("accountKind: buffer");
    expect(found.evidence).toContain("newAuthorityIs: unknown");
    // No program known for this account: the wording names the account instead.
    expect(renderFinding(found, "en").text).toContain(
      `Hands the upgrade authority of ${D.slice(0, 4)}…`,
    );
  });

  it("uses the milder wording for a vault of this multisig or a known address", async () => {
    const ms = multisig();
    const base = await context({ multisig: ms });
    const [vault] = [...base.vaults.keys()];
    if (vault === undefined) {
      throw new Error("no vault");
    }
    const toVault = await context({ instructions: [setAuthority(vault)], multisig: ms });
    const found = only(upgradeAuthorityChange.evaluate(toVault));
    expect(found.titleKey).toBe("finding.VGL-C002.ownVault");
    expect(found.evidence).toContain("newAuthorityIs: vault #0");
    expect(found.evidence).toContain("accountKind: unknown");

    const toKnown = await context({
      instructions: [
        decodeBuilt(
          loader.getSetAuthorityCheckedInstruction({
            bufferOrProgramDataAccount: D,
            currentAuthority: signer(C),
            newAuthority: signer(B),
          }),
        ),
      ],
      options: { knownAddresses: new Map([[B, "Treasury"]]) },
    });
    const known = only(upgradeAuthorityChange.evaluate(toKnown));
    expect(known.titleKey).toBe("finding.VGL-C002.ownVault");
    expect(known.evidence).toContain('newAuthorityIs: user label "Treasury"');
  });
});

describe("VGL-C003 token authority change", () => {
  it("fires on SPL Token SetAuthority, naming the authority type and both authorities", async () => {
    const ctx = await context({
      instructions: [
        decodeBuilt(
          token.getSetAuthorityInstruction({
            authorityType: token.AuthorityType.MintTokens,
            newAuthority: B,
            owned: A,
            owner: C,
          }),
        ),
      ],
    });
    const found = only(tokenAuthorityChange.evaluate(ctx));
    expect(found).toMatchObject({
      params: { account: A, authorityType: "MintTokens", newAuthority: B, oldAuthority: C },
      titleKey: "finding.VGL-C003",
    });
    expect(renderFinding(found, "pt-PT").text).toContain("Altera a autoridade de emissão");
  });

  it("says the authority is removed for good when none is given (Token-2022 extension authority)", async () => {
    const ctx = await context({
      instructions: [
        decodeBuilt(
          token2022.getSetAuthorityInstruction({
            authorityType: token2022.AuthorityType.TransferHookProgramId,
            newAuthority: null,
            owned: A,
            owner: C,
          }),
        ),
      ],
    });
    expect(only(tokenAuthorityChange.evaluate(ctx))).toMatchObject({
      params: { authorityType: "TransferHookProgramId", newAuthority: "none" },
      titleKey: "finding.VGL-C003.removed",
    });
  });

  it("fires on Token-2022 metadata and group update-authority changes", async () => {
    const ctx = await context({
      instructions: [
        decodeBuilt(
          token2022.getUpdateTokenMetadataUpdateAuthorityInstruction({
            metadata: A,
            newUpdateAuthority: B,
            updateAuthority: signer(C),
          }),
        ),
        decodeBuilt(
          token2022.getUpdateTokenGroupUpdateAuthorityInstruction({
            group: D,
            newUpdateAuthority: null,
            updateAuthority: signer(C),
          }),
        ),
      ],
    });
    const [metadata, group] = tokenAuthorityChange.evaluate(ctx);
    expect(metadata).toMatchObject({
      params: { account: A, authorityType: "MetadataUpdate", newAuthority: B, oldAuthority: C },
      titleKey: "finding.VGL-C003",
    });
    expect(group).toMatchObject({
      params: { account: D, authorityType: "GroupUpdate", newAuthority: "none" },
      titleKey: "finding.VGL-C003.removed",
    });
  });

  it("does not fire on transfers, other programs, unnamed or undecoded token instructions", async () => {
    const ctx = await context({
      instructions: [
        decodeBuilt(
          token.getTransferInstruction({ amount: 1n, authority: C, destination: B, source: A }),
        ),
        decodeBuilt(system.getAssignInstruction({ account: signer(A), programAddress: B })),
        instruction({ decoder: "none", programId: PROGRAMS.token }),
        instruction({ programId: PROGRAMS.token2022 }),
      ],
    });
    expect(tokenAuthorityChange.evaluate(ctx)).toEqual([]);
  });
});

describe("VGL-C004 delegate approval", () => {
  it("fires on Approve and ApproveChecked with the delegate and amount", async () => {
    const approve = decodeBuilt(
      token.getApproveInstruction({ amount: 5n, delegate: B, owner: C, source: A }),
    );
    const checked = decodeBuilt(
      token2022.getApproveCheckedInstruction({
        amount: 7_000_000n,
        decimals: 6,
        delegate: B,
        mint: D,
        owner: C,
        source: A,
      }),
    );
    const ctx = await context({
      instructions: [
        approve,
        {
          ...checked,
          index: 1,
          summary: { key: "x", params: { decimals: "6", mint: D, symbol: "USDC" } },
        },
      ],
    });
    const [first, second] = delegateApproval.evaluate(ctx);
    expect(first).toMatchObject({ params: { amount: "5", delegate: B, source: A } });
    expect(first?.evidence).toContain("mint: unknown");
    expect(second?.params).toMatchObject({
      amount: "7000000",
      decimals: "6",
      mint: D,
      symbol: "USDC",
    });
    if (second === undefined) {
      throw new Error("no finding");
    }
    expect(renderFinding(second, "en").text).toContain("move up to 7 USDC out of");
  });

  it("shows an unknown amount rather than guessing, and ignores Revoke", async () => {
    const ctx = await context({
      instructions: [
        instruction({ name: "approve", programId: PROGRAMS.token }),
        decodeBuilt(token.getRevokeInstruction({ owner: C, source: A })),
      ],
    });
    expect(only(delegateApproval.evaluate(ctx)).params).toMatchObject({
      amount: "unknown",
      delegate: "unknown",
      source: "unknown",
    });
  });
});

describe("VGL-C005 account owner change", () => {
  it("fires on Assign and AssignWithSeed", async () => {
    const ctx = await context({
      instructions: [
        decodeBuilt(system.getAssignInstruction({ account: signer(A), programAddress: B })),
        decodeBuilt(
          system.getAssignWithSeedInstruction({
            account: C,
            base: A,
            baseAccount: signer(A),
            programAddress: D,
            seed: "x",
          }),
        ),
      ],
    });
    const [assign, seeded] = accountOwnerChange.evaluate(ctx);
    expect(assign?.params).toEqual({ account: A, owner: B });
    expect(seeded?.params).toEqual({ account: C, owner: D });
  });

  it("does not fire on CreateAccount (a new account for a program), and tolerates a missing argument", async () => {
    const ctx = await context({
      instructions: [
        decodeBuilt(
          system.getCreateAccountInstruction({
            lamports: 1n,
            newAccount: signer(A),
            payer: signer(C),
            programAddress: B,
            space: 1n,
          }),
        ),
      ],
    });
    expect(accountOwnerChange.evaluate(ctx)).toEqual([]);
    const odd = await context({
      instructions: [instruction({ name: "assign", programId: PROGRAMS.system })],
    });
    expect(only(accountOwnerChange.evaluate(odd)).params).toEqual({
      account: "unknown",
      owner: "unknown",
    });
  });
});

describe("VGL-C007 stake authority change", () => {
  it("fires on every Authorize form with old and new authority", async () => {
    const ctx = await context({
      instructions: [
        decodeBuilt(
          stake.getAuthorizeInstruction({
            arg0: B,
            arg1: stake.StakeAuthorize.Withdrawer,
            authority: signer(C),
            stake: A,
          }),
        ),
        decodeBuilt(
          stake.getAuthorizeCheckedInstruction({
            authority: signer(C),
            newAuthority: signer(B),
            stake: A,
            stakeAuthorize: stake.StakeAuthorize.Staker,
          }),
        ),
        decodeBuilt(
          stake.getAuthorizeWithSeedInstruction({
            authorityOwner: D,
            authoritySeed: "s",
            base: signer(C),
            newAuthorizedPubkey: B,
            stake: A,
            stakeAuthorize: stake.StakeAuthorize.Withdrawer,
          }),
        ),
        decodeBuilt(
          stake.getAuthorizeCheckedWithSeedInstruction({
            authorityOwner: D,
            authoritySeed: "s",
            base: signer(C),
            newAuthority: signer(B),
            stake: A,
            stakeAuthorize: stake.StakeAuthorize.Staker,
          }),
        ),
      ],
    });
    const found = stakeAuthorityChange.evaluate(ctx);
    expect(
      found.map((f) => [
        f.titleKey,
        f.params.stakeAuthorize,
        f.params.newAuthority,
        f.params.oldAuthority,
      ]),
    ).toEqual([
      ["finding.VGL-C007.authorize", "1", B, C],
      ["finding.VGL-C007.authorize", "0", B, C],
      ["finding.VGL-C007.authorize", "1", B, C],
      ["finding.VGL-C007.authorize", "0", B, C],
    ]);
    const [first] = found;
    if (first === undefined) {
      throw new Error("no finding");
    }
    expect(renderFinding(first, "en").text).toContain(
      "Changes the withdraw authority of stake account",
    );
  });

  it("fires on SetLockup / SetLockupChecked only when they set a new custodian", async () => {
    const ctx = await context({
      instructions: [
        decodeBuilt(
          stake.getSetLockupInstruction({
            authority: signer(C),
            custodian: B,
            epoch: null,
            stake: A,
            unixTimestamp: null,
          }),
        ),
        decodeBuilt(
          stake.getSetLockupInstruction({
            authority: signer(C),
            custodian: null,
            epoch: 5n,
            stake: A,
            unixTimestamp: null,
          }),
        ),
        {
          ...decodeBuilt(
            stake.getSetLockupCheckedInstruction({
              authority: signer(C),
              epoch: null,
              stake: A,
              unixTimestamp: null,
            }),
          ),
          // The official builder has no custodian input; the program reads it from account 2
          // (solana-program/stake `interface/src/instruction.rs`, `set_lockup_checked`).
          accounts: [
            account(A),
            account(C, "authority", { isSigner: true }),
            account(D, undefined, { isSigner: true }),
          ],
        },
        decodeBuilt(
          stake.getSetLockupCheckedInstruction({
            authority: signer(C),
            epoch: 3n,
            stake: A,
            unixTimestamp: null,
          }),
        ),
      ],
    });
    const found = stakeAuthorityChange.evaluate(ctx);
    expect(found.map((f) => [f.titleKey, f.params.newAuthority])).toEqual([
      ["finding.VGL-C007.custodian", B],
      ["finding.VGL-C007.custodian", D],
    ]);
  });

  it("does not fire on withdraw, delegate, undecoded or unnamed stake instructions", async () => {
    const ctx = await context({
      instructions: [
        decodeBuilt(
          stake.getWithdrawInstruction({
            args: 1n,
            recipient: B,
            stake: A,
            withdrawAuthority: signer(C),
          }),
        ),
        instruction({ decoder: "none", programId: PROGRAMS.stake }),
        instruction({ programId: PROGRAMS.stake }),
      ],
    });
    expect(stakeAuthorityChange.evaluate(ctx)).toEqual([]);
  });

  it("shows unknown values rather than guessing when accounts are missing", async () => {
    const ctx = await context({
      instructions: [
        instruction({ name: "authorizeChecked", programId: PROGRAMS.stake }),
        instruction({
          accounts: [account(B, "base")],
          name: "authorizeWithSeed",
          programId: PROGRAMS.stake,
        }),
        instruction({ name: "authorizeCheckedWithSeed", programId: PROGRAMS.stake }),
      ],
    });
    expect(
      stakeAuthorityChange.evaluate(ctx).map((f) => [f.params.newAuthority, f.params.oldAuthority]),
    ).toEqual([
      ["unknown", "unknown"],
      ["unknown", B],
      ["unknown", "unknown"],
    ]);
  });
});

describe("VGL-C008 address poisoning", () => {
  it("compares the first and last four characters only, and never an address with itself", () => {
    expect(looksLike(A, lookalikeOf(A))).toBe(true);
    expect(looksLike(A, A)).toBe(false);
    expect(looksLike(A, B)).toBe(false);
  });

  it("fires on a transaction address that looks like a member but is not one", async () => {
    const ms = multisig();
    const member = ms.members[0]?.key ?? A;
    const fake = lookalikeOf(member);
    const ctx = await context({
      instructions: [
        decodeBuilt(
          system.getTransferSolInstruction({ amount: 1n, destination: fake, source: signer(C) }),
        ),
      ],
      multisig: ms,
    });
    const found = only(addressPoisoning.evaluate(ctx));
    expect(found.params).toEqual({ address: fake, resembles: member });
    expect(found.evidence).toContain(`resembles: ${member} (member)`);
    // Full addresses in the sentence: shortening them would hide exactly what differs.
    expect(renderFinding(found, "en").text).toContain(fake);
  });

  it("checks address arguments, token account owners and config actions too", async () => {
    const known = new Map([[A, "Treasury"]]);
    const fake = lookalikeOf(A);
    const inArgs = await context({
      instructions: [
        decodeBuilt(
          token.getSetAuthorityInstruction({
            authorityType: token.AuthorityType.AccountOwner,
            newAuthority: fake,
            owned: B,
            owner: C,
          }),
        ),
      ],
      options: { knownAddresses: known },
    });
    expect(only(addressPoisoning.evaluate(inArgs)).params.address).toBe(fake);

    const inOwner = await context({
      instructions: [
        instruction({
          programId: PROGRAMS.token,
          summary: { key: "x", params: { destinationOwner: fake } },
        }),
      ],
      options: { knownAddresses: known },
    });
    expect(only(addressPoisoning.evaluate(inOwner)).params.address).toBe(fake);

    const inConfig = await context({
      configActions: [{ kind: "addMember", member: fake, permissions: ["Vote"] }],
      options: { knownAddresses: known },
    });
    expect(only(addressPoisoning.evaluate(inConfig)).params.address).toBe(fake);
  });

  it("does not fire on known addresses, unrelated addresses, constructed native ids or non-address strings", async () => {
    const ctx = await context({
      instructions: [
        instruction({
          accounts: [account(A), account(B)],
          args: { list: [C, "not an address", 7, null], nested: { value: D } },
          programId: address("StakeConfig11111111111111111111111111111111"),
        }),
      ],
      options: { knownAddresses: new Map([[A, "Treasury"]]) },
    });
    expect(addressPoisoning.evaluate(ctx)).toEqual([]);
  });
});

describe("VGL-C009 account closed to an external destination", () => {
  const closeToken = (destination: Address) =>
    decodeBuilt(token.getCloseAccountInstruction({ account: A, destination, owner: C }));
  const closeProgram = (destination: Address) =>
    decodeBuilt(
      loader.getCloseInstruction({
        authority: signer(C),
        bufferOrProgramDataAccount: D,
        destinationAccount: destination,
      }),
    );

  it("fires when the lamports go outside the multisig's vaults", async () => {
    const ctx = await context({
      input: { kind: "squads-proposal", multisig: multisig().address, transactionIndex: 1n },
      instructions: [closeToken(B), closeProgram(B)],
      multisig: multisig(),
    });
    expect(
      closeToExternal
        .evaluate(ctx)
        .map((f) => [f.titleKey, f.params.account, f.params.destination]),
    ).toEqual([
      ["finding.VGL-C009.token", A, B],
      ["finding.VGL-C009.loader", D, B],
    ]);
  });

  it("does not fire when the lamports go to a vault, a known address or (base64 mode) a signer", async () => {
    const ms = multisig();
    const base = await context({ multisig: ms });
    const [vault] = [...base.vaults.keys()];
    if (vault === undefined) {
      throw new Error("no vault");
    }
    const proposal = await context({
      input: { kind: "squads-proposal", multisig: ms.address, transactionIndex: 1n },
      instructions: [closeToken(vault), closeProgram(B)],
      multisig: ms,
      options: { knownAddresses: new Map([[B, "Ops wallet"]]) },
    });
    expect(closeToExternal.evaluate(proposal)).toEqual([]);

    const raw = await context({ feePayer: B, instructions: [closeToken(C), closeProgram(B)] });
    expect(closeToExternal.evaluate(raw)).toEqual([]);
  });

  it("does not fire without a destination, and shows an unknown closed account", async () => {
    const ctx = await context({
      instructions: [
        instruction({ name: "closeAccount", programId: PROGRAMS.token }),
        instruction({
          accounts: [account(B, "destination")],
          name: "closeAccount",
          programId: PROGRAMS.token2022,
        }),
      ],
    });
    expect(only(closeToExternal.evaluate(ctx)).params).toEqual({
      account: "unknown",
      destination: B,
    });
  });
});

describe("VGL-C010 unresolvable message", () => {
  const gap = (
    code: AnalysisGap["code"],
    instructionIndex?: number,
    where?: Address,
  ): AnalysisGap => ({
    code,
    message: `${code} detail`,
    ...(instructionIndex === undefined ? {} : { instructionIndex }),
    ...(where === undefined ? {} : { address: where }),
  });

  it("fires once per kind of unresolvable gap, with the instruction when there is only one", async () => {
    const ctx = await context({
      gaps: [
        gap("LOOKUP_TABLE_NOT_FOUND", 2),
        gap("LOOKUP_TABLE_NOT_FOUND", 2),
        gap("ACCOUNT_UNRESOLVED", 1),
        gap("ACCOUNT_UNRESOLVED", 3),
        gap("EMBEDDED_MESSAGE_INVALID"),
        gap("MALFORMED_INSTRUCTION", 0, PROGRAMS.squads),
      ],
    });
    const found = unresolvableMessage.evaluate(ctx);
    expect(found.map((f) => [f.params.code, f.instructionIndex])).toEqual([
      ["LOOKUP_TABLE_NOT_FOUND", 2],
      ["ACCOUNT_UNRESOLVED", undefined],
      ["EMBEDDED_MESSAGE_INVALID", undefined],
      ["MALFORMED_INSTRUCTION", 0],
    ]);
    const [first] = found;
    if (first === undefined) {
      throw new Error("no finding");
    }
    expect(renderFinding(first, "en").text).toBe(
      "Part of the transaction cannot be resolved, so what it does cannot be fully shown: An address lookup table used by the transaction does not exist.",
    );
  });

  it("does not fire on gaps that leave the message resolvable", async () => {
    const ctx = await context({
      gaps: [
        gap("UNKNOWN_PROGRAM", 0),
        gap("MALFORMED_INSTRUCTION", 0, PROGRAMS.token),
        gap("TOKEN_DECIMALS_UNKNOWN", 1),
      ],
    });
    expect(unresolvableMessage.evaluate(ctx)).toEqual([]);
  });
});

describe("VGL-C011 upgrade buffer with external authority", () => {
  it("fires when the buffer's authority is not the upgrading authority", async () => {
    const ctx = await context({
      facts: { buffers: new Map([[B, { address: B, authority: D }]]) },
      instructions: [upgradeIx(B, C)],
    });
    expect(only(bufferExternalAuthority.evaluate(ctx)).params).toEqual({
      buffer: B,
      bufferAuthority: D,
    });
  });

  it("does not fire when the buffer is unknown, immutable or held by the upgrading authority", async () => {
    for (const buffers of [
      undefined,
      new Map([[B, { address: B, authority: null }]]),
      new Map([[B, { address: B, authority: C }]]),
    ]) {
      const ctx = await context({
        ...(buffers === undefined ? {} : { facts: { buffers } }),
        instructions: [
          upgradeIx(B, C),
          decodeBuilt(
            system.getTransferSolInstruction({ amount: 1n, destination: A, source: signer(C) }),
          ),
        ],
      });
      expect(bufferExternalAuthority.evaluate(ctx)).toEqual([]);
    }
  });

  it("handles an upgrade instruction missing its buffer or authority", async () => {
    const noBuffer = await context({
      facts: { buffers: new Map([[B, { address: B, authority: D }]]) },
      instructions: [instruction({ name: "upgrade", programId: PROGRAMS.loader })],
    });
    expect(bufferExternalAuthority.evaluate(noBuffer)).toEqual([]);
    const noAuthority = await context({
      facts: { buffers: new Map([[B, { address: B, authority: D }]]) },
      instructions: [
        instruction({
          accounts: [account(B, "bufferAccount")],
          name: "upgrade",
          programId: PROGRAMS.loader,
        }),
      ],
    });
    expect(only(bufferExternalAuthority.evaluate(noAuthority)).evidence).toContain(
      "upgradeAuthority: unknown",
    );
  });
});
