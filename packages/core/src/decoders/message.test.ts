import type { Address } from "@solana/kit";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDecodeContext, decodeCompiledMessage } from "./decode.js";
import { DecodeError } from "./errors.js";
import type { LookupTableEntry } from "./lookup-tables.js";
import { parseSquadsTransactionMessage } from "./message.js";

const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
const asAddress = (publicKey: PublicKey) => publicKey.toBase58() as Address;

const vault = key(1);
const recipient = key(2);
const customProgram = key(3);
const tableKey = key(4);
const tableEntries = [key(10), key(11), key(12), key(13)];

const lookupTable = new AddressLookupTableAccount({
  key: tableKey,
  state: {
    addresses: tableEntries,
    deactivationSlot: 18446744073709551615n,
    lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0,
  },
});

const customInstruction = new TransactionInstruction({
  // 300 bytes: exercises the u16 data-length prefix.
  data: Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256)),
  keys: [
    { isSigner: false, isWritable: true, pubkey: tableEntries[2] ?? vault },
    { isSigner: false, isWritable: false, pubkey: tableEntries[0] ?? vault },
    { isSigner: true, isWritable: true, pubkey: vault },
  ],
  programId: customProgram,
});

/** Serialized with the official Squads SDK, exactly as a proposal creator would. */
function officialMessageBytes(): Uint8Array {
  const message = new TransactionMessage({
    instructions: [
      SystemProgram.transfer({ fromPubkey: vault, lamports: 1_000_000n, toPubkey: recipient }),
      customInstruction,
    ],
    payerKey: vault,
    recentBlockhash: PublicKey.default.toBase58(),
  });
  return multisig.utils.transactionMessageToMultisigTransactionMessageBytes({
    addressLookupTableAccounts: [lookupTable],
    message,
    vaultPda: vault,
  });
}

describe("parseSquadsTransactionMessage", () => {
  it("matches the Squads SDK's own deserializer field by field", () => {
    const bytes = officialMessageBytes();
    const [sdk] = multisig.types.transactionMessageBeet.deserialize(Buffer.from(bytes));
    const ours = parseSquadsTransactionMessage(bytes);

    expect(ours.numSigners).toBe(sdk.numSigners);
    expect(ours.numWritableSigners).toBe(sdk.numWritableSigners);
    expect(ours.numWritableNonSigners).toBe(sdk.numWritableNonSigners);
    expect(ours.staticAccounts).toEqual(sdk.accountKeys.map(asAddress));
    expect(ours.instructions).toHaveLength(sdk.instructions.length);
    ours.instructions.forEach((instruction, i) => {
      const expected = sdk.instructions[i];
      expect(instruction.programIndex).toBe(expected?.programIdIndex);
      expect(instruction.accountIndexes).toEqual(Array.from(expected?.accountIndexes ?? []));
      expect(Array.from(instruction.data)).toEqual(Array.from(expected?.data ?? []));
    });
    expect(ours.lookups).toEqual(
      sdk.addressTableLookups.map((lookup) => ({
        readonlyIndexes: Array.from(lookup.readonlyIndexes),
        tableAddress: asAddress(lookup.accountKey),
        writableIndexes: Array.from(lookup.writableIndexes),
      })),
    );
    expect(ours.lookups).toHaveLength(1);
  });

  it("resolves every account, including lookup-table ones, to the original instruction keys", () => {
    const message = parseSquadsTransactionMessage(officialMessageBytes());
    const tables = new Map<Address, LookupTableEntry>([
      [
        asAddress(tableKey),
        {
          status: "ok",
          table: {
            address: asAddress(tableKey),
            addresses: tableEntries.map(asAddress),
            authority: null,
            deactivationSlot: 18446744073709551615n,
          },
        },
      ],
    ]);
    const context = createDecodeContext(tables);
    const [transfer, custom] = decodeCompiledMessage(message, context, 0, undefined);

    expect(context.missing.size).toBe(0);
    expect(transfer?.name).toBe("transferSol");
    expect(transfer?.args).toEqual({ amount: 1_000_000n });
    expect(transfer?.accounts).toEqual([
      { address: asAddress(vault), isSigner: true, isWritable: true, role: "source" },
      { address: asAddress(recipient), isSigner: false, isWritable: true, role: "destination" },
    ]);

    expect(custom?.decoder).toBe("none");
    expect(custom?.programId).toBe(asAddress(customProgram));
    expect(custom?.rawDataHex).toBe(customInstruction.data.toString("hex"));
    expect(custom?.accounts).toEqual(
      customInstruction.keys.map((meta) => ({
        address: asAddress(meta.pubkey),
        ...(meta.pubkey.equals(vault) ? {} : { fromLookupTable: asAddress(tableKey) }),
        isSigner: meta.isSigner,
        isWritable: meta.isWritable,
      })),
    );
    // The unknown program is reported, never silently skipped.
    expect(context.gaps.map((gap) => gap.code)).toEqual(["UNKNOWN_PROGRAM"]);
  });

  it("asks for lookup tables it has not seen instead of guessing their contents", () => {
    const context = createDecodeContext();
    decodeCompiledMessage(
      parseSquadsTransactionMessage(officialMessageBytes()),
      context,
      0,
      undefined,
    );
    expect([...context.missing]).toEqual([asAddress(tableKey)]);
  });

  it("rejects truncated messages", () => {
    const bytes = officialMessageBytes();
    expect(() => parseSquadsTransactionMessage(bytes.subarray(0, bytes.length - 1))).toThrow(
      DecodeError,
    );
  });

  it("applies the program's header validation", () => {
    const bytes = officialMessageBytes().slice();
    bytes[1] = (bytes[0] ?? 0) + 1; // num_writable_signers > num_signers
    expect(() => parseSquadsTransactionMessage(bytes)).toThrow(/num_writable_signers/);
  });

  it("never throws anything but a DecodeError on arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (bytes) => {
        try {
          parseSquadsTransactionMessage(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(DecodeError);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
