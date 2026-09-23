import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { ByteReader } from "../decoders/bytes.js";
import { TOKEN_2022_PROGRAM_ADDRESS } from "../decoders/native/token-2022.js";

/**
 * Hand-written readers for the few token-related accounts Vigil needs: SPL Token / Token-2022 mints
 * and token accounts (`docs/reference.md` §8), the Token-2022 `TokenMetadata` extension, and the
 * Metaplex Token Metadata account. Every reader checks the owner program and the layout markers and
 * returns `null` rather than guessing when the bytes are not what they claim to be.
 */

export const TOKEN_METADATA_PROGRAM_ADDRESS =
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s" as Address;

const MINT_BASE_SIZE = 82;
const TOKEN_ACCOUNT_BASE_SIZE = 165;
/** SPL Token multisig account size; Token-2022 refuses extensions at this exact length. */
const MULTISIG_SIZE = 355;
/**
 * Token-2022 extended accounts: the base state is padded to 165 bytes, then one `AccountType` byte
 * (1 = Mint, 2 = Account), then TLV entries (`type: u16`, `length: u16`, value).
 * solana-program/token-2022 `interface/src/extension/mod.rs` (`BASE_ACCOUNT_LENGTH`,
 * `type_and_tlv_indices`, `Length(U16)`) at commit bc9c3fa987807021549b41a884fcada35dc8e79e.
 */
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;
const ACCOUNT_TYPE_ACCOUNT = 2;
const TLV_START = 166;
/** `ExtensionType::TokenMetadata` (the 20th variant of the `#[repr(u16)]` enum, same commit). */
const EXTENSION_TOKEN_METADATA = 19;
/** Metaplex `Key::MetadataV1` (mpl-token-metadata `state/mod.rs`, commit 353d01be). */
const METAPLEX_KEY_METADATA_V1 = 4;

const TOKEN_PROGRAMS: ReadonlySet<Address> = new Set([
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
]);

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export interface RawAccount {
  readonly owner: Address;
  readonly data: ReadonlyUint8Array;
}

/** A name and symbol as declared on chain, not yet sanitized. */
export interface RawDeclaredMetadata {
  readonly name: string;
  readonly symbol: string;
}

export interface MintInfo {
  readonly tokenProgram: Address;
  readonly decimals: number;
  /** From the Token-2022 `TokenMetadata` extension inside the mint itself, when present. */
  readonly extensionMetadata: RawDeclaredMetadata | null;
}

export interface TokenAccountInfo {
  readonly tokenProgram: Address;
  readonly mint: Address;
  readonly owner: Address;
}

function extendedAccountType(account: RawAccount, baseSize: number): number | null {
  const { data } = account;
  if (account.owner === TOKEN_PROGRAM_ADDRESS) {
    return data.length === baseSize ? 0 : null;
  }
  if (data.length === baseSize) {
    return 0;
  }
  if (data.length <= ACCOUNT_TYPE_OFFSET || data.length === MULTISIG_SIZE) {
    return null;
  }
  return data[ACCOUNT_TYPE_OFFSET] ?? null;
}

export function parseMintAccount(account: RawAccount): MintInfo | null {
  if (!TOKEN_PROGRAMS.has(account.owner)) {
    return null;
  }
  const type = extendedAccountType(account, MINT_BASE_SIZE);
  if (type === null || (type !== 0 && type !== ACCOUNT_TYPE_MINT)) {
    return null;
  }
  const { data } = account;
  const decimals = data[44];
  if (decimals === undefined || data[45] !== 1) {
    return null;
  }
  return {
    decimals,
    extensionMetadata: type === ACCOUNT_TYPE_MINT ? findTokenMetadataExtension(data) : null,
    tokenProgram: account.owner,
  };
}

export function parseTokenAccount(account: RawAccount): TokenAccountInfo | null {
  if (!TOKEN_PROGRAMS.has(account.owner)) {
    return null;
  }
  const type = extendedAccountType(account, TOKEN_ACCOUNT_BASE_SIZE);
  if (type === null || (type !== 0 && type !== ACCOUNT_TYPE_ACCOUNT)) {
    return null;
  }
  const reader = new ByteReader(account.data);
  const mint = reader.address();
  const owner = reader.address();
  // `state` at byte 108: 0 = Uninitialized.
  if (account.data[108] === 0) {
    return null;
  }
  return { mint, owner, tokenProgram: account.owner };
}

/**
 * `TokenMetadata` (solana-program/token-metadata `interface/src/state.rs`, commit 7176d78e):
 * update_authority (32, zero = none), mint (32), name, symbol, uri (Borsh strings), additional
 * metadata. Only name and symbol are read.
 */
function findTokenMetadataExtension(data: ReadonlyUint8Array): RawDeclaredMetadata | null {
  let offset = TLV_START;
  while (offset + 4 <= data.length) {
    const reader = new ByteReader(data, offset);
    const type = reader.u16();
    const length = reader.u16();
    if (type === 0) {
      return null;
    }
    const valueStart = offset + 4;
    if (valueStart + length > data.length) {
      return null;
    }
    if (type === EXTENSION_TOKEN_METADATA) {
      return readNameAndSymbol(data.subarray(valueStart, valueStart + length), 64);
    }
    offset = valueStart + length;
  }
  return null;
}

/** Metaplex `Metadata`: key (1), update_authority (32), mint (32), then `Data { name, symbol, ... }`. */
export function parseMetaplexMetadata(
  account: RawAccount,
  expectedMint: Address,
): RawDeclaredMetadata | null {
  if (account.owner !== TOKEN_METADATA_PROGRAM_ADDRESS) {
    return null;
  }
  try {
    const reader = new ByteReader(account.data);
    if (reader.u8() !== METAPLEX_KEY_METADATA_V1) {
      return null;
    }
    reader.address();
    if (reader.address() !== expectedMint) {
      return null;
    }
    return readNameAndSymbol(account.data, 65);
  } catch {
    return null;
  }
}

function readNameAndSymbol(data: ReadonlyUint8Array, offset: number): RawDeclaredMetadata | null {
  try {
    const reader = new ByteReader(data, offset);
    const name = readString(reader);
    const symbol = readString(reader);
    return { name, symbol };
  } catch {
    return null;
  }
}

/**
 * Borsh `String`. Metaplex pads names and symbols with trailing NULs to a fixed width; that padding
 * is layout, not content, so it is stripped here (anything else goes through the sanitizer).
 */
function readString(reader: ByteReader): string {
  const length = reader.u32();
  const text = strictUtf8.decode(Uint8Array.from(reader.bytes(length)));
  return text.replace(/\0+$/, "");
}

/** `["metadata", program, mint]` (mpl-token-metadata `pda.rs`, `PREFIX = "metadata"`). */
export async function findMetaplexMetadataAddress(mint: Address): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: TOKEN_METADATA_PROGRAM_ADDRESS,
    seeds: [
      getUtf8Encoder().encode("metadata"),
      getAddressEncoder().encode(TOKEN_METADATA_PROGRAM_ADDRESS),
      getAddressEncoder().encode(mint),
    ],
  });
  return address;
}
