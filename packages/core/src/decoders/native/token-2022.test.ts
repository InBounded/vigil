import {
  type AccountMeta,
  AccountRole,
  type Address,
  createNoopSigner,
  getAddressDecoder,
  type Instruction,
  type InstructionWithData,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  AccountState,
  AuthorityType,
  getApproveCheckedInstruction,
  getBurnCheckedInstruction,
  getCloseAccountInstruction,
  getDisableCpiGuardInstruction,
  getFreezeAccountInstruction,
  getInitializeAccount3Instruction,
  getInitializeGroupMemberPointerInstruction,
  getInitializeGroupPointerInstruction,
  getInitializeMetadataPointerInstruction,
  getInitializeMint2Instruction,
  getInitializeMintCloseAuthorityInstruction,
  getInitializeMintInstruction,
  getInitializePausableConfigInstruction,
  getInitializePermanentDelegateInstruction,
  getInitializeTransferHookInstruction,
  getMintToCheckedInstruction,
  getMintToInstruction,
  getPauseInstruction,
  getResumeInstruction,
  getRevokeInstruction,
  getSetAuthorityInstruction,
  getSetTransferFeeInstruction,
  getSyncNativeInstruction,
  getThawAccountInstruction,
  getTransferCheckedInstruction,
  getTransferInstruction,
  getUpdateDefaultAccountStateInstruction,
  getUpdateGroupMemberPointerInstruction,
  getUpdateGroupPointerInstruction,
  getUpdateMetadataPointerInstruction,
  getUpdateTokenGroupUpdateAuthorityInstruction,
  getUpdateTokenMetadataUpdateAuthorityInstruction,
  getUpdateTransferHookInstruction,
  getWithdrawExcessLamportsInstruction,
  TOKEN_2022_PROGRAM_ADDRESS as OFFICIAL_TOKEN_2022_PROGRAM_ADDRESS,
  parseToken2022Instruction,
  Token2022Instruction,
} from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { enumName, instructionName, normalizeArgs, rolesFromParsedAccounts } from "../codama.js";
import type { InstructionInput } from "../types.js";
import {
  TOKEN_2022_AUTHORITY_TYPES,
  TOKEN_2022_PROGRAM_ADDRESS,
  token2022Decoder,
} from "./token-2022.js";

const addressDecoder = getAddressDecoder();
const addr = (seed: number): Address => addressDecoder.decode(new Uint8Array(32).fill(seed));
const signer = (seed: number) => createNoopSigner(addr(seed));

const mint = addr(1);
const account = addr(2);
const destination = addr(3);
const authority = signer(4);
const newAuthority = addr(5);
const hookProgram = addr(6);

type BuiltInstruction = Instruction & InstructionWithData<ReadonlyUint8Array>;

function toInput(instruction: BuiltInstruction): InstructionInput {
  return {
    accounts: (instruction.accounts ?? []).map((meta) => {
      const role = (meta as AccountMeta).role;
      return {
        address: meta.address,
        isSigner: role === AccountRole.READONLY_SIGNER || role === AccountRole.WRITABLE_SIGNER,
        isWritable: role === AccountRole.WRITABLE || role === AccountRole.WRITABLE_SIGNER,
      };
    }),
    data: instruction.data,
    programId: instruction.programAddress,
  };
}

/** What the official client says about an instruction, in our normalized vocabulary. */
function official(instruction: BuiltInstruction) {
  const parsed = parseToken2022Instruction(instruction);
  const metas = (instruction.accounts ?? []) as AccountMeta[];
  const args = "data" in parsed ? normalizeArgs(parsed.data) : {};
  if (typeof args.authorityType === "number") {
    args.authorityType = enumName(AuthorityType, args.authorityType);
  }
  return {
    args,
    name: instructionName(String(enumName(Token2022Instruction, parsed.instructionType))),
    roles: rolesFromParsedAccounts(metas, "accounts" in parsed ? parsed.accounts : undefined),
  };
}

