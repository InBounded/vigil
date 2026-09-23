import type { Address } from "@solana/kit";
import { findRegistryToken } from "../../registry/index.js";
import type { ConfigAction, Finding, Provenance } from "../../report.js";
import { configActionsFromInstruction } from "../../squads/config-actions.js";
import { accountByRole, describeAddress, ev, finding, PROGRAMS } from "../helpers.js";
import type { Rule, RuleContext } from "../types.js";
import { onlyProposes, type WalkedInstruction, walkWithExecuted } from "../walk.js";

/** `Pubkey::default()`: a spending limit on this mint is a SOL spending limit (Squads v4 source). */
const SOL_SPENDING_LIMIT_MINT = PROGRAMS.system;

interface Change {
  readonly variant: string;
  readonly params: Record<string, string>;
  readonly evidence: string[];
}

/** Decimals and symbol for a spending limit's amount, when Vigil knows them. */
function amountParams(context: RuleContext, mint: Address): Record<string, string> {
  if (mint === SOL_SPENDING_LIMIT_MINT) {
    return { decimals: "9", symbol: "SOL" };
  }
  const token = context.tokens.find((t) => t.mint === mint);
  const registry = findRegistryToken(mint, context.cluster);
  const decimals = token?.decimals ?? registry?.decimals;
  const symbol = token?.registry?.symbol ?? registry?.symbol;
  return {
    mint,
    ...(decimals === undefined ? {} : { decimals: String(decimals) }),
    ...(symbol === undefined ? {} : { symbol }),
  };
}

function describe(
  context: RuleContext,
  action: ConfigAction,
  current: { readonly threshold: number; readonly timeLockSeconds: number } | undefined,
): Change {
  switch (action.kind) {
    case "addMember":
      return {
        evidence: [
          ev("member", action.member),
          ev("permissions", action.permissions.join(",") || "none"),
        ],
        params: { member: action.member, permissions: action.permissions.join(",") || "none" },
        variant: "addMember",
      };
    case "removeMember":
      return {
        evidence: [ev("member", action.member)],
        params: { member: action.member },
        variant: "removeMember",
      };
    case "changeThreshold": {
      const old = current?.threshold;
      return {
        evidence: [ev("oldThreshold", old ?? "unknown"), ev("newThreshold", action.newThreshold)],
        params: {
          newThreshold: String(action.newThreshold),
          ...(old === undefined ? {} : { oldThreshold: String(old) }),
        },
        variant: old !== undefined && action.newThreshold < old ? "thresholdLowered" : "threshold",
      };
    }
    case "setTimeLock": {
      const old = current?.timeLockSeconds;
      return {
        evidence: [
          ev("oldTimeLockSeconds", old ?? "unknown"),
          ev("newTimeLockSeconds", action.newTimeLockSeconds),
        ],
        params: {
          newTimeLock: String(action.newTimeLockSeconds),
          ...(old === undefined ? {} : { oldTimeLock: String(old) }),
        },
        variant:
          old !== undefined && action.newTimeLockSeconds < old ? "timeLockLowered" : "timeLock",
      };
    }
    case "setRentCollector":
      return {
        evidence: [ev("newRentCollector", action.newRentCollector ?? "none")],
        params: { newRentCollector: action.newRentCollector ?? "none" },
        variant: "rentCollector",
      };
    case "addSpendingLimit":
      return {
        evidence: [
          ev("vaultIndex", action.vaultIndex),
          ev("mint", action.mint === SOL_SPENDING_LIMIT_MINT ? "SOL" : action.mint),
          ev("amountBaseUnits", action.amount),
          ev("period", action.period),
          ...action.members.map((m) => ev("canUse", `${m} (${describeAddress(context, m)})`)),
          ...(action.destinations.length === 0
            ? [ev("destinations", "any")]
            : action.destinations.map((d) => ev("destination", d))),
          ev("createKey", action.createKey),
        ],
        params: {
          ...amountParams(context, action.mint),
          amount: String(action.amount),
          destinations:
            action.destinations.length === 0 ? "none" : String(action.destinations.length),
          members: String(action.members.length),
          period: action.period,
          vaultIndex: String(action.vaultIndex),
        },
        variant: "spendingLimitAdded",
      };
    case "removeSpendingLimit":
      return {
        evidence: [ev("spendingLimit", action.spendingLimit)],
        params: { spendingLimit: action.spendingLimit },
        variant: "spendingLimitRemoved",
      };
    case "setConfigAuthority":
      return {
        evidence: [
          ev("newConfigAuthority", action.newConfigAuthority),
          ev("newConfigAuthorityIs", describeAddress(context, action.newConfigAuthority)),
        ],
        params: { newConfigAuthority: action.newConfigAuthority },
        variant: "configAuthority",
      };
  }
}

export const multisigConfigChange: Rule = {
  defaultSeverity: "critical",
  docs: {
    falsePositives:
      "Every settings change fires, including routine ones such as adding a new member or raising the threshold: they all change who controls the vaults. Lowering the threshold or the time lock gets the stronger wording.",
    what: "A change to this multisig's settings: add or remove a member, change the threshold (stronger if lowered), change the time lock (stronger if lowered), set the rent collector, add or remove a spending limit, or change the config authority. Found in a config proposal, in a proposal being created in the analysed transaction, or in a direct config-authority instruction.",
    why: "These change who can approve and execute transactions and how fast. A spending limit lets its members spend up to its amount without any vote. Attackers who get one proposal through often use it to lower the threshold or add their own member.",
  },
  evaluate(context) {
    const findings: Finding[] = [];
    const multisig = context.multisig;
    const emit = (
      action: ConfigAction,
      target: Address | undefined,
      provenance: Provenance,
      proposed: boolean,
      at: WalkedInstruction | undefined,
    ): void => {
      const current = multisig !== undefined && target === multisig.address ? multisig : undefined;
      const change = describe(context, action, current);
      findings.push(
        finding(this, {
          evidence: [ev("multisig", target ?? "unknown"), ...change.evidence],
          params: { ...change.params, ...(proposed ? { proposed: "true" } : {}) },
          provenance,
          variant: change.variant,
          ...(at === undefined ? {} : { at }),
        }),
      );
    };

    for (const action of context.configActions ?? []) {
      emit(action, multisig?.address, "onchain", false, undefined);
    }
    const { walked, executed } = walkWithExecuted(context.instructions);
    for (const at of walked) {
      const actions = configActionsFromInstruction(at.instruction);
      if (actions === undefined) {
        continue;
      }
      const proposed =
        at.proposed ||
        (at.instruction.name === "configTransactionCreate" &&
          onlyProposes(at.instruction, executed));
      const target = accountByRole(at.instruction, "multisig");
      for (const action of actions) {
        emit(action, target, at.instruction.provenance, proposed, at);
      }
    }
    return findings;
  },
  id: "VGL-C006",
  name: "Multisig configuration change",
  titleKey: "finding.VGL-C006",
  variants: [
    "addMember",
    "removeMember",
    "thresholdLowered",
    "threshold",
    "timeLockLowered",
    "timeLock",
    "rentCollector",
    "spendingLimitAdded",
    "spendingLimitRemoved",
    "configAuthority",
  ],
};
