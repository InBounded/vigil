import {
  type Address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type ReadonlyUint8Array,
} from "@solana/kit";
import type { RpcClient } from "../rpc/types.js";
import { toHex } from "./bytes.js";
import { decodeMessageWithLookups, type MessageDecodeResult } from "./decode.js";
import { DecodeError } from "./errors.js";
import type { CompiledMessage } from "./message.js";

export interface RawTransactionDecodeResult extends MessageDecodeResult {
  /** Hex SHA-256 of the decoded wire-transaction bytes (identifies the input in the report). */
  readonly sha256: string;
  readonly version: "legacy" | 0;
  readonly feePayer: Address;
  readonly signatureCount: number;
}

const base64Bytes = getBase64Encoder();
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodes a base64 wire transaction (signatures + message, as produced by wallets and
 * `getTransaction(..., { encoding: "base64" })`), resolves its lookup tables and decodes every
 * instruction, recursing into Squads proposal-creation messages. Nothing is signed or sent.
 *
 * v1 messages (SIMD-0385; `VersionedMessage::V1` in anza-xyz/solana-sdk, live on mainnet — see
 * `docs/DECISIONS.md`) are rejected for now: the RPC client cannot fetch them yet, so no real v1
 * transaction could be captured to test against, and `AGENTS.md` forbids untested decoders.
 */
export async function decodeRawTransaction(
  rpc: RpcClient,
  base64: string,
): Promise<RawTransactionDecodeResult> {
  const bytes = parseBase64(base64);
  const { message, signatureCount } = parseWireTransaction(bytes);
  const [decoded, sha256] = await Promise.all([
    decodeMessageWithLookups(rpc, message.compiled),
    sha256Hex(bytes),
  ]);
  return {
    ...decoded,
    feePayer: message.feePayer,
    sha256,
    signatureCount,
    version: message.version,
  };
}

export interface ParsedWireTransaction {
  readonly signatureCount: number;
  readonly message: {
    readonly version: "legacy" | 0;
    readonly feePayer: Address;
    readonly compiled: CompiledMessage;
  };
}

export function parseWireTransaction(bytes: ReadonlyUint8Array): ParsedWireTransaction {
  let transaction: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  try {
    const [decoded, end] = getTransactionDecoder().read(bytes, 0);
    if (end !== bytes.length) {
      throw new DecodeError("TRAILING_BYTES", `${bytes.length - end} unexpected trailing byte(s)`);
    }
    transaction = decoded;
  } catch (error) {
    throw asTransactionError(error);
  }

  // The transaction decoder hands every byte after the signatures to `messageBytes`, and the
  // message decoder stops at the end of the message, so trailing bytes are only visible here.
  let compiled: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    const [decoded, end] = getCompiledTransactionMessageDecoder().read(transaction.messageBytes, 0);
    if (end !== transaction.messageBytes.length) {
      throw new DecodeError(
        "TRAILING_BYTES",
        `${transaction.messageBytes.length - end} unexpected trailing byte(s)`,
      );
    }
    compiled = decoded;
  } catch (error) {
    throw asTransactionError(error);
  }
  if (compiled.version === 1) {
    throw new DecodeError("INVALID_TRANSACTION", "v1 transaction messages are not supported yet");
  }

  const { header, staticAccounts } = compiled;
  const feePayer = staticAccounts[0];
  if (feePayer === undefined) {
    throw new DecodeError("INVALID_TRANSACTION", "transaction has no accounts");
  }
  const numSigners = header.numSignerAccounts;
  const numNonSigners = staticAccounts.length - numSigners;
  if (numSigners > staticAccounts.length || header.numReadonlySignerAccounts > numSigners) {
    throw new DecodeError(
      "INVALID_TRANSACTION",
      "message header is inconsistent with its accounts",
    );
  }
  if (header.numReadonlyNonSignerAccounts > numNonSigners) {
    throw new DecodeError(
      "INVALID_TRANSACTION",
      "message header is inconsistent with its accounts",
    );
  }
  const lookups = compiled.version === 0 ? (compiled.addressTableLookups ?? []) : [];
  return {
    message: {
      compiled: {
        instructions: compiled.instructions.map((instruction) => ({
          accountIndexes: instruction.accountIndices ?? [],
          data: instruction.data ?? new Uint8Array(),
          programIndex: instruction.programAddressIndex,
        })),
        lookups: lookups.map((lookup) => ({
          readonlyIndexes: lookup.readonlyIndexes,
          tableAddress: lookup.lookupTableAddress,
          writableIndexes: lookup.writableIndexes,
        })),
        numSigners,
        numWritableNonSigners: numNonSigners - header.numReadonlyNonSignerAccounts,
        numWritableSigners: numSigners - header.numReadonlySignerAccounts,
        staticAccounts,
      },
      feePayer,
      version: compiled.version,
    },
    signatureCount: Object.keys(transaction.signatures).length,
  };
}

function parseBase64(input: string): ReadonlyUint8Array {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0 || !BASE64_PATTERN.test(trimmed)) {
    throw new DecodeError("INVALID_TRANSACTION", "input is not valid base64");
  }
  return base64Bytes.encode(trimmed);
}

async function sha256Hex(bytes: ReadonlyUint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return toHex(new Uint8Array(digest));
}

function asTransactionError(error: unknown): DecodeError {
  if (error instanceof DecodeError) {
    return error;
  }
  return new DecodeError(
    "INVALID_TRANSACTION",
    `not a valid Solana wire transaction: ${error instanceof Error ? error.message : String(error)}`,
  );
}
