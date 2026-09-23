import { type Address, getBase64Encoder, type ReadonlyUint8Array } from "@solana/kit";
import { type AccountLabel, labelFor } from "../labels/labels.js";
import { findRegistryToken } from "../registry/index.js";
import type { AssetId, BalanceChange } from "../report.js";
import type { AccountInfo, Cluster } from "../rpc/types.js";
import { parseMintAccount, parseTokenAccount } from "../tokens/accounts.js";

const base64Bytes = getBase64Encoder();

/** SPL Token / Token-2022 base layout, `docs/reference.md` §8: `amount` is a u64 LE at 64..72. */
const TOKEN_AMOUNT_OFFSET = 64;

export interface TokenBalanceState {
  readonly mint: Address;
  readonly owner: Address;
  readonly amount: bigint;
}

/** Reads a token account's mint, owner and amount; `null` if the account is not a token account. */
export function readTokenBalance(account: AccountInfo): TokenBalanceState | null {
  const data = base64Bytes.encode(account.dataBase64);
  const parsed = parseTokenAccount({ data, owner: account.owner });
  if (parsed === null || data.length < TOKEN_AMOUNT_OFFSET + 8) {
    return null;
  }
  return { amount: readU64(data, TOKEN_AMOUNT_OFFSET), mint: parsed.mint, owner: parsed.owner };
}

function readU64(data: ReadonlyUint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  }
  return value;
}

export interface BalanceInput {
  /** Accounts compared, in the order they were requested. */
  readonly addresses: readonly Address[];
  /** State before, from `getMultipleAccounts` (`null`: did not exist). */
  readonly pre: ReadonlyMap<Address, AccountInfo | null>;
  /** State after, from the simulation's `accounts` (`null`: does not exist afterwards). */
  readonly post: ReadonlyMap<Address, AccountInfo | null>;
  readonly feePayer: Address;
  /** Fee the simulated transaction pays, added back to the fee payer's SOL. */
  readonly fee: bigint;
  /** Mint accounts (for decimals), by mint address. */
  readonly mints: ReadonlyMap<Address, AccountInfo | null>;
  readonly cluster: Cluster;
  readonly labels: ReadonlyMap<Address, AccountLabel>;
}

/** Every mint referenced by a token account before or after, for the decimals read. */
export function mintsToRead(input: Pick<BalanceInput, "addresses" | "pre" | "post">): Address[] {
  const mints = new Set<Address>();
  for (const address of input.addresses) {
    for (const state of [input.pre.get(address), input.post.get(address)]) {
      const token = state == null ? null : readTokenBalance(state);
      if (token !== null) {
        mints.add(token.mint);
      }
    }
  }
  return [...mints].sort();
}

export interface BalanceComputation {
  readonly changes: BalanceChange[];
  /** Mints whose decimals could be read neither from the mint account nor from the registry. */
  readonly unknownDecimals: Address[];
}

/**
 * SOL and token balance changes between the pre-state read and the simulation's post-state, in
 * exact base units. The fee payer's SOL change excludes the transaction fee (`feeExcluded`), so
 * what is shown is what the instructions do. Sorted by holder (token owner, or the account itself
 * for SOL), then account, then asset, so changes group by who is affected.
 */
export function computeBalanceChanges(input: BalanceInput): BalanceComputation {
  const changes: BalanceChange[] = [];
  const unknownDecimals = new Set<Address>();
  const label = (address: Address) => labelFor(address, input.labels, input.cluster);
  const withLabels = (change: BalanceChange, holder: Address): BalanceChange => {
    const accountLabel = label(change.account);
    const holderLabel = label(holder);
    return {
      ...change,
      ...(accountLabel === undefined ? {} : { label: accountLabel }),
      ...(holderLabel === undefined ? {} : { holderLabel }),
    };
  };

  for (const address of new Set(input.addresses)) {
    const pre = input.pre.get(address) ?? null;
    const post = input.post.get(address) ?? null;
    const lifecycle = {
      ...(pre === null && post !== null ? { created: true } : {}),
      ...(pre !== null && post === null ? { closed: true } : {}),
    };

    const preLamports = pre?.lamports ?? 0n;
    const fee = address === input.feePayer ? input.fee : 0n;
    const postLamports = (post?.lamports ?? 0n) + fee;
    if (preLamports !== postLamports) {
      changes.push(
        withLabels(
          {
            account: address,
            asset: "SOL",
            decimals: 9,
            post: postLamports,
            pre: preLamports,
            ...(fee > 0n ? { feeExcluded: fee } : {}),
            ...lifecycle,
          },
          address,
        ),
      );
    }

    const preToken = pre === null ? null : readTokenBalance(pre);
    const postToken = post === null ? null : readTokenBalance(post);
    const token = postToken ?? preToken;
    if (token === null) {
      continue;
    }
    if (preToken !== null && postToken !== null && preToken.mint !== postToken.mint) {
      // Cannot happen for a real token account (its mint never changes); if the RPC says so,
      // show both sides as separate changes rather than subtracting different assets.
      changes.push(tokenChange(address, preToken, preToken.amount, 0n, {}));
      changes.push(tokenChange(address, postToken, 0n, postToken.amount, {}));
      continue;
    }
    const preAmount = preToken?.amount ?? 0n;
    const postAmount = postToken?.amount ?? 0n;
    if (preAmount === postAmount && preToken !== null && postToken !== null) {
      continue;
    }
    changes.push(tokenChange(address, token, preAmount, postAmount, lifecycle));
  }

  const resolved = changes.map((change) => {
    if (change.asset === "SOL") {
      return change;
    }
    const decimals = mintDecimals(change.asset, input);
    if (decimals === undefined) {
      unknownDecimals.add(change.asset);
    }
    const holder = change.owner ?? change.account;
    return withLabels(decimals === undefined ? change : { ...change, decimals }, holder);
  });

  resolved.sort(
    (a, b) =>
      compare(a.owner ?? a.account, b.owner ?? b.account) ||
      compare(a.account, b.account) ||
      compare(assetKey(a.asset), assetKey(b.asset)),
  );
  return { changes: resolved, unknownDecimals: [...unknownDecimals].sort() };
}

function tokenChange(
  account: Address,
  token: TokenBalanceState,
  pre: bigint,
  post: bigint,
  lifecycle: { readonly created?: boolean; readonly closed?: boolean },
): BalanceChange {
  return { account, asset: token.mint, owner: token.owner, post, pre, ...lifecycle };
}

function mintDecimals(mint: Address, input: BalanceInput): number | undefined {
  const account = input.mints.get(mint);
  if (account != null) {
    const parsed = parseMintAccount({
      data: base64Bytes.encode(account.dataBase64),
      owner: account.owner,
    });
    if (parsed !== null) {
      return parsed.decimals;
    }
  }
  return findRegistryToken(mint, input.cluster)?.decimals;
}

/** `"SOL"` sorts before every mint. */
function assetKey(asset: AssetId): string {
  return asset === "SOL" ? "" : asset;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Groups balance changes by holder (token owner, or the account itself for SOL), in order. */
export function groupBalanceChanges(
  changes: readonly BalanceChange[],
): { readonly holder: Address; readonly changes: readonly BalanceChange[] }[] {
  const groups = new Map<Address, BalanceChange[]>();
  for (const change of changes) {
    const holder = change.owner ?? change.account;
    const group = groups.get(holder);
    if (group === undefined) {
      groups.set(holder, [change]);
    } else {
      group.push(change);
    }
  }
  return [...groups].map(([holder, grouped]) => ({ changes: grouped, holder }));
}
