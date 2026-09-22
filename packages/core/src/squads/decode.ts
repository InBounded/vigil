import {
  type Address,
  type EncodedAccount,
  getBase64Encoder,
  type ReadonlyUint8Array,
} from "@solana/kit";
import type { AccountInfo } from "../rpc/types.js";

const base64Bytes = getBase64Encoder();

/** Converts our own `AccountInfo` (address is the caller's key, not part of the value) into the
 * `EncodedAccount` shape Codama-generated `decode*` functions expect. No I/O — pure conversion. */
export function toEncodedAccount<TAddress extends string>(
  address: Address<TAddress>,
  info: AccountInfo,
): EncodedAccount<TAddress> {
  return {
    address,
    data: base64Bytes.encode(info.dataBase64),
    executable: info.executable,
    lamports: info.lamports as EncodedAccount<TAddress>["lamports"],
    programAddress: info.owner,
    space: info.space,
  };
}

/** Compares an account's leading bytes against a known 8-byte Anchor discriminator. */
export function matchesDiscriminator(
  data: ReadonlyUint8Array,
  discriminator: ReadonlyUint8Array,
): boolean {
  if (data.length < discriminator.length) {
    return false;
  }
  for (let i = 0; i < discriminator.length; i++) {
    if (data[i] !== discriminator[i]) {
      return false;
    }
  }
  return true;
}

export type MemberPermission = "Initiate" | "Vote" | "Execute";

/** Bit values per `docs/reference.md` §6: Initiate = 1, Vote = 2, Execute = 4. */
const PERMISSION_BITS: ReadonlyArray<readonly [number, MemberPermission]> = [
  [1, "Initiate"],
  [2, "Vote"],
  [4, "Execute"],
];

export function decodePermissions(mask: number): readonly MemberPermission[] {
  return PERMISSION_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
}
