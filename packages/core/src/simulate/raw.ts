import { type Address, getBase64Encoder } from "@solana/kit";
import { fetchLookupTables, type LookupTableEntry } from "../decoders/lookup-tables.js";
import { parseWireTransaction } from "../decoders/transaction.js";
import type { RpcClient } from "../rpc/types.js";
import { resolveMessageKeys, writableKeys } from "./resolve.js";
import {
  type PreState,
  readPreState,
  runSimulation,
  type SimulationContext,
  type SimulationGathered,
  unavailable,
} from "./run.js";

const base64Bytes = getBase64Encoder();

/**
 * Simulates a base64 wire transaction exactly as given (`sigVerify: false`,
 * `replaceRecentBlockhash: true`): its own fee payer pays, its own signatures (valid or not) are
 * ignored. The input must already have been decoded by `decodeRawTransaction` (which rejects
 * malformed input with a typed error); this function throws the same error for malformed bytes.
 */
export async function simulateRawTransaction(
  rpc: RpcClient,
  base64: string,
  context: SimulationContext,
): Promise<SimulationGathered> {
  const transactionBase64 = base64.trim();
  const parsed = parseWireTransaction(base64Bytes.encode(transactionBase64));
  const { compiled, feePayer } = parsed.message;
  const tableAddresses = [...new Set(compiled.lookups.map((lookup) => lookup.tableAddress))];
  let tables = new Map<Address, LookupTableEntry>();
  if (tableAddresses.length > 0) {
    try {
      tables = (await fetchLookupTables(rpc, tableAddresses)).entries;
    } catch {
      return unavailable("rpc-error", "the transaction's address lookup tables could not be read");
    }
  }
  const keys = resolveMessageKeys(compiled, tables);
  if (!keys.ok) {
    return unavailable("accounts-unresolved", `${keys.reason} (${keys.table ?? "?"})`);
  }
  let pre: PreState;
  try {
    pre = await readPreState(rpc, writableKeys(keys.resolved));
  } catch {
    return unavailable("rpc-error", "the accounts' current state could not be read");
  }
  return runSimulation(
    rpc,
    {
      feePayer: { address: feePayer, source: "transaction" },
      notes: [{ key: "simulation.note.feePayerTransaction", params: { feePayer } }],
      resolved: keys.resolved,
      signatureCount: parsed.signatureCount,
      transactionBase64,
    },
    pre,
    context,
  );
}
