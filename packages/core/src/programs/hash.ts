import type { ReadonlyUint8Array } from "@solana/kit";

/**
 * The executable hash `solana-verify` prints (`get-program-hash`, `get-buffer-hash`): SHA-256 of
 * the program bytes (after the 45-byte ProgramData or 37-byte Buffer header) with every trailing
 * zero byte removed, as lower-case hex. Confirmed in
 * solana-foundation/solana-verifiable-build `src/main.rs` (`get_binary_hash`, `get_program_hash`,
 * `get_buffer_hash`) at fef5951281092948c7c465bf63fa28ab59ff5485, and against the tool's own
 * output on real mainnet programs (see `docs/DECISIONS.md`).
 */
export async function executableHash(code: ReadonlyUint8Array): Promise<string> {
  let end = code.length;
  while (end > 0 && code[end - 1] === 0) {
    end--;
  }
  const trimmed = Uint8Array.from(code.subarray(0, end));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", trimmed));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