/** Instructions whose arguments our decoder fully decodes. */
const FULLY_DECODED: Array<[string, BuiltInstruction]> = [
  [
    "initializeMint",
    getInitializeMintInstruction({
      decimals: 6,
      freezeAuthority: newAuthority,
      mint,
      mintAuthority: authority.address,
    }),
  ],
  [
    "initializeMint (no freeze)",
    getInitializeMintInstruction({ decimals: 9, mint, mintAuthority: authority.address }),
  ],
  [
    "initializeMint2",
    getInitializeMint2Instruction({
      decimals: 0,
      freezeAuthority: null,
      mint,
      mintAuthority: authority.address,
    }),
  ],
  ["initializeAccount3", getInitializeAccount3Instruction({ account, mint, owner: newAuthority })],
  ["transfer", getTransferInstruction({ amount: 1n, authority, destination, source: account })],
  [
    "transferChecked (u64::MAX)",
    getTransferCheckedInstruction({
      amount: 18446744073709551615n,
      authority,
      decimals: 9,
      destination,
      mint,
      source: account,
    }),
  ],
  [
    "approveChecked",
    getApproveCheckedInstruction({
      amount: 42n,
      decimals: 2,
      delegate: newAuthority,
      mint,
      owner: authority,
      source: account,
    }),
  ],
  ["revoke", getRevokeInstruction({ owner: authority, source: account })],
  ["mintTo", getMintToInstruction({ amount: 7n, mint, mintAuthority: authority, token: account })],
  [
    "mintToChecked",
    getMintToCheckedInstruction({
      amount: 7n,
      decimals: 3,
      mint,
      mintAuthority: authority,
      token: account,
    }),
  ],
  ["burnChecked", getBurnCheckedInstruction({ account, amount: 5n, authority, decimals: 3, mint })],
  ["closeAccount", getCloseAccountInstruction({ account, destination, owner: authority })],
  ["freezeAccount", getFreezeAccountInstruction({ account, mint, owner: authority })],
  ["thawAccount", getThawAccountInstruction({ account, mint, owner: authority })],
  ["syncNative", getSyncNativeInstruction({ account })],
  [
    "withdrawExcessLamports",
    getWithdrawExcessLamportsInstruction({ authority, destination, source: account }),
  ],
  [
    "initializeMintCloseAuthority",
    getInitializeMintCloseAuthorityInstruction({ closeAuthority: newAuthority, mint }),
  ],
  [
    "initializePermanentDelegate",
    getInitializePermanentDelegateInstruction({ delegate: newAuthority, mint }),
  ],
  [
    "initializeTransferHook",
    getInitializeTransferHookInstruction({ authority: newAuthority, mint, programId: hookProgram }),
  ],
  [
    "updateTransferHook",
    getUpdateTransferHookInstruction({ authority, mint, programId: hookProgram }),
  ],
  [
    "updateTransferHook (remove)",
    getUpdateTransferHookInstruction({ authority, mint, programId: null }),
  ],
  [
    "initializeMetadataPointer",
    getInitializeMetadataPointerInstruction({
      authority: newAuthority,
      metadataAddress: null,
      mint,
    }),
  ],
  [
    "updateMetadataPointer",
    getUpdateMetadataPointerInstruction({
      metadataAddress: destination,
      metadataPointerAuthority: authority,
      mint,
    }),
  ],
  [
    "initializeGroupPointer",
    getInitializeGroupPointerInstruction({ authority: null, groupAddress: destination, mint }),
  ],
  [
    "updateGroupPointer",
    getUpdateGroupPointerInstruction({
      groupAddress: destination,
      groupPointerAuthority: authority,
      mint,
    }),
  ],
  [
    "initializeGroupMemberPointer",
    getInitializeGroupMemberPointerInstruction({
      authority: newAuthority,
      memberAddress: destination,
      mint,
    }),
  ],
  [
    "updateGroupMemberPointer",
    getUpdateGroupMemberPointerInstruction({
      groupMemberPointerAuthority: authority,
      memberAddress: null,
      mint,
    }),
  ],
  [
    "initializePausableConfig",
    getInitializePausableConfigInstruction({ authority: newAuthority, mint }),
  ],
  ["pause", getPauseInstruction({ authority, mint })],
  ["resume", getResumeInstruction({ authority, mint })],
  [
    "updateTokenMetadataUpdateAuthority",
    getUpdateTokenMetadataUpdateAuthorityInstruction({
      metadata: mint,
      newUpdateAuthority: newAuthority,
      updateAuthority: authority,
    }),
  ],
  [
    "updateTokenMetadataUpdateAuthority (remove)",
    getUpdateTokenMetadataUpdateAuthorityInstruction({
      metadata: mint,
      newUpdateAuthority: null,
      updateAuthority: authority,
    }),
  ],
  [
    "updateTokenGroupUpdateAuthority",
    getUpdateTokenGroupUpdateAuthorityInstruction({
      group: mint,
      newUpdateAuthority: newAuthority,
      updateAuthority: authority,
    }),
  ],
  // Every one of the 18 authority types, both setting and removing.
  ...TOKEN_2022_AUTHORITY_TYPES.flatMap(
    (_name, authorityType): Array<[string, BuiltInstruction]> => [
      [
        `setAuthority ${authorityType}`,
        getSetAuthorityInstruction({ authorityType, newAuthority, owned: mint, owner: authority }),
      ],
      [
        `setAuthority ${authorityType} (remove)`,
        getSetAuthorityInstruction({
          authorityType,
          newAuthority: null,
          owned: mint,
          owner: authority,
        }),
      ],
    ],
  ),
];

