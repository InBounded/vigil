import {
  type AccountMeta,
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionSize,
  type Instruction,
  isTransactionWithinSizeLimit,
  pipe,
  type ReadonlyUint8Array,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { CompiledMessage } from "../decoders/message.js";
import type { ResolvedKeys } from "./resolve.js";

/**
 * Placeholder recent blockhash (32 zero bytes). Simulation always runs with
 * `replaceRecentBlockhash: true`, so the RPC swaps in its latest blockhash; the placeholder only
 * keeps the built bytes deterministic, which lets recorded simulations be replayed in tests.
 */
export const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111" as Blockhash;

export interface BuiltTransaction {
  readonly base64: string;
  readonly size: number;
}

export type BuildResult =
  | { readonly ok: true; readonly transaction: BuiltTransaction }
  | { readonly ok: false; readonly code: "too-large" | "build-failed"; readonly reason: string };

/** A Squads message's instructions, with each account's role taken from the message header. */
export function instructionsFromMessage(
  message: CompiledMessage,
  resolved: ResolvedKeys,
): Instruction[] {
  return message.instructions.map((instruction) => {
    const program = resolved.keys[instruction.programIndex];
    if (program === undefined) {
      // `resolveMessageKeys` resolved every index and Squads validated them on chain.
      throw new RangeError(`program index ${instruction.programIndex} out of range`);
    }
    const accounts: AccountMeta[] = instruction.accountIndexes.map((index) => {
      const address = resolved.keys[index];
      if (address === undefined) {
        throw new RangeError(`account index ${index} out of range`);
      }
      return { address, role: accountRole(resolved.signer[index], resolved.writable[index]) };
    });
    const data: ReadonlyUint8Array = instruction.data;
    return { accounts, data, programAddress: program };
  });
}

function accountRole(signer: boolean | undefined, writable: boolean | undefined): AccountRole {
  if (signer === true) {
    return writable === true ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
  }
  return writable === true ? AccountRole.WRITABLE : AccountRole.READONLY;
}

/**
 * Builds the v0 transaction a proposal's instructions would form if the vault (and the proposal's
 * ephemeral signers) signed them directly, reusing the proposal's own lookup tables so it stays
 * under the size limit. Every signature is left as 64 zero bytes (kit encodes a missing signature
 * that way); nothing is ever signed. Only ever passed to `simulateTransaction` with
 * `sigVerify: false`.
 */
export function buildSimulationTransaction(input: {
  readonly instructions: readonly Instruction[];
  readonly feePayer: Address;
  readonly lookupTables: Readonly<Record<Address, readonly Address[]>>;
}): BuildResult {
  let transaction: ReturnType<typeof compileTransaction>;
  try {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(input.feePayer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: PLACEHOLDER_BLOCKHASH, lastValidBlockHeight: 0n },
          m,
        ),
      (m) => appendTransactionMessageInstructions(input.instructions, m),
      (m) =>
        compressTransactionMessageUsingAddressLookupTables(
          m,
          input.lookupTables as Record<Address, Address[]>,
        ),
    );
    transaction = compileTransaction(message);
  } catch (error) {
    return {
      code: "build-failed",
      ok: false,
      reason: `the transaction could not be assembled: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const size = getTransactionSize(transaction);
  if (!isTransactionWithinSizeLimit(transaction)) {
    return {
      code: "too-large",
      ok: false,
      reason: `the transaction would be ${size} bytes, above the 1232-byte limit for simulation`,
    };
  }
  return { ok: true, transaction: { base64: getBase64EncodedWireTransaction(transaction), size } };
}
