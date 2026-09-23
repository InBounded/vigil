import {
  type Address,
  createAddressWithSeed,
  fixEncoderSize,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from "@solana/kit";

export const PROGRAM_METADATA_PROGRAM_ADDRESS =
  "ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S" as Address;

/** The Program Metadata seed under which programs publish their IDL. */
export const PROGRAM_METADATA_IDL_SEED = "idl";

/**
 * The canonical Program Metadata account for `program`'s IDL: PDA of the Program Metadata program
 * with seeds `[program, authority, seed]`, where the authority is `None` for the canonical account
 * (encoded as zero bytes, `getOptionEncoder(..., { prefix: null })`) and the seed is UTF-8 padded
 * to 16 bytes. `findMetadataPda` in `@solana-program/program-metadata@0.10.0`
 * (`src/generated/pdas/metadata.ts`); cross-checked in tests.
 */
export async function findProgramMetadataIdlAddress(program: Address): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: PROGRAM_METADATA_PROGRAM_ADDRESS,
    seeds: [
      getAddressEncoder().encode(program),
      fixEncoderSize(getUtf8Encoder(), 16).encode(PROGRAM_METADATA_IDL_SEED),
    ],
  });
  return address;
}

/**
 * The legacy Anchor IDL account: `create_with_seed(find_program_address(&[], program), "anchor:idl",
 * program)` — `IdlAccount::address` in solana-foundation/anchor `lang/src/idl.rs` at commit
 * cc9f6b1c5e4a646bc592486a7bd485a8357a028d (where it is marked deprecated in favour of Program
 * Metadata).
 */
export async function findAnchorIdlAddress(program: Address): Promise<Address> {
  const [base] = await getProgramDerivedAddress({ programAddress: program, seeds: [] });
  return createAddressWithSeed({ baseAddress: base, programAddress: program, seed: "anchor:idl" });
}
