import type { Address } from "@solana/kit";
import type { LookupTableEntry } from "../decoders/lookup-tables.js";
import { type CompiledMessage, staticAccountFlags } from "../decoders/message.js";

/** Every account key of a message, in index order, with its signer and writable flags. */
export interface ResolvedKeys {
  readonly keys: readonly Address[];
  readonly signer: readonly boolean[];
  readonly writable: readonly boolean[];
}

export type ResolveKeysResult =
  | { readonly ok: true; readonly resolved: ResolvedKeys }
  | { readonly ok: false; readonly reason: string; readonly table?: Address };

/**
 * Resolves a compiled message's account index space (static keys, then every lookup's writable
 * entries, then every lookup's readonly entries — the order `decoders/message.ts` documents)
 * against fetched lookup tables. Unlike decoding, simulation cannot proceed with any key missing,
 * so the first unresolvable key fails the whole resolution.
 */
export function resolveMessageKeys(
  message: CompiledMessage,
  tables: ReadonlyMap<Address, LookupTableEntry>,
): ResolveKeysResult {
  const keys: Address[] = [];
  const signer: boolean[] = [];
  const writable: boolean[] = [];
  message.staticAccounts.forEach((address, i) => {
    const flags = staticAccountFlags(message, i);
    keys.push(address);
    signer.push(flags.isSigner);
    writable.push(flags.isWritable);
  });
  for (const pass of ["writable", "readonly"] as const) {
    for (const lookup of message.lookups) {
      const entry = tables.get(lookup.tableAddress);
      if (entry === undefined || entry.status !== "ok") {
        return {
          ok: false,
          reason:
            entry?.status === "invalid"
              ? `address lookup table is invalid: ${entry.reason}`
              : "address lookup table does not exist",
          table: lookup.tableAddress,
        };
      }
      const indexes = pass === "writable" ? lookup.writableIndexes : lookup.readonlyIndexes;
      for (const index of indexes) {
        const address = entry.table.addresses[index];
        if (address === undefined) {
          return {
            ok: false,
            reason: `lookup table index ${index} is past its end (${entry.table.addresses.length} entries)`,
            table: lookup.tableAddress,
          };
        }
        keys.push(address);
        signer.push(false);
        writable.push(pass === "writable");
      }
    }
  }
  return { ok: true, resolved: { keys, signer, writable } };
}

/** Writable keys, first occurrence each, in index order. */
export function writableKeys(resolved: ResolvedKeys): Address[] {
  const out = new Set<Address>();
  resolved.keys.forEach((key, i) => {
    if (resolved.writable[i] === true) {
      out.add(key);
    }
  });
  return [...out];
}
