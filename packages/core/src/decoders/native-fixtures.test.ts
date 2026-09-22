import { fileURLToPath } from "node:url";
import {
  type AccountMeta,
  AccountRole,
  type Address,
  createNoopSigner,
  getAddressDecoder,
  getBase64Encoder,
  type Instruction,
  type Signature,
} from "@solana/kit";
import { SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { getDeactivateInstruction, getWithdrawInstruction } from "@solana-program/stake";
import { beforeAll, describe, expect, it } from "vitest";
import type { DecodedInstruction } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { loadFixtureFile } from "../rpc/fixture-file.js";
import type { FixtureData } from "../rpc/index.js";
import { createDecodeContext, decodeCompiledMessage, decodeInstruction } from "./decode.js";
import { fetchLookupTables } from "./lookup-tables.js";
import { SYSVAR_CLOCK_ADDRESS, SYSVAR_RENT_ADDRESS } from "./native/stake.js";
import { decodeRawTransaction, parseWireTransaction } from "./transaction.js";

const FIXTURE = fileURLToPath(
  new URL("../../../../fixtures/native-instructions.json", import.meta.url),
);

let data: FixtureData;
beforeAll(async () => {
  data = await loadFixtureFile(FIXTURE);
});

async function decode(signature: string) {
  const tx = data.transactions.get(signature as Signature);
  if (tx === undefined) {
    throw new Error(`fixture has no transaction ${signature}`);
  }
  return decodeRawTransaction(new FixtureRpcClient(data), tx.transactionBase64);
}

function roles(instruction: DecodedInstruction | undefined): Array<[string | undefined, string]> {
  return (instruction?.accounts ?? []).map((account) => [account.role, account.address]);
}

describe("Stake Program against real mainnet transactions (legacy account layout)", () => {
  it("uses the same sysvar addresses as @solana/web3.js", () => {
    expect(SYSVAR_CLOCK_ADDRESS).toBe(SYSVAR_CLOCK_PUBKEY.toBase58());
    expect(SYSVAR_RENT_ADDRESS).toBe(SYSVAR_RENT_PUBKEY.toBase58());
  });

  it("withdraw: the Clock sysvar is never labelled as the withdraw authority", async () => {
    const result = await decode(
      "D78nFyzrJE9ZqX9WjsMW8ERUkDJVr8VESBYDa74RypbNzRHHxavFN8kLTRU71xUYfg1sHoWjX8E6d8Maqrqu93o",
    );
    expect(result.gaps).toEqual([]);
    const withdraw = result.instructions[1];
    expect(withdraw?.name).toBe("withdraw");
    expect(withdraw?.args).toEqual({ args: 43810906n });
    expect(roles(withdraw)).toEqual([
      ["stake", "Ci9LYDWV1rP2Dqask1xXxQGFk28qwQwsbBo1k3zL2vCP"],
      ["recipient", "HUFNXAYT14vMcFm4WZqbke33GKncGQVQ77aMHLQb1TM8"],
      ["clockSysvar", "SysvarC1ock11111111111111111111111111111111"],
      ["stakeHistorySysvar", "SysvarStakeHistory1111111111111111111111111"],
      ["withdrawAuthority", "HUFNXAYT14vMcFm4WZqbke33GKncGQVQ77aMHLQb1TM8"],
    ]);
    expect(withdraw?.accounts[4]?.isSigner).toBe(true);
  });

  it("createAccountWithSeed + initialize + delegateStake", async () => {
    const result = await decode(
      "rfo8UEYup1dvLfYcrHxxftsY7R9K6gsQDy18bXEtGLjGmJSc2LtXZ488q9Mhp9k6yvQh4u5FDRyi5jyYAQkpTAj",
    );
    expect(result.gaps).toEqual([]);
    const [, , create, initialize, delegate] = result.instructions;
    expect(create?.name).toBe("createAccountWithSeed");
    expect(create?.args).toMatchObject({
      amount: 1101666240n,
      programAddress: "Stake11111111111111111111111111111111111111",
      seed: "stake:0",
      space: 200n,
    });
    expect(initialize?.name).toBe("initialize");
    expect(roles(initialize).map(([role]) => role)).toEqual(["stake", "rentSysvar"]);
    expect(delegate?.name).toBe("delegateStake");
    expect(roles(delegate)).toEqual([
      ["stake", "S4HqznF6YkYPgs9YmKqS6Y8qhdxbji3LufZz2xFw16a"],
      ["vote", "SKRuTecmFDZHjs2DxRTJNEK7m7hunKGTWJiaZ3tMVVA"],
      ["clockSysvar", "SysvarC1ock11111111111111111111111111111111"],
      ["stakeHistorySysvar", "SysvarStakeHistory1111111111111111111111111"],
      ["stakeConfig", "StakeConfig11111111111111111111111111111111"],
      ["stakeAuthority", "BHL9R7TWpahkM5DxVDakfsuNUxxzr3GjDncmbqca3Fyu"],
    ]);
  });

  it("deactivate", async () => {
    const result = await decode(
      "LFNio8rsN3db6zEVyyvnxMNDBdWkZUxcYb2p8CmrZ9v3uT3k16T6K8LATaQAjTTaCjQoEtY1izBxWoQ9NWFLVSo",
    );
    expect(result.gaps).toEqual([]);
    expect(roles(result.instructions[2])).toEqual([
      ["stake", "AsghVFggsdm9GkV3zuuSM8bwfeHAnw4Z6ddTKqWmUSis"],
      ["clockSysvar", "SysvarC1ock11111111111111111111111111111111"],
      ["stakeAuthority", "HYXmYzFkHqRYcXBvGXKETfKDCuyDqE8aKGLJJWSpz547"],
    ]);
  });

  it("still labels the current (sysvar-free) layout correctly", () => {
    const addressDecoder = getAddressDecoder();
    const addr = (seed: number) => addressDecoder.decode(new Uint8Array(32).fill(seed));
    const authority = createNoopSigner(addr(4));
    const cases: Array<[Instruction, string[]]> = [
      [
        getWithdrawInstruction({
          args: 5n,
          recipient: addr(2),
          stake: addr(1),
          withdrawAuthority: authority,
        }),
        ["stake", "recipient", "withdrawAuthority"],
      ],
      [
        getDeactivateInstruction({ stake: addr(1), stakeAuthority: authority }),
        ["stake", "stakeAuthority"],
      ],
    ];
    for (const [instruction, expected] of cases) {
      const decoded = decodeInstruction(
        {
          accounts: (instruction.accounts ?? []).map((meta) => ({
            address: meta.address,
            isSigner:
              (meta as AccountMeta).role === AccountRole.READONLY_SIGNER ||
              (meta as AccountMeta).role === AccountRole.WRITABLE_SIGNER,
            isWritable:
              (meta as AccountMeta).role === AccountRole.WRITABLE ||
              (meta as AccountMeta).role === AccountRole.WRITABLE_SIGNER,
          })),
          data: instruction.data ?? new Uint8Array(),
          programId: instruction.programAddress,
        },
        0,
        createDecodeContext(),
        0,
        0,
      );
      expect(decoded.accounts.map((a) => a.role)).toEqual(expected);
    }
  });
});

describe("Memo, System, ATA, Token and Token-2022 against real mainnet transactions", () => {
  it("legacy memo + USDC transferChecked", async () => {
    const result = await decode(
      "3Feg3sty9zSxEridJZWLqdEuLeSL2khcwyZjQu76KA1nif69KJ7Pj2iDiL9VEDW2qbRFR4if1CdrPyL1rJhWgBE1",
    );
    expect(result.gaps).toEqual([]);
    expect(result.instructions[1]).toMatchObject({
      args: { memo: "cc-69a24867-2d57-43bb-a2ce-f76b8461c8d5:open" },
      name: "addMemo",
      programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    });
    expect(result.instructions[2]).toMatchObject({
      args: { amount: 50000000n, decimals: 6 },
      name: "transferChecked",
    });
    expect(result.instructions[2]?.accounts[1]?.address).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });

  it("v0 durable-nonce transaction: nonce advance, ATA, memo, and an unknown program reported", async () => {
    const result = await decode(
      "P1pgDRoQmpCGNmE5Rb2cHvTxv8TNB2BFLUWriJzoGDRYcENQ2ZLk5pdtejXZnZWHDPwpKke4yeAdiChnE8RL8Lm",
    );
    expect(result.version).toBe(0);
    expect(result.instructions.map((ix) => ix.name ?? null)).toEqual([
      "advanceNonceAccount",
      "setComputeUnitLimit",
      "createAssociatedTokenIdempotent",
      null,
      "addMemo",
      "transferSol",
    ]);
    expect(roles(result.instructions[0]).map(([role]) => role)).toEqual([
      "nonceAccount",
      "recentBlockhashesSysvar",
      "nonceAuthority",
    ]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        address: "6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB",
        code: "UNKNOWN_PROGRAM",
        instructionIndex: 3,
      }),
    ]);
  });

  it("Token-2022 closeAccount (hand-written decoder, real data)", async () => {
    const result = await decode(
      "3LhnZy1FDL75fK4eBchxHwv8nzdmWNy7Kh2SsWyUAZe3kCXBX1qmBoLo5FDZMh2UfS2u84wJ2hXFFVGLpstQdTLb",
    );
    expect(result.gaps).toEqual([]);
    expect(result.instructions[0]).toMatchObject({
      decoder: "native",
      name: "closeAccount",
      programLabel: "Token-2022",
    });
    expect(roles(result.instructions[0])).toEqual([
      ["account", "7xsdLSnN1HJsvUsafdys5ZNLxjTgTqdirnJay6Qx1BUM"],
      ["destination", "2HQEZkgWhapA8xLyjJVAUYAG61ZUU6SAFrkZV7X5MWYJ"],
      ["owner", "2HQEZkgWhapA8xLyjJVAUYAG61ZUU6SAFrkZV7X5MWYJ"],
    ]);
  });
});

