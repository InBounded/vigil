import { type Address, getBase16Encoder, unwrapOption } from "@solana/kit";
import type { ConfigAction, DecodedInstruction, SpendingLimitPeriod } from "../report.js";
import { decodePermissions } from "./decode.js";
import { getConfigTransactionCreateInstructionDataDecoder } from "./generated/instructions/configTransactionCreate.js";
import { getMultisigAddMemberInstructionDataDecoder } from "./generated/instructions/multisigAddMember.js";
import { getMultisigAddSpendingLimitInstructionDataDecoder } from "./generated/instructions/multisigAddSpendingLimit.js";
import { getMultisigChangeThresholdInstructionDataDecoder } from "./generated/instructions/multisigChangeThreshold.js";
import { getMultisigRemoveMemberInstructionDataDecoder } from "./generated/instructions/multisigRemoveMember.js";
import { getMultisigSetConfigAuthorityInstructionDataDecoder } from "./generated/instructions/multisigSetConfigAuthority.js";
import { getMultisigSetRentCollectorInstructionDataDecoder } from "./generated/instructions/multisigSetRentCollector.js";
import { getMultisigSetTimeLockInstructionDataDecoder } from "./generated/instructions/multisigSetTimeLock.js";
import { SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS } from "./generated/programs/squadsMultisigProgram.js";
import type { ConfigAction as GeneratedConfigAction } from "./generated/types/configAction.js";
import { Period } from "./generated/types/period.js";

const hex = getBase16Encoder();

/** `Period` in the Squads v4 IDL, indexed by its `u8` value (generated enum order). */
const PERIODS: Readonly<Record<Period, SpendingLimitPeriod>> = {
  [Period.OneTime]: "OneTime",
  [Period.Day]: "Day",
  [Period.Week]: "Week",
  [Period.Month]: "Month",
};

/** A config transaction's action (as the generated client decodes it) in the report's shape. */
export function toConfigAction(action: GeneratedConfigAction): ConfigAction {
  switch (action.__kind) {
    case "AddMember":
      return {
        kind: "addMember",
        member: action.newMember.key,
        permissions: decodePermissions(action.newMember.permissions.mask),
      };
    case "RemoveMember":
      return { kind: "removeMember", member: action.oldMember };
    case "ChangeThreshold":
      return { kind: "changeThreshold", newThreshold: action.newThreshold };
    case "SetTimeLock":
      return { kind: "setTimeLock", newTimeLockSeconds: action.newTimeLock };
    case "AddSpendingLimit":
      return {
        amount: action.amount,
        createKey: action.createKey,
        destinations: action.destinations,
        kind: "addSpendingLimit",
        members: action.members,
        mint: action.mint,
        period: PERIODS[action.period],
        vaultIndex: action.vaultIndex,
      };
    case "RemoveSpendingLimit":
      return { kind: "removeSpendingLimit", spendingLimit: action.spendingLimit };
    case "SetRentCollector":
      return {
        kind: "setRentCollector",
        newRentCollector: unwrapOption<Address>(action.newRentCollector),
      };
  }
}

/**
 * The settings changes carried by a decoded Squads instruction: every action of a
 * `configTransactionCreate` (proposed, not applied), or the one change a controlled multisig's
 * config authority makes directly with a `multisig*` instruction. `undefined` for any other
 * instruction. Re-decodes the instruction's own bytes with the generated codecs, so the result is
 * typed exactly as the Squads v4 IDL declares it.
 */
export function configActionsFromInstruction(
  instruction: DecodedInstruction,
): readonly ConfigAction[] | undefined {
  if (
    instruction.programId !== SQUADS_MULTISIG_PROGRAM_PROGRAM_ADDRESS ||
    instruction.decoder !== "squads"
  ) {
    return undefined;
  }
  const data = hex.encode(instruction.rawDataHex);
  switch (instruction.name) {
    case "configTransactionCreate":
      return getConfigTransactionCreateInstructionDataDecoder()
        .decode(data)
        .actions.map(toConfigAction);
    case "multisigAddMember": {
      const { newMember } = getMultisigAddMemberInstructionDataDecoder().decode(data);
      return [toConfigAction({ __kind: "AddMember", newMember })];
    }
    case "multisigRemoveMember": {
      const { oldMember } = getMultisigRemoveMemberInstructionDataDecoder().decode(data);
      return [{ kind: "removeMember", member: oldMember }];
    }
    case "multisigChangeThreshold": {
      const { newThreshold } = getMultisigChangeThresholdInstructionDataDecoder().decode(data);
      return [{ kind: "changeThreshold", newThreshold }];
    }
    case "multisigSetTimeLock": {
      const { timeLock } = getMultisigSetTimeLockInstructionDataDecoder().decode(data);
      return [{ kind: "setTimeLock", newTimeLockSeconds: timeLock }];
    }
    case "multisigAddSpendingLimit": {
      const decoded = getMultisigAddSpendingLimitInstructionDataDecoder().decode(data);
      return [toConfigAction({ ...decoded, __kind: "AddSpendingLimit" })];
    }
    case "multisigRemoveSpendingLimit": {
      // The spending limit is the instruction's third account (`spendingLimit`), not an argument.
      const spendingLimit = instruction.accounts.find((a) => a.role === "spendingLimit")?.address;
      return spendingLimit === undefined ? [] : [{ kind: "removeSpendingLimit", spendingLimit }];
    }
    case "multisigSetRentCollector": {
      const { rentCollector } = getMultisigSetRentCollectorInstructionDataDecoder().decode(data);
      return [{ kind: "setRentCollector", newRentCollector: unwrapOption<Address>(rentCollector) }];
    }
    case "multisigSetConfigAuthority": {
      const { configAuthority } =
        getMultisigSetConfigAuthorityInstructionDataDecoder().decode(data);
      return [{ kind: "setConfigAuthority", newConfigAuthority: configAuthority }];
    }
    default:
      return undefined;
  }
}
