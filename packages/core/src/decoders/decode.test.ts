import {
  type AccountMeta,
  AccountRole,
  type Address,
  appendTransactionMessageInstruction,
  type Blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressDecoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  AuthorityType,
  getBatchInstructionDataEncoder,
  getSetAuthorityInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { VAULT_TRANSACTION_CREATE_DISCRIMINATOR } from "../squads/generated/instructions/vaultTransactionCreate.js";
import { SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS } from "../squads/generated/programs/squadsMultisigProgram.js";
import { createDecodeContext, decodeInstruction, MAX_EMBEDDED_DEPTH } from "./decode.js";
import { DecodeError } from "./errors.js";
import { decodeRawTransaction } from "./transaction.js";
import type { InstructionAccountInput, InstructionInput } from "./types.js";

const addressDecoder = getAddressDecoder();
const addr = (seed: number): Address => addressDecoder.decode(new Uint8Array(32).fill(seed));

function accountsOf(instruction: Instruction): InstructionAccountInput[] {
  return (instruction.accounts ?? []).map((meta) => {
    const role = (meta as AccountMeta).role;
    return {
      address: meta.address,
      isSigner: role === AccountRole.READONLY_SIGNER || role === AccountRole.WRITABLE_SIGNER,
      isWritable: role === AccountRole.WRITABLE || role === AccountRole.WRITABLE_SIGNER,
    };
  });
}

const emptyRpc = new FixtureRpcClient({
  accounts: new Map(),
  contextSlot: 1n,
  transactions: new Map(),
});

describe("Token Batch (tag 255)", () => {
  const owner = createNoopSigner(addr(9));
  const transfer = getTransferCheckedInstruction({
    amount: 5n,
    authority: owner,
    decimals: 6,
    destination: addr(3),
    mint: addr(2),
    source: addr(1),
  });
  const setAuthority = getSetAuthorityInstruction({
    authorityType: AuthorityType.MintTokens,
    newAuthority: null,
    owned: addr(2),
    owner,
  });

  function batch(items: Instruction[]): InstructionInput {
    const data = getBatchInstructionDataEncoder().encode({
      data: items.map((item) => ({
        instructionData: item.data ?? new Uint8Array(),
        numberOfAccounts: item.accounts?.length ?? 0,
      })),
    });
    return {
      accounts: items.flatMap(accountsOf),
      data,
      programId: TOKEN_PROGRAM_ADDRESS,
    };
  }

  it("decodes every item against its own slice of accounts, so a hidden SetAuthority is visible", () => {
    const context = createDecodeContext();
    const decoded = decodeInstruction(batch([transfer, setAuthority]), 0, context, 0, 0);
    expect(decoded.name).toBe("batch");
    expect(context.gaps).toEqual([]);
    expect(decoded.inner?.map((ix) => ix.name)).toEqual(["transferChecked", "setAuthority"]);
    expect(decoded.inner?.[1]?.args).toEqual({ authorityType: "MintTokens", newAuthority: null });
    expect(decoded.inner?.[1]?.summary?.params.newAuthority).toBe("none");
    expect(decoded.inner?.[1]?.accounts.map((a) => [a.role, a.address])).toEqual([
      ["owned", addr(2)],
      ["owner", addr(9)],
    ]);
  });

  it("rejects a batch that claims more accounts than the instruction has", () => {
    const input = batch([transfer]);
    const context = createDecodeContext();
    const decoded = decodeInstruction(
      { ...input, accounts: input.accounts.slice(1) },
      0,
      context,
      0,
      0,
    );
    expect(decoded.decoder).toBe("none");
    expect(context.gaps[0]?.code).toBe("MALFORMED_INSTRUCTION");
  });

  it("rejects nested batches, as the program does", () => {
    const inner = batch([transfer]);
    const nested = getBatchInstructionDataEncoder().encode({
      data: [{ instructionData: inner.data, numberOfAccounts: inner.accounts.length }],
    });
    const context = createDecodeContext();
    const decoded = decodeInstruction(
      { accounts: inner.accounts, data: nested, programId: TOKEN_PROGRAM_ADDRESS },
      0,
      context,
      0,
      0,
    );
    expect(decoded.decoder).toBe("none");
    expect(context.gaps[0]?.message).toMatch(/nested Batch/);
  });
});

describe("gaps are always reported", () => {
  it("memo that is not valid UTF-8 is malformed, not silently replaced", () => {
    const context = createDecodeContext();
    const decoded = decodeInstruction(
      {
        accounts: [],
        data: new Uint8Array([0xff, 0xfe]),
        programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address,
      },
      0,
      context,
      0,
      0,
    );
    expect(decoded.decoder).toBe("none");
    expect(context.gaps[0]?.code).toBe("MALFORMED_INSTRUCTION");
  });

  it("an unknown discriminator is UNKNOWN_INSTRUCTION, keeping the program label", () => {
    const context = createDecodeContext();
    const decoded = decodeInstruction(
      { accounts: [], data: new Uint8Array([200]), programId: TOKEN_PROGRAM_ADDRESS },
      0,
      context,
      0,
      0,
    );
    expect(decoded).toMatchObject({ decoder: "none", programLabel: "SPL Token", rawDataHex: "c8" });
    expect(context.gaps[0]?.code).toBe("UNKNOWN_INSTRUCTION");
  });

  it(`stops decoding embedded messages below depth ${MAX_EMBEDDED_DEPTH}`, () => {
    // A syntactically valid vaultTransactionCreate whose message we never get to parse.
    // vaultIndex 0, ephemeralSigners 0, empty transactionMessage (u32 length 0), memo None.
    const data = new Uint8Array([...VAULT_TRANSACTION_CREATE_DISCRIMINATOR, 0, 0, 0, 0, 0, 0, 0]);
    const accounts = Array.from({ length: 5 }, (_, i) => ({
      address: addr(i + 1),
      isSigner: false,
      isWritable: false,
    }));
    const context = createDecodeContext();
    const decoded = decodeInstruction(
      { accounts, data, programId: SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS },
      0,
      context,
      MAX_EMBEDDED_DEPTH,
      0,
    );
    expect(decoded.name).toBe("vaultTransactionCreate");
    expect(decoded.inner).toBeUndefined();
    expect(context.gaps.map((gap) => gap.code)).toEqual(["EMBEDDED_MESSAGE_INVALID"]);
  });
});

describe("decodeRawTransaction input validation", () => {
  it.each([
    ["empty", ""],
    ["not base64", "not base64!!"],
    ["bad padding", "AAA"],
    ["a single byte", "AA=="],
  ])("%s → typed DecodeError", async (_label, input) => {
    await expect(decodeRawTransaction(emptyRpc, input)).rejects.toBeInstanceOf(DecodeError);
  });

  /** A real wire transaction built and encoded by kit itself (one Compute Budget instruction). */
  function kitTransaction(version: 0 | 1 | "legacy"): string {
    const message = pipe(
      createTransactionMessage({ version }),
      (m) => setTransactionMessageFeePayer(addr(7), m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: addr(8) as string as Blockhash, lastValidBlockHeight: 0n },
          m,
        ),
      (m) =>
        appendTransactionMessageInstruction(
          {
            data: new Uint8Array([2, 64, 66, 15, 0]),
            programAddress: "ComputeBudget111111111111111111111111111111" as Address,
          },
          m,
        ),
    );
    return getBase64EncodedWireTransaction(compileTransaction(message));
  }

  it.each(["legacy", 0] as const)("decodes a kit-built %s transaction", async (version) => {
    const result = await decodeRawTransaction(emptyRpc, kitTransaction(version));
    expect(result.version).toBe(version);
    expect(result.feePayer).toBe(addr(7));
    expect(result.gaps).toEqual([]);
    expect(result.instructions).toMatchObject([
      { args: { units: 1_000_000 }, name: "setComputeUnitLimit" },
    ]);
  });

  it("rejects trailing bytes after a valid transaction", async () => {
    const bytes = getBase64Encoder().encode(kitTransaction(0));
    const trailing = getBase64Decoder().decode(new Uint8Array([...bytes, 7]));
    await expect(decodeRawTransaction(emptyRpc, trailing)).rejects.toThrow(/trailing/);
  });

  it("rejects v1 messages with a typed error until real v1 data can be tested", async () => {
    await expect(decodeRawTransaction(emptyRpc, kitTransaction(1))).rejects.toThrow(
      /v1 transaction messages are not supported/,
    );
  });
});
