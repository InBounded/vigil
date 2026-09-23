import type { Address } from "@solana/kit";

/**
 * Sysvar addresses with their display names. The addresses are the ones exported by
 * `@solana/sysvars@8.3.0` (`SYSVAR_*_ADDRESS`), which `sysvars.test.ts` cross-checks; they are
 * copied rather than imported to avoid a runtime dependency for ten constants.
 */
export const SYSVARS: ReadonlyMap<Address, string> = new Map([
  ["SysvarC1ock11111111111111111111111111111111" as Address, "Clock"],
  ["SysvarEpochRewards1111111111111111111111111" as Address, "Epoch Rewards"],
  ["SysvarEpochSchedu1e111111111111111111111111" as Address, "Epoch Schedule"],
  ["Sysvar1nstructions1111111111111111111111111" as Address, "Instructions"],
  ["SysvarLastRestartS1ot1111111111111111111111" as Address, "Last Restart Slot"],
  ["SysvarRecentB1ockHashes11111111111111111111" as Address, "Recent Blockhashes"],
  ["SysvarRent111111111111111111111111111111111" as Address, "Rent"],
  ["SysvarS1otHashes111111111111111111111111111" as Address, "Slot Hashes"],
  ["SysvarS1otHistory11111111111111111111111111" as Address, "Slot History"],
  ["SysvarStakeHistory1111111111111111111111111" as Address, "Stake History"],
]);
