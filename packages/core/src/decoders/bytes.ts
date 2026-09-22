import { type Address, getAddressDecoder, type ReadonlyUint8Array } from "@solana/kit";
import { DecodeError } from "./errors.js";

const addressDecoder = getAddressDecoder();

export function toHex(bytes: ReadonlyUint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Bounds-checked little-endian reader over untrusted bytes. Every read throws a `DecodeError`
 * (never returns garbage) when the input is too short.
 */
export class ByteReader {
  readonly #bytes: ReadonlyUint8Array;
  #offset = 0;

  constructor(bytes: ReadonlyUint8Array, offset = 0) {
    this.#bytes = bytes;
    this.#offset = offset;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  #take(length: number): ReadonlyUint8Array {
    if (length < 0 || this.#offset + length > this.#bytes.length) {
      throw new DecodeError(
        "TRUNCATED",
        `needed ${length} byte(s) at offset ${this.#offset}, only ${this.remaining} left`,
      );
    }
    const slice = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  u8(): number {
    return this.#take(1)[0] ?? 0;
  }

  u16(): number {
    const b = this.#take(2);
    return (b[0] ?? 0) | ((b[1] ?? 0) << 8);
  }

  u32(): number {
    const b = this.#take(4);
    return ((b[0] ?? 0) | ((b[1] ?? 0) << 8) | ((b[2] ?? 0) << 16)) + (b[3] ?? 0) * 0x1000000;
  }

  u64(): bigint {
    const b = this.#take(8);
    let value = 0n;
    for (let i = 7; i >= 0; i--) {
      value = (value << 8n) | BigInt(b[i] ?? 0);
    }
    return value;
  }

  bytes(length: number): ReadonlyUint8Array {
    return this.#take(length);
  }

  rest(): ReadonlyUint8Array {
    return this.#take(this.remaining);
  }

  address(): Address {
    return addressDecoder.decode(this.#take(32));
  }

  /** `true` if every one of the next 32 bytes is zero (does not advance). */
  peekZeroAddress(): boolean {
    if (this.remaining < 32) {
      return false;
    }
    for (let i = 0; i < 32; i++) {
      if (this.#bytes[this.#offset + i] !== 0) {
        return false;
      }
    }
    return true;
  }

  expectEnd(): void {
    if (this.remaining !== 0) {
      throw new DecodeError("TRAILING_BYTES", `${this.remaining} unexpected trailing byte(s)`);
    }
  }
}
