import type { Address } from "@solana/kit";
import { ByteReader } from "../bytes.js";
import { DecodeError } from "../errors.js";
import type { InstructionInput, ProgramDecodeResult, ProgramDecoder } from "../types.js";
import { splitTokenBatch, TOKEN_BATCH_TAG } from "./token-batch.js";

/**
 * Hand-written Token-2022 decoder (see `docs/DECISIONS.md` for why the official
 * `@solana-program/token-2022` client is not a runtime dependency).
 *
 * Layouts are taken from `solana-program/token-2022` at commit
 * `f0d526508a9fa7e638b9aca1800d9c504ed87335` (`interface/src/instruction.rs`,
 * `interface/src/extension/<name>/instruction.rs`, `program/src/processor.rs`) and every one is
 * cross-checked in tests against the official client's encoders.
 *
 * Full argument decoding covers: the base SPL-Token-compatible instructions, every instruction
 * that sets or changes an authority (including `SetAuthority` for all 18 authority types and the
 * extension "update" instructions that re-point a mint at a different hook program, metadata,
 * group or group member), and the Token Metadata / Token Group interface authority changes.
 * Every other extension instruction is identified by name only and reported as such.
 */
export const TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/** `AuthorityType` in `interface/src/instruction.rs`, indexed by its `u8` value. */
export const TOKEN_2022_AUTHORITY_TYPES = [
  "MintTokens",
  "FreezeAccount",
  "AccountOwner",
  "CloseAccount",
  "TransferFeeConfig",
  "WithheldWithdraw",
  "CloseMint",
  "InterestRate",
  "PermanentDelegate",
  "ConfidentialTransferMint",
  "TransferHookProgramId",
  "ConfidentialTransferFeeConfig",
  "MetadataPointer",
  "GroupPointer",
  "GroupMemberPointer",
  "ScaledUiAmount",
  "Pause",
  "PermissionedBurn",
] as const;

/** `sha256("spl_token_metadata_interface:update_the_authority")[..8]`. */
const TOKEN_METADATA_UPDATE_AUTHORITY = [215, 228, 166, 228, 84, 100, 86, 123] as const;
/** `sha256("spl_token_group_interface:update_authority")[..8]`. */
const TOKEN_GROUP_UPDATE_AUTHORITY = [161, 105, 88, 1, 237, 221, 216, 203] as const;

type Decoded = Omit<ProgramDecodeResult, "accountRoles"> & {
  /** Named roles for the leading account positions; further accounts (multisig signers) have none. */
  readonly roles: readonly string[];
};

/** Extension prefix tag → sub-instruction names, in enum order (sub-tag = array index). */
const EXTENSION_SUB_INSTRUCTIONS: Readonly<Record<number, readonly string[]>> = {
  26: [
    "initializeTransferFeeConfig",
    "transferCheckedWithFee",
    "withdrawWithheldTokensFromMint",
    "withdrawWithheldTokensFromAccounts",
    "harvestWithheldTokensToMint",
    "setTransferFee",
  ],
  27: [
    "initializeConfidentialTransferMint",
    "updateConfidentialTransferMint",
    "configureConfidentialTransferAccount",
    "approveConfidentialTransferAccount",
    "emptyConfidentialTransferAccount",
    "confidentialDeposit",
    "confidentialWithdraw",
    "confidentialTransfer",
    "applyConfidentialPendingBalance",
    "enableConfidentialCredits",
    "disableConfidentialCredits",
    "enableNonConfidentialCredits",
    "disableNonConfidentialCredits",
    "confidentialTransferWithFee",
    "configureConfidentialTransferAccountWithRegistry",
  ],
  28: ["initializeDefaultAccountState", "updateDefaultAccountState"],
  30: ["enableMemoTransfers", "disableMemoTransfers"],
  33: ["initializeInterestBearingMint", "updateRateInterestBearingMint"],
  34: ["enableCpiGuard", "disableCpiGuard"],
  36: ["initializeTransferHook", "updateTransferHook"],
  37: [
    "initializeConfidentialTransferFee",
    "withdrawWithheldTokensFromMintForConfidentialTransferFee",
    "withdrawWithheldTokensFromAccountsForConfidentialTransferFee",
    "harvestWithheldTokensToMintForConfidentialTransferFee",
    "enableHarvestToMint",
    "disableHarvestToMint",
  ],
  39: ["initializeMetadataPointer", "updateMetadataPointer"],
  40: ["initializeGroupPointer", "updateGroupPointer"],
  41: ["initializeGroupMemberPointer", "updateGroupMemberPointer"],
  42: [
    "initializeConfidentialMintBurn",
    "rotateSupplyElgamalPubkey",
    "updateConfidentialMintBurnDecryptableSupply",
    "confidentialMint",
    "confidentialBurn",
    "applyConfidentialPendingBurn",
  ],
  43: ["initializeScaledUiAmountMint", "updateMultiplierScaledUiMint"],
  44: ["initializePausableConfig", "pause", "resume"],
  46: [
    "initializePermissionedBurn",
    "permissionedBurn",
    "permissionedBurnChecked",
    "permissionedConfidentialBurn",
  ],
};

