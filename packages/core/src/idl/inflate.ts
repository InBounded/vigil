import type { ReadonlyUint8Array } from "@solana/kit";
import { Gunzip, Unzlib } from "fflate";

/** Hard limits on IDL data (3B.1): compressed as stored on chain, and after decompression. */
export const MAX_IDL_COMPRESSED_BYTES = 1_000_000;
export const MAX_IDL_DECOMPRESSED_BYTES = 5_000_000;

/**
 * Input is fed to the inflater in slices this small so that output can be checked against the
 * limit as it is produced: deflate expands at most ~1032:1, so one slice yields at most ~1 MB
 * before the check runs. A decompression bomb is stopped, never fully inflated.
 */
const INPUT_SLICE = 1024;

export class InflateLimitError extends Error {
  constructor() {
    super(`decompressed IDL exceeds ${MAX_IDL_DECOMPRESSED_BYTES} bytes`);
    this.name = "InflateLimitError";
  }
}

export function inflateBounded(
  compressed: ReadonlyUint8Array,
  format: "zlib" | "gzip",
  limit = MAX_IDL_DECOMPRESSED_BYTES,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  const onData = (chunk: Uint8Array, final: boolean): void => {
    total += chunk.length;
    if (total > limit) {
      throw new InflateLimitError();
    }
    chunks.push(chunk);
    finished ||= final;
  };
  const stream = format === "zlib" ? new Unzlib(onData) : new Gunzip(onData);
  const input = Uint8Array.from(compressed);
  if (input.length === 0) {
    throw new Error("compressed IDL is empty");
  }
  for (let offset = 0; offset < input.length; offset += INPUT_SLICE) {
    const end = Math.min(offset + INPUT_SLICE, input.length);
    stream.push(input.subarray(offset, end), end === input.length);
  }
  if (!finished) {
    throw new Error("compressed IDL is truncated");
  }
  const out = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}
