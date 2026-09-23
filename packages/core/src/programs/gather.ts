import { type Address, getBase64Encoder } from "@solana/kit";
import type { AnalysisGap, DecodedInstruction, ProgramInfo, ProgramLoader } from "../report.js";
import type { AccountInfo, RpcClient } from "../rpc/types.js";
import type { UpgradeBufferInfo } from "../rules/types.js";
import { executableHash } from "./hash.js";
import {
  LOADERS,
  parseBufferAccount,
  parseProgramAccount,
  parseProgramDataAccount,
} from "./loader.js";

const base64Bytes = getBase64Encoder();

export interface ProgramFactsInput {
  /** Programs to describe (invoked at top level, nested, or through CPI). */
  readonly programs: readonly Address[];
  /** Upgrade buffers referenced by loader `upgrade` instructions. */
  readonly buffers: readonly Address[];
  /**
   * Vaults of the analysed multisig to compare upgrade authorities with (address → index): the
   * vaults the proposal uses and vault 0. Empty in raw-transaction mode without a multisig.
   */
  readonly vaults: readonly { readonly address: Address; readonly index: number }[];
}

export interface ProgramFacts {
  /** One entry per requested program, sorted by address; `verification` is still `unknown`. */
  readonly programs: readonly ProgramInfo[];
  readonly buffers: ReadonlyMap<Address, UpgradeBufferInfo>;
  /** Slot of the account reads. */
  readonly contextSlot: bigint;
  readonly gaps: readonly AnalysisGap[];
}

/**
 * Reads what can be known on chain about each program: its loader, whether and by whom it can be
 * upgraded, when it was last deployed, and the solana-verify executable hash of its code; and each
 * upgrade buffer's authority and hash. Two `getMultipleAccounts` rounds (programs and buffers, then
 * ProgramData accounts). Anything that cannot be read is `unknown` with a `PROGRAM_INFO_UNKNOWN`
 * gap; RPC failures do not throw.
 */
export async function gatherProgramFacts(
  rpc: RpcClient,
  input: ProgramFactsInput,
): Promise<ProgramFacts> {
  const programs = [...new Set(input.programs)].sort();
  const buffers = [...new Set(input.buffers)].sort();
  const gaps: AnalysisGap[] = [];
  const vaultIndex = new Map(input.vaults.map((vault) => [vault.address, vault.index]));

  let first: Map<Address, AccountInfo | null>;
  let contextSlot = 0n;
  try {
    const read = await rpc.getMultipleAccounts([...programs, ...buffers]);
    contextSlot = read.contextSlot;
    first = new Map(
      [...programs, ...buffers].map((address, i) => [address, read.value[i] ?? null]),
    );
  } catch {
    return {
      buffers: new Map(),
      contextSlot,
      gaps: [...programs, ...buffers].map((address) =>
        gap(address, "its account could not be read"),
      ),
      programs: programs.map((address) => ({
        address,
        upgrade: { kind: "unknown" },
        verification: "unknown",
      })),
    };
  }

  const programDataOf = new Map<Address, Address>();
  const infos = new Map<Address, ProgramInfo>();
  for (const address of programs) {
    const account = first.get(address) ?? null;
    if (account === null) {
      infos.set(address, {
        address,
        loader: "not-a-program",
        upgrade: { kind: "unknown" },
        verification: "unknown",
      });
      gaps.push(gap(address, "the program account does not exist"));
      continue;
    }
    const loader = loaderOf(account.owner);
    if (loader === "native") {
      // Built into the validator: changed only by validator releases and feature activation.
      infos.set(address, {
        address,
        loader,
        upgrade: { kind: "immutable" },
        verification: "unknown",
      });
    } else if (loader === "loader-v1" || loader === "loader-v2") {
      // These loaders have no upgrade instruction; the code is the program account's own data
      // (solana-verify hashes it the same way, `get_program_hash`).
      infos.set(address, {
        address,
        executableHash: await executableHash(base64Bytes.encode(account.dataBase64)),
        loader,
        upgrade: { kind: "immutable" },
        verification: "unknown",
      });
    } else if (loader === "upgradeable") {
      const parsed = parseProgramAccount(base64Bytes.encode(account.dataBase64));
      if (!parsed.ok) {
        infos.set(address, {
          address,
          loader,
          upgrade: { kind: "unknown" },
          verification: "unknown",
        });
        gaps.push(gap(address, parsed.reason));
        continue;
      }
      programDataOf.set(address, parsed.programData);
    } else {
      infos.set(address, {
        address,
        loader,
        upgrade: { kind: "unknown" },
        verification: "unknown",
      });
      gaps.push(
        gap(
          address,
          loader === "loader-v4"
            ? "the program uses loader v4, whose upgrade authority Vigil does not read yet"
            : `the account is owned by ${account.owner}, not by a program loader`,
        ),
      );
    }
  }

  const programDatas = [...new Set(programDataOf.values())].sort();
  let second = new Map<Address, AccountInfo | null>();
  if (programDatas.length > 0) {
    try {
      const read = await rpc.getMultipleAccounts(programDatas, { minContextSlot: contextSlot });
      second = new Map(programDatas.map((address, i) => [address, read.value[i] ?? null]));
    } catch {
      // Every affected program is reported below as unknown, with a gap.
    }
  }
  for (const [program, programData] of programDataOf) {
    const account = second.get(programData) ?? null;
    const base = {
      address: program,
      loader: "upgradeable" as const,
      programData,
      verification: "unknown" as const,
    };
    if (account === null || account.owner !== LOADERS.upgradeable) {
      infos.set(program, { ...base, upgrade: { kind: "unknown" } });
      gaps.push(
        gap(
          program,
          account === null
            ? "its ProgramData account could not be read"
            : "its ProgramData account is not owned by the upgradeable loader",
        ),
      );
      continue;
    }
    const parsed = parseProgramDataAccount(base64Bytes.encode(account.dataBase64));
    if (!parsed.ok) {
      infos.set(program, { ...base, upgrade: { kind: "unknown" } });
      gaps.push(gap(program, parsed.reason));
      continue;
    }
    const index = parsed.authority === null ? undefined : vaultIndex.get(parsed.authority);
    infos.set(program, {
      ...base,
      executableHash: await executableHash(parsed.code),
      lastDeploySlot: parsed.slot,
      upgrade:
        parsed.authority === null
          ? { kind: "immutable" }
          : { authority: parsed.authority, kind: "upgradeable" },
      ...(index === undefined ? {} : { authorityVaultIndex: index }),
    });
  }

  const bufferInfos = new Map<Address, UpgradeBufferInfo>();
  for (const address of buffers) {
    const account = first.get(address) ?? null;
    if (account === null || account.owner !== LOADERS.upgradeable) {
      gaps.push(
        gap(
          address,
          account === null
            ? "the upgrade buffer does not exist (already used or closed)"
            : "the upgrade buffer is not owned by the upgradeable loader",
        ),
      );
      continue;
    }
    const parsed = parseBufferAccount(base64Bytes.encode(account.dataBase64));
    if (!parsed.ok) {
      gaps.push(gap(address, parsed.reason));
      continue;
    }
    bufferInfos.set(address, {
      address,
      authority: parsed.authority,
      executableHash: await executableHash(parsed.code),
    });
  }

  return {
    buffers: bufferInfos,
    contextSlot,
    gaps,
    programs: programs.map(
      (address) =>
        infos.get(address) ?? { address, upgrade: { kind: "unknown" }, verification: "unknown" },
    ),
  };
}