describe("Address Lookup Table program and resolution against real mainnet transactions", () => {
  it("create + extend, extend, deactivate", async () => {
    const created = await decode(
      "3iyVgLc4hjBwxfiFg9nGeAuCQYUFvBURejUZ88hUFKkH9cimReex9CJSMbu7MEoptiJT1zeT4W4NeWJjTJW4y7uS",
    );
    expect(created.gaps).toEqual([]);
    expect(created.instructions[2]).toMatchObject({
      args: { bump: 255, recentSlot: 449487174n },
      name: "createLookupTable",
    });
    expect(created.instructions[3]?.name).toBe("extendLookupTable");

    const extended = await decode(
      "imT13FLsdMW2HdvdNYE7NbP5oyVJHSe6H7KHqros9SfGc6S648US6cYMXZGDTDUxxTTq9Qj51UREFFRsgN9H9TV",
    );
    expect(extended.gaps).toEqual([]);
    expect(extended.instructions[0]?.name).toBe("extendLookupTable");
    expect(Array.isArray(extended.instructions[0]?.args?.addresses)).toBe(true);

    const deactivated = await decode(
      "4JkSWhWcvpBoXdzPACmQkqXxnwmZTP1Q3xMuEr44seubcjWR1utfY2xAdQdHhgQGNShS7MUJW6mBup4DUZJdGxaY",
    );
    expect(deactivated.gaps).toEqual([]);
    expect(roles(deactivated.instructions[0])).toEqual([
      ["address", "2RTf3AUrwxyk4GzLjxg8hw9tnbkwrxQAbinFAgE5y6kd"],
      ["authority", "6uBjU3bXJL9E5NPwBrqvxsyYruwFzEbTqY5kJB9bu6F3"],
    ]);
  });

  it("resolves four lookup tables exactly as the cluster did (meta.loadedAddresses)", async () => {
    const signature =
      "62Ye2RyK6K4xBh4D2CCMfEDTaPJe4vTXhk2kUwPoiq5mJ2G3NSUuxbQ146N3KitXieGpsNC6fQ24KvcUx3rRvjSH";
    const tx = data.transactions.get(signature as Signature);
    if (tx === undefined) {
      throw new Error("missing transaction");
    }
    const { compiled } = parseWireTransaction(
      getBase64Encoder().encode(tx.transactionBase64),
    ).message;
    expect(compiled.lookups).toHaveLength(4);
    const { entries } = await fetchLookupTables(
      new FixtureRpcClient(data),
      compiled.lookups.map((lookup) => lookup.tableAddress),
    );
    const decoded = decodeCompiledMessage(compiled, createDecodeContext(entries), 0, undefined);
    const loaded: readonly Address[] = [
      ...tx.loadedAddresses.writable,
      ...tx.loadedAddresses.readonly,
    ];
    const staticCount = compiled.staticAccounts.length;
    let checked = 0;
    compiled.instructions.forEach((instruction, i) => {
      instruction.accountIndexes.forEach((accountIndex, position) => {
        if (accountIndex >= staticCount) {
          const account = decoded[i]?.accounts[position];
          expect(account?.address).toBe(loaded[accountIndex - staticCount]);
          expect(account?.isWritable).toBe(
            accountIndex - staticCount < tx.loadedAddresses.writable.length,
          );
          checked++;
        }
      });
    });
    expect(checked).toBeGreaterThan(5);

    const result = await decode(signature);
    expect(result.lookupTables).toHaveLength(4);
    expect(result.instructions[3]).toMatchObject({
      args: { amount: 100000n, decimals: 6 },
      name: "transferChecked",
    });
    expect(result.instructions[3]?.accounts[1]).toMatchObject({
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      fromLookupTable: expect.any(String),
    });
  });
});
