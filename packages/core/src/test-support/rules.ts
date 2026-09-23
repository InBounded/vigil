/**
 * Builders shared by the rules tests. Excluded from the build and from coverage. Hand-built
 * instructions are only used for branches no captured transaction exercises; every rule is also
 * run over real decoded mainnet data (`rules/fixtures.test.ts`).
 */
import { fileURLToPath } from "node:url";
import {
  type Address,
  createNoopSigner,
  getAddressDecoder,
  type Instruction,
  isAddress,
  isSignerRole,
  isWritableRole,
  type Signature,
} from "@solana/kit";
import { annotateInstructions } from "../annotate.js";
import { createDecodeContext, decodeInstruction } from "../decoders/decode.js";
import { decodeVaultTransactionMessage } from "../decoders/squads-proposal.js";
import { decodeRawTransaction } from "../decoders/transaction.js";
import type { DecodedAccount, DecodedInstruction } from "../report.js";
import { FixtureRpcClient } from "../rpc/fixture-client.js";
import { loadFixtureFile } from "../rpc/fixture-file.js";
import type { FixtureData } from "../rpc/index.js";
import { createRuleContext, type RuleContextInput } from "../rules/context.js";
import type { RuleContext } from "../rules/types.js";
import { SquadsV4Adapter } from "../squads/adapter.js";
import { toEncodedAccount } from "../squads/decode.js";
import { decodeVaultTransaction } from "../squads/generated/accounts/vaultTransaction.js";
import type { SquadsMultisigSummary } from "../squads/types.js";

export const NOW = 1_800_000_000n;

const addressDecoder = getAddressDecoder();

/** A valid, deterministic address for hand-built cases: 32 bytes of `n`. */
export function addr(n: number): Address {
  return addressDecoder.decode(new Uint8Array(32).fill(n));
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A different valid address with the same first and last four characters as `address`. */
export function lookalikeOf(address: Address): Address {
  for (let position = 5; position < address.length - 5; position++) {
    for (const char of BASE58) {
      const candidate = `${address.slice(0, position)}${char}${address.slice(position + 1)}`;
      if (candidate !== address && isAddress(candidate)) {
        return candidate;
      }
    }
  }
  throw new Error(`no look-alike found for ${address}`);
}

export function account(
  address: Address,
  role?: string,
  flags: { readonly isSigner?: boolean; readonly isWritable?: boolean } = {},
): DecodedAccount {
  return {
    address,
    isSigner: flags.isSigner ?? false,
    isWritable: flags.isWritable ?? false,
    ...(role === undefined ? {} : { role }),
  };
}

/** A decoded instruction with sensible defaults (native decoder, on-chain provenance). */
export function instruction(
  fields: Partial<DecodedInstruction> & Pick<DecodedInstruction, "programId">,
): DecodedInstruction {
  return {
    accounts: [],
    decoder: "native",
    index: 0,
    provenance: "onchain",
    rawDataHex: "",
    ...fields,
  };
}

export function multisig(fields: Partial<SquadsMultisigSummary> = {}): SquadsMultisigSummary {
  return {
    address: addr(200),
    configAuthority: "11111111111111111111111111111111" as Address,
    createKey: addr(201),
    isControlled: false,
    members: [
      { key: addr(202), permissions: ["Initiate", "Vote", "Execute"] },
      { key: addr(203), permissions: ["Vote"] },
    ],
    rentCollector: null,
    staleTransactionIndex: 0n,
    threshold: 2,
    timeLockSeconds: 0,
    transactionIndex: 10n,
    ...fields,
  };
}

export type ContextOverrides = Partial<RuleContextInput>;

/** A context for a raw transaction by default; override anything. */
export function context(overrides: ContextOverrides = {}): Promise<RuleContext> {
  return createRuleContext({
    cluster: "mainnet",
    gaps: [],
    input: { kind: "raw-transaction", sha256: "00" },
    instructions: [],
    now: NOW,
    programs: [],
    tokens: [],
    ...overrides,
  });
}

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/${name}.json`, import.meta.url));
}

export async function loadFixture(name: string): Promise<FixtureData> {
  return loadFixtureFile(fixturePath(name));
}

/** Decodes (and annotates: token amounts, labels) a real captured transaction. */
export async function decodeFixtureTransaction(
  data: FixtureData,
  signature: string,
  multisigContext?: { readonly address: Address; readonly members: readonly Address[] },
) {
  const tx = data.transactions.get(signature as Signature);
  if (tx === undefined) {
    throw new Error(`fixture has no transaction ${signature}`);
  }
  const rpc = new FixtureRpcClient(data);
  const decoded = await decodeRawTransaction(rpc, tx.transactionBase64);
  const annotated = await annotateInstructions(rpc, decoded.instructions, {
    cluster: "mainnet",
    ...(multisigContext === undefined ? {} : { multisig: multisigContext }),
  });
  return {
    decoded,
    gaps: [...decoded.gaps, ...annotated.gaps],
    instructions: annotated.instructions,
    tokens: annotated.tokens,
  };
}

/**
 * A squads-proposal context built the way the analysis will build it: the multisig, the proposal
 * and the stored VaultTransaction message read from a real fixture through `SquadsV4Adapter`.
 */
export async function proposalFixtureContext(
  fixture: string,
  multisigAddress: Address,
  transactionIndex: bigint,
  overrides: ContextOverrides = {},
) {
  const data = await loadFixture(fixture);
  const rpc = new FixtureRpcClient(data);
  const bundle = await new SquadsV4Adapter(rpc).fetchProposalBundle(
    multisigAddress,
    transactionIndex,
  );
  const info = data.accounts.get(bundle.transactionAddress);
  if (info === undefined) {
    throw new Error("fixture is missing the VaultTransaction account");
  }
  const stored = decodeVaultTransaction(toEncodedAccount(bundle.transactionAddress, info)).data;
  const decoded = await decodeVaultTransactionMessage(rpc, stored.message);
  const annotated = await annotateInstructions(rpc, decoded.instructions, {
    cluster: "mainnet",
    multisig: {
      address: multisigAddress,
      members: bundle.multisig.members.map((m) => m.key),
      vaultIndex: stored.vaultIndex,
    },
  });
  const ctx = await context({
    gaps: [...decoded.gaps, ...annotated.gaps],
    input: { kind: "squads-proposal", multisig: multisigAddress, transactionIndex },
    instructions: annotated.instructions,
    multisig: bundle.multisig,
    proposal: bundle.proposal,
    tokens: annotated.tokens,
    transactionKind: bundle.transactionKind,
    vaultIndex: stored.vaultIndex,
    ...overrides,
  });
  return { bundle, context: ctx, stored };
}

/**
 * An instruction encoded by an official client builder (`@solana-program/*` or the generated
 * Squads client), decoded by Vigil's own decoders: the bytes are exactly what the program expects.
 */
export function decodeBuilt(built: Instruction, index = 0): DecodedInstruction {
  return decodeInstruction(
    {
      accounts: (built.accounts ?? []).map((meta) => ({
        address: meta.address,
        isSigner: isSignerRole(meta.role),
        isWritable: isWritableRole(meta.role),
      })),
      data: built.data ?? new Uint8Array(),
      programId: built.programAddress,
    },
    index,
    createDecodeContext(new Map()),
    0,
    index,
  );
}

/** A no-op signer for builders that require one (nothing is ever signed). */
export function signer(address: Address) {
  return createNoopSigner(address);
}