/** Instructions without sub-tags that are identified by name only (arguments not decoded). */
const IDENTIFIED_ONLY: Readonly<Record<number, string>> = {
  21: "getAccountDataSize",
  23: "amountToUiAmount",
  24: "uiAmountToAmount",
  29: "reallocate",
  31: "createNativeMint",
  32: "initializeNonTransferableMint",
  45: "unwrapLamports",
};

/** Names `decodeToken2022` returns directly (fully decoded instructions). */
const DECODED_NAMES = [
  "initializeMint",
  "initializeMint2",
  "initializeAccount",
  "initializeMultisig",
  "initializeMultisig2",
  "transfer",
  "approve",
  "revoke",
  "setAuthority",
  "mintTo",
  "burn",
  "closeAccount",
  "freezeAccount",
  "thawAccount",
  "transferChecked",
  "approveChecked",
  "mintToChecked",
  "burnChecked",
  "initializeAccount2",
  "syncNative",
  "initializeAccount3",
  "initializeImmutableOwner",
  "initializeMintCloseAuthority",
  "initializePermanentDelegate",
  "withdrawExcessLamports",
  "batch",
  "updateTokenMetadataUpdateAuthority",
  "updateTokenGroupUpdateAuthority",
] as const;

/** Pointer-style extensions: `Initialize { authority, <field> }` / `Update { <field> }`, both `MaybeNull<Address>`. */
const POINTER_EXTENSIONS: Readonly<
  Record<number, { readonly field: string; readonly authorityRole: string }>
> = {
  36: { authorityRole: "authority", field: "programId" },
  39: { authorityRole: "metadataPointerAuthority", field: "metadataAddress" },
  40: { authorityRole: "groupPointerAuthority", field: "groupAddress" },
  41: { authorityRole: "groupMemberPointerAuthority", field: "memberAddress" },
};

export const token2022Decoder: ProgramDecoder = {
  decode(instruction: InstructionInput): ProgramDecodeResult {
    const decoded = decodeToken2022(instruction);
    const { roles, ...rest } = decoded;
    return {
      ...rest,
      accountRoles: instruction.accounts.map((_account, i) => roles[i]),
    };
  },
  instructionNames: [
    ...new Set([
      ...DECODED_NAMES,
      ...Object.values(IDENTIFIED_ONLY),
      ...Object.values(EXTENSION_SUB_INSTRUCTIONS).flat(),
    ]),
  ],
  key: "token2022",
  kind: "native",
  label: "Token-2022",
  programIds: [TOKEN_2022_PROGRAM_ADDRESS],
};

