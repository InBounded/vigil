import type { Address } from "@solana/kit";
import type { DecodedInstruction } from "../report.js";

/** Squads instructions that run a transaction account's content (their `transaction` account). */
const SQUADS_EXECUTE = new Set([
  "batchExecuteTransaction",
  "configTransactionExecute",
  "vaultTransactionExecute",
]);

/** One instruction anywhere in the tree, with where it sits. */
export interface WalkedInstruction {
  readonly instruction: DecodedInstruction;
  /** Index of its top-level ancestor (or itself). */
  readonly topIndex: number;
  /** Position path, e.g. `2` or `2.0` for the first instruction inside instruction 2. */
  readonly path: string;
  readonly depth: number;
  /**
   * `true` when the instruction is inside a Squads transaction message carried by a
   * `vaultTransactionCreate` / `batchAddTransaction` and the analysed transaction does not also
   * execute that Squads transaction: it only creates the proposal, and this instruction runs only
   * if the proposal is later approved and executed.
   */
  readonly proposed: boolean;
}

/** Squads transaction accounts that the analysed transaction itself executes. */
function executedHere(instructions: readonly DecodedInstruction[]): ReadonlySet<Address> {
  const out = new Set<Address>();
  const visit = (list: readonly DecodedInstruction[]): void => {
    for (const instruction of list) {
      const executed = instruction.accounts.find((a) => a.role === "transaction")?.address;
      if (
        instruction.decoder === "squads" &&
        SQUADS_EXECUTE.has(instruction.name ?? "") &&
        executed !== undefined
      ) {
        out.add(executed);
      }
      visit(instruction.inner ?? []);
    }
  };
  visit(instructions);
  return out;
}

/**
 * `true` when `instruction` is a Squads instruction that stores a transaction (or config change)
 * for later, and the analysed transaction does not execute it too.
 */
export function onlyProposes(
  instruction: DecodedInstruction,
  executed: ReadonlySet<Address>,
): boolean {
  const transaction = instruction.accounts.find((a) => a.role === "transaction")?.address;
  return (
    instruction.decoder === "squads" && (transaction === undefined || !executed.has(transaction))
  );
}

/** Every instruction, depth first, in order. */
export function walkInstructions(
  instructions: readonly DecodedInstruction[],
): readonly WalkedInstruction[] {
  const executed = executedHere(instructions);
  const out: WalkedInstruction[] = [];
  const visit = (
    list: readonly DecodedInstruction[],
    topIndex: number | undefined,
    prefix: string,
    depth: number,
    proposed: boolean,
  ): void => {
    list.forEach((instruction, position) => {
      const top = topIndex ?? position;
      const path = prefix === "" ? String(position) : `${prefix}.${position}`;
      out.push({ depth, instruction, path, proposed, topIndex: top });
      visit(
        instruction.inner ?? [],
        top,
        path,
        depth + 1,
        proposed || onlyProposes(instruction, executed),
      );
    });
  };
  visit(instructions, undefined, "", 0, false);
  return out;
}

/** Walks `instructions` and also returns the Squads transactions they execute. */
export function walkWithExecuted(instructions: readonly DecodedInstruction[]): {
  readonly walked: readonly WalkedInstruction[];
  readonly executed: ReadonlySet<Address>;
} {
  return { executed: executedHere(instructions), walked: walkInstructions(instructions) };
}
