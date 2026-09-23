import type { Address, ReadonlyUint8Array } from "@solana/kit";
import { ByteReader } from "../decoders/bytes.js";

/** Loader program ids, anza-xyz/solana-sdk `sdk-ids/src/lib.rs` at 43339f08. */
export const LOADERS = {
  loaderV1: "BPFLoader1111111111111111111111111111111111" as Address,
  loaderV2: "BPFLoader2111111111111111111111111111111111" as Address,
  loaderV4: "LoaderV411111111111111111111111111111111111" as Address,
  native: "NativeLoader1111111111111111111111111111111" as Address,
  upgradeable: "BPFLoaderUpgradeab1e11111111111111111111111" as Address,
} as const;

/**
 * `UpgradeableLoaderState` (bincode, u32 LE tag), anza-xyz/solana-sdk
 * `loader-v3-interface/src/state.rs` at 43339f08: header sizes are fixed whatever the `Option`
 * holds — Buffer 37 (`size_of_buffer_metadata`), Program 36, ProgramData 45
 * (`size_of_programdata_metadata`); program bytes start right after the Buffer / ProgramData header.
 */
export const BUFFER_METADATA_SIZE = 37;
export const PROGRAM_SIZE = 36;
export const PROGRAMDATA_METADATA_SIZE = 45;

const TAG_BUFFER = 1;
const TAG_PROGRAM = 2;
const TAG_PROGRAMDATA = 3;

export type LoaderStateError = { readonly ok: false; readonly reason: string };

export function parseProgramAccount(
  data: ReadonlyUint8Array,
): { readonly ok: true; readonly programData: Address } | LoaderStateError {
  if (data.length < PROGRAM_SIZE) {
    return {
      ok: false,
      reason: `program account is ${data.length} bytes, expected ${PROGRAM_SIZE}`,
    };
  }
  const reader = new ByteReader(data);
  const tag = reader.u32();
  if (tag !== TAG_PROGRAM) {
    return {
      ok: false,
      reason: `program account has loader state ${tag}, expected ${TAG_PROGRAM}`,
    };
  }
  return { ok: true, programData: reader.address() };
}

export function parseProgramDataAccount(data: ReadonlyUint8Array):
  | {
      readonly ok: true;
      readonly slot: bigint;
      readonly authority: Address | null;
      readonly code: ReadonlyUint8Array;
    }
  | LoaderStateError {
  if (data.length < PROGRAMDATA_METADATA_SIZE) {
    return { ok: false, reason: `ProgramData account is only ${data.length} bytes` };
  }
  const reader = new ByteReader(data);
  const tag = reader.u32();
  if (tag !== TAG_PROGRAMDATA) {
    return {
      ok: false,
      reason: `ProgramData account has loader state ${tag}, expected ${TAG_PROGRAMDATA}`,
    };
  }
  const slot = reader.u64();
  const authority = readOptionAddress(reader);
  if (authority === undefined) {
    return { ok: false, reason: "ProgramData authority option tag is not 0 or 1" };
  }
  return { authority, code: data.subarray(PROGRAMDATA_METADATA_SIZE), ok: true, slot };
}

export function parseBufferAccount(
  data: ReadonlyUint8Array,
):
  | { readonly ok: true; readonly authority: Address | null; readonly code: ReadonlyUint8Array }
  | LoaderStateError {
  if (data.length < BUFFER_METADATA_SIZE) {
    return { ok: false, reason: `buffer account is only ${data.length} bytes` };
  }
  const reader = new ByteReader(data);
  const tag = reader.u32();
  if (tag !== TAG_BUFFER) {
    return { ok: false, reason: `account has loader state ${tag}, not a buffer (${TAG_BUFFER})` };
  }
  const authority = readOptionAddress(reader);
  if (authority === undefined) {
    return { ok: false, reason: "buffer authority option tag is not 0 or 1" };
  }
  return { authority, code: data.subarray(BUFFER_METADATA_SIZE), ok: true };
}

/** bincode `Option<Pubkey>`: 1-byte tag, then 32 bytes (the header reserves them either way). */
function readOptionAddress(reader: ByteReader): Address | null | undefined {
  const tag = reader.u8();
  const address = reader.address();
  return tag === 0 ? null : tag === 1 ? address : undefined;
}
