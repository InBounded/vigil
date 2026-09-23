import { type Address, isAddress } from "@solana/kit";
import { MAX_HISTORY_DEPTH, MAX_RAW_TRANSACTION_BASE64_LENGTH } from "@vigil-sol/core";
import { CliError } from "./errors.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const U64_MAX = 18_446_744_073_709_551_615n;

/** A base58 Solana address (32 bytes once decoded). */
export function parseAddress(value: string | undefined, what: string): Address {
  if (value === undefined || value === "") {
    throw new CliError(`Missing the ${what}.`, "Run the command with --help to see its arguments.");
  }
  if (!BASE58.test(value)) {
    throw new CliError(
      `The ${what} "${printable(value)}" is not a base58 address: it contains characters base58 does not use (0, O, I, l, or symbols).`,
      "Copy the address again, in full, from a source you trust.",
    );
  }
  if (!isAddress(value)) {
    throw new CliError(
      `The ${what} "${printable(value)}" is not a valid Solana address (it must decode to 32 bytes; this has ${value.length} character${value.length === 1 ? "" : "s"}).`,
      "Check that the whole address was copied.",
    );
  }
  return value;
}

/** A Squads transaction index: a positive integer that fits in a u64. */
export function parseIndex(value: string | undefined): bigint {
  if (value === undefined || value === "") {
    throw new CliError(
      "Missing the proposal index.",
      "Usage: vigil decode <multisig> <index>, e.g. vigil decode <multisig> 12. Use vigil list <multisig> to find it.",
    );
  }
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > U64_MAX) {
    throw new CliError(
      `The proposal index "${printable(value)}" is not a positive whole number.`,
      "Use the number shown in Squads (1, 2, 3, …), without # or separators. vigil list <multisig> shows them.",
    );
  }
  return BigInt(value);
}

/** Base64 of a wire transaction: standard alphabet, padded, within the size limit. */
export function parseBase64Transaction(value: string): string {
  const text = value.replace(/\s+/g, "");
  if (text === "") {
    throw new CliError(
      "The transaction is empty.",
      "Pass the base64 transaction after --tx, or --tx - to read it from standard input.",
    );
  }
  if (text.length > MAX_RAW_TRANSACTION_BASE64_LENGTH) {
    throw new CliError(
      `The transaction is ${text.length} base64 characters; a Solana transaction is at most ${MAX_RAW_TRANSACTION_BASE64_LENGTH}.`,
      "Pass one serialized transaction (not a JSON file or several transactions).",
    );
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new CliError(
      "The transaction is not valid base64 (standard alphabet A–Z a–z 0–9 + /, padded with =).",
      'Pass the serialized transaction as base64, as wallets and getTransaction(..., { encoding: "base64" }) produce it. base58 and hex are not accepted.',
    );
  }
  return text;
}

export function parseChoice<T extends string>(
  value: string | undefined,
  option: string,
  choices: readonly T[],
  fallback: T,
): T {
  if (value === undefined) {
    return fallback;
  }
  if (!(choices as readonly string[]).includes(value)) {
    throw new CliError(
      `${option} must be one of ${choices.join(", ")} (got "${printable(value)}").`,
    );
  }
  return value as T;
}

export function parseInteger(
  value: string | undefined,
  option: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const n = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new CliError(
      `${option} must be a whole number from ${min} to ${max} (got "${printable(value)}").`,
    );
  }
  return n;
}

export const HISTORY_MAX = MAX_HISTORY_DEPTH;

/** Keeps user input printable in an error message: short, and no control characters. */
function printable(value: string): string {
  const shown = value.length > 60 ? `${value.slice(0, 57)}...` : value;
  return shown.replace(/[^\x20-\x7e]/g, "?");
}
