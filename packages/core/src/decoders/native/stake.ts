import type { Address } from "@solana/kit";
import {
  identifyStakeInstruction,
  parseStakeInstruction,
  STAKE_PROGRAM_ADDRESS,
  StakeInstruction,
} from "@solana-program/stake";
import {
  enumName,
  instructionName,
  normalizeArgs,
  rolesFromParsedAccounts,
  toKitInstruction,
} from "../codama.js";
import type { InstructionInput, ProgramDecodeResult, ProgramDecoder } from "../types.js";

/** Cross-checked against `@solana/web3.js`'s `SYSVAR_CLOCK_PUBKEY` / `SYSVAR_RENT_PUBKEY` in tests. */
export const SYSVAR_CLOCK_ADDRESS = "SysvarC1ock11111111111111111111111111111111" as Address;
export const SYSVAR_RENT_ADDRESS = "SysvarRent111111111111111111111111111111111" as Address;

interface LegacyLayout {
  /** Position where the legacy layout has a sysvar and the current layout has an authority. */
  readonly branch: number;
  readonly sysvar: Address;
  /** Roles of the extra legacy accounts starting at `branch`, in order. */
  readonly extras: readonly string[];
}

/**
 * The Stake program accepts two account layouts for these instructions: the current one (no
 * sysvars) and the legacy one (sysvars first), told apart by whether the account at `branch` is
 * the Clock (or Rent) sysvar — see the `// diverge` blocks in `program/src/processor.rs`,
 * solana-program/stake at commit `6ff57404c5b723c96bad6c7438d812825968ecaf`.
 *
 * `@solana-program/stake@0.10.0` only models the current layout, so on a legacy-layout
 * transaction (still common on mainnet) it would label the Clock sysvar as the withdraw/stake
 * authority. We strip the legacy sysvars, let the official parser name what remains, then put the
 * sysvars back with their own role names.
 */
const LEGACY_LAYOUTS: Readonly<Partial<Record<StakeInstruction, LegacyLayout>>> = {
  [StakeInstruction.Initialize]: { branch: 1, extras: ["rentSysvar"], sysvar: SYSVAR_RENT_ADDRESS },
  [StakeInstruction.Authorize]: {
    branch: 1,
    extras: ["clockSysvar"],
    sysvar: SYSVAR_CLOCK_ADDRESS,
  },
  [StakeInstruction.DelegateStake]: {
    branch: 2,
    extras: ["clockSysvar", "stakeHistorySysvar", "stakeConfig"],
    sysvar: SYSVAR_CLOCK_ADDRESS,
  },
  [StakeInstruction.Withdraw]: {
    branch: 2,
    extras: ["clockSysvar", "stakeHistorySysvar"],
    sysvar: SYSVAR_CLOCK_ADDRESS,
  },
  [StakeInstruction.Deactivate]: {
    branch: 1,
    extras: ["clockSysvar"],
    sysvar: SYSVAR_CLOCK_ADDRESS,
  },
  [StakeInstruction.Merge]: {
    branch: 2,
    extras: ["clockSysvar", "stakeHistorySysvar"],
    sysvar: SYSVAR_CLOCK_ADDRESS,
  },
  [StakeInstruction.AuthorizeWithSeed]: {
    branch: 2,
    extras: ["clockSysvar"],
    sysvar: SYSVAR_CLOCK_ADDRESS,
  },
  [StakeInstruction.InitializeChecked]: {
    branch: 1,
    extras: ["rentSysvar"],
    sysvar: SYSVAR_RENT_ADDRESS,
  },
  [StakeInstruction.AuthorizeChecked]: {
    branch: 1,
    extras: ["clockSysvar"],
    sysvar: SYSVAR_CLOCK_ADDRESS,
  },
  [StakeInstruction.AuthorizeCheckedWithSeed]: {
    branch: 2,
    extras: ["clockSysvar"],
    sysvar: SYSVAR_CLOCK_ADDRESS,
  },
};

export const stakeDecoder: ProgramDecoder = {
  decode(instruction: InstructionInput): ProgramDecodeResult {
    const type = identifyStakeInstruction(instruction);
    const layout = LEGACY_LAYOUTS[type];
    const isLegacy =
      layout !== undefined && instruction.accounts[layout.branch]?.address === layout.sysvar;
    const legacyPositions = isLegacy
      ? new Set(layout.extras.map((_role, i) => layout.branch + i))
      : new Set<number>();

    const reduced: InstructionInput = {
      ...instruction,
      accounts: instruction.accounts.filter((_account, i) => !legacyPositions.has(i)),
    };
    const kit = toKitInstruction(reduced);
    const parsed = parseStakeInstruction(kit);
    const reducedRoles = rolesFromParsedAccounts(
      kit.accounts,
      "accounts" in parsed ? parsed.accounts : undefined,
    );

    const accountRoles: (string | undefined)[] = [];
    let cursor = 0;
    instruction.accounts.forEach((_account, i) => {
      if (layout !== undefined && legacyPositions.has(i)) {
        accountRoles.push(layout.extras[i - layout.branch]);
      } else {
        accountRoles.push(reducedRoles[cursor]);
        cursor++;
      }
    });

    return {
      accountRoles,
      args: "data" in parsed ? normalizeArgs(parsed.data) : {},
      name: instructionName(String(enumName(StakeInstruction, parsed.instructionType))),
    };
  },
  key: "stake",
  kind: "native",
  label: "Stake Program",
  programIds: [STAKE_PROGRAM_ADDRESS],
};
