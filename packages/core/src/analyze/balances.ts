import {
  type Address,
  getAddressDecoder,
  getBase64Encoder,
  type ReadonlyUint8Array,
} from "@solana/kit";
import type { AnalysisGap, AssetId, DecodedInstruction } from "../report.js";
import type { AccountInfo, RpcClient } from "../rpc/types.js";
import { listTransfers } from "../rules/catalog/warning.js";
import { accountByRole } from "../rules/helpers.js";
import type { AssetBalance } from "../rules/types.js";
import { parseTokenAccount } from "../tokens/accounts.js";

const base64Bytes = getBase64Encoder();
const addressDecoder = getAddressDecoder();

export interface TransferBalances {
  readonly balances: readonly AssetBalance[];
  readonly gaps: readonly AnalysisGap[];
}

/** Base token account layout (`docs/reference.md` §8, same in Token-2022). */
const AMOUNT_OFFSET = 64;
const DELEGATE_OFFSET = 72;
const DELEGATED_AMOUNT_OFFSET = 121;

/**
 * Reads the balance every transfer draws on, for VGL-W004: the sender's lamports for SOL; for a
 * token transfer, the amount in the source token account(s) the transfer authority can move (the
 * whole amount for the owner, at most the approved amount for a delegate). Several source accounts
 * of the same sender and asset are added up. A balance that cannot be established is left out,
 * with a `TRANSFER_BALANCE_UNKNOWN` gap unless an absolute threshold is set for that asset (the
 * rule can then still judge the transfer). RPC failures do not throw.
 */
export async function gatherTransferBalances(
  rpc: RpcClient,
  instructions: readonly DecodedInstruction[],
  absoluteThresholds: ReadonlyMap<AssetId, bigint>,
): Promise<TransferBalances> {
  const groups = new Map<
    string,
    { from: Address; asset: AssetId; sources: Set<Address>; topIndex: number }
  >();
  for (const transfer of listTransfers(instructions)) {
    const source =
      transfer.asset === "SOL" ? transfer.from : accountByRole(transfer.at.instruction, "source");
    const key = `${transfer.from}|${transfer.asset}`;
    const group = groups.get(key) ?? {
      asset: transfer.asset,
      from: transfer.from,
      sources: new Set<Address>(),
      topIndex: transfer.at.topIndex,
    };
    if (source !== undefined) {
      group.sources.add(source);
    }
    groups.set(key, group);
  }
  if (groups.size === 0) {
    return { balances: [], gaps: [] };
  }

  const addresses = [...new Set([...groups.values()].flatMap((g) => [...g.sources]))].sort();
  let accounts: ReadonlyMap<Address, AccountInfo | null> | undefined;
  try {
    const read = await rpc.getMultipleAccounts(addresses);
    accounts = new Map(addresses.map((address, i) => [address, read.value[i] ?? null]));
  } catch {
    accounts = undefined;
  }

  const balances: AssetBalance[] = [];
  const gaps: AnalysisGap[] = [];
  for (const group of groups.values()) {
    const amount =
      accounts === undefined || group.sources.size === 0
        ? undefined
        : sumBalances(group.from, group.asset, [...group.sources], accounts);
    if (amount !== undefined) {
      balances.push({ amount, asset: group.asset, owner: group.from });
    } else if (!absoluteThresholds.has(group.asset)) {
      gaps.push({
        address: group.from,
        code: "TRANSFER_BALANCE_UNKNOWN",
        instructionIndex: group.topIndex,
        message:
          accounts === undefined
            ? "the balance this transfer draws on could not be read from the RPC"
            : "the balance this transfer draws on could not be established from the source account",
      });
    }
  }
  return { balances, gaps };
}

function sumBalances(
  from: Address,
  asset: AssetId,
  sources: readonly Address[],
  accounts: ReadonlyMap<Address, AccountInfo | null>,
): bigint | undefined {
  let total = 0n;
  for (const source of sources) {
    const account = accounts.get(source) ?? null;
    if (asset === "SOL") {
      // An account that does not exist holds no lamports: that is a known balance of zero.
      total += account?.lamports ?? 0n;
      continue;
    }
    if (account === null) {
      return undefined;
    }
    const available = tokenBalanceFor(from, asset, account);
    if (available === undefined) {
      return undefined;
    }
    total += available;
  }
  return total;
}

/** What `authority` can move out of a token account of `mint`, or `undefined` if it is not that. */
function tokenBalanceFor(
  authority: Address,
  mint: Address,
  account: AccountInfo,
): bigint | undefined {
  const data = base64Bytes.encode(account.dataBase64);
  const info = parseTokenAccount({ data, owner: account.owner });
  if (info === null || info.mint !== mint || data.length < DELEGATED_AMOUNT_OFFSET + 8) {
    return undefined;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const amount = view.getBigUint64(AMOUNT_OFFSET, true);
  if (info.owner === authority) {
    return amount;
  }
  const hasDelegate = view.getUint32(DELEGATE_OFFSET, true) === 1;
  if (hasDelegate && addressAt(data, DELEGATE_OFFSET + 4) === authority) {
    const delegated = view.getBigUint64(DELEGATED_AMOUNT_OFFSET, true);
    return delegated < amount ? delegated : amount;
  }
  return undefined;
}

function addressAt(data: ReadonlyUint8Array, offset: number): Address {
  return addressDecoder.decode(data.subarray(offset, offset + 32));
}
