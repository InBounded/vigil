import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU8Encoder,
  getU32Encoder,
  getU64Encoder,
  type ProgramDerivedAddress,
} from "@solana/kit";
import { SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS } from "./generated/programs/squadsMultisigProgram.js";

/**
 * PDA seeds, per `docs/reference.md` §5 and independently cross-checked against `@sqds/multisig`'s
 * own `src/pda.ts` — see `pda.test.ts` and `docs/DECISIONS.md`.
 */
const SEED_PREFIX = "multisig";
const SEED_PROGRAM_CONFIG = "program_config";
const SEED_MULTISIG = "multisig";
const SEED_VAULT = "vault";
const SEED_TRANSACTION = "transaction";
const SEED_PROPOSAL = "proposal";
const SEED_BATCH_TRANSACTION = "batch_transaction";
const SEED_EPHEMERAL_SIGNER = "ephemeral_signer";
const SEED_SPENDING_LIMIT = "spending_limit";

const addressEncoder = getAddressEncoder();
const u8Encoder = getU8Encoder();
const u32Encoder = getU32Encoder();
const u64Encoder = getU64Encoder();

export interface ProgramAddressArg {
  readonly programAddress?: Address;
}

export async function getProgramConfigPda(
  args: ProgramAddressArg = {},
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: args.programAddress ?? SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS,
    seeds: [SEED_PREFIX, SEED_PROGRAM_CONFIG],
  });
}

export async function getMultisigPda(
  args: { readonly createKey: Address } & ProgramAddressArg,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: args.programAddress ?? SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS,
    seeds: [SEED_PREFIX, SEED_MULTISIG, addressEncoder.encode(args.createKey)],
  });
}

export async function getVaultPda(
  args: { readonly multisigPda: Address; readonly index: number } & ProgramAddressArg,
): Promise<ProgramDerivedAddress> {
  if (args.index < 0 || args.index > 255) {
    throw new RangeError(`vault index must be a u8 (0-255), got ${args.index}`);
  }
  return getProgramDerivedAddress({
    programAddress: args.programAddress ?? SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS,
    seeds: [
      SEED_PREFIX,
      addressEncoder.encode(args.multisigPda),
      SEED_VAULT,
      u8Encoder.encode(args.index),
    ],
  });
}

export async function getTransactionPda(
  args: { readonly multisigPda: Address; readonly index: bigint } & ProgramAddressArg,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: args.programAddress ?? SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS,
    seeds: [
      SEED_PREFIX,
      addressEncoder.encode(args.multisigPda),
      SEED_TRANSACTION,
      u64Encoder.encode(args.index),
    ],
  });
}

export async function getProposalPda(
  args: { readonly multisigPda: Address; readonly transactionIndex: bigint } & ProgramAddressArg,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: args.programAddress ?? SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS,
    seeds: [
      SEED_PREFIX,
      addressEncoder.encode(args.multisigPda),
      SEED_TRANSACTION,
      u64Encoder.encode(args.transactionIndex),
      SEED_PROPOSAL,
    ],
  });
}

export async function getEphemeralSignerPda(
  args: {
    readonly transactionPda: Address;
    readonly ephemeralSignerIndex: number;
  } & ProgramAddressArg,
): Promise<ProgramDerivedAddress> {
  if (args.ephemeralSignerIndex < 0 || args.ephemeralSignerIndex > 255) {
    throw new RangeError(
      `ephemeral signer index must be a u8 (0-255), got ${args.ephemeralSignerIndex}`,
    );
  }
  return getProgramDerivedAddress({
    programAddress: args.programAddress ?? SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS,
    seeds: [
      SEED_PREFIX,
      addressEncoder.encode(args.transactionPda),
      SEED_EPHEMERAL_SIGNER,
      u8Encoder.encode(args.ephemeralSignerIndex),
    ],
  });
}

export async function getBatchTransactionPda(
  args: {
    readonly multisigPda: Address;
    readonly batchIndex: bigint;
    readonly transactionIndex: number;
  } & ProgramAddressArg,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: args.programAddress ?? SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS,
    seeds: [
      SEED_PREFIX,
      addressEncoder.encode(args.multisigPda),
      SEED_TRANSACTION,
      u64Encoder.encode(args.batchIndex),
      SEED_BATCH_TRANSACTION,
      u32Encoder.encode(args.transactionIndex),
    ],
  });
}

export async function getSpendingLimitPda(
  args: { readonly multisigPda: Address; readonly createKey: Address } & ProgramAddressArg,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: args.programAddress ?? SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS,
    seeds: [
      SEED_PREFIX,
      addressEncoder.encode(args.multisigPda),
      SEED_SPENDING_LIMIT,
      addressEncoder.encode(args.createKey),
    ],
  });
}