function decodeToken2022(instruction: InstructionInput): Decoded {
  const data = instruction.data;
  if (startsWith(data, TOKEN_METADATA_UPDATE_AUTHORITY)) {
    const reader = new ByteReader(data, 8);
    return {
      args: { newUpdateAuthority: maybeNullAddress(reader) },
      name: "updateTokenMetadataUpdateAuthority",
      roles: ["metadata", "updateAuthority"],
    };
  }
  if (startsWith(data, TOKEN_GROUP_UPDATE_AUTHORITY)) {
    const reader = new ByteReader(data, 8);
    return {
      args: { newUpdateAuthority: maybeNullAddress(reader) },
      name: "updateTokenGroupUpdateAuthority",
      roles: ["group", "updateAuthority"],
    };
  }

  const reader = new ByteReader(data);
  const tag = reader.u8();
  switch (tag) {
    case 0:
    case 20: {
      const decimals = reader.u8();
      const mintAuthority = reader.address();
      const freezeAuthority = cOptionAddress(reader);
      return {
        args: { decimals, freezeAuthority, mintAuthority },
        name: tag === 0 ? "initializeMint" : "initializeMint2",
        roles: tag === 0 ? ["mint", "rent"] : ["mint"],
      };
    }
    case 1:
      return { args: {}, name: "initializeAccount", roles: ["account", "mint", "owner", "rent"] };
    case 2:
    case 19:
      return {
        args: { m: reader.u8() },
        name: tag === 2 ? "initializeMultisig" : "initializeMultisig2",
        roles: tag === 2 ? ["multisig", "rent"] : ["multisig"],
      };
    case 3:
      return {
        args: { amount: reader.u64() },
        name: "transfer",
        roles: ["source", "destination", "authority"],
      };
    case 4:
      return {
        args: { amount: reader.u64() },
        name: "approve",
        roles: ["source", "delegate", "owner"],
      };
    case 5:
      return { args: {}, name: "revoke", roles: ["source", "owner"] };
    case 6: {
      const authorityIndex = reader.u8();
      const authorityType = TOKEN_2022_AUTHORITY_TYPES[authorityIndex];
      if (authorityType === undefined) {
        throw new DecodeError(
          "INVALID_VALUE",
          `unknown Token-2022 AuthorityType ${authorityIndex}`,
        );
      }
      return {
        args: { authorityType, newAuthority: cOptionAddress(reader) },
        name: "setAuthority",
        roles: ["owned", "owner"],
      };
    }
    case 7:
      return {
        args: { amount: reader.u64() },
        name: "mintTo",
        roles: ["mint", "token", "mintAuthority"],
      };
    case 8:
      return {
        args: { amount: reader.u64() },
        name: "burn",
        roles: ["account", "mint", "authority"],
      };
    case 9:
      return { args: {}, name: "closeAccount", roles: ["account", "destination", "owner"] };
    case 10:
      return { args: {}, name: "freezeAccount", roles: ["account", "mint", "owner"] };
    case 11:
      return { args: {}, name: "thawAccount", roles: ["account", "mint", "owner"] };
    case 12:
      return {
        args: { amount: reader.u64(), decimals: reader.u8() },
        name: "transferChecked",
        roles: ["source", "mint", "destination", "authority"],
      };
    case 13:
      return {
        args: { amount: reader.u64(), decimals: reader.u8() },
        name: "approveChecked",
        roles: ["source", "mint", "delegate", "owner"],
      };
    case 14:
      return {
        args: { amount: reader.u64(), decimals: reader.u8() },
        name: "mintToChecked",
        roles: ["mint", "token", "mintAuthority"],
      };
    case 15:
      return {
        args: { amount: reader.u64(), decimals: reader.u8() },
        name: "burnChecked",
        roles: ["account", "mint", "authority"],
      };
    case 16:
      return {
        args: { owner: reader.address() },
        name: "initializeAccount2",
        roles: ["account", "mint", "rent"],
      };
    case 17:
      return { args: {}, name: "syncNative", roles: ["account", "rent"] };
    case 18:
      return {
        args: { owner: reader.address() },
        name: "initializeAccount3",
        roles: ["account", "mint"],
      };
    case 22:
      return { args: {}, name: "initializeImmutableOwner", roles: ["account"] };
    case 25:
      return {
        args: { closeAuthority: cOptionAddress(reader) },
        name: "initializeMintCloseAuthority",
        roles: ["mint"],
      };
    case 35:
      return {
        args: { delegate: reader.address() },
        name: "initializePermanentDelegate",
        roles: ["mint"],
      };
    case 38:
      return {
        args: {},
        name: "withdrawExcessLamports",
        roles: ["source", "destination", "authority"],
      };
    case 36:
    case 39:
    case 40:
    case 41:
      return decodePointerExtension(tag, reader);
    case 44:
      return decodePausable(reader);
    case TOKEN_BATCH_TAG:
      return {
        args: {},
        innerInstructions: splitTokenBatch(instruction),
        name: "batch",
        roles: [],
      };
    default:
      return identifyOnly(tag, reader);
  }
}

