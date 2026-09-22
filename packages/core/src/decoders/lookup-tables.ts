import { type Address, getBase64Encoder, type ReadonlyUint8Array, unwrapOption } from "@solana/kit";
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
  getAddressLookupTableDecoder,
} from "@solana-program/address-lookup-table";
import type { RpcClient } from "../rpc/types.js";

/** `ProgramState::LookupTable` discriminant (u32 LE) in the lookup table account layout. */
const LOOKUP_TABLE_STATE = 1;
/** Fixed metadata size before the address list (`LOOKUP_TABLE_META_SIZE`, `docs/reference.md` §9). */
const LOOKUP_TABLE_META_SIZE = 56;

export interface LookupTableInfo {
  readonly address: Address;
  readonly authority: Address | null;
  /** `u64::MAX` while the table is active. */
  readonly deactivationSlot: bigint;
  readonly addresses: readonly Address[];
}

export type LookupTableEntry =
  | { readonly status: "ok"; readonly table: LookupTableInfo }
  | { readonly status: "not-found" }
  | { readonly status: "invalid"; readonly reason: string };

const base64Bytes = getBase64Encoder();
const tableDecoder = getAddressLookupTableDecoder();

/**
 * Reads lookup tables with a single `getMultipleAccounts` call (the RPC client chunks it).
 * Owner and state discriminant are checked; anything else is reported as invalid, never guessed.
 * Existing lookup-table entries are immutable (tables are append-only), so an index that resolves
 * now resolves to the same address at execution time — unless the table is closed first.
 */
export async function fetchLookupTables(
  rpc: RpcClient,
  addresses: readonly Address[],
): Promise<{ readonly contextSlot: bigint; readonly entries: Map<Address, LookupTableEntry> }> {
  const entries = new Map<Address, LookupTableEntry>();
  if (addresses.length === 0) {
    return { contextSlot: 0n, entries };
  }
  const { contextSlot, value } = await rpc.getMultipleAccounts(addresses);
  addresses.forEach((address, i) => {
    const account = value[i] ?? null;
    if (account === null) {
      entries.set(address, { status: "not-found" });
      return;
    }
    if (account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS) {
      entries.set(address, {
        reason: `owned by ${account.owner}, not the Address Lookup Table program`,
        status: "invalid",
      });
      return;
    }
    entries.set(address, parseLookupTableAccount(address, base64Bytes.encode(account.dataBase64)));
  });
  return { contextSlot, entries };
}

export function parseLookupTableAccount(
  address: Address,
  data: ReadonlyUint8Array,
): LookupTableEntry {
  if (data.length < LOOKUP_TABLE_META_SIZE || (data.length - LOOKUP_TABLE_META_SIZE) % 32 !== 0) {
    return { reason: `unexpected account size ${data.length}`, status: "invalid" };
  }
  try {
    const decoded = tableDecoder.decode(data);
    if (decoded.discriminator !== LOOKUP_TABLE_STATE) {
      return { reason: `uninitialized (state ${decoded.discriminator})`, status: "invalid" };
    }
    return {
      status: "ok",
      table: {
        address,
        addresses: decoded.addresses,
        authority: unwrapOption(decoded.authority),
        deactivationSlot: decoded.deactivationSlot,
      },
    };
  } catch (error) {
    return {
      reason: `could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
      status: "invalid",
    };
  }
}