/** Instructions our decoder identifies by name only. */
const NAME_ONLY: Array<[string, BuiltInstruction]> = [
  [
    "setTransferFee",
    getSetTransferFeeInstruction({
      maximumFee: 10n,
      mint,
      transferFeeBasisPoints: 5,
      transferFeeConfigAuthority: authority,
    }),
  ],
  [
    "updateDefaultAccountState",
    getUpdateDefaultAccountStateInstruction({
      freezeAuthority: authority,
      mint,
      state: AccountState.Frozen,
    }),
  ],
  ["disableCpiGuard", getDisableCpiGuardInstruction({ owner: authority, token: account })],
];

describe("token2022Decoder vs the official @solana-program/token-2022 client", () => {
  it("uses the same program address", () => {
    expect(TOKEN_2022_PROGRAM_ADDRESS).toBe(OFFICIAL_TOKEN_2022_PROGRAM_ADDRESS);
  });

  it("uses the same AuthorityType names and order", () => {
    TOKEN_2022_AUTHORITY_TYPES.forEach((name, value) => {
      expect(AuthorityType[value]).toBe(name);
    });
    expect(AuthorityType[TOKEN_2022_AUTHORITY_TYPES.length]).toBeUndefined();
  });

  it.each(FULLY_DECODED)("%s: same name, args and account roles", (_label, instruction) => {
    const ours = token2022Decoder.decode(toInput(instruction));
    const theirs = official(instruction);
    expect(ours.name).toBe(theirs.name);
    expect(ours.argsNotDecoded).toBeUndefined();
    expect(ours.args).toEqual(theirs.args);
    expect(ours.accountRoles).toEqual(theirs.roles);
  });

  it.each(NAME_ONLY)("%s: same name, flagged as args-not-decoded", (_label, instruction) => {
    const ours = token2022Decoder.decode(toInput(instruction));
    expect(ours.name).toBe(official(instruction).name);
    expect(ours.argsNotDecoded).toBe(true);
  });

  it("rejects an unknown authority type instead of guessing", () => {
    const data = new Uint8Array([6, TOKEN_2022_AUTHORITY_TYPES.length, 0]);
    expect(() =>
      token2022Decoder.decode({ accounts: [], data, programId: TOKEN_2022_PROGRAM_ADDRESS }),
    ).toThrow(/AuthorityType/);
  });
});