function decodePointerExtension(tag: number, reader: ByteReader): Decoded {
  const pointer = POINTER_EXTENSIONS[tag];
  const names = EXTENSION_SUB_INSTRUCTIONS[tag];
  if (pointer === undefined || names === undefined) {
    throw new DecodeError("INVALID_TAG", `not a pointer extension tag: ${tag}`);
  }
  const subTag = reader.u8();
  if (subTag === 0) {
    const authority = maybeNullAddress(reader);
    const value = maybeNullAddress(reader);
    return { args: { authority, [pointer.field]: value }, name: names[0] ?? "", roles: ["mint"] };
  }
  if (subTag === 1) {
    return {
      args: { [pointer.field]: maybeNullAddress(reader) },
      name: names[1] ?? "",
      roles: ["mint", pointer.authorityRole],
    };
  }
  throw new DecodeError("INVALID_TAG", `unknown sub-instruction ${subTag} for extension ${tag}`);
}

function decodePausable(reader: ByteReader): Decoded {
  const subTag = reader.u8();
  switch (subTag) {
    case 0:
      return {
        args: { authority: reader.address() },
        name: "initializePausableConfig",
        roles: ["mint"],
      };
    case 1:
      return { args: {}, name: "pause", roles: ["mint", "authority"] };
    case 2:
      return { args: {}, name: "resume", roles: ["mint", "authority"] };
    default:
      throw new DecodeError("INVALID_TAG", `unknown pausable sub-instruction ${subTag}`);
  }
}

/** Instructions recognised by tag (and sub-tag) but whose arguments are not decoded. */
function identifyOnly(tag: number, reader: ByteReader): Decoded {
  const plainName = IDENTIFIED_ONLY[tag];
  if (plainName !== undefined) {
    return { argsNotDecoded: true, name: plainName, roles: [] };
  }
  const names = EXTENSION_SUB_INSTRUCTIONS[tag];
  if (names === undefined) {
    throw new DecodeError("INVALID_TAG", `unknown Token-2022 instruction tag ${tag}`);
  }
  const subTag = reader.u8();
  const name = names[subTag];
  if (name === undefined) {
    throw new DecodeError("INVALID_TAG", `unknown sub-instruction ${subTag} for extension ${tag}`);
  }
  return { argsNotDecoded: true, name, roles: [] };
}

/** `COption<Pubkey>` as packed in instruction data: `0` = None, `1` + 32 bytes = Some. */
function cOptionAddress(reader: ByteReader): Address | null {
  const flag = reader.u8();
  if (flag === 0) {
    return null;
  }
  if (flag === 1) {
    return reader.address();
  }
  throw new DecodeError("INVALID_VALUE", `invalid COption flag ${flag}`);
}

/** `MaybeNull<Address>` / `OptionalNonZeroPubkey`: 32 bytes, all-zero = None. */
function maybeNullAddress(reader: ByteReader): Address | null {
  if (reader.peekZeroAddress()) {
    reader.bytes(32);
    return null;
  }
  return reader.address();
}

function startsWith(data: Uint8Array | ArrayLike<number>, prefix: readonly number[]): boolean {
  if (data.length < prefix.length) {
    return false;
  }
  return prefix.every((byte, i) => data[i] === byte);
}
