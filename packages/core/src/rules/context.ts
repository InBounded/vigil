import type { Address } from "@solana/kit";
import { LABELLED_VAULT_INDICES } from "../labels/labels.js";
import { REGISTRY_PROGRAMS, REGISTRY_TOKENS } from "../registry/index.js";
import { getVaultPda } from "../squads/pda.js";
import { resolveRuleOptions } from "./options.js";
import type { KnownAddressKind, RuleContext, RuleFacts, RuleOptions } from "./types.js";

export type RuleContextInput = Omit<RuleContext, "facts" | "known" | "options" | "vaults"> & {
  readonly facts?: RuleFacts;
  readonly options?: RuleOptions;
  /** The vault the proposal executes from; derived and known even above index 15. */
  readonly vaultIndex?: number;
};

/**
 * Resolves the options and derives what the rules share: this multisig's vaults (indices 0–15
 * plus the proposal's own, as for labels) and the registry of known addresses. Async only because
 * deriving a PDA hashes with WebCrypto; nothing here reads the network.
 */
export async function createRuleContext(input: RuleContextInput): Promise<RuleContext> {
  const { facts = {}, options, vaultIndex, ...rest } = input;
  const resolved = resolveRuleOptions(options);
  const vaults = new Map<Address, number>();
  if (input.multisig !== undefined) {
    const indices = new Set<number>();
    for (let i = 0; i < LABELLED_VAULT_INDICES; i++) {
      indices.add(i);
    }
    if (vaultIndex !== undefined) {
      indices.add(vaultIndex);
    }
    for (const index of [...indices].sort((a, b) => a - b)) {
      const [vault] = await getVaultPda({ index, multisigPda: input.multisig.address });
      vaults.set(vault, index);
    }
  }

  const known = new Map<Address, KnownAddressKind[]>();
  const add = (address: Address, kind: KnownAddressKind): void => {
    const kinds = known.get(address);
    if (kinds === undefined) {
      known.set(address, [kind]);
    } else if (!kinds.includes(kind)) {
      kinds.push(kind);
    }
  };
  if (input.multisig !== undefined) {
    add(input.multisig.address, "multisig");
    for (const member of input.multisig.members) {
      add(member.key, "member");
    }
  }
  for (const vault of vaults.keys()) {
    add(vault, "vault");
  }
  for (const program of REGISTRY_PROGRAMS) {
    add(program.address, "registry-program");
  }
  for (const token of REGISTRY_TOKENS) {
    if (token.cluster === input.cluster) {
      add(token.address, "registry-token");
    }
  }
  for (const address of resolved.knownAddresses.keys()) {
    add(address, "user");
  }
  for (const address of facts.recentDestinations ?? []) {
    add(address, "recent-destination");
  }

  return { ...rest, facts, known, options: resolved, vaults };
}
