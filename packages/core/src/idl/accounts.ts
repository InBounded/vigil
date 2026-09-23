import type { Address, ReadonlyUint8Array } from "@solana/kit";
import { ByteReader } from "../decoders/bytes.js";
import { PROGRAM_METADATA_PROGRAM_ADDRESS } from "./addresses.js";
import { MAX_IDL_COMPRESSED_BYTES } from "./inflate.js";

/**
 * Why an IDL account could not be used. `at-url` and `external` are the Program Metadata data
 * sources Vigil deliberately does not follow (maintainer decision): a URL would be a network request
 * outside the RPC allowlist and a phishing vector; an external account is a possible later addition.
 */
export type IdlAccountProblem =
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "at-url" }
  | { readonly kind: "external" }
  | { readonly kind: "unsupported"; readonly reason: string };

/** Compressed or plain IDL bytes read from an account, not yet inflated or parsed. */
export interface IdlPayload {
  readonly bytes: ReadonlyUint8Array;
  readonly compression: "none" | "zlib" | "gzip";
}

export type IdlAccountResult =
  | { readonly ok: true; readonly payload: IdlPayload }
  | { readonly ok: false; readonly problem: IdlAccountProblem };

const invalid = (reason: string): IdlAccountResult => ({
  ok: false,
  problem: { kind: "invalid", reason },
});

/**
 * Anchor `IdlAccount` (`lang/src/idl.rs`, see `addresses.ts`): 8-byte account discriminator
 * `sha256("internal:IdlAccount")[..8]` (see `fetch.ts`), `authority: Pubkey`, `data_len: u32`, then `data_len` bytes
 * of zlib-compressed JSON (`docs/reference.md` §10). The account is owned by the program itself.
 */
export function parseAnchorIdlAccount(
  owner: Address,
  data: ReadonlyUint8Array,
  program: Address,
  discriminator: ReadonlyUint8Array,
): IdlAccountResult {
  if (owner !== program) {
    return invalid(`the Anchor IDL account is owned by ${owner}, not by the program`);
  }
  try {
    const reader = new ByteReader(data);
    const actual = reader.bytes(8);
    if (!actual.every((byte, i) => byte === discriminator[i])) {
      return invalid("the Anchor IDL account has the wrong discriminator");
    }
    reader.address();
    const length = reader.u32();
    if (length > MAX_IDL_COMPRESSED_BYTES) {
      return invalid(
        `the compressed IDL is ${length} bytes, above the ${MAX_IDL_COMPRESSED_BYTES}-byte limit`,
      );
    }
    return { ok: true, payload: { bytes: reader.bytes(length), compression: "zlib" } };
  } catch {
    return invalid("the Anchor IDL account is truncated");
  }
}

/** Program Metadata `Header` size (`program/src/state/header.rs`, `#[repr(C)]`, align 1). */
const HEADER_SIZE = 96;
const DISCRIMINATOR_METADATA = 2;
const ENCODING_UTF8 = 1;
const COMPRESSIONS = ["none", "gzip", "zlib"] as const;
const FORMAT_NONE = 0;
const FORMAT_JSON = 1;
const DATA_SOURCE_DIRECT = 0;
const DATA_SOURCE_URL = 1;
const DATA_SOURCE_EXTERNAL = 2;

/**
 * Program Metadata `Metadata` account, laid out as `Header` then data
 * (solana-program/program-metadata `program/src/state/header.rs` at commit
 * b618644b45667681d38ad5f920258d06b519eaf0; field order matches `getMetadataDecoder` in
 * `@solana-program/program-metadata@0.10.0`): discriminator u8 (2 = Metadata), program (32),
 * authority (32, zeroes = none), mutable u8, canonical u8, seed [16], encoding u8, compression u8,
 * format u8, data_source u8, data_length u32, padding [5], then `data_length` bytes.
 *
 * Accepted: canonical accounts for this program, UTF-8 encoding, JSON or unspecified format (the
 * content must still parse as JSON), data stored directly in the account.
 */
export function parseProgramMetadataAccount(
  owner: Address,
  data: ReadonlyUint8Array,
  program: Address,
): IdlAccountResult {
  if (owner !== PROGRAM_METADATA_PROGRAM_ADDRESS) {
    return invalid(`the Program Metadata account is owned by ${owner}`);
  }
  try {
    const reader = new ByteReader(data);
    if (reader.u8() !== DISCRIMINATOR_METADATA) {
      return invalid("the Program Metadata account is not a Metadata account");
    }
    if (reader.address() !== program) {
      return invalid("the Program Metadata account describes a different program");
    }
    reader.bytes(32);
    reader.u8();
    if (reader.u8() !== 1) {
      return invalid("the Program Metadata account is not canonical");
    }
    reader.bytes(16);
    const encoding = reader.u8();
    const compression = COMPRESSIONS[reader.u8()];
    const format = reader.u8();
    const dataSource = reader.u8();
    const length = reader.u32();
    if (dataSource === DATA_SOURCE_URL) {
      return { ok: false, problem: { kind: "at-url" } };
    }
    if (dataSource === DATA_SOURCE_EXTERNAL) {
      return { ok: false, problem: { kind: "external" } };
    }
    if (dataSource !== DATA_SOURCE_DIRECT || compression === undefined) {
      return invalid("the Program Metadata account has an unknown data source or compression");
    }
    if (format !== FORMAT_JSON && format !== FORMAT_NONE) {
      return { ok: false, problem: { kind: "unsupported", reason: "the IDL is not JSON" } };
    }
    if (encoding !== ENCODING_UTF8) {
      return { ok: false, problem: { kind: "unsupported", reason: "the IDL is not UTF-8 text" } };
    }
    if (length > MAX_IDL_COMPRESSED_BYTES) {
      return invalid(
        `the stored IDL is ${length} bytes, above the ${MAX_IDL_COMPRESSED_BYTES}-byte limit`,
      );
    }
    return {
      ok: true,
      payload: { bytes: new ByteReader(data, HEADER_SIZE).bytes(length), compression },
    };
  } catch {
    return invalid("the Program Metadata account is truncated");
  }
}
