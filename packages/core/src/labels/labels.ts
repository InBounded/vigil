import type { Address } from "@solana/kit";
import { findRegistryProgram, findRegistryToken } from "../registry/index.js";
import type { DecodedAccount, DecodedInstruction } from "../report.js";
import type { Cluster } from "../rpc/types.js";
import { getVaultPda } from "../squads/pda.js";
import { SYSVARS } from "./sysvars.js";

/**
 * Where a label comes from. Interfaces must show user labels as the user's own (they may have been
 * imported from someone else's file); every other source is derived by Vigil itself.
 */
export type LabelSource = "multisig" | "registry" | "sysvar" | "user";

/** An i18n key + params, like instruction summaries; the interface owns the wording. */
export interface AccountLabel {
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
  readonly source: LabelSource;
}

/**
 * Vault indices labelled for every proposal (maintainer decision). Squads allows 0–255; deriving
 * all of them per analysis is wasteful, so a vault above 15 is only labelled when it is the
 * proposal's own `vaultIndex`. **An unlabelled address may therefore still be a vault of this
 * multisig at a higher index.**
 */
export const LABELLED_VAULT_INDICES = 16;

export interface MultisigLabelContext {
  readonly address: Address;
  readonly members: readonly Address[];
  /** The vault the proposal executes from; always labelled, even above 15. */
  readonly vaultIndex?: number;
}

export interface LabelContext {
  readonly cluster: Cluster;
  readonly multisig?: MultisigLabelContext;
  /** Already sanitized and validated (see `parseUserLabels`). */
  readonly userLabels?: ReadonlyMap<Address, string>;
}

/**
 * Builds the label for every address Vigil can name. Precedence, highest first: this multisig
 * (multisig, vault, member) > registry (program, token mint) > sysvar > user. A user label never
 * overrides what Vigil derived itself, so an imported label file cannot rename a vault or USDC.
 */
export async function buildLabels(context: LabelContext): Promise<Map<Address, AccountLabel>> {
  const labels = new Map<Address, AccountLabel>();
  const set = (address: Address, label: AccountLabel): void => {
    if (!labels.has(address)) {
      labels.set(address, label);
    }
  };

  const { multisig } = context;
  if (multisig !== undefined) {
    set(multisig.address, { key: "label.multisig", params: {}, source: "multisig" });
    const indices = new Set<number>();
    for (let i = 0; i < LABELLED_VAULT_INDICES; i++) {
      indices.add(i);
    }
    if (multisig.vaultIndex !== undefined) {
      indices.add(multisig.vaultIndex);
    }
    for (const index of [...indices].sort((a, b) => a - b)) {
      const [vault] = await getVaultPda({ index, multisigPda: multisig.address });
      set(vault, { key: "label.vault", params: { index: String(index) }, source: "multisig" });
    }
    for (const member of multisig.members) {
      set(member, { key: "label.member", params: {}, source: "multisig" });
    }
  }
  for (const [address, name] of SYSVARS) {
    set(address, { key: "label.sysvar", params: { name }, source: "sysvar" });
  }
  for (const [address, text] of context.userLabels ?? []) {
    set(address, { key: "label.user", params: { text }, source: "user" });
  }
  return labels;
}

/** Registry labels are looked up per address rather than preloaded (the lists are cluster-bound). */
function registryLabel(address: Address, cluster: Cluster): AccountLabel | undefined {
  const program = findRegistryProgram(address);
  if (program !== undefined) {
    return { key: "label.program", params: { name: program.name }, source: "registry" };
  }
  const token = findRegistryToken(address, cluster);
  if (token !== undefined) {
    return { key: "label.tokenMint", params: { symbol: token.symbol }, source: "registry" };
  }
  return undefined;
}

export function labelFor(
  address: Address,
  labels: ReadonlyMap<Address, AccountLabel>,
  cluster: Cluster,
): AccountLabel | undefined {
  const derived = labels.get(address);
  if (derived?.source === "multisig") {
    return derived;
  }
  return registryLabel(address, cluster) ?? derived;
}

/** Returns copies of the instructions (recursively) with every known account labelled. */
export function applyLabels(
  instructions: readonly DecodedInstruction[],
  labels: ReadonlyMap<Address, AccountLabel>,
  cluster: Cluster,
): DecodedInstruction[] {
  return instructions.map((instruction) => {
    const accounts = instruction.accounts.map((account): DecodedAccount => {
      const label = labelFor(account.address, labels, cluster);
      return label === undefined ? account : { ...account, label };
    });
    const programLabel =
      instruction.programLabel ?? findRegistryProgram(instruction.programId)?.name;
    return {
      ...instruction,
      accounts,
      ...(instruction.inner === undefined
        ? {}
        : { inner: applyLabels(instruction.inner, labels, cluster) }),
      ...(programLabel === undefined ? {} : { programLabel }),
    };
  });
}