function loaderOf(owner: Address): ProgramLoader {
  switch (owner) {
    case LOADERS.upgradeable:
      return "upgradeable";
    case LOADERS.loaderV2:
      return "loader-v2";
    case LOADERS.loaderV1:
      return "loader-v1";
    case LOADERS.loaderV4:
      return "loader-v4";
    case LOADERS.native:
      return "native";
    default:
      return "not-a-program";
  }
}

function gap(address: Address, reason: string): AnalysisGap {
  return { address, code: "PROGRAM_INFO_UNKNOWN", message: reason };
}

/** Every program the analysed instructions invoke (nested ones too) and those the simulation saw through CPI. */
export function invokedPrograms(
  instructions: readonly DecodedInstruction[],
  innerPrograms: readonly Address[] = [],
): Address[] {
  const out = new Set<Address>(innerPrograms);
  const walk = (list: readonly DecodedInstruction[]) => {
    for (const instruction of list) {
      out.add(instruction.programId);
      if (instruction.inner !== undefined) {
        walk(instruction.inner);
      }
    }
  };
  walk(instructions);
  return [...out].sort();
}

/** Buffers of every loader `upgrade` instruction (nested ones too). */
export function upgradeBuffers(instructions: readonly DecodedInstruction[]): Address[] {
  return upgradeAccounts(instructions, "bufferAccount");
}

/**
 * Programs replaced by a loader `upgrade` (nested ones too). They are not *invoked* (the loader
 * is), but an upgrade proposal must still show their current state and verification (VGL-C001).
 */
export function upgradedPrograms(instructions: readonly DecodedInstruction[]): Address[] {
  return upgradeAccounts(instructions, "programAccount");
}

function upgradeAccounts(instructions: readonly DecodedInstruction[], role: string): Address[] {
  const out = new Set<Address>();
  const walk = (list: readonly DecodedInstruction[]) => {
    for (const instruction of list) {
      if (instruction.programId === LOADERS.upgradeable && instruction.name === "upgrade") {
        const account = instruction.accounts.find((a) => a.role === role);
        if (account !== undefined) {
          out.add(account.address);
        }
      }
      if (instruction.inner !== undefined) {
        walk(instruction.inner);
      }
    }
  };
  walk(instructions);
  return [...out].sort();
}
