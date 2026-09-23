/**
 * The balance gatherer's branches that the real fixtures (vault-owned accounts, `analyze.test.ts`)
 * do not reach: delegates, a missing source, SOL, an RPC failure. Token accounts are encoded with
 * the official `@solana-program/token` account encoder; instructions with its builders.
 */
import { type Address, getBase64Decoder } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  AccountState,
  getTokenEncoder,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import type { AccountInfo } from "../rpc/types.js";
import { addr, decodeBuilt, signer } from "../test-support/rules.js";
import { gatherTransferBalances } from "./balances.js";

const MINT = addr(1);
const OWNER = addr(2);
const DELEGATE = addr(3);
const SOURCE = addr(4);
const DESTINATION = addr(5);
const base64 = getBase64Decoder();

function tokenAccount(fields: {
  owner: Address;
  amount: bigint;
  delegate?: Address;
  delegated?: bigint;
}): AccountInfo {
  const data = getTokenEncoder().encode({
    amount: fields.amount,
    closeAuthority: null,
    delegate: fields.delegate ?? null,
    delegatedAmount: fields.delegated ?? 0n,
    isNative: null,
    mint: MINT,
    owner: fields.owner,
    state: AccountState.Initialized,
  });
  return {
    dataBase64: base64.decode(data),
    executable: false,
    lamports: 2_039_280n,
    owner: TOKEN_PROGRAM_ADDRESS,
    space: BigInt(data.length),
  };
}

const transfer = (authority: Address, amount = 100n) =>
  decodeBuilt(
    getTransferCheckedInstruction({
      amount,
      authority: signer(authority),
      decimals: 6,
      destination: DESTINATION,
      mint: MINT,
      source: SOURCE,
    }),
  );

const rpcWith = (accounts: [Address, AccountInfo][]) =>
  new FixtureRpcClient({ accounts: new Map(accounts), contextSlot: 1n, transactions: new Map() });

describe("gatherTransferBalances", () => {
  it("the owner can move the whole amount", async () => {
    const rpc = rpcWith([[SOURCE, tokenAccount({ amount: 5_000n, owner: OWNER })]]);
    const result = await gatherTransferBalances(rpc, [transfer(OWNER)], new Map());
    expect(result).toEqual({ balances: [{ amount: 5_000n, asset: MINT, owner: OWNER }], gaps: [] });
  });

  it("a delegate can move at most what was approved", async () => {
    const rpc = rpcWith([
      [SOURCE, tokenAccount({ amount: 5_000n, delegate: DELEGATE, delegated: 700n, owner: OWNER })],
    ]);
    const result = await gatherTransferBalances(rpc, [transfer(DELEGATE)], new Map());
    expect(result.balances).toEqual([{ amount: 700n, asset: MINT, owner: DELEGATE }]);
  });

  it("an authority that is neither owner nor delegate, or a missing source: a gap", async () => {
    for (const accounts of [[[SOURCE, tokenAccount({ amount: 5_000n, owner: OWNER })]], []] as [
      Address,
      AccountInfo,
    ][][]) {
      const result = await gatherTransferBalances(
        rpcWith(accounts),
        [transfer(DELEGATE)],
        new Map(),
      );
      expect(result.balances).toEqual([]);
      expect(result.gaps).toEqual([
        {
          address: DELEGATE,
          code: "TRANSFER_BALANCE_UNKNOWN",
          instructionIndex: 0,
          message:
            "the balance this transfer draws on could not be established from the source account",
        },
      ]);
    }
  });

  it("no gap when an absolute threshold lets the rule judge the transfer anyway", async () => {
    const result = await gatherTransferBalances(
      rpcWith([]),
      [transfer(DELEGATE)],
      new Map([[MINT, 1n]]),
    );
    expect(result).toEqual({ balances: [], gaps: [] });
  });

  it("SOL: the sender's lamports, zero for an account that does not exist", async () => {
    const sol = decodeBuilt(
      getTransferSolInstruction({ amount: 1n, destination: DESTINATION, source: signer(OWNER) }),
    );
    const empty = await gatherTransferBalances(rpcWith([]), [sol], new Map());
    expect(empty.balances).toEqual([{ amount: 0n, asset: "SOL", owner: OWNER }]);
    const funded = await gatherTransferBalances(
      rpcWith([
        [OWNER, { dataBase64: "", executable: false, lamports: 42n, owner: addr(0), space: 0n }],
      ]),
      [sol],
      new Map(),
    );
    expect(funded.balances).toEqual([{ amount: 42n, asset: "SOL", owner: OWNER }]);
  });

  it("an RPC failure is a gap, never an exception", async () => {
    const rpc = rpcWith([]);
    rpc.getMultipleAccounts = () => Promise.reject(new Error("down"));
    const result = await gatherTransferBalances(rpc, [transfer(OWNER)], new Map());
    expect(result.gaps.map((g) => g.message)).toEqual([
      "the balance this transfer draws on could not be read from the RPC",
    ]);
  });

  it("nothing to read when there is no transfer", async () => {
    expect(await gatherTransferBalances(rpcWith([]), [], new Map())).toEqual({
      balances: [],
      gaps: [],
    });
  });
});
